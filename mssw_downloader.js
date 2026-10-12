#!/usr/bin/env node
'use strict';

/**
 * 主入口：从 mssw 下载报告所需的各份总表。
 *
 * 运行模式看**有没有传 `--cookie-path`**：
 *
 *   不传（默认，集群）  登录态交给 session-manager 代管，入口 origin 与统一 Host 头
 *                       取自 config/api_config.json。见 session.js。
 *   传了（本地）        直接读那个 cookie txt，走 https://<域名>，与历史行为逐字一致；
 *                       换环境用 --mssw-base-url（现在也收完整 origin，含 scheme + 端口）。
 *
 * 本地用法（端到端，不带 --type 即下载全部已实现的表）:
 *   node mssw_downloader.js \
 *     --customer "客户中文名" \
 *     --start 2026-05-12 --end 2026-05-13 \
 *     --cookie-path "C:\Users\%USERNAME%\Downloads\mssw_cookies.txt"
 *
 * 集群用法就是去掉 --cookie-path:
 *   node mssw_downloader.js --customer "客户中文名" --start 2026-05-12 --end 2026-05-13
 *
 * 只想要某一份表时用 --type，可逗号分隔多份:
 *   node mssw_downloader.js --type asset --customer "..." --cookie-path "..."
 *
 * 目标形态见 MIGRATION.md：下载六份总表（资产/事件/告警/漏洞/弱密码/暴露面），
 * 再由计算层读总表写进 data.xlsx 模板产出 {customer}_report.xlsx。
 * 当前已实现其中五份（资产/事件/告警/漏洞/弱密码），故主脚本一次跑完就是这五个 excel。
 *
 * 下载得到的中间文件在合并完成后会被删除（平台只能给文件，所以流程是
 * "下载 -> 合并 -> 删中间件"）。
 * 想留档加 --keep-intermediates。
 *
 * 失败时：stdout 上**无条件**留一个 JSON（顶层 error 带 code / message / hint），
 * 退出码按病因分（2 参数错 / 8 下载失败 / 10 登录态拿不到 / 1 未预期）——
 * 判据与 pipeline.js 共用 mssw_errors.js 一份，别在这里另写一套。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs, requireArgs, badRequest, splitList } = require('./args');
const { readMsswCookieInfo } = require('./cookie_reader');
const session = require('./session');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');
const progress = require('./progress');
const runlog = require('./runlog');
const {
  DEFAULT_MSSW_BASE_URL,
  findMsswCustomerIdByName,
  exportMsswIncidentList,
  exportMsswAssetList,
  exportMsswAlertList,
  exportMsswVulnList,
  exportMsswWeakPwdList,
  MSSW_VUL_MANAGE_TIME_RANGE_LABEL
} = require('./mssw_client');
const { buildReport, generateReportFileName } = require('./report_writer');
const { parseTableRows } = require('./mssw_parser');
const { runPreprocess } = require('./mssw_preprocess');
const { createContext } = require('./stats/context');
const { ALARM_TABLE_COLUMNS } = require('./stats/metrics/alarm');
const { BUSINESS_COLUMN, IP_COLUMN: ASSET_IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
        PRIMARY_ASSET_TYPE_COLUMN } = require('./stats/metrics/asset');
const { RISK_ASSET_COLUMN: VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN,
        DISPOSITION_COLUMN: VULN_DISPOSITION_COLUMN } = require('./stats/metrics/vuln');
const { RISK_ASSET_COLUMN: WEAKPWD_RISK_ASSET_COLUMN,
        WEAKPWD_TABLE_COLUMNS } = require('./stats/metrics/weakpwd');
const { EVENT_TABLE_COLUMNS } = require('./stats/metrics/event');
const { MAX_CORE_SYSTEMS } = require('./stats/metrics/core_system');
// 失败分类（code / 退出码 / hint）与 pipeline.js 共用同一份，见 mssw_errors.js 头注。
const { classifyFailure } = require('./mssw_errors');

// 表名以 package.json 的措辞为准（asset/event/alarm/...），故告警表主名用 alarm；
// incident / 告警 / alert 作为别名接受。
const TYPE_ALIASES = {
  event: 'event',
  incident: 'event',
  asset: 'asset',
  alarm: 'alarm',
  alert: 'alarm',
  告警: 'alarm',
  vuln: 'vuln',
  漏洞: 'vuln',
  weakpwd: 'weakpwd',
  weak_pwd: 'weakpwd',
  weakpassword: 'weakpwd',
  弱密码: 'weakpwd'
};

// 主脚本默认下载的顺序：对齐报告 sheet 顺序（资产表 → 告警表 → 事件表 → 资产漏洞表
// → 弱密码表），后续补齐暴露面时往后追加即可。
const ALL_TABLES = ['asset', 'alarm', 'event', 'vuln', 'weakpwd'];

const TYPE_LABELS = {
  asset: '资产表',
  alarm: '告警表',
  event: '事件表',
  vuln: '漏洞表',
  weakpwd: '弱密码表'
};

// 缺少 --start/--end 就**不能跑**的表。事件表/告警表在此列：它们没有"全量"这个模式。
// 漏洞表/弱密码表不在此列 —— 它们按 --start/--end 取数（两张表都按「首次发现时间」圈，
// 见 mssw_client 的 MSSW_VUL_MANAGE_TIME_RANGE_LABEL），
// 但日期是可选的：不传就退化成全量导出（见 mssw_client 的 resolveVulManageTimeRangeMs）。
const TIME_RANGE_TYPES = new Set(['event', 'alarm']);

function printHelp() {
  console.log(`Usage:
  node mssw_downloader.js --customer "客户名" --start YYYY-MM-DD --end YYYY-MM-DD [options]

运行模式（看有没有传 --cookie-path）:
  不传 --cookie-path   集群模式（默认）：登录态由 session-manager 代管，
                       入口域名/Host 头取 config/api_config.json。
  传 --cookie-path     本地模式：直接读该 cookie 文件（或目录里最新的 txt），
                       走 https://<域名>，行为与历史完全一致。

不带 --type 时下载全部已实现的表（当前：资产表 / 告警表 / 事件表 / 漏洞表 / 弱密码表），
合并成一份 {客户名}_report.xlsx 后删除下载得到的中间文件。

Options:
  --customer <name>         客户中文名（用于自动查 company_id）
  --customer-id <id>        直接指定 company_id，跳过客户名查询
  --start <YYYY-MM-DD>      时间范围起（本地 00:00:00）
  --end <YYYY-MM-DD>        时间范围止（本地 23:59:59）
                            事件表/告警表必传；漏洞表/弱密码表也认这两个值（按「最近
                            发现时间」过滤），不传则那两张表退化成全量导出
  --cookie-path <path>      mssw cookie 文件或目录；**传了即本地模式**（不传则走集群）
  --type <names>            只下指定表，逗号分隔：asset | alarm | event | vuln | weakpwd
                            （别名 incident / alert / 告警 / 漏洞 / 弱密码；默认下载全部）
  --business-systems <a,b,c> 核心业务系统名，**可选**，最多 3 个（逗号/顿号/分号均可，中英文不限）。
                            按顺序填「数据统计」的 D3/D4/D5，各自的风险总数填 D7/D8/D9，
                            D6 是那三个数之和（三个槽位一个不落地加：少传一个，那一格就是 0，
                            所以只传 2 个时 D6 就是这 2 个之和）。
                            不传/少传：名字格 D3/D4/D5 空着的那几个不写值并记入错误列表；
                            **算出来的**格（D6:D9 / G6/H6/I6 / G10）按 0 落值（用户口径 2026-10-12）。
                            D10/D12/D15/D17/D11 不受它影响。
  --mssw-base-url <origin>  MSSW 入口。裸域名默认加 https://（集群内网入口带端口，
                            用完整 origin，如 http://mssw-inner.sangfor.com.cn:30001）
  --mssw-host-header <h>    Host 头覆盖。默认本地=域名、集群=统一 Host 头；
                            传空串表示不发 Host 头
  --mssw-referer-path <p>   Referer 路径，默认 /index.html
  --download-dir <path>     原始导出落盘目录。本地默认 cookie 文件所在目录，
                            集群默认 <SKILL_OUTPUT_DIR>/tmp/downloads
  --output-dir <path>       报告产物目录。本地默认脚本所在目录，
                            集群默认 <SKILL_OUTPUT_DIR>
  --report-template <path>  报告模板，默认 <repo>/data.xlsx
  --no-beautify             不套统一视觉规范（默认套用，数据统计 sheet 始终不动）
  --beautify-theme <name>   美化主题：classic 经典清单（默认）| modern 现代汇报
  --keep-intermediates      保留下载得到的中间文件（默认合并后删除）
  --timeout-ms <ms>         导出任务轮询总超时，事件默认 120000 / 告警默认 600000
  --poll-interval-ms <ms>   轮询间隔，默认 3000
  --json                    把结果 JSON 打到 stdout（**失败时无条件打**，不必给这个参数）
  --quiet                   不输出过程日志（日志文件照常落盘，不受影响）
  --python <p>              python 解释器（资产表加工、事件表删除、报告美化都用它）；
                            不给则取环境变量 PYTHON，再不然按平台取：
                            Windows → python，其他 → python3，都带另一个做备选

本次运行的完整日志（stderr、异常栈、结果 JSON、退出码）落在
outputs/_logs/mssw_downloader.<时间戳>.log，路径也在结果 JSON 的 log.path 里。
失败时读它，报错里的 [POST /…/接口名] 就是出错的接口。
`);
}

/**
 * 进度一律走 stderr —— stdout 只留给结果 JSON。
 *
 * `--quiet` 只压控制台，**不压日志文件**：那条通路绕过了 stderr（也就绕过了 runlog
 * 的镜像），所以这里显式补一次。日志是事后排障的唯一凭据，不该被开关关掉。
 */
