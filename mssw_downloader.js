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
  exportMsswWeakPwdList
} = require('./mssw_client');
const { buildReport, generateReportFileName } = require('./report_writer');
const { parseTableRows } = require('./mssw_parser');
const { createContext } = require('./stats/context');
const { QUALIFICATION_COLUMN } = require('./stats/metrics/alarm');
const { BUSINESS_COLUMN, IP_COLUMN: ASSET_IP_COLUMN } = require('./stats/metrics/asset');
const { RISK_ASSET_COLUMN: VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN } = require('./stats/metrics/vuln');
const { RISK_ASSET_COLUMN: WEAKPWD_RISK_ASSET_COLUMN } = require('./stats/metrics/weakpwd');
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

// 需要 --start/--end 的表（都是按时间范围导出）；资产表/漏洞表/弱密码表是全量导出，
// 不吃时间参数。
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
  --cookie-path <path>      mssw cookie 文件或目录；**传了即本地模式**（不传则走集群）
  --type <names>            只下指定表，逗号分隔：asset | alarm | event | vuln | weakpwd
                            （别名 incident / alert / 告警 / 漏洞 / 弱密码；默认下载全部）
  --business-systems <a,b,c> 核心业务系统名，最多 3 个（逗号/顿号/分号均可，中英文不限）。
                            按顺序填「数据统计」的 D3/D4/D5，对应的风险总数填 D7/D8/D9。
                            不传则这 6 格一个都不写（模板原样保留）。
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
        `  共 ${result.total} 条（原样落盘，未加工）`
      ].join('\n')
    };
  }

  if (type === 'vuln' || type === 'weakpwd') {
    // 这两张表同源（/order/v1/vul_manage/*），都是全量导出、都不吃 --start/--end，
    // 也都没有轮询超时 —— 同步接口自己等，等的上限在 mssw_client 里
    // （MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS）。
    const result = type === 'vuln'
      ? await exportMsswVulnList(common)
      : await exportMsswWeakPwdList(common);
    return {
      result,
      summary: [
        `${TYPE_LABELS[type]}: ${result.filePath}`,
        '  全量导出（不传时间范围）',
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
 * 读**列白名单**而不是整表：告警导出没有行数上限，63 列全量回传会撞 execFile 的
 * maxBuffer。列名从 stats/metrics/alarm.js 取常量，不在这里写字面量 —— 写死的话
 * 平台改列名时，取值层和读取层会各说各话。
 *
 * 读失败**不吞**（R10 缺数不静默）：拿个空数组糊过去的话，14 格会安安静静地留空，
 * 看起来与「这段时间真的没有告警」一模一样。
 *
 * 列名对不上**不算读失败**：照常返回行对象（那些行一个都不带这个键），取值层的
 * hasOwnProperty 防线会抛错、把那 14 格记进错误列表。这里只负责把这个事实吼出来。
 */
async function readAlarmRows(filePath, logger) {
  const parsed = await parseTableRows(filePath, { columns: [QUALIFICATION_COLUMN] });

  if (parsed.missingColumns.length) {
    const preview = parsed.header.slice(0, 12).join('、');
    logger(
      `[数据统计] ⚠️ 告警表里没有「${parsed.missingColumns.join('、')}」列，`
      + `C133:I134 会留空并记进错误列表。表头共 ${parsed.header.length} 列: `
      + `${preview}${parsed.header.length > 12 ? ' …' : ''}`
    );
  }
  if (parsed.unnamedColumns) {
    logger(`[数据统计] 告警表有 ${parsed.unnamedColumns} 列表头为空（这些列无法按列名读取）`);
  }
  logger(`[数据统计] 告警表读入 ${parsed.rowCount} 行，取「${QUALIFICATION_COLUMN}」列`);
  return parsed.rows;
}

/**
 * 「核心业务系统」那 6 格（D3/D4/D5 + D7/D8/D9）里，靠总表算的三段要读的三份表。
 *
 * 与 readAlarmRows 同一套路（列白名单 + 读失败不吞 + 缺列吼一声），所以共用
 * readStatisticsRows：这几份表动辄上万行（漏洞表实测 13301 行），列白名单不是可选项。
 * 列名一律从 stats/metrics/*.js 取常量，不在这里写字面量。
 *
 * 事件表**不在这份清单里** —— 事件定性那 21 格（C135:I137）无论如何都要读它，所以
 * 它由 EVENT_TABLE_SPEC **无条件**读一次（见下），D7:D9 那段就从同一次读取里取。
 * 放进这个循环会让它在传了 --business-systems 时被读第二遍，而第二遍的列白名单里
 * 没有「GPT定性标签」，后读到的行对象会把先读到的盖掉、21 格全炸。
 *
 * 为空表示「这一份表这次没下到」（比如 --type asset）。**资产表**缺席时 D7:D9 走缺数路径
 * （业务归属 -> IP 的钥匙没了，一个值都不写并记进错误列表）；另外三份缺席时那一格
 * **把这一段当 0 加进去**、其余段照算（用户口径），代价是报告上看不出少算了一段，
 * 所以拼 ctx 时会给这三份各留一行警告日志。
 */
const CORE_SYSTEM_TABLES = [
  {
    type: 'asset',
    field: 'assetRows',
    label: '资产表',
    columns: [BUSINESS_COLUMN, ASSET_IP_COLUMN],
    affected: 'D7:D9'
  },
  {
    type: 'vuln',
    field: 'vulnRows',
    label: '漏洞表',
    columns: [VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN],
    affected: 'D7:D9'
  },
  {
    type: 'weakpwd',
    field: 'weakPwdRows',
    label: '弱密码表',
    columns: [WEAKPWD_RISK_ASSET_COLUMN],
    affected: 'D7:D9'
  }
];

/**
 * 事件表：**无条件**读一次（与告警表同理，不受 --business-systems 影响）。
 *
 * 读它的是两处，需求列不同，所以取并集一次读完（EVENT_TABLE_COLUMNS 就在
 * stats/metrics/event.js 里定义，列名只写一遍）：
 *   · 事件定性 21 格（C135:I137）要「GPT定性标签」
 *   · 核心业务系统的风险总数（D7:D9）要「影响资产」「安全事件二级分类」
 */
const EVENT_TABLE_SPEC = {
  type: 'event',
  field: 'eventRows',
  label: '事件表',
  columns: EVENT_TABLE_COLUMNS,
  affected: 'C135:I137、D7:D9'
};

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

  // 合并成一份报告：每个 sheet 一个表，数据统计 sheet 保持模板原样
  logger('');
  logger('===== 合并报告 =====');
  const reportOutputDir = resolveReportOutputDir(options, mode);
  logger(`报告产物目录: ${reportOutputDir}`);
  const reportPath = path.join(reportOutputDir, generateReportFileName(options.customer, companyId));

  // 「数据统计」取值层的输入。C1 规定 ctx 只能由 createContext 拼装。
  //
  // 接上 ctx 后「数据统计」会写四类格子：
  //   · 3 个报告参数格（J1/L1/M1 = 客户名 / 报告期起 / 报告期止）—— CLI 入参直传，
  //     不依赖任何总表，与 M1 时一样现在就能写
  //   · 14 格告警定性统计（C133:I134：前七名的名称 + 占比）—— 要读告警表，
  //     所以先把下载到的中间件读成行对象喂进 ctx（R9 的 parse*，见 mssw_parser.js）
  //   · 21 格事件定性统计（C135:I137：前七名的名称 / 数量 / 占比）—— 要读事件表，
  //     同一条 parse* 链（列白名单不同，见 EVENT_TABLE_SPEC）
  //   · 6 格核心业务系统（D3/D4/D5 系统名 + D7/D8/D9 风险总数）—— 名字取 CLI 的
  //     --business-systems；风险总数要读资产表（业务归属 -> IP）与漏洞表/弱密码表/事件表
  // 其余 385 格是 mode:'unresolved'，接不接 ctx 都不写（H7）。
  //
  // 按需读盘：告警表与事件表**一直读**（那 35 格与 --business-systems 无关），
  // 资产/漏洞/弱密码三份**只在传了系统名时才读** —— 没名字时 D3:D9 一格都不会写，
  // 先把上万行的漏洞表读一遍是白读盘。
  //
  // customer 允许为空串：只传 --customer-id 时客户名本来就没有，
  // 与其编一个名字，不如让 J1 留空 —— createContext 也会把它归一成 ''。
  if (!options.start || !options.end) {
    throw badRequest('缺少 --start / --end：报告参数格 L1/M1 要写报告期（stats/context.js 的 range 是必填）');
  }
  // 告警表没下到时不传（传空数组）：让 buildReport 去报「缺少 告警表 的下载结果」，
  // 那是这一轮真正该说的话。这里若自己抛，会把那句更有用的错误盖掉。
  const alarmRows = results.alarm ? await readAlarmRows(results.alarm.filePath, logger) : [];

  // 事件表**无条件**读（事件定性那 21 格 C135:I137 靠它，与 --business-systems 无关）。
  // 核心业务系统的 D7:D9 也从这一次读取里取，所以这里的列白名单是两处的并集
  // （EVENT_TABLE_COLUMNS）。没下到事件表时给空数组：那 21 格走缺数路径、记进错误列表。
  const eventRows = results.event
    ? await readStatisticsRows(results.event.filePath, EVENT_TABLE_SPEC, logger)
    : [];

  // 核心业务系统：名字取 CLI（--business-systems），三格风险总数要读资产/漏洞/弱密码三份总表
  // （事件表已在上面读过）。没传系统名时**一份都不读** —— D3:D9 那 6 格一格都不会写
  // （没名字就没得算），提前把漏洞表（上万行）读一遍纯属白读盘，与「只接告警表」同一个取舍。
  const businessSystems = splitList(options['business-systems']);
  const coreSystemTables = {};
  if (businessSystems.length) {
    // 超出三个当场报参数错，而不是让取值层丢下第四个名字：模板里只有 3 个槽位，
    // 静默丢掉的话报告看上去"正常"，但写的东西和用户给的已经不是一个东西了。
    if (businessSystems.length > MAX_CORE_SYSTEMS) {
      throw badRequest(
        `--business-systems 最多 ${MAX_CORE_SYSTEMS} 个（报告里只有核心系统1/2/3 三个槽位），`
        + `收到 ${businessSystems.length} 个: ${businessSystems.join('、')}`
      );
    }
    for (const spec of CORE_SYSTEM_TABLES) {
      // 这一份表没下到（如 --type asset）就跳过，交给取值层按下面的口径处理
      coreSystemTables[spec.field] = results[spec.type]
        ? await readStatisticsRows(results[spec.type].filePath, spec, logger)
        : [];
    }

    // 缺哪份表必须留声（用户口径：缺表不整格作废，该段按 0 算、其余照算）。
    // 取值层那边是纯函数、不打日志，报告落盘后又只有一个数，看不出少算了一段 ——
    // 所以「哪几份没下到」只能在这里说。
    // 分两种：三份风险表缺席 -> 那一段按 0；资产表缺席 -> 不是「少一段」，是整格算不出来。
    const zeroSegments = CORE_SYSTEM_TABLES
      .filter((spec) => spec.type !== 'asset' && !results[spec.type])
      .map((spec) => spec.label);
    if (!results.event) zeroSegments.push(EVENT_TABLE_SPEC.label);
    if (zeroSegments.length) {
      logger(`[警告] ${zeroSegments.join('、')}这次没下到：D7:D9 里对应的那一段按 0 计，`
        + '其余段照算 —— 报告上看不出这个数少算了一段，核对时请留意');
    }
    if (!results.asset) {
      logger('[警告] 资产表这次没下到：没有「业务归属 -> IP」，D7:D9 三格不写值（模板原样保留）');
    }
  }

  const statsCtx = createContext(Object.assign({
    customer: options.customer || '',
    customerId: companyId,
    range: { start: options.start, end: options.end },
    businessSystems,
    alarmRows,
    eventRows
  }, coreSystemTables));

  const report = await buildReport({
    templatePath: options['report-template'],
    outputPath: reportPath,
    tables: results,
    ctx: statsCtx,
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
