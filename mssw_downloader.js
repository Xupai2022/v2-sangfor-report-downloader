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
 * 六份**都已接**（暴露面 2026-10-15 接入），故主脚本一次跑完就是这六个 excel。
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
  exportMsswInternetWeakPwdList,
  exportMsswExposedSurfaceList,
  fetchMsswDeviceRows,
  fetchMsswTopnDeviceInfosOnce,
  fetchMsswSrcIpGeoTopN,
  fetchMsswThreatTypeTopN,
  fetchMsswDstIpTopN,
  fetchMsswThirdPartyDeviceCount,
  fetchMsswSecurityLogCount,
  fetchMsswInterceptedOutboundCount,
  fetchMsswExternalAttackLogCount,
  fetchMsswMonthlyExternalAttackLogCounts,
  fetchMsswMonthlyMaliciousOutboundLogCounts,
  fetchMsswImportantPeriodLogCount,
  MSSW_VUL_MANAGE_TIME_RANGE_LABEL
} = require('./mssw_client');
const { buildReport, generateReportFileName } = require('./report_writer');
const { parseTableRows, parseExposedSummary } = require('./mssw_parser');
const { runPreprocess } = require('./mssw_preprocess');
const { extractVulnReport } = require('./mssw_vuln_extract');
const { createContext, UNAVAILABLE_TEXT } = require('./stats/context');
const { ALARM_TABLE_COLUMNS, GPT_VERDICT_MISSING_TEXT } = require('./stats/metrics/alarm');
const { BUSINESS_COLUMN, IP_COLUMN: ASSET_IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
        PRIMARY_ASSET_TYPE_COLUMN, INTERNET_EXPOSURE_COLUMN,
        HOSTING_STATUS_COLUMN } = require('./stats/metrics/asset');
const { RISK_ASSET_COLUMN: VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN,
        DISPOSITION_COLUMN: VULN_DISPOSITION_COLUMN,
        AF_RULE_COLUMN: VULN_AF_RULE_COLUMN,
        FIRST_FOUND_COLUMN: VULN_FIRST_FOUND_COLUMN,
        FIX_PRIORITY_COLUMN: VULN_FIX_PRIORITY_COLUMN } = require('./stats/metrics/vuln');
const { RISK_ASSET_COLUMN: WEAKPWD_RISK_ASSET_COLUMN,
        WEAKPWD_TABLE_COLUMNS } = require('./stats/metrics/weakpwd');
const { EVENT_TABLE_COLUMNS } = require('./stats/metrics/event');
// D128 求和用的 13 项子类型清单 —— 权威在 stats/metrics/exposed.js（H4），
// 这里只是传给读取层当定位清单（Python 侧不写第二份）。
const { EXPOSED_SURFACE_SUMMARY_LABELS,
        EXPOSED_HIGH_RISK_PORT_SHEET,
        EXPOSED_INTERNET_ASSET_LABELS } = require('./stats/metrics/exposed');
const { TOP_SRC_GEO_UNAVAILABLE_TEXT } = require('./stats/metrics/top_src_geo');
const { THREAT_TYPE_UNAVAILABLE_TEXT } = require('./stats/metrics/threat_type');
const { DST_IP_UNAVAILABLE_TEXT } = require('./stats/metrics/dst_ip');
const { MAX_CORE_SYSTEMS } = require('./stats/metrics/core_system');
// 重要时期（= 报告期 ∩ 法定节假日放假整段，用户口径 2026-10-14）—— D27 要在下载层
// 按段发请求，所以这里直接用取值层那一份定义（H4：切分逻辑只有 stats/periods.js 一处）。
// 月份桶（monthPeriods，用户口径 2026-10-20）同理：C71:N72 要逐月发请求，
// 切段与取值层 monthRange 共用同一条轴，所以也从这里取，别在下载层另写一份。
const { importantPeriods, monthPeriods } = require('./stats/periods');
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
  弱密码: 'weakpwd',
  // 互联网弱密码表（2026-10-19 起与内网那份分开下）。`--type 弱密码` 仍只映射到内网，
  // 但 resolveRequestedTypes 会把 weakpwd **展开成两份**，见那里的说明。
  weakpwd_internet: 'weakpwd_internet',
  weak_pwd_internet: 'weakpwd_internet',
  internet_weakpwd: 'weakpwd_internet',
  互联网弱密码: 'weakpwd_internet',
  外网弱密码: 'weakpwd_internet',
  exposed: 'exposed',
  exposed_surface: 'exposed',
  exposure: 'exposed',
  暴露面: 'exposed'
};

// 主脚本默认下载的顺序：对齐报告 sheet 顺序（资产表 → 告警表 → 事件表 → 内网/互联网漏洞表
// → 内网/互联网弱密码表 → 暴露面表）。暴露面 2026-10-15 接入，按当初的约定**追加在末尾**。
// ⚠️ vuln 在这一层仍是**一个**类型（一个下载件、一次下载）：报告里的两张 sheet 是它解包后
// 一个工作簿里的两张 sheet（见 downloadTable 的 vuln 分支），不是两次下载。
// ⚠️ 弱密码表 2026-10-19 起是**两个独立下载件**（内网 / 互联网各一套端点与请求体），
// 所以这里是两个类型；报告里也各落一张 sheet。
const ALL_TABLES = ['asset', 'alarm', 'event', 'vuln', 'weakpwd', 'weakpwd_internet', 'exposed'];

const TYPE_LABELS = {
  asset: '资产表',
  alarm: '告警表',
  event: '事件表',
  vuln: '漏洞表',
  weakpwd: '内网弱密码表',
  weakpwd_internet: '互联网弱密码表',
  exposed: '暴露面表'
};

// 缺少 --start/--end 就**不能跑**的表。事件表/告警表在此列：它们没有"全量"这个模式。
// 漏洞表/弱密码表不在此列 —— 它们按 --start/--end 取数（两张表都按「首次发现时间」圈，
// 见 mssw_client 的 MSSW_VUL_MANAGE_TIME_RANGE_LABEL），
// 但日期是可选的：不传就退化成全量导出（见 mssw_client 的 resolveVulManageTimeRangeMs）。
// 暴露面表更彻底：请求体里**根本没有时间字段**（用户口径 2026-10-15），
// 所以它连带不带 --start/--end 都一样，只下它时两个日期都可以不传。
const TIME_RANGE_TYPES = new Set(['event', 'alarm']);