function createLogger(options = {}) {
  if (options.quiet === true || options.quiet === 'true') {
    return (message) => runlog.line(message);
  }
  return (message) => {
    console.error(message);
  };
}

/** 解析 --type；不传即全部已实现的表。支持逗号分隔。 */
function resolveRequestedTypes(options) {
  const raw = options.type;
  if (!raw || raw === true) {
    return [...ALL_TABLES];
  }

  const requested = String(raw)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const resolved = [];
  for (const item of requested) {
    const mapped = TYPE_ALIASES[item];
    if (!mapped) {
      throw badRequest(`暂不支持的表: ${item}（当前仅支持 ${ALL_TABLES.join(' / ')}）`);
    }
    if (!resolved.includes(mapped)) {
      resolved.push(mapped);
    }
  }

  if (!resolved.length) {
    return [...ALL_TABLES];
  }
  return resolved;
}

/**
 * 下载目录。
 *
 * 本地：返回 undefined，沿用 mssw_client 里「cookie 文件所在目录」的旧默认，逐字不变。
 * 集群：显式指向 <SKILL_OUTPUT_DIR>/tmp/downloads —— 集群下 cookie 文件在 session/ 里，
 *      不注入的话大宗客户 xlsx 会倒进凭据目录，而且删中间件时会把那儿的文件 unlink 掉。
 */
function resolveDownloadDir(options, mode) {
  const explicit = options['download-dir'];
  if (typeof explicit === 'string' && explicit.trim()) {
    return mode === 'cluster' ? workdir.resolveWritable(explicit) : explicit;
  }
  return mode === 'cluster' ? workdir.tmpDownloadsDir() : undefined;
}

/** 资产表加工产物目录：本地仍是 <repo>/tmp/exports，集群落到可写区。 */
function resolveAssetOutputDir(mode) {
  return mode === 'cluster' ? workdir.tmpExportsDir() : undefined;
}

