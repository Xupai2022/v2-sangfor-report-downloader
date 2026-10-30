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
 *                                   （G100 xdr告警数 = 告警表行数；它一个列名都不读）
 *   plan event <B64 json>           同上，读的是事件表（事件定性 C135:I137 +
 *                                   G101 xdr事件数 = 事件表行数 + D38 威胁和事件数量
 *                                   = 同一份表的行数、同样一个列名都不读，与 G101 **刻意
 *                                   不互为 alias** + C49 = D38 + G8 处置安全事件总数
 *                                   + G102 = G8 + G106 处置中 + G107 待处置
 *                                   + G9 事件平均响应时长 + D35 平均分析时间
 *                                   + D36 平均响应时间 + E49 事件平均处置时长
 *                                   —— 后面这四格读的是**预处理追加**的时长列，
 *                                   所以调用方要先跑一次 preprocess 子命令
 *                                   （就地改写那份 fixture）再走这里）
 *   plan vuln <B64 json>            同上，读的是漏洞表（D10 高危可利用漏洞数 /
 *                                   D12 最新漏洞影响资产数 / D15 已修复漏洞数 /
 *                                   D17 受影响的最新漏洞数（= D67 的行数） /
 *                                   D80 已闭环外网资产漏洞数 —— 后者只数
 *                                   `request.outerPath` 点名的那张「互联网漏洞表」）
 *   plan disposed <B64 json>        同上，读的是**两份**表（弱密码表 + 事件表）：
 *                                   D16 已处置弱口令数量 = 两段之和
 *   plan core <B64 json>            同上，读的是四份总表
 *                                   （资产/漏洞/弱密码/事件）+ --business-systems
 *                                   （核心业务系统 7 格 + D10 + D12 + D15 + D17 + D11）
 *   plan devices <B64 json>         同上，投喂的是**设备列表接口的行对象**
 *                                   （D100/D101/D102/D104 四格，非总表数据源）
 *   plan interfaces <B64 json>      同上，投喂的是**四个标量接口数据源**
 *                                   （D103 第三方数量 + G99 xdr日志数 + D23 已拦截外联次数
 *                                   + D61 外部攻击日志数量）
 *   plan verdict <B64 json>         同上，读的是告警表 + 资产表 + --business-systems
 *                                   （G5 威胁告警总 + G6/H6/I6 核心系统威胁告警数量；
 *                                   D62 是 G5 的 alias，跟着落同一个值/同一句）
 *                                   —— 告警表缺「GPT研判结论」列时，这五格写
 *                                   「该客户告警表无GPT研判结论，无法计算」（用户口径 2026-10-19）
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
        PRIMARY_ASSET_TYPE_COLUMN, INTERNET_EXPOSURE_COLUMN,
        HOSTING_STATUS_COLUMN } = require('../stats/metrics/asset');
const { RISK_ASSET_COLUMN: VULN_RISK_ASSET_COLUMN, THREAT_TAG_COLUMN,
        DISPOSITION_COLUMN: VULN_DISPOSITION_COLUMN,
        FIX_PRIORITY_COLUMN: VULN_FIX_PRIORITY_COLUMN,
        FIRST_FOUND_COLUMN: VULN_FIRST_FOUND_COLUMN } = require('../stats/metrics/vuln');
const { RISK_ASSET_COLUMN: WEAKPWD_RISK_ASSET_COLUMN,
        WEAKPWD_TABLE_COLUMNS } = require('../stats/metrics/weakpwd');
const { EVENT_TABLE_COLUMNS } = require('../stats/metrics/event');
const { parseTableRows, parseExposedSummary } = require('../mssw_parser');
const { encodePayload } = require('../path_helper');
const pythonCmd = require('../python_cmd');

const PY_SCRIPT = path.join(__dirname, 'verify_write_layer.py');

/** 与 Python 主体共用的验收参数：报告期固定，跑出来的值才可比。 */
const CTX_ARGS = {
  customer: '一致验收客户',
  customerId: '10086',
  range: { start: '2026-05-12', end: '2026-05-13' },
  // D130「hw 时间事件总数」的时间窗（--protect-start / --protect-end）。
  // 验收壳默认给一段与报告期相同的 HW 窗口 —— 不给的话 D130 会按「缺 HW 时间」
  // 记 errors，而本文件绝大多数段的 ctx 都是这一份，错误列表会被它污染；
  // 默认段与报告期同区间，事件类 fixture 里落进来的行都是报告期内的，语义最省事。
  // 要验「没传 HW 时间 -> 不写值 + 记错误」的段自己覆盖 protectRange: null。
  protectRange: { start: '2026-05-12', end: '2026-05-13' }
};

