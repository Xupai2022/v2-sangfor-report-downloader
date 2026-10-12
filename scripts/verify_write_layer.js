'use strict';

/**
 * 写入层验收 —— JS 侧。
 *
 * 验收主体是 scripts/verify_write_layer.py（要拿 openpyxl 逐格读回落盘结果）。
 * 本文件只干 JS 才有的那两件事，写成子命令供 Python 回调：
 *
 *   plan registry | plan modes      打印「数据统计」的写入计划（F2 决策点的产物）
 *   plan alarm <B64 json>           同上，但先把 fixture 告警表**真读一遍**喂进 ctx
 *                                   （走生产同一条链：mssw_parser -> createContext）
 *   plan event <B64 json>           同上，读的是事件表（事件定性 C135:I137 +
 *                                   G8 处置安全事件总数）
 *   plan vuln <B64 json>            同上，读的是漏洞表（D10 高危可利用漏洞数 /
 *                                   D12 最新漏洞影响资产数 / D15 已修复漏洞数 /
 *                                   D17 = D12）
 *   plan disposed <B64 json>        同上，读的是**两份**表（弱密码表 + 事件表）：
 *                                   D16 已处置弱口令数量 = 两段之和
 *   plan core <B64 json>            同上，读的是四份总表
 *                                   （资产/漏洞/弱密码/事件）+ --business-systems
 *                                   （核心业务系统 7 格 + D10 + D12 + D15 + D17 + D11）
 *   plan verdict <B64 json>         同上，读的是告警表 + 资产表 + --business-systems
 *                                   （G5 威胁告警总 + G6/H6/I6 核心系统威胁告警数量）
 *   preprocess <B64 json>           跑一次**事件表预处理**（下载之后、解析之前那一步，
 *                                   会原地改写事件表 fixture）—— 这是 Python 侧唯一能
 *                                   触发它的路，用于【3.5】【3.7】【14】按生产的顺序造表
 *   build <B64 json>                调 report_writer.buildReport 产一份报告
 *   （不带子命令）                   验收入口，按 python_cmd 的解释器优先级拉起 Python 主体
 *
 * 为什么不能全用 Node 判：本仓库的 Excel 读写已经是 openpyxl 了，JS 侧连写一个
 * fixture xlsx 都做不到 —— 那正是这次迁移要的结果。所以"文件里到底落了什么"
 * 只能由 Python 读回来看，JS 只回答"我决定写什么"。
 */

const path = require('path');
const { execFile } = require('child_process');

const { createContext } = require('../stats/context');
const { buildStatisticsWrites } = require('../stats/write_statistics_sheet');
const { ALARM_TABLE_COLUMNS } = require('../stats/metrics/alarm');
const { BUSINESS_COLUMN, IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
        PRIMARY_ASSET_TYPE_COLUMN } = require('../stats/metrics/asset');
const { RISK_ASSET_COLUMN: VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN,
        DISPOSITION_COLUMN: VULN_DISPOSITION_COLUMN } = require('../stats/metrics/vuln');
const { RISK_ASSET_COLUMN: WEAKPWD_RISK_ASSET_COLUMN,
        WEAKPWD_TABLE_COLUMNS } = require('../stats/metrics/weakpwd');
const { EVENT_TABLE_COLUMNS } = require('../stats/metrics/event');
const { parseTableRows } = require('../mssw_parser');
const { encodePath } = require('../path_helper');
const pythonCmd = require('../python_cmd');

const PY_SCRIPT = path.join(__dirname, 'verify_write_layer.py');

/** 与 Python 主体共用的验收参数：报告期固定，跑出来的值才可比。 */
const CTX_ARGS = {
  customer: '一致验收客户',
  customerId: '10086',
  range: { start: '2026-05-12', end: '2026-05-13' }
};