/** 报告产物目录：本地仍是脚本所在目录，集群落到可写区（集群上 skill 根只读）。 */
function resolveReportOutputDir(options, mode) {
  const explicit = options['output-dir'];
  if (typeof explicit === 'string' && explicit.trim()) {
    return mode === 'cluster' ? workdir.resolveWritable(explicit) : path.resolve(explicit);
  }
  return mode === 'cluster' ? workdir.outputDir() : __dirname;
}

/** 下载单份表，返回 { result, summary }。 */
async function downloadTable(type, ctx) {
  const { cookieInfo, platform, mode, companyId, options, logger } = ctx;
  const common = {
    msswCookiePath: cookieInfo.resolvedPath,
    msswBaseUrl: platform.origin,
    msswHostHeader: platform.hostHeader,
    msswRefererPath: platform.refererPath,
    downloadDir: resolveDownloadDir(options, mode),
    customerId: companyId,
    logger
  };

  if (type === 'event') {
    const result = await exportMsswIncidentList({
      ...common,
      start: options.start,
      end: options.end,
      timeoutMs: options['timeout-ms'],
      pollIntervalMs: options['poll-interval-ms']
    });
    return {
      result,
      summary: [
        `事件表: ${result.filePath}`,
        `  删除已忽略事件 ${result.removedRows} 条（${result.totalBefore} -> ${result.totalAfter}）`
      ].join('\n')
    };
  }

  if (type === 'alarm') {
    const result = await exportMsswAlertList({
      ...common,
      start: options.start,
      end: options.end,
      timeoutMs: options['timeout-ms'],
      pollIntervalMs: options['poll-interval-ms']
    });
    return {
      result,
      summary: [
        `告警表: ${result.filePath}`,
        // 下载层不动这份表（事件/漏洞/弱密码表在这一层删行，告警表不删）。
        // 「主机IP」原样落盘 —— 那个值本来就带括号说明（`172.101.226.10(未归类组)`），
        // 报告 sheet 上也原样保留（2026-10-12 起合并阶段不再剥掉它）。
        // 取值层比对时会自己剥（stats/metrics/rows.js 的 normalizeIp），不受影响。
        `  共 ${result.total} 条（下载原样落盘）`
      ].join('\n')
    };
  }

  if (type === 'vuln' || type === 'weakpwd') {
    // 这两张表同源（/order/v1/vul_manage/*），都没有轮询超时 —— 同步接口自己等，
    // 等的上限在 mssw_client 里（MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS）。
    // 时间范围按 --start/--end 传（2026-10-09 用户口径），不传则全量。
    const result = type === 'vuln'
      ? await exportMsswVulnList({ ...common, start: options.start, end: options.end })
      : await exportMsswWeakPwdList({ ...common, start: options.start, end: options.end });
    return {
      result,
      summary: [
        `${TYPE_LABELS[type]}: ${result.filePath}`,
        options.start && options.end
          ? `  时间范围 ${options.start} ~ ${options.end}（按「${MSSW_VUL_MANAGE_TIME_RANGE_LABEL}」过滤）`
          : '  全量导出（未传 --start/--end，不传时间范围）',
        `  删除处置状态为「处置完成（误报）」的行 ${result.removedRows} 条（${result.totalBefore} -> ${result.totalAfter}）`
      ].join('\n')
    };
  }

  const result = await exportMsswAssetList({
    ...common,
    // 本地不传 outputDir：资产表加工是中间步骤，固定落 <repo>/tmp/exports，
    // 免得和 --output-dir（报告产物目录）混在一起。
    // 集群下 skill 根只读，必须显式指到可写区。
    outputDir: resolveAssetOutputDir(mode)
  });
  return {
    result,
    summary: [
      `资产表: ${result.filePath}`,
      `  原始导出: ${result.rawFilePath}`,
      `  待审核资产: ${result.waitApproveFilePath || '（未导出）'}`,
      result.pagedFallback ? '  本次走的是分页兜底导出' : ''
    ].filter(Boolean).join('\n')
  };
}

/**
 * 告警表中间件 -> 内存行对象数组（MIGRATION.md R9 的 parse*，实现在 mssw_parser.js）。
 *
 * 读**列白名单**而不是整表：告警导出没有行数上限（实测一份 10 万行），整表回传会撞
 * execFile 的 maxBuffer。列名从 stats/metrics/alarm.js 取常量（ALARM_TABLE_COLUMNS：
 * 告警定性 + GPT研判结论 + 主机IP），不在这里写字面量 —— 写死的话，平台改列名时，
 * 取值层和读取层会各说各话。
 *
 * 读失败**不吞**（R10 缺数不静默）：拿个空数组糊过去的话，14 格告警定性与 G5/G6/H6/I6
 * 会安安静静地留空，看起来与「这段时间真的没有告警」一模一样。
 *
 * 列名对不上**不算读失败**：照常返回行对象（那些行一个都不带这个键），取值层的
 * hasOwnProperty 防线会抛错、把用它的格子记进错误列表。这里只负责把这个事实吼出来。
 */
async function readAlarmRows(filePath, logger) {
  const parsed = await parseTableRows(filePath, { columns: ALARM_TABLE_COLUMNS });

  if (parsed.missingColumns.length) {
    const preview = parsed.header.slice(0, 12).join('、');
    logger(
      `[数据统计] ⚠️ 告警表里没有「${parsed.missingColumns.join('、')}」列，`
      + `用它的格子（「告警定性」-> C133:I134，「GPT研判结论」/「主机IP」-> G5 / G6/H6/I6）`
      + `会留空并记进错误列表。表头共 ${parsed.header.length} 列: `
      + `${preview}${parsed.header.length > 12 ? ' …' : ''}`
    );
  }
  if (parsed.unnamedColumns) {
    logger(`[数据统计] 告警表有 ${parsed.unnamedColumns} 列表头为空（这些列无法按列名读取）`);
  }
  logger(`[数据统计] 告警表读入 ${parsed.rowCount} 行，`
    + `取「${ALARM_TABLE_COLUMNS.join('、')}」列`);
  return parsed.rows;
}