/**
 * 各 mode 的假登记表（验收专用，不进 stats/cells/）。
 *
 * 每种写模式一条，地址刻意挑模板里**有旧值**的格子（D25 等），好证明 blank 真能清掉
 * 模板原值、而不只是"没写进去"。G99/G101 在这份假表里是**异常路径**：一条抛错、
 * 一条返回 undefined，两条都必须**什么都没写**且记进 errors（R10 / H6 禁止填 0）。
 * ⚠️ 这里借用的地址与**真登记表无关**：真表里 G99 是「xdr日志数」那一格、G101 是
 * 「xdr事件数」那一格（两格都正常落值 —— 见 stats/metrics/security_log.js 与
 * stats/metrics/event.js 的 eventRowCount），本文件里这两条只活在这份假表里。
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
 * 四个**标量**接口数据源字段 —— D103 第三方数量 / G99 xdr日志数 / D23 已拦截外联次数
 * （以及读 D23 的 D21）/ D61 外部攻击日志数量。生产里是 mssw_client 的
 * fetchMsswThirdPartyDeviceCount / fetchMsswSecurityLogCount /
 * fetchMsswInterceptedOutboundCount / fetchMsswExternalAttackLogCount 报的数，**没有 xlsx 可读**，
 * 所以由 Python 侧以 JSON 直接投喂。
 *
 * ⚠️ 两档分得开靠的是 `hasOwnProperty`：JSON 里显式 `null`（= 接口不通）与"键不存在"
 * （= 接口答了、一个都没有）解出来不是一个东西，所以**只在请求里真带了这个键时**
 * 才把它塞进 ctx —— 不能写成 `fields === undefined` 那种判断（那会把"没给"和
 * "给了 null"混成一档）。
 *
 * 单列一个函数是因为**两种投喂口都要用**：纯标量那份（planInterfaces）与
 * "表 + 标量"那份（D21 要同一个 ctx 里既有告警表行、又有 D23 那个数，见 planWithTable）。
 *
 * `importantPeriodLogCounts` 不是标量，但它与 `importantPeriodLogCount` **来自同一次
 * 逐段问**（前者是逐段原值、后者是各段之和，G91:G97 的日均攻击数要前者），
 * 投喂方式与标量逐字相同（同一个 hasOwnProperty 口径），所以一并放在这里转发。
 */
const SCALAR_INTERFACE_FIELDS = ['thirdPartyCount', 'securityLogCount', 'interceptedOutboundCount',
                                 'externalAttackLogCount', 'importantPeriodLogCount',
                                 'importantPeriodLogCounts'];

function scalarFieldsOf(request) {
  const fields = {};
  for (const field of SCALAR_INTERFACE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      fields[field] = request[field];
    }
  }
  return fields;
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
 *
 *   request.range 可以覆盖报告期（形如 { start: '2026-07-15', end: '2026-09-10' }）。
 *   默认用 CTX_ARGS 那个固定区间 —— 覆盖是给「月份桶」那类**按报告期切格**的口径用的
 *   （C58:N59 的槽位数与标签直接由报告期决定，只用一个 1 个月的区间没法验）。
 *   ⚠️ 不给这个键就用 CTX_ARGS.range（不是 `request.range || ...` 那种写法：
 *   这里逐键决定要不要覆盖，别把 undefined 塞进 ctx）。
 *
 *   request 里还可以**顺带**带那三个标量接口字段（scalarFieldsOf）—— 这是给
 *   "一张表 + 一个接口数"那种格子的（D21 = D23 + D24 必须同一个 ctx 里两样都有）。
 *   不带 = 那几个字段照旧归一成 0，与从前逐字一样。
 *
 *   ⚠️ request.sheet 是**显式**开关，默认不给 —— 不给就还是"读第一个 worksheet"，
 *   与本文件历史行为逐字一样（绝大多数 fixture 是单 sheet 的，早失败会一次红掉几十段）。
 *   要用两-sheet 的 fixture 就必须在这里点名，例如漏洞表 2026-10-16 起的形态
 *   （['内网漏洞表', '互联网漏洞表']）。**这条默认值不是生产口径**：生产上
 *   mssw_downloader.js 的 VULN_TABLE_SPEC.sheet 一直带着那两张的名字，
 *   ctx.vulnRows 永远是两份相加（见 stats/metrics/vuln.js 头注）。
 *   所以「某一段 plan 只看见内网」是**本验收壳的默认值**造成的，别读成口径。
 */