/**
 * 各 mode 的假登记表（验收专用，不进 stats/cells/）。
 *
 * 每种写模式一条，地址刻意挑模板里**有旧值**的格子（D25 等），好证明 blank 真能清掉
 * 模板原值、而不只是"没写进去"。G99/G101 是**异常路径**：一条抛错、一条返回 undefined，
 * 两条都必须**什么都没写**且记进 errors（R10 / H6 禁止填 0）。
 * 注意这与「表是空的」不是一回事 —— 空表不算异常，计数格写 0、名次格写空串。
 */
const MODE_FIXTURES = [
  { addr: 'D24', label: 'x', desc: '', verify: '', compute: () => 42 },
  { addr: 'D12', label: 'x', desc: '', verify: '', compute: () => 7 },
  { addr: 'G110', alias: 'D12', label: 'x', desc: '', verify: '' },
  { addr: 'D34', label: 'x', desc: '', verify: '', mode: 'percent', compute: () => 0.8125 },
  { addr: 'D30', label: 'x', desc: '', verify: '', mode: 'literal', value: '手写' },
  { addr: 'D25', label: 'x', desc: '', verify: '', mode: 'blank' },
  { addr: 'G99', label: 'x', desc: '', verify: '', compute: () => { throw new Error('总表缺失'); } },
  { addr: 'G101', label: 'x', desc: '', verify: '', compute: () => undefined },
  { addr: 'I124', label: 'x', desc: '', verify: '', mode: 'unresolved', note: '待定' }
];

/** 把计划里的值转成可 JSON 化的形态（Date -> ISO 串），Python 侧才比得动。 */
function serializable(plan) {
  return Object.assign({}, plan, {
    writes: plan.writes.map((w) => Object.assign({}, w, {
      value: w.value instanceof Date ? w.value.toISOString() : w.value
    }))
  });
}

/**
 * 子命令参数解码：`B64:<base64>` -> 对象。
 *
 * 参数要过 base64 是因为里面带**中文路径**（fixture 目录名、客户名），
 * 与 path_helper.js 的 encodePath 同一口径（`B64:` 前缀就是它定的）。
 */
function b64decode(argument) {
  return JSON.parse(
    Buffer.from(String(argument || '').replace(/^B64:/, ''), 'base64').toString('utf8')
  );
}

/**
 * 带总表的写入计划：先把 fixture 总表**真读一遍**再算计划。
 *
 * 走的是生产路径同一条链（mssw_parser.parseTableRows -> createContext ->
 * buildStatisticsWrites），所以它同时验两件事：
 *   · 读取层真能把 xlsx 读成取值层要的行对象（键=表头文字、空值空串…）
 *   · 那几格在**有表**时会落值、在**缺列**时会记错误（表为空则按 0 / 空串落值）
 * 单独验其中任何一半都不够 —— 各自都对、接起来不匹配，正是这次"没落盘"的病根。
 *
 * 告警表（C133:I134）与事件表（C135:I137）是同一套，共用一个实现。
 * fixture 表由 Python 主体写成（JS 写不了 xlsx），路径 base64 传进来。
 *
 * @param {string} argument B64 JSON，形如 { "path": "<xlsx>", "columns": [...] }
 * @param {string} field 喂进 ctx 的字段名（alarmRows / eventRows）
 * @param {string[]} defaultColumns 没给 columns 时的列白名单 —— 取 stats/metrics 的常量，
 *   与生产同一处，不在这写第二遍字面量
 */