/**
 * 资产表：**无条件**读一次（与告警表同理，不受 --business-systems 影响）。
 *
 * 读它的是四处，需求列不同，所以取并集一次读完：
 *   · D11「管理员弱口令数量」要「重要级别」（挑出核心资产）+「IP地址」（核心资产集合）
 *   · 核心业务系统的风险总数（D6:D9）要「所属业务」「IP地址」（业务归属 -> IP）
 *   · G16「业务系统数量」只要「所属业务」这一列（数出现过多少种不同的内容 ——
 *     不读 IP、也不看 --business-systems，所以它缺「IP地址」列也照算）
 *   · G17「服务器资产数量」/ G18「PC资产数量」只要「资产类型(一级)」这一列
 *     （数整格精确等于「服务器」/「终端」的行数 —— 同样不读 IP、不看 --business-systems）
 *
 * 它同时是前两处的**钥匙**：没有资产表，D11 与 D6:D9 都做不出「-> IP 集合」这一步。
 * 不过这一点不必在这里额外照顾：下载一定发生，某份表真没下到时 buildReport 会直接报
 * 「缺少 资产表 的下载结果」、整份报告不出（scripts/build_report.py），流程走不到取值层；
 * 到了取值层的表一律是「有行」或「0 行」，两种都只是「这台/这批资产存在与否」，按 0 算。
 */
const ASSET_TABLE_SPEC = {
  type: 'asset',
  field: 'assetRows',
  label: '资产表',
  columns: [BUSINESS_COLUMN, ASSET_IP_COLUMN, IMPORTANT_LEVEL_COLUMN, PRIMARY_ASSET_TYPE_COLUMN],
  affected: 'D6:D9、D11、G16、G17、G18'
};

/**
 * 弱密码表：**无条件**读一次（D11 / D16 要它，与 --business-systems 无关）。
 *
 * 读它的是三处，需求列不同，所以取并集一次读完：
 *   · D11「管理员弱口令数量」第一段（核心资产上的弱密码行数）—— 要「风险资产」
 *   · 核心业务系统的风险总数（D6:D9）里「弱密码风险」那一段 —— 要「风险资产」
 *   · D16「已处置弱口令数量」第一段（全表「处置状态」=「处置完成」的行数）—— 要「处置状态」
 *
 * 表为空（0 行）时给空数组即可：三处都是「那一段行数为 0」
 * （口径见 stats/metrics/weakpwd.js 与 admin_weakpwd.js / disposed_weakpwd.js），
 * 0 是结论、不是缺数。报告期窗口里一条弱密码都没有，本来就会下到空表。
 */
const WEAKPWD_TABLE_SPEC = {
  type: 'weakpwd',
  field: 'weakPwdRows',
  label: '弱密码表',
  columns: WEAKPWD_TABLE_COLUMNS,
  affected: 'D6:D9、D11、D16'
};

/**
 * 漏洞表：**无条件**读一次（与告警表、事件表同理，不受 --business-systems 影响）。
 *
 * 读它的是四处，需求列不同，所以取并集一次读完：
 *   · D10「高危可利用漏洞数」要「威胁标签」（全表含「高可利用」的行数）
 *   · D12「最新漏洞影响资产数」要「威胁标签」+「风险资产」（全表含「热点漏洞」、
 *     再按「风险资产」去重数台）—— D17 是 D12 的 alias，自己不读表，列白名单里没有它的份
 *   · D15「已修复漏洞数」要「处置状态」（全表里精确等于「处置完成」的行数）
 *   · 核心业务系统的风险总数（D6:D9）那一段要「威胁标签」+「风险资产」（按 IP 圈定）
 *
 * 表为空（0 行）就是「这段时间一条漏洞都没有」-> 给空数组：D10 / D12 / D15 各归总成 0
 * （0 是结论，不是缺数）。取值层已经不再区分「整份没下到」与「下到了、0 行」——
 * 前者在 scripts/build_report.py 就被拦下了，整份报告不出。
 */
const VULN_TABLE_SPEC = {
  type: 'vuln',
  field: 'vulnRows',
  label: '漏洞表',
  columns: [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN, VULN_DISPOSITION_COLUMN],
  affected: 'D6:D9、D10、D12、D15（+ D17，走 D12 的 alias）'
};

/**
 * 事件表：**无条件**读一次（与告警表同理，不受 --business-systems 影响）。
 *
 * 读它的是八处，需求列不同，所以取并集一次读完（EVENT_TABLE_COLUMNS 就在
 * stats/metrics/event.js 里定义，列名只写一遍）：
 *   · 事件定性 21 格（C135:I137）要「GPT定性标签」
 *   · D11「管理员弱口令数量」第二段要「影响资产」「安全事件二级分类」
 *   · 核心业务系统的风险总数（D6:D9）要「影响资产」「安全事件二级分类」
 *   · G8「处置安全事件总数」要「处置状态」
 *   · G9「事件平均响应时长」要「处置状态」「推送状态」「响应时长」—— 第一列是选行
 *     （**复用 G8 那批行**，见 stats/metrics/event.js 的 disposedEventRows），
 *     「推送状态」是平台导出的真实列，「响应时长」是预处理追加的（同 G7 的那一批）。
 *   · D16「已处置弱口令数量」第二段要「安全事件二级分类」「处置状态」
 *     （与 D11 读同一列、与 G8 读同一列，但条件不同：分类含「弱口令」且状态恰为
 *     「处置完成」—— 各格的判据各写在各自的 metrics 函数里）
 *   · G7「威胁平均遏制时间」要「GPT研判结论」「遏制时长」—— 前者是选行（与 G5 同一句话），
 *     后者算均值。⚠️「遏制时长」**不是平台导出的列**，是上面那步表格预处理追加到下载件上的
 *     （见 runInner 里 runPreprocess 的位置）—— 所以读事件表必须发生在预处理之后。
 *     平台改了那两个时间源列的名时，预处理凑不齐就**不追加**时长列，
 *     G7 报「找不到『遏制时长』列」不写值 + 记错误（旧版 25 列导出就是这样）。
 *   · G10「核心系统事件数量」要「影响资产」（「精确落在」系统 IP 并集里的行数，
 *     与 D6:D9 那一段同一列、另一套数法）
 *
 * 表为空（0 行）时给空数组即可：绝大多数格子都是「那一段 / 那一格是 0 或空串」
 * （口径见 stats/metrics/event.js），0 / 空串是结论、不是缺数。
 */