function planWithTable(argument, field, defaultColumns) {
  const request = b64decode(argument);
  const columns = request.columns || defaultColumns;
  const overrides = request.range ? { range: request.range } : {};
  // D130 的 HW 时间窗：`protectRange` 可以显式覆盖（含 `null` —— 验"没传 HW 时间"那一档）。
  // 用 hasOwnProperty 而不是真值判断，否则 null 会被当成"没给"、悄悄落回 CTX_ARGS 的默认窗口。
  if (Object.prototype.hasOwnProperty.call(request, 'protectRange')) {
    overrides.protectRange = request.protectRange;
  }

  return parseTableRows(request.path, { columns, sheet: request.sheet }).then((parsed) => {
    // 漏洞表那张「互联网漏洞表」的单独切片（D80 的口径源）：request.outerPath 点名时
    // 按同一份列白名单再读一次、只读 outerSheet（默认就是「互联网漏洞表」）。
    // 不给 outerPath = ctx.vulnOuterRows 归一成 []（= 0 行），与生产里「表在、0 行」同一落法。
    const outerRead = request.outerPath
      ? parseTableRows(request.outerPath, {
        columns: request.outerColumns || columns,
        sheet: request.outerSheet || '互联网漏洞表'
      })
      : Promise.resolve(null);

    return outerRead.then((outerParsed) => {
      // 漏洞表那张「内网漏洞表」的单独切片（D14 的口径源）：request.innerPath 点名时
      // 按 innerColumns 再读一次、只读 innerSheet（默认就是「内网漏洞表」）。
      // 不给 innerPath = ctx.vulnInnerRows 归一成 []（= 0 行）。
      const innerRead = request.innerPath
        ? parseTableRows(request.innerPath, {
          columns: request.innerColumns || columns,
          sheet: request.innerSheet || '内网漏洞表'
        })
        : Promise.resolve(null);

      return innerRead.then((innerParsed) => {
        const fields = { [field]: parsed.rows };
        if (outerParsed) fields.vulnOuterRows = outerParsed.rows;
        if (innerParsed) fields.vulnInnerRows = innerParsed.rows;

        const ctx = createContext(Object.assign({}, CTX_ARGS, overrides, scalarFieldsOf(request),
                                                fields));
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
        if (outerParsed) {
          plan.parsed.outer = {
            sheet: outerParsed.sheet,
            header: outerParsed.header,
            rowCount: outerParsed.rowCount,
            missingColumns: outerParsed.missingColumns,
            unnamedColumns: outerParsed.unnamedColumns,
            rows: outerParsed.rows
          };
        }
        if (innerParsed) {
          plan.parsed.inner = {
            sheet: innerParsed.sheet,
            header: innerParsed.header,
            rowCount: innerParsed.rowCount,
            missingColumns: innerParsed.missingColumns,
            unnamedColumns: innerParsed.unnamedColumns,
            rows: innerParsed.rows
          };
        }
        process.stdout.write(JSON.stringify(plan));
        return 0;
      });
    });
  });
}

/** 告警表版：C133:I134 那 14 格 + G5「威胁告警总」（同一张表的另一列）
 *  + G100「xdr告警数」（**行数** —— 与上面两处都不同，它一个列名都不读）。 */
function planWithAlarmTable(argument) {
  return planWithTable(argument, 'alarmRows', ALARM_TABLE_COLUMNS);
}

/** 事件表版：C135:I137 那 21 格（「GPT定性标签」）+ G8「处置安全事件总数」（「处置状态」）
 *  + G101「xdr事件数」（**行数**，不读列）+ G102（= G8）、G106「处置中」、G107「待处置」
 *  （后两格与 G8 读同一列、各认一个状态值）。
 *  列白名单走 EVENT_TABLE_COLUMNS —— 与生产（mssw_downloader.js 的 EVENT_TABLE_SPEC）
 *  同一处，不在这写第二遍字面量。 */
function planWithEventTable(argument) {
  return planWithTable(argument, 'eventRows', EVENT_TABLE_COLUMNS);
}

/** 漏洞表版：D10「高危可利用漏洞数」/ D12「最新漏洞影响资产数」/ D15「已修复漏洞数」/
 *  D17「受影响的最新漏洞数」（含「热点漏洞」的行数，2026-10-22 起不再 alias D12）。 */
function planWithVulnTable(argument) {
  return planWithTable(argument, 'vulnRows', [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN,
                                              VULN_DISPOSITION_COLUMN, VULN_FIX_PRIORITY_COLUMN]);
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
    ? parseTableRows(request.assetPath, {
        columns: [BUSINESS_COLUMN, IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
                  PRIMARY_ASSET_TYPE_COLUMN, INTERNET_EXPOSURE_COLUMN,
                  HOSTING_STATUS_COLUMN]
      })
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
 * 无条件读的四类总表（数据统计那个 sheet 的输入）：表类型 -> 列白名单。
 * 弱密码表有两条（内网 / 互联网），共用 weakPwdRows。
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
    columns: [BUSINESS_COLUMN, IP_COLUMN, IMPORTANT_LEVEL_COLUMN,
              PRIMARY_ASSET_TYPE_COLUMN, INTERNET_EXPOSURE_COLUMN,
              HOSTING_STATUS_COLUMN] },
  { type: 'vuln', field: 'vulnRows',
    columns: [THREAT_TAG_COLUMN, VULN_RISK_ASSET_COLUMN,
              VULN_DISPOSITION_COLUMN, VULN_FIX_PRIORITY_COLUMN,
              VULN_FIRST_FOUND_COLUMN] },
  { type: 'weakpwd', field: 'weakPwdRows', columns: WEAKPWD_TABLE_COLUMNS },
  // 2026-10-19：弱密码表两份（内网 + 互联网），共用 weakPwdRows —— 读盘后按顺序拼接，
  // 与生产（mssw_downloader.js 的 statsTables 拼装）同一口径。
  { type: 'weakpwd_internet', field: 'weakPwdRows', columns: WEAKPWD_TABLE_COLUMNS },
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
 * @param {Object} [sheetsByType] 形如 { vuln: ['内网漏洞表', '互联网漏洞表'] }：
 *   某几份要按**名字**逐张读、行顺序拼接（生产 VULN_TABLE_SPEC.sheet 的形态，
 *   见 mssw_downloader.js）。不给 = 读第一个 worksheet，与本文件历史默认值一致。
 * @returns {Promise<{fields: Object, parsed: Object}>} fields 直接并进 createContext 入参；
 *   parsed 是每份表的读取结果（表头 / 缺列 / 行数），供 Python 侧断言
 */