function planWithTable(argument, field, defaultColumns) {
  const request = b64decode(argument);
  const columns = request.columns || defaultColumns;

  return parseTableRows(request.path, { columns }).then((parsed) => {
    const ctx = createContext(Object.assign({}, CTX_ARGS, { [field]: parsed.rows }));
    const plan = serializable(buildStatisticsWrites(ctx));
    // 把解析层自己报的形状也带回去（表头全貌、缺了哪列），Python 侧一并断言
    plan.parsed = {
      sheet: parsed.sheet,
      header: parsed.header,
      rowCount: parsed.rowCount,
      missingColumns: parsed.missingColumns,
      unnamedColumns: parsed.unnamedColumns,
      rows: parsed.rows
    };
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/** 告警表版：C133:I134 那 14 格 + G5「威胁告警总」（同一张表的另一列）。 */
function planWithAlarmTable(argument) {
  return planWithTable(argument, 'alarmRows', ALARM_TABLE_COLUMNS);
}

/** 事件表版：C135:I137 那 21 格（「GPT定性标签」）+ G8「处置安全事件总数」（「处置状态」）。
 *  列白名单走 EVENT_TABLE_COLUMNS —— 与生产（mssw_downloader.js 的 EVENT_TABLE_SPEC）
 *  同一处，不在这写第二遍字面量。 */
function planWithEventTable(argument) {
  return planWithTable(argument, 'eventRows', EVENT_TABLE_COLUMNS);
}

/** 漏洞表版：D10「高危可利用漏洞数」/ D12「最新漏洞影响资产数」/ D15「已修复漏洞数」/
 *  D17（= D12，alias 不读表）。 */
function planWithVulnTable(argument) {
  return planWithTable(argument, 'vulnRows', [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN, VULN_DISPOSITION_COLUMN]);
}

/**
 * 威胁告警数量版：G5「威胁告警总」+ G6/H6/I6「核心系统威胁告警数量」。
 *
 * 这三格要两份表、一份 CLI 参数：
 *   · 告警表（G5 只靠它；G6/H6/I6 的第二段也读它）—— 列白名单走 ALARM_TABLE_COLUMNS，
 *     与生产（mssw_downloader.js 的 readAlarmRows）同一处；
 *   · 资产表（G6/H6/I6 的第一段：业务归属 -> IP）—— 与生产 ASSET_TABLE_SPEC 同一处；
 *   · --business-systems（G6/H6/I6 的系统名，与 D3/D4/D5 同源）。
 *
 * 资产表可以不给（= 资产表为空 -> G6/H6/I6 的 IP 集合是空集，四格都数出 0）：
 * 这正是「两把钥匙互不牵连」那条口径在本段的落点。
 *
 * @param {string} argument B64 JSON，形如
 *   { "alarmPath": "...", "assetPath": "...", "businessSystems": ["OA系统", "财务系统"] }
 */
function planVerdicts(argument) {
  const request = b64decode(argument);

  const alarm = parseTableRows(request.alarmPath, { columns: ALARM_TABLE_COLUMNS });
  const asset = request.assetPath
    ? parseTableRows(request.assetPath, { columns: [BUSINESS_COLUMN, IP_COLUMN] })
    : Promise.resolve(null);

  return Promise.all([alarm, asset]).then(([alarmParsed, assetParsed]) => {
    const fields = { alarmRows: alarmParsed.rows };
    if (assetParsed) fields.assetRows = assetParsed.rows;

    const ctx = createContext(Object.assign(
      {},
      CTX_ARGS,
      { businessSystems: request.businessSystems || [] },
      fields
    ));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = {
      alarm: {
        sheet: alarmParsed.sheet,
        header: alarmParsed.header,
        rowCount: alarmParsed.rowCount,
        missingColumns: alarmParsed.missingColumns,
        unnamedColumns: alarmParsed.unnamedColumns
      },
      asset: assetParsed && {
        sheet: assetParsed.sheet,
        header: assetParsed.header,
        rowCount: assetParsed.rowCount,
        missingColumns: assetParsed.missingColumns,
        unnamedColumns: assetParsed.unnamedColumns
      }
    };
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * 无条件读的四份总表（数据统计那个 sheet 的输入）：表类型 -> 列白名单。
 *
 * 列名一律取 stats/metrics/*.js 的常量 —— 与生产（mssw_downloader.js 的
 * ASSET_TABLE_SPEC / VULN_TABLE_SPEC / WEAKPWD_TABLE_SPEC / EVENT_TABLE_SPEC）同一处，
 * 不在这写第二遍字面量：验收要是用了一套自己编的列名，它证明的就不是生产能跑通。
 *
 * 四份的读法都是「有路径就读、没给路径就等于一份空表」—— createContext 会把缺席的字段
 * 归一成空数组，于是取值层看到的只有「0 行」（= 这段时间没有数据），不是什么缺数。
 * 见 readStatisticsTables。
 */
const STATISTICS_TABLES = [
  { type: 'asset', field: 'assetRows',
    columns: [BUSINESS_COLUMN, IP_COLUMN, IMPORTANT_LEVEL_COLUMN, PRIMARY_ASSET_TYPE_COLUMN] },
  { type: 'vuln', field: 'vulnRows', columns: [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN, VULN_DISPOSITION_COLUMN] },
  { type: 'weakpwd', field: 'weakPwdRows', columns: WEAKPWD_TABLE_COLUMNS },
  { type: 'event', field: 'eventRows', columns: EVENT_TABLE_COLUMNS }
];

/** plan core / build 要读的全量就是这四份。 */
const ALL_STATISTICS_TABLES = STATISTICS_TABLES;

/**
 * 把 fixture 总表读成行对象，拼成 createContext 要的片段。
 *
 * 走生产同一条链（parseTableRows -> createContext）：读取层真能把 xlsx 读成取值层要的
 * 行对象，这件事只有在整条链上才能验（各自都对、接起来不匹配，正是之前"没落盘"的病根）。
 *
 * @param {Object} paths 形如 { asset: '<xlsx>', vuln: ..., weakpwd: ..., event: ... }，
 *   给哪几份就读哪几份，没给的不进 ctx（= 这份表为空，createContext 归一成 []）
 * @param {Array} [specs] 要读哪几份表（默认全读）。build 里按"这一段该带什么"传子集
 * @returns {Promise<{fields: Object, parsed: Object}>} fields 直接并进 createContext 入参；
 *   parsed 是每份表的读取结果（表头 / 缺列 / 行数），供 Python 侧断言
 */
function readStatisticsTables(paths, specs = ALL_STATISTICS_TABLES) {
  // 必须 map 在 chosen 上，不是 specs：没给路径的那份就是一份**空表**（不进 ctx ->
  // createContext 归一成 []），照 specs 读会把 undefined 丢给 parseTableRows、直接抛
  // 「总表路径为空」，那时验到的就不是「空表按 0 / 空串落值」这条路径了。
  const chosen = specs.filter((spec) => paths && paths[spec.type]);
  return Promise.all(chosen.map((spec) => parseTableRows(paths[spec.type], { columns: spec.columns })
    .then((parsed) => ({ spec, parsed })))).then((results) => {
    const fields = {};
    const parsed = {};
    for (const { spec, parsed: one } of results) {
      fields[spec.field] = one.rows;
      parsed[spec.type] = {
        sheet: one.sheet,
        header: one.header,
        rowCount: one.rowCount,
        missingColumns: one.missingColumns,
        unnamedColumns: one.unnamedColumns
      };
    }
    return { fields, parsed };
  });
}

/**
 * 带四份总表的写入计划：验「核心业务系统那 7 格」与 D10 / D12 / D17 / D11 在**有表**时的取值。
 *
 * 与 planWithAlarmTable 同一套思路，只是表多几份、还要把 --business-systems 传进来。
 *
 * @param {string} argument B64 JSON，形如
 *   { "paths": {"asset": "...", "vuln": "...", "weakpwd": "...", "event": "..."},
 *     "businessSystems": ["OA系统", "财务系统"] }
 */
function planCoreSystems(argument) {
  const request = b64decode(argument);

  return readStatisticsTables(request.paths || {}).then(({ fields, parsed }) => {
    const ctx = createContext(Object.assign(
      {},
      CTX_ARGS,
      { businessSystems: request.businessSystems || [] },
      fields
    ));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = parsed;
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * 已处置弱口令数量（D16）版：**跨两份表** —— 弱密码表（「处置状态」精确等于
 * 「处置完成」的行数）＋ 事件表（「安全事件二级分类」含「弱口令」且「处置状态」
 * 精确等于「处置完成」的行数）。两段的判据都在 stats/metrics 里，这里只负责把
 * 两份 fixture 真读一遍喂进 ctx。
 *
 * 列白名单走 STATISTICS_TABLES 里那两条（与生产 WEAKPWD_TABLE_SPEC / EVENT_TABLE_SPEC
 * 同一处）。两份表都可以不给 —— 不给就等于空表，那一段是 0、另一段照算。
 *
 * @param {string} argument B64 JSON，形如 { "weakPwdPath": "...", "eventPath": "..." }
 */
function planDisposedWeakPwd(argument) {
  const request = b64decode(argument);
  const paths = { weakpwd: request.weakPwdPath, event: request.eventPath };
  const specs = STATISTICS_TABLES.filter((spec) => spec.type === 'weakpwd' || spec.type === 'event');

  return readStatisticsTables(paths, specs).then(({ fields, parsed }) => {
    const ctx = createContext(Object.assign({}, CTX_ARGS, fields));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = parsed;
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * 事件表预处理 —— 「下载之后、解析之前」那一步（生产的顺序，见 mssw_downloader.js）。
 *
 * 用户口径 2026-10-12：取值层必须在预处理之后。所以验收要造的是**处理过再解析**的表，
 * 顺序不能颠倒 —— 拿一份没预处理的 fixture 喂 ctx，G7 会报「找不到『遏制时长』列」，
 * 验到的就不是生产会发生的事。本子命令就是 Python 侧触发那一步的唯一入口。
 *
 * ⚠️ **事件表 fixture 会被原地改写**（追加「内网外网资产」+ 四个时长列，
 * sheet 名与其余内容不变）。所以每段验收用**独立的 fixture 目录**，不要跨段复用同一个文件。
 *
 * @param {string} argument B64 JSON，形如 { "assetPath": "...", "eventPath": "..." }
 *   （assetPath 可以不给 = 这次没有资产表：不建映射，事件表所有有 IP 的行标「不在资产表」）
 */
function runPreprocessCommand(argument) {
  const request = b64decode(argument);
  const { runPreprocess } = require('../mssw_preprocess');

  return runPreprocess({
    assetPath: request.assetPath,
    eventPath: request.eventPath
  }).then((summary) => {
    process.stdout.write(JSON.stringify(summary));
    return 0;
  });
}

function main() {
  const [command, argument, extra] = process.argv.slice(2);

  if (command === 'preprocess') {
    return runPreprocessCommand(argument);
  }

  if (command === 'plan') {
    if (argument === 'alarm') {
      return planWithAlarmTable(extra);
    }
    if (argument === 'event') {
      return planWithEventTable(extra);
    }
    if (argument === 'vuln') {
      return planWithVulnTable(extra);
    }
    if (argument === 'disposed') {
      return planDisposedWeakPwd(extra);
    }
    if (argument === 'core') {
      return planCoreSystems(extra);
    }
    if (argument === 'verdict') {
      return planVerdicts(extra);
    }
    const ctx = createContext(CTX_ARGS);
    const cells = argument === 'modes' ? MODE_FIXTURES : undefined;
    process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx, cells))));
    return 0;
  }

  if (command === 'build') {
    // 参数带 B64: 前缀（path_helper 的口径），b64decode 自己会剥前缀并解成对象
    const options = b64decode(argument);
    const { buildReport } = require('../report_writer');

    // alarmPath 给了就先读表再拼 ctx —— 这是生产路径的形态（mssw_downloader.js
    // 在 createContext 之前调 mssw_parser）。不给就是"没有总表"那条老路径。
    // eventPath 同理（事件定性那 21 格 C135:I137）；statsPaths 给的是核心业务系统那几份
    // （asset/vuln/weakpwd，也可以直接带 event）。
    const alarm = options.alarmPath
      ? parseTableRows(options.alarmPath, { columns: ALARM_TABLE_COLUMNS })
        .then((parsed) => ({ alarmRows: parsed.rows }))
      : Promise.resolve({});

    const statsPaths = Object.assign({}, options.statsPaths || {});
    if (options.eventPath) statsPaths.event = options.eventPath;
    const stats = Object.keys(statsPaths).length
      ? readStatisticsTables(statsPaths).then(({ fields }) => fields)
      : Promise.resolve({});

    const withCtx = Promise.all([alarm, stats]).then(([alarmFields, statsFields]) => createContext(
      Object.assign({}, CTX_ARGS, alarmFields, statsFields, {
        businessSystems: options.businessSystems || []
      })
    ));

    return withCtx.then((ctx) => buildReport({
      outputPath: options.outputPath,
      tables: options.tables,
      ctx,
      // 早预处理（事件表那三步）跑在解析之前，那份汇总由调用方先跑 preprocess 子命令拿到
      // 再原样传进来 —— 生产里是 mssw_downloader.js 拿 runPreprocess 的返回直接传
      // （见 report_writer.js 的 options.preprocess）。不传 = 这次没跑早预处理。
      preprocess: options.preprocess,
      beautify: options.beautify !== false,
      logger: () => {}          // 验收只看落盘结果，日志由 Python 主体按断言打印
    })).then((result) => {
      // 只回 Python 侧要断言的那几项；日志不回来（主体自己不打日志）
      process.stdout.write(JSON.stringify({
        filePath: result.filePath,
        sheets: result.sheets,
        statistics: result.statistics,
        beautify: result.beautify,
        preprocess: result.preprocess
      }));
      return 0;
    }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      return 1;
    });
  }

  // 验收入口：交给 Python 主体。
  //
  // 这里**不复用 execFilePython**：它只在跑通时把 stdout 交回来，而验收没过时最需要看
  // 的恰恰就是那份 stdout（逐条断言）。所以按 python_cmd 的说明自己写候选循环 ——
  // 解释器不写死（本地 python / 集群 python3），只有"解释器不存在"才换下一个。
  return runAcceptance();
}

/** 验收未通过（Python 侧断言挂了）的退出码。刻意避开 1，理由见下。 */
const ACCEPTANCE_FAILED = 2;

function runAcceptance() {
  const list = pythonCmd.candidates();
  const args = [PY_SCRIPT, encodePath(JSON.stringify({
    repo: path.join(__dirname, '..'),
    bridge: __filename
  }))];
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: require('../workdir').childEnv()
  };

  const attempt = (index) => new Promise((resolve, reject) => {
    const cmd = list[index];
    execFile(cmd, args, options, (error, stdout, stderr) => {
      // 退出码 2 = 断言没过（Python 侧刻意不用 1：python_cmd 把「退出码 1 且 stderr 为空」
      // 当成"解释器不存在"，用 1 会被误判成 python 不可用，转头去试 python3 再报 ENOENT）。
      if (!error || error.code === ACCEPTANCE_FAILED) {
        process.stdout.write(String(stdout || ''));
        if (stderr) process.stderr.write(String(stderr));
        resolve(error ? ACCEPTANCE_FAILED : 0);
        return;
      }

      const missing = pythonCmd.isInterpreterSpawnError(error)
        || pythonCmd.isInterpreterMissing(error.code, stderr);
      if (missing && index + 1 < list.length) {
        process.stderr.write(`[python] ${cmd} 不可用（${error.code}），改用 ${list[index + 1]} 重试 ...\n`);
        attempt(index + 1).then(resolve, reject);
        return;
      }

      // 主体崩了（不是断言没过）：把它的输出原样带出去，别只剩一句 ENOENT
      process.stdout.write(String(stdout || ''));
      reject(new Error(String(stderr || '').trim() || `${cmd} 执行失败（退出码 ${error.code}）`));
    });
  });

  return attempt(0);
}

module.exports = { CTX_ARGS, MODE_FIXTURES };

if (require.main === module) {
  Promise.resolve()
    .then(main)
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`\n验收失败: ${error.message}\n`);
      process.exitCode = 1;
    });
}