const EVENT_TABLE_SPEC = {
  type: 'event',
  field: 'eventRows',
  label: '事件表',
  columns: EVENT_TABLE_COLUMNS,
  affected: 'C135:I137、D6:D9、D11、D16、G7、G8、G9、G10'
};

/**
 * 无条件读的四份总表（数据统计那个 sheet 的输入）。
 *
 * 这四份都与 --business-systems 无关，各自还有别的格子要读 —— 所以不再有「传了系统名
 * 才读」的分支：那种按需读盘会让 D10/D12/D15/D11 这几格在没传系统名时拿到空 ctx。
 * 列白名单一律从 stats/metrics/*.js 取常量，不在这里写字面量。
 */
const STATISTICS_TABLE_SPECS = [
  ASSET_TABLE_SPEC,
  VULN_TABLE_SPEC,
  WEAKPWD_TABLE_SPEC,
  EVENT_TABLE_SPEC
];

/**
 * 一份总表中间件 -> 内存行对象数组（MIGRATION.md R9 的 parse*，实现在 mssw_parser.js）。
 *
 * 读**列白名单**而不是整表：这几份表都没有行数上限（漏洞表实测 13301 行、事件表 6034 行），
 * 整表回传会撞 execFile 的 maxBuffer。
 *
 * 读失败**不吞**（R10 缺数不静默）：拿个空数组糊过去的话，靠它算的格子会安安静静地留空，
 * 看起来与「这段时间真的没有数据」一模一样。
 *
 * 列名对不上**不算读失败**：照常返回行对象（那些行一个都不带这个键），取值层的
 * hasOwnProperty 防线会抛错、把受影响的格子记进错误列表。这里只负责把这个事实吼出来。
 */
async function readStatisticsRows(filePath, spec, logger) {
  const parsed = await parseTableRows(filePath, { columns: spec.columns });

  if (parsed.missingColumns.length) {
    const preview = parsed.header.slice(0, 12).join('、');
    logger(
      `[数据统计] ⚠️ ${spec.label}里没有「${parsed.missingColumns.join('、')}」列，`
      + `${spec.affected} 会留空并记进错误列表。表头共 ${parsed.header.length} 列: `
      + `${preview}${parsed.header.length > 12 ? ' …' : ''}`
    );
  }
  if (parsed.unnamedColumns) {
    logger(`[数据统计] ${spec.label}有 ${parsed.unnamedColumns} 列表头为空（这些列无法按列名读取）`);
  }
  logger(`[数据统计] ${spec.label}读入 ${parsed.rowCount} 行，取「${spec.columns.join('、')}」列`);
  return parsed.rows;
}

/**
 * 收集本次运行产生的中间文件路径。
 *
 * 只收集本次运行明确拿到的路径，绝不做通配删除（--download-dir 是用户的 Downloads 目录）。
 * 资产表有两份：平台导出的原始文件 + 加工后的中间件。
 */
function collectIntermediateFiles(type, result) {
  if (!result) return [];
  if (type === 'asset') {
    return [result.rawFilePath, result.waitApproveFilePath, result.filePath].filter(Boolean);
  }
  return [result.filePath].filter(Boolean);
}

/** 删除中间文件；删不掉只告警，不影响已生成的报告。 */
function removeIntermediates(filePaths, logger) {
  const removed = [];
  for (const filePath of filePaths) {
    try {
      fs.unlinkSync(filePath);
      removed.push(filePath);
      logger(`[清理] 已删除中间文件: ${filePath}`);
    } catch (error) {
      logger(`[清理] 删除中间文件失败（忽略）: ${filePath} -> ${error.message}`);
    }
  }
  return removed;
}

/**
 * 进度上报的外壳：本 skill 要跑几分钟，用户得在 IM 里看到动静。
 *
 * 只是包一层，**业务逻辑一行没动**（原样搬进 runInner）。两个调用方
 * （`main()` 与 `pipeline.js` 的 ensureExcel）都因此免费拿到 `excel` 节点，
 * 不需要各自再报一遍。
 */
async function run(options) {
  progress.stage('excel', '正在下载资产/告警/事件/漏洞/弱密码总表并合并 Excel…');
  try {
    const payload = await runInner(options);
    const file = payload && payload.report && payload.report.filePath;
    progress.done('excel', file ? `Excel 已生成：${path.basename(file)}` : 'Excel 已生成');
    return payload;
  } catch (error) {
    progress.fail('excel', `Excel 生成失败：${error.message}`, error.code, 'excel_failed');
    throw error;
  }
}