function readStatisticsTables(paths, specs = ALL_STATISTICS_TABLES, sheetsByType = {}) {
  // 必须 map 在 chosen 上，不是 specs：没给路径的那份就是一份**空表**（不进 ctx ->
  // createContext 归一成 []），照 specs 读会把 undefined 丢给 parseTableRows、直接抛
  // 「总表路径为空」，那时验到的就不是「空表按 0 / 空串落值」这条路径了。
  const chosen = specs.filter((spec) => paths && paths[spec.type]);
  return Promise.all(chosen.map((spec) => parseTableRows(paths[spec.type], {
    columns: spec.columns,
    sheet: sheetsByType[spec.type]
  })
    .then((parsed) => ({ spec, parsed })))).then((results) => {
    const fields = {};
    const parsed = {};
    for (const { spec, parsed: one } of results) {
      // 弱密码表两份共用 weakPwdRows：拼接而不是覆盖（生产同款）。
      fields[spec.field] = (fields[spec.field] || []).concat(one.rows);
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
    // 内网漏洞表那张 sheet 的单独切片（D14 / C18:D18 的 D14 那一段）：
    // request.innerPath 点名时按 innerColumns 再读一次、只读 innerSheet。
    // 不给 innerPath = ctx.vulnInnerRows 归一成 []（D14 与 C18/D18/E18 的那一段都是 0）。
    const innerRead = request.innerPath
      ? parseTableRows(request.innerPath, {
        columns: request.innerColumns || ['AF 防护规则', '处置状态', '风险资产'],
        sheet: request.innerSheet || '内网漏洞表'
      })
      : Promise.resolve(null);

    return innerRead.then((innerParsed) => {
      if (innerParsed) fields.vulnInnerRows = innerParsed.rows;

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
  });
}

/**
 * 已处置弱口令数量（D16）版：**跨两份表** —— 弱密码表（「处置状态」精确等于
 * 「处置完成」的行数）＋ 事件表（「安全事件二级分类」含「弱口令」且「处置状态」
 * 精确等于「处置完成」的行数）。两段的判据都在 stats/metrics 里，这里只负责把
 * 两份 fixture 真读一遍喂进 ctx。
 *
 * 列白名单走 STATISTICS_TABLES 里那三条（与生产 WEAKPWD_TABLE_SPEC /
 * WEAKPWD_INTERNET_TABLE_SPEC / EVENT_TABLE_SPEC 同一处）。三份表都可以不给 ——
 * 不给就等于空表，那一段是 0、另一段照算。
 *
 * 2026-10-19 起弱密码表是两份（内网 + 互联网）：`weakPwdPath` 给内网那份，
 * `weakPwdInternetPath` 给互联网那份，两份在 readStatisticsTables 里拼成同一个
 * `weakPwdRows`。只给内网仍能跑（互联网那份按空表算）。
 *
 * @param {string} argument B64 JSON，形如
 *   { "weakPwdPath": "...", "weakPwdInternetPath": "...", "eventPath": "..." }
 */
function planDisposedWeakPwd(argument) {
  const request = b64decode(argument);
  const paths = {
    weakpwd: request.weakPwdPath,
    weakpwd_internet: request.weakPwdInternetPath,
    event: request.eventPath
  };
  const specs = STATISTICS_TABLES.filter(
    (spec) => spec.type.startsWith('weakpwd') || spec.type === 'event'
  );

  return readStatisticsTables(paths, specs).then(({ fields, parsed }) => {
    const ctx = createContext(Object.assign({}, CTX_ARGS, fields));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = parsed;
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * 设备（接入组件）那 4 格 —— D100 / D101 / D102 / D104。
 *
 * 与别的子命令不同，这里**没有 xlsx 可读**：设备列表是 JSON 接口，不是「*表」，
 * 生产路径是 mssw_client.fetchMsswDeviceRows 把行对象数组**直接**交给 ctx
 * （stats/context.js 的 SOURCE_FIELDS）。所以这一段的行由 Python 侧以 JSON 直接投喂 ——
 * 验的是**取值层**（devType 认不认、边界怎么落），下载层的翻页 / 失败语义
 * 由 fetchMsswDeviceRows 自己那一段管，两半都不在这条链上。
 *
 * @param {string} argument B64 JSON，形如 { "deviceRows": [ { "devType": 9 }, ... ] }
 *   不给 deviceRows（或给 null）就等于接口返回 0 台 —— createContext 归一成空数组，
 *   四格都写 0（0 是结论，不是缺数）。
 *   可以顺带给 businessSystems / range 覆盖报告参数：D100/D101/D102/D104 一个都不读它们，
 *   段里正是拿这两样对撞一次（不传系统 / 换个报告期，四个数都不动）。
 */
function planDevices(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    deviceRows: request.deviceRows,
    businessSystems: request.businessSystems,
    range: request.range || CTX_ARGS.range
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * 标量接口数据源那几个格子 —— D103「第三方数量」、G99「xdr日志数」、
 * D23「已拦截外联次数」（以及读它的 D21）、D61「外部攻击日志数量」。
 *
 * 与 devices 同一形状（也没有 xlsx 可读：几个都是 JSON 接口，生产路径是
 * mssw_client.fetchMsswThirdPartyDeviceCount / fetchMsswSecurityLogCount /
 * fetchMsswInterceptedOutboundCount / fetchMsswExternalAttackLogCount 把**标量**直接交给 ctx，
 * 见 stats/context.js 的 SCALAR_SOURCE_FIELDS），所以同样由 Python 侧
 * 以 JSON 直接投喂 —— 验的是取值层，下载层的失败语义由客户端那几个函数自己管。
 *
 * ⚠️ G99 与 D23 在**生产**里是同一个端点的两次问（第三次问是 D61；差别只在 searchString），
 * 但在这里它们是**两个各自独立的 ctx 字段**：验收正是要能一格通一格不通地喂，
 * 好证"一次失败不牵连另一格"。合并成一个字段就验不出这条了。
 *
 * @param {string} argument B64 JSON，形如
 *   { "thirdPartyCount": 7, "securityLogCount": 2815, "interceptedOutboundCount": 3,
 *     "externalAttackLogCount": 154, "businessSystems": [...], "range": {start,end} }
 *   不给某个字段 = createContext 归一成 0（= 接口答了、0 个）；
 *   显式给 `null` = 接口不通那一档（读它的格子写「接口不通无值」）。
 *   带键 / 不带键的分档见 scalarFieldsOf。
 */
function planInterfaces(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, scalarFieldsOf(request), {
    businessSystems: request.businessSystems,
    range: request.range || CTX_ARGS.range
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * C71:N72「外部攻击数（按月）」+ C73:N73「恶意外联数（按月）」—— 逐月序列
 * （stats/context.js 的 SERIES_SOURCE_FIELDS），不是标量也不是总表：生产里是
 * mssw_client.fetchMsswMonthlyExternalAttackLogCounts /
 * fetchMsswMonthlyMaliciousOutboundLogCounts **逐月**问出来的数组
 * （首尾月已裁到报告期，见 stats/periods.js 的 monthPeriods）。
 *
 * 两组共用这一条命令：Python 侧要验哪一组就投喂哪个字段（也可以两组一起给）。
 *
 * 所以由 Python 侧以 JSON 直接投喂 `monthlyExternalAttackCounts` /
 * `monthlyMaliciousOutboundCounts`，验的是取值层：
 *   · 数组 -> 逐月落标签 + 值（长度必须等于报告期月份数）
 *   · 元素 `null` -> 那一格写「接口不通无值」，其余月份照落
 *   · 整个字段 `null` -> 每个月都不通
 *   · 没给 -> 每个月 0
 *   · 报告期不足 12 个月 -> 剩下的槽位标签 / 值都空串
 *
 * @param {string} argument B64 JSON，形如
 *   { "range": {start, end}, "monthlyExternalAttackCounts": [3, null, 0],
 *     "monthlyMaliciousOutboundCounts": [9, null, 0] }
 *   ⚠️ 月份数由 range 决定（与 monthRange 同一把尺子），数组短一格会当场抛 ——
 *   这正是要验的（错位落值在报告上完全看不出来）。
 */
function planMonthlyAttack(argument) {
  const request = b64decode(argument);
  const overrides = { range: request.range || CTX_ARGS.range };

  // 显式给了 null 就是「整段接口不通」那一档，不能与"没给"混成一档（同 scalarFieldsOf）
  for (const field of ['monthlyExternalAttackCounts', 'monthlyMaliciousOutboundCounts']) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      overrides[field] = request[field];
    }
  }
  const ctx = createContext(Object.assign({}, CTX_ARGS, overrides));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * C75:N75「告警数（按月）」12 格 —— 数据源是**告警表**（不是接口序列），
 * 所以这里由 Python 侧直接把行对象投喂进来（生产里那些行由 parseTableRows 从下载件读，
 * 读取层那一步由【6】等段落单独验），本命令验的是「按『最早发生时间』落月份桶数行」这条口径。
 *
 * @param {string} argument B64 JSON，形如
 *   { "range": {start, end}, "rows": [{"最早发生时间": "2026-07-03 10:00:00"}, ...] }
 */
function planMonthlyAlarm(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    range: request.range || CTX_ARGS.range,
    alarmRows: Array.isArray(request.rows) ? request.rows : []
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * C86:N88「漏洞趋势 / 剩余漏洞数量 / 已闭环漏洞数」36 格 —— 数据源是**漏洞表全表**
 * （内网 + 互联网两份拼起来的 ctx.vulnRows），所以这里由 Python 侧直接把行对象投喂进来，
 * 验的是「按『首次发现时间』落月份桶数行」与「88 行在同一批行里再数『处置状态』
 * 包含『处置完成』」这两条口径。
 *
 * @param {string} argument B64 JSON，形如
 *   { "range": {start, end}, "rows": [{"首次发现时间": "2026-07-03 10:00:00", "处置状态": "处置完成"}, ...] }
 */
function planMonthlyVuln(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    range: request.range || CTX_ARGS.range,
    vulnRows: Array.isArray(request.rows) ? request.rows : []
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * 暴露面汇总（D128「暴露面数」）：走生产同一条链 ——
 * `parseExposedSummary`（读「文档说明」sheet 的 13 项）-> `createContext` -> 写层计划。
 *
 * 与 topn 那种「JSON 直接投喂」不同：这一格的数据源是**下载件 xlsx**，
 * 所以 fixture 要由 Python 侧写成真正的暴露面表形态（标题 + 基本信息 + 汇总表），
 * 再让这里按文字定位读一遍。验的是「文字定位 / 右侧一格 / 求和」这条口径本身。
 *
 * @param {string} argument B64 JSON，形如 { "path": "<xlsx>", "labels": [...] }
 *   labels 省略时用 stats/metrics/exposed.js 的权威清单。
 */
function planExposedSummary(argument) {
  const request = b64decode(argument);
  const { EXPOSED_SURFACE_SUMMARY_LABELS } = require('../stats/metrics/exposed');

  return parseExposedSummary(request.path, {
    sheet: request.sheet || '文档说明',
    labels: request.labels || EXPOSED_SURFACE_SUMMARY_LABELS
  }).then((parsed) => {
    const ctx = createContext(Object.assign({}, CTX_ARGS, {
      exposedRows: parsed.rows
    }));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = {
      sheet: parsed.sheet,
      rowCount: parsed.rowCount,
      missingLabels: parsed.missingLabels,
      duplicateLabels: parsed.duplicateLabels,
      invalidLabels: parsed.invalidLabels
    };
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * I81「暴露面风险端口数量」：走生产同一条链 ——
 * `parseTableRows`（读下载件里的「高危端口&服务」sheet）-> `createContext` -> 写层计划。
 *
 * 与 D128 同一个下载件、不同 sheet：D128 读「文档说明」汇总表（专用读表器），
 * 本格读规整的数据表（通用读表器），口径就是**数据行数、不含表头**。
 * fixture 由 Python 侧写成真实的表形态（第 1 行表头 + N 行数据）。
 *
 * @param {string} argument B64 JSON，形如 { "path": "<xlsx>", "sheet": "高危端口&服务" }
 */
function planExposedPortCount(argument) {
  const request = b64decode(argument);
  const { EXPOSED_HIGH_RISK_PORT_SHEET } = require('../stats/metrics/exposed');

  return parseTableRows(request.path, {
    sheet: request.sheet || EXPOSED_HIGH_RISK_PORT_SHEET,
    columns: request.columns || []
  }).then((parsed) => {
    const ctx = createContext(Object.assign({}, CTX_ARGS, {
      exposedHighRiskPortRows: parsed.rows
    }));
    const plan = serializable(buildStatisticsWrites(ctx));
    plan.parsed = { sheet: parsed.sheet, rowCount: parsed.rowCount };
    process.stdout.write(JSON.stringify(plan));
    return 0;
  });
}

/**
 * I79「互联网IP数量」/ I80「互联网端口数量」：走生产同一条链 ——
 * `parseExposedSummary`（「文档说明」汇总表，`match: 'contains'` 找「IP资产」/「端口资产」）
 * -> `createContext` -> 写层计划。验的是「包含匹配 / 右侧一格 / 不求和」这条口径本身。
 *
 * @param {string} argument B64 JSON，二选一：
 *   · { "path": "<xlsx>", "labels": [...], "match": "contains" }  —— 真的去读下载件
 *   · { "rows": [ {子类型, 总数}, ... ] }                        —— 直接投喂行对象
 *     （空数组 = 没喂汇总行那一档；也算非法行 / 重复行等边界）
 */
function planExposedAssetCounts(argument) {
  const request = b64decode(argument);
  const { EXPOSED_INTERNET_ASSET_LABELS } = require('../stats/metrics/exposed');

  function finish(rows, parsed) {
    const ctx = createContext(Object.assign({}, CTX_ARGS, {
      exposedAssetCountRows: rows
    }));
    const plan = serializable(buildStatisticsWrites(ctx));
    if (parsed) plan.parsed = parsed;
    process.stdout.write(JSON.stringify(plan));
    return 0;
  }

  if (Object.prototype.hasOwnProperty.call(request, 'rows')) {
    return Promise.resolve(finish(request.rows));
  }

  return parseExposedSummary(request.path, {
    sheet: request.sheet || '文档说明',
    labels: request.labels || EXPOSED_INTERNET_ASSET_LABELS,
    match: request.match || 'contains'
  }).then((parsed) => finish(parsed.rows, {
    sheet: parsed.sheet,
    rowCount: parsed.rowCount,
    missingLabels: parsed.missingLabels,
    duplicateLabels: parsed.duplicateLabels,
    invalidLabels: parsed.invalidLabels
  }));
}

/**
 * topn 源 IP 地域那 10 格 —— F62:F66 / G62:G66。
 *
 * 与 devices 同一形状：数据源是 JSON 接口（不是总表），生产路径是
 * mssw_client.fetchMsswSrcIpGeoTopN 把 `data.list`（`[{src_ip_geo, attack_count}]`）
 * 直接交给 ctx.topSrcGeoRows（stats/context.js 的 SOURCE_FIELDS）。所以这里也由
 * Python 侧以 JSON 直接投喂，验的是取值层：
 *   · 有 5 行 -> 十格逐行落值
 *   · 只有 3 行 -> 前 3 行落值，剩下 4 格写空串（接口答了、就是没那么多）
 *   · `[]` -> 十格全空串
 *   · `null` -> 十格全写「topn接口不通无法取值」
 *
 * @param {string} argument B64 JSON，形如 { "topSrcGeoRows": [ {...}, ... ] }
 *   不给（键不存在）与给 `[]` 同档：接口答了 0 行（createContext 归一成空数组）；
 *   显式给 `null` 才是接口不通那一档。
 */
function planTopnSrcGeo(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    topSrcGeoRows: request.topSrcGeoRows,
    range: request.range || CTX_ARGS.range
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * topn 威胁类型那 10 格 —— I62:I66 / J62:J66。
 *
 * 与 planTopnSrcGeo 同一形状（同一个 topn 接口、同一套请求体），只是数据源字段换成
 * ctx.threatTypeRows、行对象是 `[{threat_type, attack_count}]`。
 * 边界与它逐条对齐：5 行 / 超过 5 行截断 / 只有 3 行 -> 剩下 4 格空串 /
 * `[]` -> 十格空串 / `null` -> 十格写「topn接口不通无法取值」/ 缺字段 -> 该格进 errors。
 *
 * @param {string} argument B64 JSON，形如 { "threatTypeRows": [ {...}, ... ] }
 *   不给（键不存在）与给 `[]` 同档：接口答了 0 行；显式给 `null` 才是接口不通那一档。
 */
function planTopnThreatType(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    threatTypeRows: request.threatTypeRows,
    range: request.range || CTX_ARGS.range
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * topn 目的 IP 那 10 格 —— L62:L66 / M62:M66。
 *
 * 与另两个 topn 子命令同一形状：数据源字段是 ctx.dstIpRows、行对象是
 * `[{dst_ip, attack_count}]`，边界逐条对齐（5 行 / 截断 / 3 行 / `[]` / `null` / 缺字段）。
 *
 * @param {string} argument B64 JSON，形如 { "dstIpRows": [ {...}, ... ] }
 *   不给（键不存在）与给 `[]` 同档：接口答了 0 行；显式给 `null` 才是接口不通那一档。
 */
function planTopnDstIp(argument) {
  const request = b64decode(argument);
  const ctx = createContext(Object.assign({}, CTX_ARGS, {
    dstIpRows: request.dstIpRows,
    range: request.range || CTX_ARGS.range
  }));
  process.stdout.write(JSON.stringify(serializable(buildStatisticsWrites(ctx))));
  return 0;
}

/**
 * 事件表预处理 —— 「下载之后、解析之前」那一步（生产的顺序，见 mssw_downloader.js）。
 *
 * 用户口径 2026-10-12：取值层必须在预处理之后。所以验收要造的是**处理过再解析**的表，
 * 顺序不能颠倒 —— 拿一份没预处理的 fixture 喂 ctx，G7 会报「找不到『遏制时长』列」，
 * 验到的就不是生产会发生的事。本子命令就是 Python 侧触发那一步的唯一入口。
 *
 * ⚠️ **事件表 fixture 会被原地改写**（追加「内网外网资产」+ 五个时长列，
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
    if (argument === 'devices') {
      return planDevices(extra);
    }
    if (argument === 'topn') {
      return planTopnSrcGeo(extra);
    }
    if (argument === 'threat-type') {
      return planTopnThreatType(extra);
    }
    if (argument === 'dst-ip') {
      return planTopnDstIp(extra);
    }
    if (argument === 'exposed') {
      return planExposedSummary(extra);
    }
    if (argument === 'exposed-ports') {
      return planExposedPortCount(extra);
    }
    if (argument === 'exposed-assets') {
      return planExposedAssetCounts(extra);
    }
    if (argument === 'interfaces') {
      return planInterfaces(extra);
    }
    if (argument === 'monthly-attack') {
      return planMonthlyAttack(extra);
    }
    if (argument === 'monthly-alarm') {
      return planMonthlyAlarm(extra);
    }
    if (argument === 'monthly-vuln') {
      return planMonthlyVuln(extra);
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
      ? readStatisticsTables(statsPaths, ALL_STATISTICS_TABLES, options.statsSheets || {})
        .then(({ fields }) => fields)
      : Promise.resolve({});

    const withCtx = Promise.all([alarm, stats]).then(([alarmFields, statsFields]) => createContext(
      Object.assign({}, CTX_ARGS, alarmFields, statsFields, {
        businessSystems: options.businessSystems || [],
        // 报告期可以覆盖（与 plan 那几种子命令同一条口径）：C58:N59 的月份桶直接由
        // 报告期决定，只用一个 1 个月的区间验不出「跨 3 个月」与「越界槽位」。
        range: options.range || CTX_ARGS.range,
        // 设备列表接口的行对象（非总表数据源）：与 alarmFields/statsFields 不同，
        // 它没有 xlsx 可读，生产里是 mssw_client.fetchMsswDeviceRows 直接给的数组。
        // 不给 = 没有 deviceRows = 「一台设备都没有」（D100/D101/D102/D104 写 0）。
        deviceRows: options.deviceRows,
        // topn 源 IP 地域接口的行对象（非总表数据源）：F62:G66 十格。
        // 不给 = 接口答了 0 行（十格留空）；显式 null = 接口不通（十格写那句话）。
        topSrcGeoRows: options.topSrcGeoRows,
        // topn 威胁类型接口的行对象（非总表数据源）：I62:J66 十格。
        // 不给 = 接口答了 0 行（十格留空）；显式 null = 接口不通（十格写那句话）。
        threatTypeRows: options.threatTypeRows,
        // topn 目的 IP 接口的行对象（非总表数据源）：L62:M66 十格。
        // 不给 = 接口答了 0 行（十格留空）；显式 null = 接口不通（十格写那句话）。
        dstIpRows: options.dstIpRows,
        // 暴露面表「文档说明」的汇总行（{子类型, 总数}，D128 的口径源）。
        // 生产里由 parseExposedSummary 从下载件读出来；这里给的是读好的行对象，
        // 用于『落盘』那一步（解析本身由 plan exposed 那一段单独验）。
        exposedRows: options.exposedRows,
        // 暴露面下载件「高危端口&服务」sheet 的数据行（I81 数行数，不含表头）。
        // 生产里由 parseTableRows 读出来；这里给读好的行对象，用于『落盘』那一步
        // （解析本身由 plan exposed-ports 那一段单独验）。
        exposedHighRiskPortRows: options.exposedHighRiskPortRows,
        // 暴露面表「文档说明」里按**包含**匹配抽出的两行（{子类型, 总数}，I79/I80 的口径源）。
        // 生产里由 parseExposedSummary(match:'contains') 读出来；这里给读好的行对象，
        // 用于『落盘』那一步（解析本身由 plan exposed-assets 那一段单独验）。
        exposedAssetCountRows: options.exposedAssetCountRows,
        // 三个**标量**接口数据源（非总表）：D103 第三方数量 / G99 xdr日志数 /
        // D23 已拦截外联次数（D21 读它，再加 D24）。
        // 生产里是 mssw_client 的 fetchMsswThirdPartyDeviceCount /
        // fetchMsswSecurityLogCount / fetchMsswInterceptedOutboundCount 报的数
        // （后两个是**同一个端点的多次问里的两次**，所以各自是独立的字段 —— 一格不通不该
        // 牵连另一格）。不给 = 接口答了 0；显式 null = 接口不通。
        thirdPartyCount: options.thirdPartyCount,
        securityLogCount: options.securityLogCount,
        interceptedOutboundCount: options.interceptedOutboundCount,
        // 第五个标量（用户口径 2026-10-17）：D61 外部攻击日志数量 —— 同一个日志量端点的
        // 第三次问（只问网络安全日志一张表、带「外→内」过滤串）。生产里是
        // mssw_client.fetchMsswExternalAttackLogCount 报的 total。不给 = 0；显式 null = 接口不通。
        externalAttackLogCount: options.externalAttackLogCount,
        // 按月序列（用户口径 2026-10-20）：C71:N72 外部攻击数 —— 同一个日志量端点的问法、
        // 逐月各问一次（首尾月裁到报告期）。生产里是 mssw_client.fetchMsswMonthlyExternalAttackLogCounts
        // 报的数组。不给 = 每个月 0；显式 null = 整段不通；元素 null = 那个月不通。
        monthlyExternalAttackCounts: options.monthlyExternalAttackCounts,
        // 按月序列第二组（用户口径 2026-10-20）：C73:N73 恶意外联数 —— 同一套逐月问法、
        // 过滤串换成「内→外」。生产里是 mssw_client.fetchMsswMonthlyMaliciousOutboundLogCounts
        // 报的数组。三档与上面逐字相同（不给 = 每月 0；整体 null = 整段不通；元素 null = 那个月不通）。
        monthlyMaliciousOutboundCounts: options.monthlyMaliciousOutboundCounts,
        // 第四个标量（用户口径 2026-10-14）：D27 重要时期安全日志数 —— 报告期切成重要时期段、
        // 逐段问日志量、各段之和。生产里是 mssw_client.fetchMsswImportantPeriodLogCount
        // 报的那个 total。不给 = 0（= 报告期内没有重要时期那一档）；显式 null = 某一段接口不通。
        importantPeriodLogCount: options.importantPeriodLogCount,
        // 同一次逐段问的**逐段原值**（用户口径 2026-10-27）：G91:G97「日均攻击数」
        // = 该段原值 ÷ 该段天数。与上面那个标量同生共死（某段不通两边都是不通）；
        // 不给 = 没有逐段数据（归一成 []）；显式 null = 某一段接口不通。
        importantPeriodLogCounts: options.importantPeriodLogCounts,
        // D130 的 HW 时间窗（用户口径 2026-10-21）：与 plan 那条 hasOwnProperty 口径逐字相同 ——
        // 可以显式给 null（验"没传 HW 时间 -> 不写值 + 记错误"），不给就落回 CTX_ARGS 的默认窗口。
        // 生产里是 mssw_downloader.js 从 --protect-start / --protect-end 拼出来的 {start, end}。
        ...(Object.prototype.hasOwnProperty.call(options, 'protectRange')
          ? { protectRange: options.protectRange }
          : {})
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
  const args = [PY_SCRIPT, encodePayload({
    repo: path.join(__dirname, '..'),
    bridge: __filename
  })];
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