function printHelp() {
  console.log(`Usage:
  node mssw_downloader.js --customer "客户名" --start YYYY-MM-DD --end YYYY-MM-DD [options]

运行模式（看有没有传 --cookie-path）:
  不传 --cookie-path   集群模式（默认）：登录态由 session-manager 代管，
                       入口域名/Host 头取 config/api_config.json。
  传 --cookie-path     本地模式：直接读该 cookie 文件（或目录里最新的 txt），
                       走 https://<域名>，行为与历史完全一致。

不带 --type 时下载全部六类总表（资产表 / 告警表 / 事件表 / 漏洞表（内网+外网）/
弱密码表（内网+互联网）/ 暴露面表），
合并成一份 {客户名}_report.xlsx 后删除下载得到的中间文件。

Options:
  --customer <name>         客户中文名（用于自动查 company_id）
  --customer-id <id>        直接指定 company_id，跳过客户名查询
  --start <YYYY-MM-DD>      时间范围起（本地 00:00:00）
  --end <YYYY-MM-DD>        时间范围止（本地 23:59:59）
                            事件表/告警表必传；漏洞表/弱密码表也认这两个值（按「首次
                            发现时间」过滤），不传则那两张表退化成全量导出；
                            暴露面表**不认**它们（那份接口没有时间参数，导当前暴露面）
  --protect-start <YYYY-MM-DD>  护网（HW）起，与 --protect-end 成对传入，闭区间。
  --protect-end <YYYY-MM-DD>    护网（HW）止。
                            这对日期只喂「数据统计」的 D130「hw 时间事件总数」（数事件表
                            「事件创建时间」落在窗口内的行）；**可选**，不传则 D130 写 0
                            （= 这次不按 HW 窗口统计）。与本处 --start / --end（报告期）
                            是两件事，互不替代。
  --cookie-path <path>      mssw cookie 文件或目录；**传了即本地模式**（不传则走集群）
  --type <names>            只下指定表，逗号分隔：
                            asset | alarm | event | vuln | weakpwd | weakpwd_internet | exposed
                            （别名 incident / alert / 告警 / 漏洞 / 弱密码 / 互联网弱密码 / 暴露面；
                            weakpwd 会**展开成内网 + 互联网两份**，只想下互联网那份用
                            weakpwd_internet；默认下载全部）
  --business-systems <a,b,c> 核心业务系统名，**可选**，最多 3 个（逗号/顿号/分号均可，中英文不限）。
                            按顺序填「数据统计」的 D3/D4/D5，各自的风险总数填 D7/D8/D9，
                            D6 是那三个数之和（三个槽位一个不落地加：少传一个，那一格就是 0，
                            所以只传 2 个时 D6 就是这 2 个之和）。
                            不传/少传：名字格 D3/D4/D5 空着的那几个不写值并记入错误列表；
                            **算出来的**格（D6:D9 / G6/H6/I6 / G10 / G14）按 0 落值（用户口径 2026-10-12）。
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
  --timeout-ms <ms>         导出任务轮询总超时，事件默认 120000 / 告警、暴露面默认 600000
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
    // 2026-10-19：用户口径「弱密码表要下两个」。`--type weakpwd` / `--type 弱密码`
    // 保留原写法但**展开成两份**（内网 + 互联网）；只想下互联网那份用
    // `--type weakpwd_internet` / `--type 互联网弱密码`。
    const expanded = mapped === 'weakpwd' ? ['weakpwd', 'weakpwd_internet'] : [mapped];
    for (const type of expanded) {
      if (!resolved.includes(type)) {
        resolved.push(type);
      }
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

  if (type === 'vuln') {
    // 漏洞表 2026-10-16 起走**异步报表**接口（与暴露面同一套端点与流程，见 mssw_client 的
    // MSSW_VULN_ASYNC_* 那一段）：建任务 -> 轮询 report_async_task -> 附件端点下载。
    // 时间范围必传（新接口的请求体里 found_time_range 是必带键），传不出就当场抛。
    const result = await exportMsswVulnList({ ...common, start: options.start, end: options.end });

    // 下到的是**压缩包**：里面是内网 / 外网两份报表，各四张 sheet，要的是最后那张完整清单。
    // 拿到之后**立刻**解包，落成一个两-sheet 的工作簿（「内网漏洞表」「互联网漏洞表」）——
    // 下游（parse_table_rows.py 取值 / build_report.py 搬表）看到的都是那个 xlsx。
    // 解包只发生在这一处（mssw_client.exportMsswVulnList 那一层一个字都不改，
    // scripts/verify_vuln_async.js 钉着「zip 字节原样落盘」）。
    // ⚠️ 用户口径 2026-10-21：**漏洞表的预处理包含删「处置完成（误报）」的行**，
    // 删行在 extractVulnReport 里、搬表之前做（用户原话「所有的漏洞操作都是等预处理后才做的」）。
    // 2026-10-16 那版「靠 fixed_status 筛、本仓不删」的口径已作废 —— 删行不再押在接口上。
    // 弱密码表那步 removeRowsByStatus 是另一条路，别混起来。
    const extracted = await extractVulnReport({ zipPath: result.filePath });
    for (const line of extracted.logs) logger(line);

    return {
      result: Object.assign({}, result, {
        // filePath 改指解包出来的那个 xlsx：它是这条链路上**唯一的漏洞表中间件**，
        // 取值层与搬表都按它走。zip 另存为 rawFilePath（与资产表 rawFilePath 的先例同款）,
        // 留着是为了「解包结果可疑时回去看原件」。
        filePath: extracted.filePath,
        rawFilePath: result.filePath,
        vulnSheets: extracted.sheets,
        extractSkipped: extracted.alreadyPresent
      }),
      summary: [
        `漏洞表: ${extracted.filePath}`,
        `  原始压缩包: ${result.filePath}`,
        `  时间范围 ${options.start} ~ ${options.end}（按「${MSSW_VUL_MANAGE_TIME_RANGE_LABEL}」过滤，`
          + `data_type=${result.dataType}）`,
        `  任务 ${result.taskId}，附件 ${result.attachmentUrl}`,
        extracted.alreadyPresent
          ? '  解包跳过（中间件已存在且两张 sheet 齐）'
          : '  ' + extracted.sheets
            .map((sheet) => `${sheet.name} ${sheet.rows} 行 × ${sheet.columns} 列`)
            .join('、'),
        '  ⚠️ 两份不合并（各自一张 sheet）；预处理已删掉「处置完成（误报）」的行'
      ].join('\n')
    };
  }

  if (type === 'weakpwd') {
    // 弱密码表走同步导出（导出前先取 custom_headers 视图配置），见 mssw_client 的
    // MSSW_VUL_MANAGE_*。别把它和漏洞表的异步报表接口混起来：两条路不同源。
    const result = await exportMsswWeakPwdList({ ...common, start: options.start, end: options.end });
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

  if (type === 'weakpwd_internet') {
    // 互联网弱密码表：导出 /order/v1/internet_vul_manage/vul_risk_export、下载
    // /order/v1/internet_vul_manage/download_file，导出前先取自己的 custom_headers。
    // 请求体与内网那份**不共用**（键集、视图配置都不同），见 mssw_client 的
    // MSSW_INTERNET_WEAKPWD_* 那一段。
    const result = await exportMsswInternetWeakPwdList({
      ...common,
      start: options.start,
      end: options.end
    });
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

  if (type === 'exposed') {
    // 暴露面表：第四种范式（异步任务 -> 轮询 report_async_task -> 附件端点下载），
    // 细节都在 mssw_client 的 MSSW_EXPOSED_SURFACE_* 那一段。
    // ⚠️ **不传 start/end**：这份表的请求体里没有时间字段（用户口径 2026-10-15）。
    // 轮询上限走 --timeout-ms（默认 600s，与告警表同量级）。
    const result = await exportMsswExposedSurfaceList({
      ...common,
      timeoutMs: options['timeout-ms'],
      pollIntervalMs: options['poll-interval-ms']
    });
    return {
      result,
      summary: [
        `暴露面表: ${result.filePath}`,
        '  当前暴露面（接口不带时间范围，--start/--end 不参与）',
        // 下载层不动这份表：删行/加列的口径一条都没投喂过，原样落盘（与告警表同款）。
        `  任务 ${result.taskId}，附件 ${result.attachmentUrl}（下载原样落盘）`
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
 * 告警定性 + GPT研判结论 + 主机IP + 访问方向），不在这里写字面量 —— 写死的话，
 * 平台改列名时，取值层和读取层会各说各话。
 *
 * 读失败**不吞**（R10 缺数不静默）：拿个空数组糊过去的话，14 格告警定性与
 * G5/G6/H6/I6 会安安静静地留空、D24 会静默数出 0，
 * 看起来与「这段时间真的没有告警」「一条外联都没有」一模一样。
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
      + `用它的格子（「告警定性」-> C133:I134，「主机IP」-> G6/H6/I6，`
      + `「访问方向」-> D24 / D21）会留空并记进错误列表；`
      + `「GPT研判结论」那一档不算错误：G5 / G6/H6/I6（与 D62）会写`
      + `「${GPT_VERDICT_MISSING_TEXT}」（有些客户的告警表本来就没有这一列）。`
      + `表头共 ${parsed.header.length} 列: `
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
 *   · K79「内网服务器资产数量」/ K80「内网MSS服务资产数」还要「互联网暴露」列
 *     （K80 另要「托管状态」列）—— 与「资产类型(一级)」一起做三条件交给行数
 *
 * ⚠️ 这里只取白名单里的列：**不在这份清单里的表头到不了 ctx.assetRows**，
 * 取值层会报「找不到某某列」。新加一格读新列时，必须同时把列名加进下面这份清单。
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
  columns: [BUSINESS_COLUMN, ASSET_IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
            PRIMARY_ASSET_TYPE_COLUMN, INTERNET_EXPOSURE_COLUMN, HOSTING_STATUS_COLUMN],
  affected: 'D6:D9、D11、G16、G17、G18、K79、K80'
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
  label: '内网弱密码表',
  columns: WEAKPWD_TABLE_COLUMNS,
  affected: 'D6:D9、D11、D16'
};

/**
 * 互联网弱密码表：与内网那份**共用 ctx.weakPwdRows**（2026-10-19 用户口径：
 * 弱密码表现在要算两个表 —— 全表口径 = 内网 + 互联网两份相加）。
 *
 * 两份表的列白名单完全一样（只需要「风险资产」「处置状态」，互联网那份 13 列里两列都有），
 * 所以这里走同一份 WEAKPWD_TABLE_COLUMNS；读盘后由 runInner 把两批行**顺序拼接**，
 * 与漏洞表「内网 + 外网」的做法一致（见 VULN_TABLE_SPEC 的同款说明）。
 *
 * ⚠️ 别把 field 改成 weakPwdInternetRows：ctx 的 TABLE_FIELDS 只认 weakPwdRows，
 * 多出来的字段会被 createContext 丢掉，D6:D9 / D11 / D16 就会静默少算一半。
 */
const WEAKPWD_INTERNET_TABLE_SPEC = {
  type: 'weakpwd_internet',
  field: 'weakPwdRows',
  label: '互联网弱密码表',
  columns: WEAKPWD_TABLE_COLUMNS,
  affected: 'D6:D9、D11、D16'
};

/**
 * 漏洞表：**无条件**读一次（与告警表、事件表同理，不受 --business-systems 影响）。
 *
 * 读它的是四处（+ 一格 alias），需求列不同，所以取并集一次读完：
 *   · D10「高危可利用漏洞数」要「威胁标签」（全表含「高可利用」的行数）
 *   · D12「最新漏洞影响资产数」要「威胁标签」+「风险资产」（全表含「热点漏洞」、
 *     再按「风险资产」去重数台）
 *   · D17「受影响的最新漏洞数」要「威胁标签」（全表含「热点漏洞」的行数 ——
 *     与 D67 同一个派生量，2026-10-22 起不再走 D12 的 alias）
 *   · D15「已修复漏洞数」要「处置状态」（全表里**包含**「处置完成」的行数，
 *     2026-10-26 改回包含判据 —— 平台带括号的四种「处置完成（已修复/已缓解/接受风险/忽略）」
 *     都算；此前几版是精确 / 前缀判据，详见 stats/metrics/vuln.js）
 *     —— **D37「已闭环漏洞数量」是 D15 的 alias**（用户口径 2026-10-13），同样自己不读表、
 *     也不占列白名单的份：它跟着 D15 走，D15 读得到它就落值、读不到它就跟着报错
 *   · 核心业务系统的风险总数（D6:D9）那一段要「威胁标签」+「风险资产」（按 IP 圈定）
 *   · C86:N88「漏洞趋势 / 剩余漏洞数量 / 已闭环漏洞数」要「发现时间（填充…粉红色…）」+「处置状态」
 *     （用户口径 2026-10-23：按报告期切月，把每个漏洞的「首次发现时间」落进对应月份；
 *     88 行再在同一批漏洞里数「处置状态」包含「处置完成」的那些，仍按这条时间轴分月。
 *     ⚠️ 平台 2026-10-29 起该列表头改名为「发现时间（填充此单元格为粉红色…）」（带换行），
 *     逐字定义在 stats/metrics/vuln.js 的 FIRST_FOUND_COLUMN）
 *
 * ⚠️ 2026-10-16 起这份表是**两份相加**：平台把漏洞表拆成内网/外网两份报表、下载产物变成
 * zip，解包后落在**一个**工作簿的两张 sheet 上（VULN_TABLE_SHEETS）。取值层的「全表」
 * 口径 = 两份相加（用户口径 2026-10-16），实现就是这里把 `sheet` 传成数组 ——
 * 逐张按**同一份**四列白名单读、行顺序拼接，所以下面这些格子一格都不用分开写。
 *
 * 表为空（0 行）就是「这段时间一条漏洞都没有」-> 给空数组：D10 / D12 / D15 / D17 各归总成 0
 * （0 是结论，不是缺数；D37 跟着它的 alias 目标 D15 落同样的 0）。
 * 取值层已经不再区分「整份没下到」与「下到了、0 行」——
 * 前者在 scripts/build_report.py 就被拦下了，整份报告不出。
 */

/**
 * 漏洞表工作簿里那两张 sheet 的名字 —— 必须与 **两处**逐字一致（跨语言，靠这条注释对上）：
 *   · scripts/extract_vuln_report.py：解包 zip 时写出的两张 sheet 名
 *   · scripts/build_report.py 的 TABLE_SHEET_NAMES['vuln']：搬进报告时按这两个名字取
 * 三处都是「内网漏洞表 / 互联网漏洞表」。改名字要三处一起改 —— 只改一处的话，
 * 取值层会报「总表里没有 sheet」，或者更糟：报告里少搬一张 sheet 而没有任何报错。
 */
const VULN_TABLE_SHEETS = ['内网漏洞表', '互联网漏洞表'];

const VULN_TABLE_SPEC = {
  type: 'vuln',
  field: 'vulnRows',
  label: '漏洞表',
  sheet: VULN_TABLE_SHEETS,
  columns: [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN, VULN_DISPOSITION_COLUMN,
            VULN_FIX_PRIORITY_COLUMN, VULN_FIRST_FOUND_COLUMN],
  affected: 'D6:D9、D10、D12、D15、D17（+ D37，走 D15 的 alias）、D83/D84/D85（修复优先级）、E83/E84/E85（+ 处置状态）、C86:N88（按月，发现时间 + 处置状态）'
};

/**
 * 互联网漏洞表那一张 sheet 的单独切片 —— D80「已闭环外网资产漏洞数」的口径源
 * （用户口径 2026-10-21：只数**互联网漏洞表**里「处置状态」含「处置完成」的行数）。
 *
 * 为什么不能直接用 ctx.vulnRows：那是内网 + 互联网两份拼起来的数组，行对象不带来源标记，
 * 拼完就分不出哪一行来自哪一张 sheet。所以同一个下载件按同一份列白名单**再读一次**、
 * 只点名「互联网漏洞表」这一张。字段走 ctx.vulnOuterRows（stats/context.js 的
 * TABLE_SHEET_FIELDS），不是新加一份总表。
 *
 * 只读「处置状态」一列：D80 不认标签、也不需要「风险资产」。
 *
 * 2026-10-26 起这份切片还给 **D129「HW及前一周已加固中高危漏洞数」** 用 ——
 * 外网那份没有「AF 防护规则」列，所以 D129 把内网 / 外网分开读、各数各的再加，
 * 外网这边只按「已修复」（处置状态包含「处置完成」）+ 发现时间判；
 * 「修复优先级」这一列仍在这里，但只为 D80 之外的其它读者保着 —— D129 不读它。
 */
const VULN_OUTER_TABLE_SPEC = {
  type: 'vuln',
  field: 'vulnOuterRows',
  label: '互联网漏洞表',
  sheet: [VULN_TABLE_SHEETS[1]],
  columns: [VULN_DISPOSITION_COLUMN, VULN_FIX_PRIORITY_COLUMN, VULN_FIRST_FOUND_COLUMN],
  affected: 'D80、D129（HW 窗口内的外网已修复行）'
};

/**
 * 内网漏洞表那一张 sheet 的单独切片 —— D14「已防护漏洞数」与 D34「高危漏洞防护率」
 * 分子的口径源（用户口径 2026-10-22：内网漏洞表里「AF 防护规则」=「有效」且
 * 「处置状态」=「处置完成（已缓解）」的行数；2026-10-26 起 D34 的分子也走这里，
 * 因为「AF 防护规则」只有内网这张表有）。
 *
 * 为什么不能直接用 ctx.vulnRows：同 VULN_OUTER_TABLE_SPEC —— 拼完的行不带来源标记。
 * 同一个下载件按本 SPEC 的列白名单**再读一次**、只点名「内网漏洞表」这一张。
 * 字段走 ctx.vulnInnerRows（stats/context.js 的 TABLE_SHEET_FIELDS）。
 *
 * 读五列：D14 自己只认「AF 防护规则」+「处置状态」，不认标签；
 * 「修复优先级」是给 D34 的分子用的 —— D34 只认「急需修复」那批行，
 * **D129 不读它**（用户口径 2026-10-26「不需要判断修复优先级」）；
 * 「风险资产」是给 C18/D18/E18 用的 —— 那三格要把 D14 这一段的行按核心系统 IP 集合
 * 再筛一遍（用户口径 2026-10-22），没有这一列就筛不了；
 * 「发现时间（填充此单元格为粉红色…）」是给 D129 的 HW 窗口用的（用户口径 2026-10-26；
 * 列名口径 2026-10-29：原来的「首次发现时间」已被平台改名成这一列）。
 * ⚠️ 「AF 防护规则」是平台新增的列，旧导出件里没有 —— 缺列时取值层抛错不写值
 * （D129 是例外：它的「已防护」在当前判据下是「已修复」的子集，缺这一列不影响计数）。
 */
const VULN_INNER_TABLE_SPEC = {
  type: 'vuln',
  field: 'vulnInnerRows',
  label: '内网漏洞表',
  sheet: [VULN_TABLE_SHEETS[0]],
  columns: [VULN_AF_RULE_COLUMN, VULN_DISPOSITION_COLUMN, VULN_RISK_ASSET_COLUMN,
            VULN_FIX_PRIORITY_COLUMN, VULN_FIRST_FOUND_COLUMN],
  affected: 'D14、D34（分子）、D129（内网那一半）、C18/D18/E18（= D13 按核心系统 IP 圈定的版本）'
};

/**
 * 事件表：**无条件**读一次（与告警表同理，不受 --business-systems 影响）。
 *
 * 读它的是十一处，需求列不同，所以取并集一次读完（EVENT_TABLE_COLUMNS 就在
 * stats/metrics/event.js 里定义，列名只写一遍）：
 *   · 事件定性 21 格（C135:I137）要「GPT定性标签」
 *   · D11「管理员弱口令数量」第二段要「影响资产」「安全事件二级分类」
 *   · 核心业务系统的风险总数（D6:D9）要「影响资产」「安全事件二级分类」
 *   · G8「处置安全事件总数」要「处置状态」
 *   · G9「事件平均响应时长」要「处置状态」「推送状态」「响应时长」—— 第一列是选行
 *     （**复用 G8 那批行**，见 stats/metrics/event.js 的 disposedEventRows），
 *     「推送状态」是平台导出的真实列，「响应时长」是预处理追加的（同 G7 的那一批）。
 *   · D35「平均分析时间」/ D36「平均响应时间」/ E49「事件平均处置时长」（用户口径 2026-10-13）
 *     要「推送状态」「识别时长」/「响应时长」/「处置时长」—— 选行只看「推送状态」
 *     **整格精确等于**「已推送」，**一道处置状态的筛都没有**（这是与 G9 的分界：
 *     推送了但还在处置中 / 待处置的行算这三格、不算 G9）。⚠️ 三个时长列都是预处理追加的，
 *     列白名单里都要有；三个列**逐列独立**，缺一列只停读它的那一格（用户口径 2026-10-12）——
 *     其中「识别时长」与「处置时长」共用被减数「事件创建时间」，那两个会一起停。
 *   · D16「已处置弱口令数量」第二段要「安全事件二级分类」「处置状态」
 *     （与 D11 读同一列、与 G8 读同一列，但条件不同：分类含「弱口令」且状态恰为
 *     「处置完成」—— 各格的判据各写在各自的 metrics 函数里）
 *   · G7「威胁平均遏制时间」要「GPT研判结论」「遏制时长」—— 前者是选行（与 G5 同一句话），
 *     后者算均值。⚠️「遏制时长」**不是平台导出的列**，是上面那步表格预处理追加到下载件上的
 *     （见 runInner 里 runPreprocess 的位置）—— 所以读事件表必须发生在预处理之后。
 *     平台改了那两个时间源列的名时，预处理凑不齐就**不追加****「遏制时长」这一条**，
 *     G7 报「找不到『遏制时长』列」不写值 + 记错误（旧版 25 列导出就是这样）。
 *     ⚠️ 但五条时长列是**逐列独立**的（用户口径 2026-10-12）：停的只有它自己那一条 ——
 *     「识别时长 / 处置时长 / 响应时长 / 闭环时长」照建照算，G9 读的「响应时长」因此照常在，
 *     本格的落空不会把 G9 一起拖下水。
 *   · G10「核心系统事件数量」要「影响资产」（「精确落在」系统 IP 并集里的行数，
 *     与 D6:D9 那一段同一列、另一套数法）
 *   · G14「核心系统威胁事件总数」也要「影响资产」（同一个并集、同一批候选行 ——
 *     G10 那一步的**子集**），另外还要「GPT研判结论」（多一道精确匹配）。两列都在本白名单里
 *   · 整表**行数**那两格（G101「xdr事件数」/ D38「威胁和事件数量」）**一个列名都不要**
 *     （见 stats/metrics/event.js 的 eventRowCount）—— 它们不在列白名单里，但在这张表
 *     "读到了 / 没读到"的影响面上：表读不到 -> 这两格也不写值。C49 走 D38 的 alias，同理。
 *
 * 表为空（0 行）时给空数组即可：绝大多数格子都是「那一段 / 那一格是 0 或空串」
 * （口径见 stats/metrics/event.js），0 / 空串是结论、不是缺数。
 */
const EVENT_TABLE_SPEC = {
  type: 'event',
  field: 'eventRows',
  label: '事件表',
  columns: EVENT_TABLE_COLUMNS,
  affected: 'C135:I137、D6:D9、D11、D16、D35、D36、D38、D49、E49、G7、G8、G9、G10、G14、G101（+ C49，走 D38 的 alias）'
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
  WEAKPWD_INTERNET_TABLE_SPEC,
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
  // spec.sheet 只有漏洞表有（一个工作簿两张 sheet，两表相加 —— 见 VULN_TABLE_SPEC 头注）；
  // 其余几份是单张表的下载件，拿掉这个键就是老路径（取第一个 worksheet）
  const parsed = await parseTableRows(filePath, { columns: spec.columns, sheet: spec.sheet });

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
 * 暴露面表「文档说明」sheet -> 汇总行对象数组（D128「暴露面数」的口径源）。
 *
 * 这份表不在 STATISTICS_TABLE_SPECS 里，因为它不是「第一行就是表头」的规整表：
 * 标题与基本信息占住上半张，汇总表从第 15 行才开始。所以单独走一个读表器
 * （mssw_parser.js 的 parseExposedSummary -> scripts/parse_exposed_summary.py），
 * 按投喂口径「逐格找子类型文字、取右侧一格」抽成 `{子类型, 总数}` 行对象。
 *
 * **失败语义与其它总表相同**（R10 缺数不静默）：文件 / sheet 不存在、一个子类型都
 * 找不到时抛错，整份报告不出 —— 不拿空数组糊过去（那会让 D128 算出 0，
 * 与"暴露面确实是 0"长得一模一样）。部分缺失不在这里抛：取值层会把那一项记进
 * D128 的错误列表，报告其余格子照常。
 *
 * @param {string} filePath 暴露面表下载件路径
 * @param {Function} logger
 * @returns {Promise<Array<{子类型: string, 总数: number}>>}
 */
async function readExposedSummaryRows(filePath, logger) {
  const parsed = await parseExposedSummary(filePath, {
    sheet: '文档说明',
    labels: EXPOSED_SURFACE_SUMMARY_LABELS
  });

  const details = [];
  if (parsed.missingLabels.length) {
    details.push(`缺 ${parsed.missingLabels.length} 项（${parsed.missingLabels.join('、')}）`);
  }
  if (parsed.duplicateLabels.length) {
    details.push(`重复 ${parsed.duplicateLabels.length} 项（${parsed.duplicateLabels.join('、')}）`);
  }
  if (parsed.invalidLabels.length) {
    details.push(`右侧不是数字 ${parsed.invalidLabels.length} 项（`
      + parsed.invalidLabels.map((item) => `${item.label}@${item.cell}=${JSON.stringify(item.value)}`)
        .join('、') + '）');
  }

  logger(`[数据统计] 暴露面表「${parsed.sheet}」读到 ${parsed.rowCount} / `
    + `${EXPOSED_SURFACE_SUMMARY_LABELS.length} 项（D128 按 13 项「总数」求和）`);
  if (details.length) {
    logger(`[数据统计] ⚠️ 暴露面汇总不完整：${details.join('；')}`
      + ' —— D128 会不写值并记进错误列表（不写部分和）');
  }
  return parsed.rows;
}

/**
 * 暴露面表「文档说明」汇总表 -> **包含匹配**的两行（I79「互联网IP数量」/ I80「互联网端口数量」）。
 *
 * 与 readExposedSummaryRows 用同一个读表器、同一张 sheet，但判据不同：
 *   · D128 那 13 项是**整格精确相等**（投喂口径 2026-10-19）；
 *   · 本函数找的是**包含**「IP资产」/「端口资产」的格子（投喂口径 2026-10-21
 *     「找包含『IP资产』的单元格右侧一个单元格的值」），同样只取右侧一格。
 *
 * 为什么单独再读一遍、不从那 13 项里拆：D128 一项缺失就整格报错，I79/I80 不该被
 * 别的项牵连；而且判据不同（精确 vs 包含），换判据要动 D128 的口径就成了一把尺子量两件事。
 *
 * ⚠️ 投喂原话写的是「高危端口&服务 sheet」，但真实下载件里这两格文字只在
 * 「文档说明」（见 stats/metrics/exposed.js 的核对说明）—— 这里按真实结构读。
 *
 * **失败语义与 D128 相同**（R10）：文件 / sheet 不存在、两项文字一个都找不到时抛错，
 * 整份报告不出；部分缺失不在这里抛，交给取值层记进 I79/I80 的错误列表。
 *
 * @param {string} filePath 暴露面表下载件路径
 * @param {Function} logger
 * @returns {Promise<Array<{子类型: string, 总数: number}>>}
 */
async function readExposedAssetCountRows(filePath, logger) {
  const parsed = await parseExposedSummary(filePath, {
    sheet: '文档说明',
    labels: EXPOSED_INTERNET_ASSET_LABELS,
    match: 'contains'
  });

  const details = [];
  if (parsed.missingLabels.length) {
    details.push(`缺 ${parsed.missingLabels.length} 项（${parsed.missingLabels.join('、')}）`);
  }
  if (parsed.duplicateLabels.length) {
    details.push(`重复 ${parsed.duplicateLabels.length} 项（${parsed.duplicateLabels.join('、')}）`);
  }
  if (parsed.invalidLabels.length) {
    details.push(`右侧不是数字 ${parsed.invalidLabels.length} 项（`
      + parsed.invalidLabels.map((item) => `${item.label}@${item.cell}=${JSON.stringify(item.value)}`)
        .join('、') + '）');
  }

  logger(`[数据统计] 暴露面表「${parsed.sheet}」按包含匹配读到 ${parsed.rowCount} / `
    + `${EXPOSED_INTERNET_ASSET_LABELS.length} 项（I79/I80 取右侧一格的值）`);
  if (details.length) {
    logger(`[数据统计] ⚠️ 互联网资产汇总不完整：${details.join('；')}`
      + ' —— 对应的 I79/I80 会不写值并记进错误列表');
  }
  return parsed.rows;
}

/**
 * 暴露面表「高危端口&服务」sheet -> 数据行对象数组（I81「暴露面风险端口数量」的口径源）。
 *
 * 与 D128 的「文档说明」不同，这张是**规整表**（第 1 行就是表头），所以走通用读表器；
 * 本格只要行数、不要任何列的值 —— 传空白名单，避免把整张表搬回内存。
 * rowCount / 行集合与报告同名 sheet **同源**（scripts/parse_table_rows.py 的
 * collect_source_rows + split_leading_blank_rows），所以数出来的行数就是报告上
 * 肉眼看到的行数：不含表头，整行没值的空行不算。
 *
 * **失败语义**：sheet 不存在 / 文件读不了 -> 抛（R10），整份报告不出；
 * 只有表头、0 行数据 -> 空数组，取值层写 0（那是结论，不是缺数）。
 *
 * @param {string} filePath 暴露面表下载件路径
 * @param {Function} logger
 * @returns {Promise<Array<Object>>}
 */
async function readExposedHighRiskPortRows(filePath, logger) {
  const parsed = await parseTableRows(filePath, {
    sheet: EXPOSED_HIGH_RISK_PORT_SHEET,
    columns: []
  });
  logger(`[数据统计] 暴露面表「${parsed.sheet}」读到 ${parsed.rowCount} 行`
    + '（I81 数行数，不含表头）');
  return parsed.rows;
}

/**
 * 设备列表接口 -> 内存行对象数组（D100/D101/D102/D104 四格的取值源）。
 *
 * **不是总表**：不落盘、没有下载件、没有 parse* 环节、报告里也没有对应的 sheet，
 * 所以这里没有 spec / 列白名单，只有一次带 cookie 与 Host 头的查询
 * （mssw_client.js 的 fetchMsswDeviceRows，全量翻页在那边做完）。
 *
 * 与 readStatisticsRows **不同**：这里**吞掉接口失败**（长期口径，用户口径 2026-10-13）——
 * 设备列表调不通**不拦整份报告**，四格写「接口不通无值」（`UNAVAILABLE_TEXT`）。
 * 所以失败时返回 `null`（ctx 里「读不到」那一档），不往上抛。
 * ⚠️ 但日志里必须留下**真实原因**：平台改了字段名这类问题不能长得像"网不通"。
 *
 * 与「0 台」分得开：空数组只在"接口成功、返回 0 台"时出现，那是结论（四格写 0）。
 *
 * 与 --start/--end 无关：设备台账是当前的接入情况，接口不带时间参数。
 */
async function readDeviceRows(ctx, logger) {
  try {
    const result = await fetchMsswDeviceRows({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      logger
    });
    logger(`[数据统计] 设备列表读入 ${result.rows.length} 台设备`
      + `（接口报的总数 ${result.total}）—— D100/D101/D102/D104 按 devType 计数`);
    return result.rows;
  } catch (error) {
    logger(`⚠️ [数据统计] 设备列表接口不通（${error.message}）`
      + `—— D100/D101/D102/D104 四格写「${UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * topn 设备台账 -> `device_infos`（F62:G66 / I62:J66 / L62:M66 三块 topn 共用一次查询）。
 *
 * 用户口径 2026-10-20：「取一次就行」。三块排行的 `device_infos` 是同一份设备清单，
 * 所以这里先问一次，把结果传给三个 fetch；那三个函数见到 `topnDeviceInfos`
 * 就不再各自问 device_list（见 mssw_client.fetchMsswTopnDeviceInfosOnce）。
 *
 * 失败语义：接口不通**不拦整份报告**，返回 `null`，三块共 30 格一起写
 * 「topn接口不通无法取值」—— 台账都没有，三个排行都没法问。日志只在这里记一次。
 * 空数组 = 接口答了、就是没有设备（照常去问三个排行，不写那句话）。
 */
async function readTopnDeviceInfos(ctx, logger) {
  try {
    return await fetchMsswTopnDeviceInfosOnce({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      logger
    });
  } catch (error) {
    logger(`⚠️ [数据统计] topn 设备台账接口不通（${error.message}）`
      + '—— F62:G66 / I62:J66 / L62:M66 共 30 格写「topn接口不通无法取值」'
      + '（不拦整份报告）');
    return null;
  }
}

/**
 * topn 源 IP 地域接口 -> 内存行对象数组（F62:G66 十格的取值源）。
 *
 * **不是总表**：不落盘、没有下载件、没有 parse* 环节、报告里也没有对应的 sheet。
 * 生产路径是 mssw_client 的 fetchMsswSrcIpGeoTopN：设备台账由 readTopnDeviceInfos
 * 取一次后经 `topnDeviceInfos` 传进来，这里只负责接住结果、把失败收成 `null`。
 *
 * 失败语义与 readDeviceRows 同一套（长期口径，用户口径 2026-10-13/19）：
 * 接口调不通**不拦整份报告**，F62:G66 十格都写「topn接口不通无法取值」
 * （`TOP_SRC_GEO_UNAVAILABLE_TEXT`，不是空串、也不是 0）。
 * ⚠️ 日志里必须留下**真实原因**：平台改字段名这类问题不能长得像"网不通"。
 *
 * 与「接口答了、0~4 行」分得开：空数组是结论，取值层把剩下的 F/G 留空。
 *
 * 报告期 = CLI 的 --start/--end，不做任何收窄（见 fetchMsswSrcIpGeoTopN）。
 */
async function readTopSrcGeoRows(ctx, logger, topnDeviceInfos) {
  try {
    const result = await fetchMsswSrcIpGeoTopN({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      topnDeviceInfos,
      logger
    });
    return result.rows;
  } catch (error) {
    logger(`⚠️ [数据统计] topn 源 IP 地域接口不通（${error.message}）`
      + `—— F62:G66 十格写「${TOP_SRC_GEO_UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * topn 威胁类型接口 -> 内存行对象数组（I62:J66 十格的取值源）。
 *
 * 与 readTopSrcGeoRows 同一套：不落盘、没有下载件、没有 parse* 环节，
 * 失败不拦整份报告 —— 十格都写「topn接口不通无法取值」。
 * 请求体与源 IP 地域那次逐字相同，只换端点（见 mssw_client.fetchMsswThreatTypeTopN）。
 *
 * 报告期 = CLI 的 --start/--end；空数组 = 接口答了 0 行（结论），
 * 取值层把剩下的 I/J 留空。
 */
async function readThreatTypeRows(ctx, logger, topnDeviceInfos) {
  try {
    const result = await fetchMsswThreatTypeTopN({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      topnDeviceInfos,
      logger
    });
    return result.rows;
  } catch (error) {
    logger(`⚠️ [数据统计] topn 威胁类型接口不通（${error.message}）`
      + `—— I62:J66 十格写「${THREAT_TYPE_UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * topn 目的 IP 接口 -> 内存行对象数组（L62:M66 十格的取值源）。
 *
 * 与另两个 topn 数据源同一套：不落盘、没有下载件、没有 parse* 环节，
 * 失败不拦整份报告 —— 十格都写「topn接口不通无法取值」。
 * 请求体与源 IP 地域那次逐字相同，只换端点、并把 ip_type 换成 dst_ip
 * （见 mssw_client.fetchMsswDstIpTopN）。
 *
 * 报告期 = CLI 的 --start/--end；空数组 = 接口答了 0 行（结论），
 * 取值层把剩下的 L/M 留空。
 */
async function readDstIpRows(ctx, logger, topnDeviceInfos) {
  try {
    const result = await fetchMsswDstIpTopN({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      topnDeviceInfos,
      logger
    });
    return result.rows;
  } catch (error) {
    logger(`⚠️ [数据统计] topn 目的 IP 接口不通（${error.message}）`
      + `—— L62:M66 十格写「${DST_IP_UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * 第三方设备列表接口 -> 第三方实例**总数**（D103 一格的取值源）。
 *
 * 与 readDeviceRows 同一套失败语义（长期口径，用户口径 2026-10-13）：接口调不通
 * **不拦整份报告**，那格写「接口不通无值」（`UNAVAILABLE_TEXT`）—— 失败时返回 `null`。
 * ⚠️ 日志里必须留下真实原因；「接口答了、0 个」走的是另一档（返回 0）。
 *
 * 与 --start/--end 无关：第三方台账是"当前的接入情况"，接口不带时间参数。
 */
async function readThirdPartyCount(ctx, logger) {
  try {
    const result = await fetchMsswThirdPartyDeviceCount({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      logger
    });
    logger(`[数据统计] 第三方设备（应用实例）接口报的总数 ${result.count}`
      + `—— D103 一格按这个总数落值（不翻页、不按行重算）`);
    return result.count;
  } catch (error) {
    logger(`⚠️ [数据统计] 第三方设备列表接口不通（${error.message}）`
      + `—— D103 写「${UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * 日志量接口 -> 报告期内的日志条数（G99「xdr日志数」的取值源）。
 *
 * 报告期**就是命令行 --start/--end**（用户口径 2026-10-13）：起 = 起始日 00:00:00、
 * 止 = 结束日 23:59:59（与事件/告警表同一把尺子，由 mssw_client 的 resolveMsswTimeRange 落）——
 * 这里只把 CLI 的两个日期原样传下去，不做任何收窄。
 *
 * 失败语义同上：接口调不通**不拦整份报告**，G99 写「接口不通无值」，失败时返回 `null`。
 * 「这段时间平台没收到日志」是另一档（接口答了、总数 0 -> 返回 0）。
 */
async function readSecurityLogCount(ctx, logger) {
  try {
    const result = await fetchMsswSecurityLogCount({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      logger
    });
    // 起止那一段由客户端自己打（它手里有那两个 epoch 秒），这里只说和式本身。
    logger(`[数据统计] 日志量（网络安全日志 ${result.network} + 终端安全日志 ${result.endpoint}）`
      + `= ${result.total} 条 —— G99 一格按这个和落值`);
    return result.total;
  } catch (error) {
    logger(`⚠️ [数据统计] 日志量接口不通（${error.message}）`
      + `—— G99 写「${UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * 日志量接口的第二问 -> 报告期内已拦截外联的条数（D23「已拦截外联次数」的取值源）。
 *
 * 与 `readSecurityLogCount`（G99）**是同一个端点上的另一次问**，差别只在每张表多带一条
 * `searchString` 过滤串（口径见 stats/metrics/security_log.js）—— 所以这里刻意**再问一次**，
 * 而不是拿 G99 的数去减：两格是两个独立的结论，各自要有自己的一份"通/不通"。
 * 报告期同样是 CLI 的 --start/--end 原样传下去（起 00:00:00 / 止 23:59:59，不做收窄）。
 *
 * 失败语义同上：接口调不通**不拦整份报告**，D23 写「接口不通无值」（`UNAVAILABLE_TEXT`），
 * 失败时返回 `null`；「这段时间一条这样的日志都没有」是另一档（接口答了、总数 0 -> 返回 0）。
 * ⚠️ 这一问失败**不影响** G99：两次调用各有各的 try/catch，一次断只让读它的那格变成
 * 「接口不通无值」，另一格照旧落值。
 */
async function readInterceptedOutboundCount(ctx, logger) {
  try {
    const result = await fetchMsswInterceptedOutboundCount({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      logger
    });
    // 起止那一段由客户端自己打（它手里有那两个 epoch 秒），这里只说和式本身。
    logger(`[数据统计] 已拦截外联（网络安全日志 ${result.network} + 终端安全日志 ${result.endpoint}）`
      + `= ${result.total} 条 —— D23 一格按这个和落值（D21 = D23 + D24）`);
    return result.total;
  } catch (error) {
    logger(`⚠️ [数据统计] 已拦截外联的日志量接口不通（${error.message}）`
      + `—— D23 / D21 写「${UNAVAILABLE_TEXT}」（不拦整份报告；G99 那一问不受影响）`);
    return null;
  }
}

/**
 * 日志量接口的**第三问** -> 报告期内外部攻击日志的条数（D61「外部攻击日志数量（XDR）」的取值源）。
 *
 * 用户口径 2026-10-17（浏览器抓包）：与 G99/D23 是**同一个端点**，但只问
 * **网络安全日志一张表**，过滤串是 `filter srcIpTag=0 AND dstIpTag=1`（外→内）。
 * 所以这里同样**再问一次**，不与 D23/G99 共用结果 —— 四格（G99/D23/D61/D27）各自有
 * 自己的一份"通/不通"。报告期沿用 CLI 的 --start/--end 原样传下去。
 *
 * 失败语义同上：接口调不通**不拦整份报告**，D61 写「接口不通无值」，失败时返回 `null`；
 * 「这段时间一条外部攻击日志都没有」是另一档（接口答了、总数 0 -> 返回 0）。
 */
async function readExternalAttackLogCount(ctx, logger) {
  try {
    const result = await fetchMsswExternalAttackLogCount({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      start: ctx.options.start,
      end: ctx.options.end,
      logger
    });
    // 起止那一段由客户端自己打（它手里有那两个 epoch 秒），这里只说最终落值。
    logger(`[数据统计] 外部攻击日志数量（网络安全日志）=${result.total} 条 —— D61 一格按这个数落值`);
    return result.total;
  } catch (error) {
    logger(`⚠️ [数据统计] 外部攻击日志量接口不通（${error.message}）`
      + `—— D61 写「${UNAVAILABLE_TEXT}」（不拦整份报告；G99/D23 那两问不受影响）`);
    return null;
  }
}

/**
 * 「外部攻击数（按月）」C71:N72 的取值源 —— 用户口径 2026-10-20：
 * 「按照输入的时间范围划分出月份，按照月份调用多次 D61 的接口条件…
 * 最多 12 个月，月份不足就留空。首尾月要限定在输入的时间范围里」。
 *
 * 所以这一块**不是读盘、也不是拿 D61 那个总数去分**，而是把报告期切成月、
 * 每个月照 D61 的接口条件**各问一次**（见 mssw_client.js 的
 * fetchMsswMonthlyExternalAttackLogCounts）：
 *   1. 报告期按 stats/periods.js 的 monthPeriods 切成 `{label, start, end}`，
 *      首月 / 末月已裁到报告期（与取值层 monthRange 共用同一条月份轴，槽位逐格对得上）；
 *   2. 逐月串行问「网络安全日志 + 外→内过滤串」的条数；
 *   3. 按月份顺序回一个**与月份桶等长**的数组给 ctx.monthlyExternalAttackCounts。
 *
 * 失败语义（与标量字段同一套三档，只是"空"的形态是数组）：
 *   · 某个月调不通 -> 那一个元素是 `null`，那一格写「接口不通无值」，**其余月份照常落值**
 *     （各月各自独立地断；客户端里逐月 try/catch，这里不再兜一道）；
 *   · 整段前置失败（读 cookie 就失败）-> 回 `null`，ctx 把每个月都当不通；
 *   · 「那个月一条外部攻击日志都没有」是另一档：接口答了、数 0 -> 元素是 0（结论）。
 * ⚠️ 报告期切月本身抛错（起止倒置 / 认不出的日期）**不在这里接**：那是参数错，
 * 与 importantPeriods 越界同一条，整份报告停，不静默空一块。
 */
async function readMonthlyExternalAttackLogCounts(ctx, logger) {
  return readMonthlyLogCounts(ctx, logger, {
    title: '外部攻击数（按月）',
    cells: 'C71:N72',
    fetch: fetchMsswMonthlyExternalAttackLogCounts
  });
}

/**
 * 「恶意外联数（按月）」C73:N73 的取值源 —— 用户口径 2026-10-20：
 * 「C73:N73是每个月的恶意外联数，一样切分月份，拿日志接口，请求体条件是
 * srcIpTag=1 AND dstIpTag=0」。
 *
 * 与 C71:N72 **完全同一套切月/落值口径**（共用 `readMonthlyLogCounts`），差别只有过滤串：
 *   · 本组：`filter srcIpTag=1 AND dstIpTag=0`（内→外）；
 *   · 上面那组：`filter srcIpTag=0 AND dstIpTag=1`（外→内）。
 * ⚠️ 与 D23「已拦截外联次数」**不是同一条**：D23 的串还带 `action = 2`（只要已拦截的），
 * 用户这次给的条件里没有那一条 —— 本组数的是全部内→外日志。也不与 D23 / D61 互相推算。
 *
 * @param {Object} ctx 同 readMonthlyExternalAttackLogCounts
 * @returns {Promise<Array<number|null>|null>} 与月份桶等长同序；元素 null = 那个月不通
 */
async function readMonthlyMaliciousOutboundLogCounts(ctx, logger) {
  return readMonthlyLogCounts(ctx, logger, {
    title: '恶意外联数（按月）',
    cells: 'C73:N73',
    fetch: fetchMsswMonthlyMaliciousOutboundLogCounts
  });
}

/**
 * 「按月各问一次」的共用读取 —— C71:N72 与 C73:N73 两份逐月序列共用这一处
 * （H4：切月、失败收档、整段兜底只有一份），差别只在过滤串与日志里的叫法。
 *
 * @param {Object} ctx 下载层 ctx（带 options / cookieInfo / platform / companyId）
 * @param {Function} logger
 * @param {{title: string, cells: string, fetch: Function}} spec
 * @returns {Promise<Array<number|null>|null>} 与月份桶等长同序；整段前置失败回 `null`
 */
async function readMonthlyLogCounts(ctx, logger, spec) {
  const months = monthPeriods(ctx.options.start, ctx.options.end);
  logger(`[数据统计] ${spec.title}共 ${months.length} 个月（`
    + `${months.map((month) => `${month.label} ${month.start}~${month.end}`).join('、')}）`
    + `—— ${spec.cells} 逐月照 D61 的接口问法各问一次`);

  try {
    const result = await spec.fetch({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      months,
      logger
    });
    if (result.segments.length !== months.length) {
      throw new Error(`${spec.title}返回 ${result.segments.length} 段，月份桶是 ${months.length} 个`);
    }
    return result.segments.map((segment) => segment.total);
  } catch (error) {
    // 整段前置失败（逐月的失败客户端已经各自收成 null 了）：每个月都按「接口不通」落格。
    logger(`⚠️ [数据统计] ${spec.title}接口不通（${error.message}）`
      + `—— ${spec.cells} 的 ${months.length} 个值格都写「${UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
}

/**
 * 重要时期日志量接口（**不是总表**）：D27「重要时期安全日志数」一格的口径源。
 *
 * 用户口径 2026-10-14：「按照日志查询接口，根据重要时间，**分段**查网络安全日志+终端
 * 安全日志，无需额外的筛选条件…**分段的结果求和**」。所以与 G99 是**同一个端点、
 * 同一批表、同一种问法**（不筛），差别只在报告期被切成了多段：
 *   1. 报告期先按 stats/periods.js 的 importantPeriods 切成重要时期段（= 报告期 ∩
 *      法定节假日放假整段，**与 --protect-start/--protect-end 无关**）；
 *   2. 逐段各问一次日志量（段内仍是"一次问两张表、相加"，见 mssw_client.js 的
 *      fetchMsswImportantPeriodLogCount）；
 *   3. 各段的数相加 = 这一格；逐段原值另给 G91:G97（该段原值 ÷ 该段天数）。
 *
 * 两种失败刻意**分两类处理**（别把它们混成一档）：
 *   · 报告期越出节假日表覆盖范围 / 起止倒置 -> importantPeriods 抛，**这里不接**，
 *     整份报告停。那是配置错（表不够用，要补 stats/holidays.js），不是"这段没有节假日"
 *     —— 静默返回空会让报告少算都不吭声（R10 / H6）。
 *   · **某一段**接口调不通 -> 不拦整份报告，D27 **整格**写「接口不通无值」，返回 `null`。
 *     ⚠️ 不写"已通的那几段之和"：那会把"少算了几段"伪装成"算完了"
 *     （同 D21 对 D23 的加法穿透口径，见 stats/metrics/security_log.js）。
 *   · 「报告期内一个节假日都没有」是第三档：返回 `{ total: 0, counts: [] }`
 *     （0 是结论），**连接口都不调**。
 *
 * @returns {Promise<{total: number, counts: number[]}|null>} total = 各段之和（D27），
 *   counts = 逐段原值、顺序与 importantPeriods 一致（G91:G97）；任一段不通时整个是 `null`
 */
async function readImportantPeriodLogCount(ctx, logger) {
  const periods = importantPeriods(ctx.options.start, ctx.options.end);

  if (periods.length === 0) {
    logger('[数据统计] 报告期内没有重要时期（与任何法定节假日都不相交）'
      + `—— D27 写 0（这是结论，不调日志量接口）`);
    return { total: 0, counts: [] };
  }

  logger(`[数据统计] 重要时期共 ${periods.length} 段（`
    + `${periods.map((period) => `${period.name} ${period.start}~${period.end}`).join('、')}）`
    + '—— D27 逐段问日志量、各段求和');

  try {
    const result = await fetchMsswImportantPeriodLogCount({
      msswCookiePath: ctx.cookieInfo.resolvedPath,
      msswBaseUrl: ctx.platform.origin,
      msswHostHeader: ctx.platform.hostHeader,
      msswRefererPath: ctx.platform.refererPath,
      customerId: ctx.companyId,
      periods,
      logger
    });
    // 逐段那几行由客户端自己打（它手里有每段的两个 epoch 秒），这里只说和式。
    logger(`[数据统计] 重要时期安全日志数（${result.segments.length} 段之和）`
      + `= ${result.total} 条 —— D27 一格按这个和落值；逐段原值给 G91:G97 算日均`);
    return { total: result.total, counts: result.segments.map((segment) => segment.total) };
  } catch (error) {
    logger(`⚠️ [数据统计] 重要时期日志量接口不通（${error.message}）`
      + `—— D27 写「${UNAVAILABLE_TEXT}」（不拦整份报告）`);
    return null;
  }
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
  if (type === 'vuln') {
    // 两个都删：解包出来的那个两-sheet 工作簿是"中间件"，zip 是它上游的中间件
    // （与资产表 rawFilePath 同款 —— 两份都是「下载/加工过程产物」，不是要交互的交付物）。
    return [result.rawFilePath, result.filePath].filter(Boolean);
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
  progress.stage('excel', '正在下载资产/告警/事件/漏洞/弱密码/暴露面总表并合并 Excel…');
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
  // （眼下是「内网外网资产」与「遏制时长 / 识别时长 / 处置时长 / 响应时长 / 闭环时长」）。
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
  //   · 1 格已修复漏洞数（D15）—— 还是同一份漏洞表，「处置状态」**包含「处置完成」**
  //     的行数（2026-10-26 改成包含；带括号的四种都算），
  //     同样与 --business-systems 无关
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
  //     一个样本都没有时写 **0**（用户口径「没有就写0」）
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
  //   · 1 格核心系统威胁事件总数（G14）—— **就在上面那一步之上**：同一个 IP 并集、同一批
  //     候选行，只多一道「GPT研判结论」精确等于「真实攻击未成功」的筛（判据与 G5/G6/H6/I6/G7
  //     同一句）。两格的关系是「G14 的候选行是 G10 那一批的子集」、G14 恒 ≤ G10，
  //     但**不是 alias**（G10 不看研判结论）。⚠️ 也别与 G6/H6/I6 混：那三格读**告警表**
  //     的「主机IP」。要的两列（「影响资产」「GPT研判结论」）本白名单里都已经有了，不额外加列
  //   · 1 格业务系统数量（G16）—— 只读资产表「所属业务」一列：把这一列的值去重成一个集合、
  //     数有几个（**整格内容算一个条目**，不按逗号拆开、不分子串；去首尾空白 + 转小写；
  //     空 / 纯空白 / 横杠占位符跳过）。与 --business-systems 无关，也不叠加报告期过滤。
  //     它的列（「所属业务」）别处已经要了，不额外加列
  //   · 2 格资产类型台数（G17 服务器 / G18 PC）—— 只读资产表「资产类型(一级)」一列：
  //     整格**精确等于**「服务器」/「终端」的行数（不含「网络设备」，也不看二级那列）。
  //     与 --business-systems 无关，也不叠加报告期过滤。⚠️ 这一列**别处都没要**
  //     —— 它必须进资产表的列白名单（ASSET_TABLE_SPEC.columns），漏了的话两格会以
  //     「资产表里找不到「资产类型(一级)」列」报错，不是安静地数出 0
  //   · 4 格接入组件数量（D100 SIP / D101 AF / D102 STA / D104 EDR，用户口径 2026-10-13）——
  //     **本仓唯一不读总表的域**：数设备列表接口返回行里 devType 落在这四个代号集合里的行数
  //     （9 / 3 / 25 / 12+37+100038+50038+100012+69，EDR 是家族 6 个代号，
  //     口径见 stats/metrics/device.js）。设备台账不落盘：接口返回的行对象直接进
  //     ctx.deviceRows，没有下载件、没有 parse*、报告里也没有对应的 sheet。
  //     与 --business-systems 无关、也不叠加报告期过滤（接口不带时间参数）；
  //     空结果（0 台）写 0，那四格都是计数格。⚠️ 这一列（devType）**不属于任何总表**，
  //     所以不用进哪份表的列白名单；它进了 ctx 契约（stats/context.js 的 SOURCE_FIELDS）
  //     ⚠️ **接口不通写「接口不通无值」**（长期口径，见 stats/context.js 的 UNAVAILABLE_TEXT）
  //     —— 这四格不拦整份报告，与四份总表"下不到就整份不出"刻意不同
  //   · 1 格第三方数量（D103，用户口径 2026-10-13）—— **也不是总表**：取第三方设备列表接口
  //     （/api/apex/thirdparty/v1/app/instance/list）报的 data.count，不翻页、不按行重算
  //     （口径见 stats/metrics/third_party.js；标量进 ctx.thirdPartyCount，
  //     见 stats/context.js 的 SCALAR_SOURCE_FIELDS）。与上面那 4 格不是同一把尺子、
  //     两个集合互不相交；与 --business-systems、--start/--end 都无关
  //     ⚠️ 接口不通同样写「接口不通无值」、不拦整份报告
  //   · 1 格xdr日志数（G99，用户口径 2026-10-13；换接口 2026-10-14）—— **也不是总表**：
  //     日志量聚合计数接口，同一端点问两次（`tableName` 分别给 network_security_log /
  //     endpoint_security_log），各取 data.total 后**两张表相加**
  //     （口径见 stats/metrics/security_log.js；标量进 ctx.securityLogCount）。
  //     报告期**就是 CLI 的 --start/--end**（起 00:00:00 / 止 23:59:59，不做"近 30 天"收窄）；
  //     与 --business-systems 无关。⚠️ 接口不通同样写「接口不通无值」、不拦整份报告
  //   · 1 格已拦截外联次数（D23，用户口径 2026-10-14）—— **与 G99 同一个端点上的第二问**：
  //     同一批表、同一段时间，每张表多一条 searchString 过滤串（网络「内→外 且已拦截」、
  //     终端「已拦截」），两张表相加（口径见 stats/metrics/security_log.js；标量进
  //     ctx.interceptedOutboundCount）。**再问一次、不拿 G99 去减**，两次各有各的 catch ——
  //     一格不通不牵连另一格；不通同样写「接口不通无值」、不拦整份报告
  //   · 1 格外联通报风险次数（D21，用户口径 2026-10-14）—— **不读盘、不调接口**：
  //     值 = D23 + D24，两个加数各走各的具名口径（H4），自己不重复任何一边的取数逻辑。
  //     ⚠️ D23 那一半「接口不通」时本格也写「接口不通无值」（穿透，不当 0 加）
  //   · 1 格恶意外联告警数（D24，用户口径 2026-10-14）—— 读**告警表**「访问方向」列，
  //     整格精确等于「内➝外」的行数（口径见 stats/metrics/alarm.js 的 outboundAlarmCount）。
  //     这一列已随 D24 加进告警表的列白名单（ALARM_TABLE_COLUMNS）。
  //     ⚠️ 匹配值是**表里实际写的那三个字**（`➝` 是 U+279D），不是口述的「内到外」——
  //     按口述去匹配会安静地数出 0
  //   · 3 格重要时期（D27「重要时期安全日志数」/ D28「重要时期告警数」/
  //     D29「重要时期事件数」，用户口径 2026-10-14）—— 三格一律以「**重要时期 = 报告期 ∩
  //     中国法定节假日放假整段**」为准（定义见 stats/periods.js 的 importantPeriods，
  //     数据 stats/holidays.js）。
  //     ⚠️ **与 --protect-start/--protect-end 无关**（用户原话「重要时期与 cli 传入的重保
  //     时间无关」；2026-10-27 起这两个参数只叫**护网时间**）—— 模板 E27 的备注 2026-10-27
  //     已由用户改成「节假日，不算护网时间」、E28/E29 的旧备注已删，模板与本仓口径一致；
  //     M3「护网时间」走 ctx.protectRange，是另一回事。「重保」在本仓专指**重要节假日**
  //     （L4:M10 重保周期清单）。
  //     · D27 **在下载层算**（下面那个 readImportantPeriodLogCount）：报告期先切成重要时期段，
  //       **逐段**问日志量（不筛，与 G99 同一个端点、同一种问法），各段相加 ->
  //       ctx.importantPeriodLogCount。报告期内无重要时期 -> 0（结论，**连接口都不调**）；
  //       某一段不通 -> **整格**「接口不通无值」（不写"已通的那几段之和"）；
  //       报告期越出节假日表覆盖 -> importantPeriods 抛错、**整份报告停**（配置错，不静默）
  //     · D28 / D29 **不调接口**，是读盘：告警表「最早发生时间」（文本）与事件表
  //       「事件创建时间」（真 datetime -> epoch 秒）落在重要时期内的行数。
  //       这两列已随本条加进 ALARM_TABLE_COLUMNS / EVENT_TABLE_COLUMNS
  //       （口径见 stats/metrics/important_period.js）
  //   · 3 格整表行数（G100 xdr告警数 = 告警表行数 / G101 xdr事件数 = 事件表行数，
  //     用户口径 2026-10-13；D38 威胁和事件数量 = 事件表行数，用户口径 2026-10-13）——
  //     **一个列名都不读**：数的是下载件里有多少行数据，
  //     所以这三格不需要往任何列白名单里加列，也是全仓唯一没有"缺列"这一档的格子
  //     （平台整份改了列名它们照常落值）。与 --business-systems 无关，也不叠加报告期过滤
  //     ⚠️ D38 与 G101 **口径逐字相同、值必然相等，却刻意不走 alias**（投喂原文
  //     「不要复用，重新查」）—— 两条各自的 compute，改一条时另一条要跟着想一遍；
  //     C49 安全事件总数才是复用方（alias 指向 D38）。
  //   · 3 格按处置状态数的事件数（G102 已处置 / G106 处置中 / G107 待处置，
  //     用户口径 2026-10-13）—— 都读事件表**同一列**「处置状态」，判据是整格精确相等；
  //     G102 的三个状态与 G8 逐字相同，所以走 alias、不重算，也没有它自己的读盘。
  //     ⚠️ G8/G102/G106/G107 是 G101 的**子集**、不是划分（处置状态为空 / 是 `-` 的行
  //     只进 G101），⚠️ 这一列别处已经要了（G8），不额外加列。
  //     ⚠️ 缺「处置状态」列 -> 这四格一起不写值 + 记错误，而 G101 / G100 照落行数
  //   · 2 格保护率常量格（D32 资产覆盖率 / D33 威胁遏制率，用户口径 2026-10-13
  //     「默认写 100%」）—— **一个数据源都不读**（报告里写的就是那个默认值）：
  //     它们不在读盘清单里、也没有列白名单要加，平台改列名 / 总表整份没下到都不影响。
  //     `mode: 'percent'` 写小数 1、写层套 `0.00%`，所以显示 100.00% / 存的是 1
  //     （常量只定义在 stats/metrics/protection.js 一处，H4）
  //   · 3 格按推送状态求时长均值（D35 平均分析时间 / D36 平均响应时间 /
  //     E49 事件平均处置时长，用户口径 2026-10-13）——
  //     事件表「推送状态」**整格精确等于**「已推送」的行，其「识别时长」/「响应时长」/
  //     「处置时长」的
  //     非空均值（分钟；口径见 stats/metrics/event.js 的 averagePushedDurationMinutes）。
  //     ⚠️ 这三格**一道处置状态的筛都没有** —— 那是与 G9 的分界：推送了但还在处置中 / 待处置
  //     的事件算这三格、不算 G9（同一份事件表上两个数一般不等，验收专门钉了这条）。
  //     ⚠️ 三个时长列都是预处理追加的（同 G7/G9 那一批），列白名单里本就要了它们；
  //     三个列**逐列独立**，缺一列只停读它的那一格（用户口径 2026-10-12）——
  //     「识别时长」与「处置时长」共用被减数「事件创建时间」，那两个会一起停。
  //     一个样本都没有（空表 / 一行都不命中 / 时长整列都空）-> 写 **0**，不报错
  //     （用户口径 2026-10-13「写 0，与 G9 同一条」）
  //     ⚠️ D49 事件平均响应时间**不在这里**：它与 D36 同值（用户口径「复用D36」），
  //     走 alias、不读盘、没有自己的 compute。
  //   · 5 格平均时长五连（G51 平均识别时长 / G52 平均响应时长 / G53 平均遏制时长 /
  //     G54 平均处置时长 / G55 平均闭环时长，用户口径 2026-10-13 **第二版**）——
  //     **整张事件表，一道筛都没有**（用户原话「不用跟推送状态挂钩，跟 alias 的不一样的」），
  //     五格各取各的时长列做非空均值；**五格各写各的 compute**
  //     （stats/metrics/event.js 的 averageEventDurationMinutes），一格都不指向别人 ——
  //     ⚠️ 与上面那三格（D35/D36/E49，只数「推送状态」=「已推送」那批）**读同一列、
  //     却不是同一个数**：两套选行，同一份表上必须不一样。同日第一版那四条 alias
  //     （G51→D35、G52→D36、G54→E49、G55→E49）已全部撤掉。
  //     五格读的都是预处理追加的时长列，五个列都在白名单里（G51/G52/G53/G54 用的列
  //     此前就有读者，「闭环时长」是随 G55 立项才补进来的，见 stats/metrics/event.js）。
  //     ⚠️ G53 与 G7 读**同一列、不是同一把尺子**：G7 认「GPT研判结论」，G53 一道筛都没有
  //     —— 同一份事件表上必须算出两个数，谁把 G53 写成 G7 的 alias 就错在这一格。
  //     ⚠️ G54 与 G55 在**任何**输入上都同值（「处置时长」与「闭环时长」同式同源、逐行恒等），
  //     却**刻意不互为 alias**：各读各的列、各写各的 compute（验收【26】造了一份两列不相等的表
  //     钉住这一点，此时 G54 = 210、G55 = 2000）。
  //     · 五个时长列同样**逐列独立**，缺一列只停读它的那一格；
  //       ⚠️ 这五格**不读「推送状态」**，缺那一列不影响它们（只有 D35/D36/E49 报缺列）；
  //       没有可平均的样本 -> 写 **0**（同上面那三格与 G9）。
  //   · 1 格已闭环漏洞数量（D37，用户口径 2026-10-13）—— **读漏洞表**，但走 alias：
  //     与 D15「已修复漏洞数」同一条口径（「处置状态」包含「处置完成」的行数），
  //     所以本格自己不读盘、没有自己的列白名单条目，跟着 D15 走（H5）。
  //     ⚠️ 投喂当天先给的是「D37 = G14 + G5」，随后改成这一条 —— 现在它与告警表、
  //     事件表都没有关系了（旧口径那条 compute 已删，不是并存的两份）。
  // 其余 323 格是 mode:'unresolved'，接不接 ctx 都不写（H7）。
  //
  // 读盘：告警表 + 四份总表（STATISTICS_TABLE_SPECS：资产 / 漏洞 / 弱密码 / 事件）
  // + 三路接口（设备列表 / 第三方设备 / 日志量——后者问**三次**：G99 不问、
  //   D23 各表带过滤串、D27 按重要时期逐段各问一次）
  // **全部无条件读**。从前资产与弱密码表「只在传了系统名时才读」，D11 立项后不能再这么省
  // —— 它没传系统名也要读那两份，按需读盘只会让 D11 拿到空 ctx。
  //
  // customer 允许为空串：只传 --customer-id 时客户名本来就没有，
  // 与其编一个名字，不如让 J1 留空 —— createContext 也会把它归一成 ''。
  if (!options.start || !options.end) {
    throw badRequest('缺少 --start / --end：报告参数格 L1/M1 要写报告期（stats/context.js 的 range 是必填）');
  }

  // 护网（HW）起止时间：只喂 D130「hw 时间事件总数」，与上面的报告期是两件事。
  // 两端必须成对 —— 只给一端时窗口说不清，当场按参数错拦住，不猜另一半；
  // 两端都不给是合法跑法（D130 那一格写 0 = 这次不按 HW 窗口统计，见 stats/metrics/important_period.js）。
  const protectStart = options['protect-start'];
  const protectEnd = options['protect-end'];
  if ((protectStart && !protectEnd) || (!protectStart && protectEnd)) {
    throw badRequest('--protect-start / --protect-end 必须成对传入（HW 起止时间）');
  }
  // 告警表为空（或压根没下到）时给空数组：G5/G6/H6/I6（与 alias 的 D62）都数出 0、
  // C133:I134 的定性槽位写空串，那是「这段时间没有告警」的结论，不是缺数。
  // ⚠️ 表里有行、却没有「GPT研判结论」列是**另一档**（用户口径 2026-10-19）：
  // 那四格写 GPT_VERDICT_MISSING_TEXT 那句结论文字，不记错误、也不填 0 —— 见 readAlarmRows 的日志。
  const alarmRows = results.alarm ? await readAlarmRows(results.alarm.filePath, logger) : [];

  // 四类总表都**无条件**读一次（各 SPEC 的头注写了谁在读、列白名单为什么是并集）。
  // 弱密码表在 STATISTICS_TABLE_SPECS 里有两项（内网 / 互联网），先按类型分行读，
  // 再按 field 拼接 —— 与漏洞表两张 sheet 合并成 vulnRows 是同一个口径。
  // 某份没下到时给空数组 —— 但那只是一道兜底：真没下到时上面的 failures 分支已经抛了
  // （R10 缺数不静默），这里见到的表一律是「有行」或「0 行」，「0 行」按 0 / 空串算。
  const statsRowsByType = {};
  for (const spec of STATISTICS_TABLE_SPECS) {
    statsRowsByType[spec.type] = results[spec.type]
      ? await readStatisticsRows(results[spec.type].filePath, spec, logger)
      : [];
  }
  const statsTables = {};
  for (const spec of STATISTICS_TABLE_SPECS) {
    statsTables[spec.field] = (statsTables[spec.field] || []).concat(statsRowsByType[spec.type]);
  }

  // 互联网漏洞表那一张 sheet 的单独切片（D80）：同一个下载件按同一份列白名单再读一次，
  // 只点名 VULN_TABLE_SHEETS[1]。不能从 statsTables.vulnRows 里拆 —— 拼完的行不带来源标记。
  // 失败语义与其它总表相同：sheet 读不出来就抛、整份报告不出（R10）。
  statsTables.vulnOuterRows = results.vuln
    ? await readStatisticsRows(results.vuln.filePath, VULN_OUTER_TABLE_SPEC, logger)
    : [];

  // 内网漏洞表那一张 sheet 的单独切片（D14）：同一个下载件按 VULN_INNER_TABLE_SPEC
  // 再读一次，只点名 VULN_TABLE_SHEETS[0]。失败语义同上：sheet 读不出来就抛、整份报告不出。
  statsTables.vulnInnerRows = results.vuln
    ? await readStatisticsRows(results.vuln.filePath, VULN_INNER_TABLE_SPEC, logger)
    : [];

  // 暴露面表（六份总表的最后一份）：D128「暴露面数」的口径源。
  // 与上面四类总表的读法不同 ——「文档说明」sheet 的表头不在第 1 行，走专用读表器
  // （见 readExposedSummaryRows 的注释）。没下到时给空数组，与其它表同一道兜底：
  // 真没下到时上面的 failures 分支已经抛了（R10），走到这里的暴露面件一定存在。
  const exposedRows = results.exposed
    ? await readExposedSummaryRows(results.exposed.filePath, logger)
    : [];

  // 同一个暴露面下载件的**第二张 sheet**「高危端口&服务」：I81「暴露面风险端口数量」
  // 数它的数据行数（不含表头）。规整表，走通用读表器（见 readExposedHighRiskPortRows）。
  const exposedHighRiskPortRows = results.exposed
    ? await readExposedHighRiskPortRows(results.exposed.filePath, logger)
    : [];

  // 同一个「文档说明」汇总表里**另外两项**（I79「互联网IP数量」/ I80「互联网端口数量」）：
  // 判据是**包含**（D128 那 13 项是精确匹配），所以按 contains 再读一遍、单独放一个字段
  // （见 readExposedAssetCountRows 的注释）。
  const exposedAssetCountRows = results.exposed
    ? await readExposedAssetCountRows(results.exposed.filePath, logger)
    : [];

  // 设备列表接口（**不是总表**）：D100/D101/D102/D104 四格（接入组件数量）的口径源。
  // 与四份总表同样"无条件取一次"，但**失败语义不同**（长期口径，用户口径 2026-10-13）：
  // 接口调不通**不拦整份报告** —— readDeviceRows 把失败收成 `null`（ctx 里「读不到」那一档），
  // 那四格写「接口不通无值」。
  // 与"0 台"分得开：空数组只在接口答了、答案是 0 台时出现，那是结论（写 0）。
  // 它不落盘（报告里没有"设备表"这个 sheet）、也没有 filePath，故不进 results。
  const deviceRows = await readDeviceRows(ctx, logger);

  // topn 三块排行（F62:G66 / I62:J66 / L62:M66）共用一份设备台账：
  // 用户口径 2026-10-20「取一次就行」。readTopnDeviceInfos 只问一次 device_list，
  // 三个 fetch 拿到 `topnDeviceInfos` 就不再各自问。
  // 台账调不通 -> 返回 null，三块共 30 格一起写「topn接口不通无法取值」，
  // 三个排行请求直接跳过（台账都没有，问了也是同样的失败），日志只记一次。
  const topnDeviceInfos = await readTopnDeviceInfos(ctx, logger);

  // topn 源 IP 地域接口（**不是总表**）：F62:G66 十格（攻击来源地域分布top5 / 攻击数量）
  // 的口径源。报告期 = CLI 的 --start/--end；失败语义同上 —— 调不通不拦整份报告，
  // readTopSrcGeoRows 把失败收成 `null`，十格写「topn接口不通无法取值」。
  // 与"接口答了、0~4 行"分得开：空数组是结论，剩下的格子留空。
  const topSrcGeoRows = topnDeviceInfos === null
    ? null
    : await readTopSrcGeoRows(ctx, logger, topnDeviceInfos);

  // topn 威胁类型接口（**不是总表**）：I62:J66 十格（攻击类型top5 / 攻击数量）的口径源。
  // 请求体与上面那次逐字相同、只换端点；失败语义也一样 —— 调不通不拦整份报告，
  // readThreatTypeRows 把失败收成 `null`，十格写「topn接口不通无法取值」。
  const threatTypeRows = topnDeviceInfos === null
    ? null
    : await readThreatTypeRows(ctx, logger, topnDeviceInfos);

  // topn 目的 IP 接口（**不是总表**）：L62:M66 十格（遭受外部攻击的主机 / 日志数量）的口径源。
  // 请求体与上面两次逐字相同、只换端点与 ip_type；失败语义也一样 ——
  // 调不通不拦整份报告，readDstIpRows 把失败收成 `null`，十格写「topn接口不通无法取值」。
  const dstIpRows = topnDeviceInfos === null
    ? null
    : await readDstIpRows(ctx, logger, topnDeviceInfos);

  // 第三方设备列表接口（**不是总表**）：D103「第三方数量」一格的口径源。
  // 与设备列表**不是同一个接口、也不是同一把尺子**（那 4 格数深信服设备的 devType 行数，
  // 本格读第三方应用实例台账报的总数 data.count），但失败语义完全一样：
  // 接口调不通不拦整份报告，readThirdPartyCount 把失败收成 `null`，D103 写「接口不通无值」。
  const thirdPartyCount = await readThirdPartyCount(ctx, logger);

  // 日志量接口（**不是总表**）：G99「xdr日志数」一格的口径源。
  // 报告期就是 CLI 的 --start/--end 原样传下去（用户口径 2026-10-13，见 readSecurityLogCount）；
  // 失败语义同上 —— 调不通写「接口不通无值」，不拦整份报告。
  const securityLogCount = await readSecurityLogCount(ctx, logger);

  // 同一个日志量端点上的**第二问**（用户口径 2026-10-14）：D23「已拦截外联次数」的口径源。
  // 与 G99 那一问同一个接口、同一段时间，每张表多带一条过滤串（网络问「内→外 且已拦截」、
  // 终端问「已拦截」），两张表相加。**刻意各问一次、各有各的 catch**：
  // 一次不通只让读它的那格写「接口不通无值」，不用一格的失败去污染另一格
  // （也不能拿 G99 的数去减 —— 两格是两个独立的结论）。
  const interceptedOutboundCount = await readInterceptedOutboundCount(ctx, logger);

  // 同一个日志量端点上的**第三问**（用户口径 2026-10-17）：D61「外部攻击日志数量（XDR）」的口径源。
  // 只问网络安全日志一张表、带「外→内」过滤串（抓包见 mssw_client.js 的 MSSW_EXTERNAL_ATTACK_FILTER）；
  // 同样**单独问、单独 catch** —— 一次不通只让 D61 写「接口不通无值」，不牵连 G99/D23。
  const externalAttackLogCount = await readExternalAttackLogCount(ctx, logger);

  // 同一个端点、同一条过滤串，但**逐月各问一次**（用户口径 2026-10-20）：
  // C71:N72「外部攻击数（按月）」的口径源。报告期先按 monthPeriods 切成月
  // （首尾月裁到报告期、最多 12 个月），逐月问、按月份顺序进 ctx。
  // 与 D61 是两个不同的问题（整段 vs 逐月），**不拿 D61 去分**；一次只影响一个月那格。
  const monthlyExternalAttackCounts = await readMonthlyExternalAttackLogCounts(ctx, logger);

  // 同一套「按月各问一次」，换过滤串（用户口径 2026-10-20）：
  // C73:N73「恶意外联数（按月）」的口径源 —— `filter srcIpTag=1 AND dstIpTag=0`（内→外）。
  // ⚠️ 与 D23「已拦截外联次数」不是同一条（D23 还带 action=2），也不与上面那组互推。
  const monthlyMaliciousOutboundCounts = await readMonthlyMaliciousOutboundLogCounts(ctx, logger);

  // 重要时期日志量接口（**不是总表**，用户口径 2026-10-14）：D27「重要时期安全日志数」的口径源，
  // 逐段原值同时给 G91:G97「日均攻击数」（用户口径 2026-10-27：该段日志量 ÷ 该段天数）。
  // 报告期先切成重要时期段（stats/periods.js 的 importantPeriods），再**逐段**问日志量、各段求和
  // —— 分段与求和都在上面那个 read 里发生（要么给 {total, counts}、要么给 `null`）。
  // 失败语义同上：某一段调不通 -> 整格写「接口不通无值」，不拦整份报告；
  // 「报告期内没有节假日」-> total 0、counts []（结论，不调接口）。报告期越界则由 importantPeriods 抛、整份停。
  const importantPeriodLogs = await readImportantPeriodLogCount(ctx, logger);
  const importantPeriodLogCount = importantPeriodLogs === null ? null : importantPeriodLogs.total;
  const importantPeriodLogCounts = importantPeriodLogs === null ? null : importantPeriodLogs.counts;

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
    .filter((spec) => statsRowsByType[spec.type].length === 0)
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
    // 护网（HW）起止时间：没传是 null（D130 那一格据此写 0 = 这次不按 HW 窗口统计），
    // 不是「空区间」—— createContext 的 normalizeRange 也把 null 原样保留。
    protectRange: protectStart ? { start: protectStart, end: protectEnd } : null,
    businessSystems,
    alarmRows,
    deviceRows,
    topSrcGeoRows,
    threatTypeRows,
    dstIpRows,
    exposedRows,
    exposedHighRiskPortRows,
    exposedAssetCountRows,
    thirdPartyCount,
    securityLogCount,
    interceptedOutboundCount,
    externalAttackLogCount,
    monthlyExternalAttackCounts,
    monthlyMaliciousOutboundCounts,
    importantPeriodLogCount,
    importantPeriodLogCounts
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