async function runInner(options) {
  const requestedTypes = resolveRequestedTypes(options);

  // 事件/告警按时间范围导出，主脚本默认含这两份，所以要校验。
  if (requestedTypes.some((type) => TIME_RANGE_TYPES.has(type))) {
    requireArgs(options, ['start', 'end']);
  }

  const logger = createLogger(options);

  // 模式判定：传了 --cookie-path 走本地 txt，没传则经 session-manager 取态（集群为默认）。
  const auth = await session.resolveAuth({
    cookiePath: options['cookie-path'],
    msswBaseUrl: options['mssw-base-url'],
    msswHostHeader: options['mssw-host-header'],
    msswRefererPath: options['mssw-referer-path']
  }, logger);
  const { platform, mode } = auth;

  // 先读一次 cookie：既校验可读，也拿到 resolvedPath。
  const cookieInfo = await readMsswCookieInfo(auth.cookiePath);
  logger(`MSSW Cookie: ${cookieInfo.resolvedPath}`);

  let companyId = String(options['customer-id'] || '').trim();
  if (!companyId) {
    if (!options.customer) {
      throw badRequest('需要 --customer 或 --customer-id 之一用于确定 company_id');
    }
    companyId = await findMsswCustomerIdByName(cookieInfo, platform, options.customer);
    logger(`客户 ${options.customer} -> company_id=${companyId}`);
  }

  logger(`准备下载 ${requestedTypes.length} 份表: ${requestedTypes.map((t) => TYPE_LABELS[t]).join(' / ')}`);

  const ctx = { cookieInfo, platform, mode, companyId, options, logger };
  const results = {};
  const failures = [];

  for (const type of requestedTypes) {
    logger('');
    logger(`===== ${TYPE_LABELS[type]} =====`);
    try {
      const { result, summary } = await downloadTable(type, ctx);
      results[type] = result;
      logger(summary);
    } catch (error) {
      // 单表失败不中断其余表，但一律记下来并在末尾明确报错，不静默吞掉（MIGRATION.md R10）
      failures.push({ type, label: TYPE_LABELS[type], message: error.message });
      logger(`${TYPE_LABELS[type]} 失败: ${error.message}`);
    }
  }

  const summaryLines = [];
  for (const type of requestedTypes) {
    const result = results[type];
    if (!result) continue;
    summaryLines.push(`${TYPE_LABELS[type]}: ${result.filePath}`);
  }
  if (failures.length) {
    summaryLines.push('');
    summaryLines.push(`失败 ${failures.length} 份:`);
    for (const failure of failures) {
      summaryLines.push(`  ${failure.label}: ${failure.message}`);
    }
  }

  if (failures.length) {
    // 有表没下到就不出报告：缺 sheet 的报告看起来像"这段时间没数据"，
    // 会被下游静默消费掉（MIGRATION.md R10 缺数不静默）。
    logger('');
    logger(summaryLines.join('\n'));
    const error = new Error(`${failures.length} 份表下载失败，未生成报告: ${failures.map((f) => f.label).join(', ')}`);
    error.results = results;
    error.failures = failures;
    throw error;
  }

  logger('');
  logger(summaryLines.join('\n'));

  // ----- 表格预处理：事件表那三步，跑在解析之前（用户口径 2026-10-12）-----
  //
  // **取值层必须在预处理之后** —— ctx 里的事件表行对象要能直接读到预处理追加出来的列
  // （眼下是「内网外网资产」与「遏制时长 / 识别时长 / 处置时长 / 响应时长」）。
  // 所以这几步只能在 parse* 之前落到下载件上（原地改写，见 mssw_preprocess.js）：
  //
  //   下载 -> 事件表预处理（这里）-> parse* -> createContext -> buildReport
  //
  // 表格预处理**只有这一处**：从前还有一步「告警表『主机IP』剥括号」留在合并报告时跑，
  // 2026-10-12 已删除 —— 它不影响任何取值，却让同一个「主机IP」在仓库里有两个形态。
  // 现在交付物里与取值层看到的都是平台原样（带括号那种）。
  //
  // 只下事件表（`--type event`）时跳过：没有资产表就建不出「IP -> 内网/外网」映射，
  // 而且那种跑法本来就凑不齐六份表 —— 后面 build_report.py 的「缺少 X 的下载结果」
  // 会照常报（R10 缺数不静默）。
  //
  // 预处理自己抛错（文件被占用、工作簿里已有同名 sheet）**不吞**：那是真异常，
  // 而且它一失败，取值层读到的就与「平台改了列名」长得一模一样。
  logger('');
  logger('===== 表格预处理（下载之后、解析之前）=====');
  let preprocess = null;
  if (results.event && results.asset) {
    const summary = await runPreprocess({
      assetPath: results.asset.filePath,
      eventPath: results.event.filePath
    });
    for (const line of summary.logs) logger(line);
    preprocess = {
      ran: summary.ran,
      asset: summary.asset,
      event: summary.event,
      duration: summary.duration
    };
  } else {
    const absent = ['event', 'asset']
      .filter((type) => !results[type])
      .map((type) => TYPE_LABELS[type]);
    logger(`[预处理] 跳过（这次没下到 ${absent.join('、')}）：取值层读到的表与下载件一致`);
  }

  // 合并成一份报告：每个 sheet 一个表，数据统计 sheet 保持模板原样
  logger('');
  logger('===== 合并报告 =====');
  const reportOutputDir = resolveReportOutputDir(options, mode);
  logger(`报告产物目录: ${reportOutputDir}`);
  const reportPath = path.join(reportOutputDir, generateReportFileName(options.customer, companyId));

  // 「数据统计」取值层的输入。C1 规定 ctx 只能由 createContext 拼装。
  //
  // 接上 ctx 后「数据统计」会写几类格子：
  //   · 3 个报告参数格（J1/L1/M1 = 客户名 / 报告期起 / 报告期止）—— CLI 入参直传，
  //     不依赖任何总表，与 M1 时一样现在就能写
  //   · 14 格告警定性统计（C133:I134：前七名的名称 + 占比）—— 要读告警表，
  //     所以先把下载到的中间件读成行对象喂进 ctx（R9 的 parse*，见 mssw_parser.js）
  //   · 21 格事件定性统计（C135:I137：前七名的名称 / 数量 / 占比）—— 要读事件表，
  //     同一条 parse* 链（列白名单不同，见 EVENT_TABLE_SPEC）
  //   · 7 格核心业务系统（D3/D4/D5 系统名 + D6 安全风险总数 + D7/D8/D9 各自的风险总数）——
  //     名字取 CLI 的 --business-systems；每个系统的风险总数要读资产表（业务归属 -> IP）
  //     与漏洞表/弱密码表/事件表，D6 是那三格之和（三个槽位一个不落地加）
  //     ⚠️ --business-systems 是**可选**的：没给到哪个槽位，那一槽的数字格就是 0
  //     （不记账），只有写系统名的 D3/D4/D5 空着才不写值 + 记错误（用户口径 2026-10-12）
  //   · 1 格高危可利用漏洞数（D10）—— 要读漏洞表（整张表，见 VULN_TABLE_SPEC），
  //     与 --business-systems 无关
  //   · 1 格最新漏洞影响资产数（D12）—— 同一份漏洞表，含「热点漏洞」的漏洞再按
  //     「风险资产」去重数台，同样与 --business-systems 无关
  //   · 1 格已修复漏洞数（D15）—— 还是同一份漏洞表，「处置状态」精确等于「处置完成」
  //     的行数，同样与 --business-systems 无关
  //   · 1 格受影响的最新漏洞数（D17）—— **同 D12**（投喂口径「值 = D12」），走 alias：
  //     它不读任何表，D12 算出什么它就跟什么（D12 是 0 它就是 0），所以这里没有它自己的读盘
  //   · 1 格管理员弱口令数量（D11）—— 要读资产表（重要级别 = 核心 -> 核心资产集合）
  //     与弱密码表 / 事件表，与 --business-systems 无关
  //   · 1 格威胁告警总（G5）—— 要读告警表（「GPT研判结论」精确等于「真实攻击未成功」的
  //     行数），与 --business-systems 无关
  //   · 3 格核心系统威胁告警数量（G6/H6/I6）—— 要读资产表（业务归属 -> IP）与告警表
  //     （「主机IP」落在集合里的行数），系统名与 D3/D4/D5 同取 --business-systems
  //   · 1 格处置安全事件总数（G8）—— 还是事件表，但读的是另一列：「处置状态」整格精确
  //     等于「已遏制 / 处置完成 / 已忽略」三者之一的行数，与 --business-systems 无关
  //     （与那 21 格同表不同列，所以 EVENT_TABLE_SPEC 的列白名单里两列都要有）
  //   · 1 格事件平均响应时长（G9）—— 还是事件表：在 G8 那批行之上再精确匹配
  //     「推送状态」=「已推送」，取「响应时长」列（分钟）的非空均值 ——
  //     「响应时长」与 G7 的「遏制时长」同一批、由上面的表格预处理追加，列白名单里要有它；
  //     一个样本都没有时写 **0**（用户口径「没有就写0」—— 与 G7 写空串不是同一条口径）
  //   · 1 格已处置弱口令数量（D16）—— **跨两份表、两段相加、不去重**：弱密码表里
  //     「处置状态」精确等于「处置完成」的行数 ＋ 事件表里「安全事件二级分类」含
  //     「弱口令」且「处置状态」精确等于「处置完成」的行数，与 --business-systems 无关
  //   · 1 格威胁平均遏制时间（G7）—— 还是事件表：「GPT研判结论」精确等于「真实攻击未成功」
  //     的那几行，取「遏制时长」列（分钟）的非空均值。这一列**不是平台导出的**，
  //     是上面那步表格预处理按「事件遏制时间 − 专家研判时间」追加到下载件上的 ——
  //     所以取值层读得到它（列白名单里要有它）
  //   · 1 格核心系统事件数量（G10）—— 资产表 + 事件表：**全部传入**的核心业务系统 ->
  //     资产表「所属业务」-> IP **并成一个集合**，再数事件表里「影响资产」**精确落在**
  //     该集合里的行数。与 D7/D8/D9 的事件那一段刻意不同（并集 + 一道分类筛都没有）。
  //     这两份表的列白名单里，本格要的列（「所属业务」「IP地址」「影响资产」）别处已经都要了，
  //     不额外加列
  //   · 1 格业务系统数量（G16）—— 只读资产表「所属业务」一列：把这一列的值去重成一个集合、
  //     数有几个（**整格内容算一个条目**，不按逗号拆开、不分子串；去首尾空白 + 转小写；
  //     空 / 纯空白 / 横杠占位符跳过）。与 --business-systems 无关，也不叠加报告期过滤。
  //     它的列（「所属业务」）别处已经要了，不额外加列
  //   · 2 格资产类型台数（G17 服务器 / G18 PC）—— 只读资产表「资产类型(一级)」一列：
  //     整格**精确等于**「服务器」/「终端」的行数（不含「网络设备」，也不看二级那列）。
  //     与 --business-systems 无关，也不叠加报告期过滤。⚠️ 这一列**别处都没要**
  //     —— 它必须进资产表的列白名单（ASSET_TABLE_SPEC.columns），漏了的话两格会以
  //     「资产表里找不到「资产类型(一级)」列」报错，不是安静地数出 0
  // 其余 366 格是 mode:'unresolved'，接不接 ctx 都不写（H7）。
  //
  // 读盘：告警表 + 四份总表（STATISTICS_TABLE_SPECS：资产 / 漏洞 / 弱密码 / 事件）
  // **全部无条件读**。从前资产与弱密码表「只在传了系统名时才读」，D11 立项后不能再这么省
  // —— 它没传系统名也要读那两份，按需读盘只会让 D11 拿到空 ctx。
  //
  // customer 允许为空串：只传 --customer-id 时客户名本来就没有，
  // 与其编一个名字，不如让 J1 留空 —— createContext 也会把它归一成 ''。
  if (!options.start || !options.end) {
    throw badRequest('缺少 --start / --end：报告参数格 L1/M1 要写报告期（stats/context.js 的 range 是必填）');
  }
  // 告警表为空（或压根没下到）时给空数组：G5/G6/H6/I6 都数出 0、C133:I134 的定性槽位写空串，
  // 那是「这段时间没有告警」的结论，不是缺数。
  const alarmRows = results.alarm ? await readAlarmRows(results.alarm.filePath, logger) : [];

  // 四份总表都**无条件**读一次（各 SPEC 的头注写了谁在读、列白名单为什么是并集）。
  // 某份没下到时给空数组 —— 但那只是一道兜底：真没下到时上面的 failures 分支已经抛了
  // （R10 缺数不静默），这里见到的表一律是「有行」或「0 行」，「0 行」按 0 / 空串算。
  const statsTables = {};
  for (const spec of STATISTICS_TABLE_SPECS) {
    statsTables[spec.field] = results[spec.type]
      ? await readStatisticsRows(results[spec.type].filePath, spec, logger)
      : [];
  }

  // 核心业务系统的名字取 CLI（--business-systems）；四份总表与它无关，已在上面读完。
  const businessSystems = splitList(options['business-systems']);
  // 超出三个当场报参数错，而不是让取值层丢下第四个名字：模板里只有 3 个槽位，
  // 静默丢掉的话报告看上去"正常"，但写的东西和用户给的已经不是一个东西了。
  if (businessSystems.length > MAX_CORE_SYSTEMS) {
    throw badRequest(
      `--business-systems 最多 ${MAX_CORE_SYSTEMS} 个（报告里只有核心系统1/2/3 三个槽位），`
      + `收到 ${businessSystems.length} 个: ${businessSystems.join('、')}`
    );
  }

  // 到这里四份总表与告警表都已经读到（没读到的在上面的 failures 分支抛了）。
  // 留一句「表是空的」的点名：空表在报告上就是一个 0 / 一片空格，与「数据真的没有」
  // 长得一样 —— 取值层是纯函数、不打日志，所以只能在这里说清楚哪几份这次是空的。
  const emptyTables = STATISTICS_TABLE_SPECS
    .filter((spec) => statsTables[spec.field].length === 0)
    .map((spec) => spec.label);
  if (alarmRows.length === 0) emptyTables.push(TYPE_LABELS.alarm);
  if (emptyTables.length) {
    logger(`[提示] ${emptyTables.join('、')}这次是空表（0 行）：靠它算的格子按 0 / 空串落值`
      + '（0 是结论，不是缺数）');
  }

  const statsCtx = createContext(Object.assign({
    customer: options.customer || '',
    customerId: companyId,
    range: { start: options.start, end: options.end },
    businessSystems,
    alarmRows
  }, statsTables));

  const report = await buildReport({
    templatePath: options['report-template'],
    outputPath: reportPath,
    tables: results,
    ctx: statsCtx,
    preprocess,
    beautify: !(options['no-beautify'] === true || options['no-beautify'] === 'true'),
    beautifyTheme: typeof options['beautify-theme'] === 'string' ? options['beautify-theme'] : undefined,
    logger
  });
  logger(`报告已生成: ${report.filePath}`);

  if (options['keep-intermediates'] === true || options['keep-intermediates'] === 'true') {
    logger('[清理] --keep-intermediates 已指定，保留中间文件');
  } else {
    const intermediates = [];
    for (const type of requestedTypes) {
      intermediates.push(...collectIntermediateFiles(type, results[type]));
    }
    removeIntermediates(intermediates, logger);
  }

  const payload = { results, failures, report };
  const logPath = runlog.currentPath();
  if (logPath) {
    payload.log = { path: logPath };
  }
  runlog.line(`\n===== 结果 JSON =====\n${JSON.stringify(payload, null, 2)}`);
  if (options.json === true || options.json === 'true') {
    console.log(JSON.stringify(payload, null, 2));
  }

  return payload;
}

/**
 * 失败时也要在 stdout 上留一个 JSON —— SKILL.md 的契约是「stdout 恰好一个 JSON 对象，
 * 失败看顶层 error」。以前这里只 `process.exitCode = 1` 就完了：脚本拿到的 stdout 是
 * **0 字节**，退出码还一律是 1，只能去猜 stderr（2026-10-08 实测）。
 *
 * 成功路径仍然只在 `--json` 时打 JSON（历史行为，不动）；失败路径**无条件**打 ——
 * 失败的 JSON 是排障必需品，没它就只剩人肉读日志一条路。
 *
 * 分类（code / 退出码 / hint）走 mssw_errors.classifyFailure，与 pipeline.js 同一份判据。
 */
function emitFailure(error, options, logger, extra) {
  const failure = classifyFailure(error, options);
  const payload = Object.assign({
    ok: false,
    failures: (error.failures || []).map((f) => ({ type: f.type, label: f.label, message: f.message })),
    error: { code: failure.code, message: error.message, hint: failure.hint }
  }, extra || {});
  const logPath = runlog.currentPath();
  if (logPath) {
    payload.log = { path: logPath };
  }
  const text = JSON.stringify(payload, null, 2);
  process.stdout.write(`${text}\n`);
  runlog.line(`\n===== 结果 JSON =====\n${text}`);

  logger(`失败: ${error.message}`);
  logger(`  hint: ${failure.hint}`);
  return failure.exitCode;
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));

  if (options.help === true || options.h === true) {
    printHelp();
    return;
  }

  // `--python` 进程级生效：分页导出、资产表加工、删事件行、报告美化四处都认它。
  // pipeline.js 走的是本模块的 run()（不是 main()），所以那边自己设一次。
  pythonCmd.setOverride(options.python);

  // 日志文件在这里开（--help 不留文件）。attach() 之后 stderr 上的一切自动进文件。
  // pipeline.js 是 require 本模块的 run() 而不是 main()，所以同进程不会开两份。
  const logPath = runlog.open({ entry: 'mssw_downloader' });
  runlog.attach();

  const logger = createLogger(options);
  if (logPath) {
    logger(`[log] 本次运行日志: ${logPath}`);
  }
  try {
    await run(options);
  } catch (error) {
    // 已经下到的表照样回传（失败的那一份没进报告，但别的表确实躺在磁盘上）——
    // 调用方要落盘留存时不必再从日志里扒路径。
    process.exitCode = emitFailure(error, options, logger, error.results ? { results: error.results } : null);
  }
}

if (require.main === module) {
  main();
}

module.exports = { run, resolveRequestedTypes, ALL_TABLES };
