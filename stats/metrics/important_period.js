'use strict';

/**
 * 「重要时期」域的取值（CELL_REGISTRY.md §8）——
 *   D27「重要时期安全日志数」、D28「重要时期告警数」、D29「重要时期事件数」
 * （三格口径均为用户投喂，2026-10-14），以及同一天起报期上另两格
 *   D90「重要时期值守次数」、D91「重要时期安全事件数」（用户口径 2026-10-26），
 *   以及 F91:F97「重要时期安全态势分布 · 节日名」/ H91:H97「防御率」（用户口径 2026-10-26），
 *   以及 G91:G97「日均攻击数」（用户口径 2026-10-27：该段日志量 ÷ 该段天数），
 *   以及 L4:L10 / M4:M10「重保周期清单」（用户口径 2026-10-27：L 写节日简称、M 写日期范围）。
 *
 * D90 数的是**命中的节假日个数**（报告期 ∩ 法定节假日，逐条计一次，不数天数；
 * **上限 7** —— 与 F91:F97 / L4:L10 的 7 个槽位同一条轴，用户口径 2026-10-29）；
 * D91 的判据与 D29 **逐字相同**（事件表「事件创建时间」落在重要时期内的行数），
 * 走同一个 `importantPeriodEventCount`，只是另登一格（H4，不是 alias）。
 *
 * 另有一格 **D130「hw 时间事件总数」**（用户投喂 2026-10-21）也放在本文件：
 * 它不是"重要时期"这个概念的一部分，但判据与 D29 **逐字相同**（事件表
 * 「事件创建时间」按日期落在给定窗口内的行数），只换时间窗 —— D29 用重要时期，
 * D130 用 ctx.protectRange（CLI `--protect-start` / `--protect-end`）。
 * 数行逻辑因此共用 `countRowsInPeriods`（H4），不在这里另写一份。
 * ⚠️ 概念上两者**仍然不是一回事**：重要时期（= 重保，重要节假日）只算节假日、
 * 与护网（HW）时间无关；别因为共用一个函数就把它们混成一个口径。
 *
 * ⚠️ 「重要时期」的**唯一定义**在 stats/periods.js 的 `importantPeriods`
 * （= 报告期 ∩ 中国法定节假日**放假整段**，数据在 stats/holidays.js）。本文件只**消费**
 * 它裁好的段、不重算、不并段（H4）。特别注意：重要时期与 CLI 的
 * `--protect-start` / `--protect-end`（护网时间）**无关** —— 那是报告里 M3「护网时间」，
 * 走 ctx.protectRange，是另一回事。
 *
 * 三格的数据源各不相同，这是本域存在的理由（跨域：一格接口标量、一格告警表、一格事件表）：
 *
 *   · **D27 —— 接口标量**。用户原话：「按照日志查询接口，根据重要时间，**分段**查网络安全
 *     日志+终端安全日志，无需额外的筛选条件…**分段的结果求和**」。分段与求和都发生在
 *     **下载层**（要发 N 次 HTTP，取值层是纯函数、不碰网络），结果落在
 *     ctx.importantPeriodLogCount（scalar 数据源，见 stats/context.js 的
 *     SCALAR_SOURCE_FIELDS）。本函数只把「接口不通」那一档翻成 UNAVAILABLE_TEXT，
 *     与 G99 的 securityLogCount 逐字同构。
 *
 *   · **D28 —— 告警表**。用户原话：「精确查找**告警表**的**「最早发生时间」**列，
 *     如果里面的时间落在重要时间，就加一」。
 *
 *   · **D29 —— 事件表**。用户原话：「精确查找**事件表**的**「事件创建时间」**列，
 *     如果里面的时间落在重要时间，就加一」。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要一个共用的日期归一（cellDateOnly）
 * ---------------------------------------------------------------------------
 * 两格的判据列**形态不同**（已用真实产物核过）：
 *   · 告警表「最早发生时间」是**文本** `'2026-09-30 20:56:18'`（openpyxl data_type='s'）
 *   · 事件表「事件创建时间」是**真 datetime**，经 scripts/parse_table_rows.py 后是 **epoch 秒**
 * 所以不能共用一句朴素比较。归一交给 stats/metrics/rows.js 的 `cellDateOnly`
 * （那是**取值层唯一**的日期解析器，只回答"哪一天"，见那里的说明）。
 *
 * 归一后一律与 importantPeriods 给出的段（短横 `YYYY-MM-DD`）做**字典序**比较 ——
 * YYYY-MM-DD 的字典序就是时间序，不必再走 Date（时区一碰就挪一天，见 periods.js）。
 *
 * 匹配口径（三格共通的几条边界）：
 *   · 按**日期**比，不是按时刻：`2026-10-07 23:59:59` **算**在国庆期内，
 *     `2026-10-08 00:00:00` **不算**
 *   · 段的**两端闭区间**都算（节假日首日、末日都算数）
 *   · **一行一票**、不去重、不看别的列
 *   · 报告期内与任何节假日**不相交** -> 那一格是 **0**（0 是结论，不是缺数）
 *   · 该列表格里**空值 / 占位符 / 认不出的时间** -> 跳过那一行（不影响其余行）
 *   · 该列**整根不在**（平台改列名）-> 不写值、记错误（requireColumn，C5）
 *   · 该列**在、也有非空值、但一个都解析不出** -> **抛错**（见下）
 *
 * ⚠️ 上面几条**有先后**：判据列的检查（最后两条）只在"真要读那一列"时才发生。
 * 告警表 0 行、或报告期内一个节假日都没有 —— 这两种情况下这一格的答案是 0 且恒为 0，
 * 与判据列长什么样无关，所以那两条不触发（理由写在 importantPeriodAlarmCount 里）。
 */

const { UNAVAILABLE_TEXT } = require('../context');
const { importantPeriods, toDateOnly, formatReportDateRange, inclusiveDayCount } = require('../periods');
const { requireColumn, cellText, cellDateOnly } = require('./rows');
const { EARLIEST_OCCURRENCE_COLUMN } = require('./alarm');
const { CREATED_TIME_COLUMN } = require('./event');

/**
 * 一个已归一的日期是否落在**任一段**重要时期内（两端闭区间）。
 *
 * 纯字符串比较 —— 入参两侧都是短横 `YYYY-MM-DD`（段来自 stats/periods.js，
 * 单元格值来自 rows.js 的 cellDateOnly），位数固定，字典序即时间序。
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {Array<{start: string, end: string}>} periods 升序、互不重叠
 */
function dateInAnyPeriod(date, periods) {
  return periods.some((period) => date >= period.start && date <= period.end);
}

/**
 * 数一列时间值落在给定日期段内的行数 —— D28/D29（重要时期）与 D130（HW 起止时间）
 * 共用的那一段（H4：几边口径逐字相同，只有数据源、列名与段的来源不同）。
 *
 * `periods` 只要求是 `[{start, end}]`、两端都是**短横** `YYYY-MM-DD` 的闭区间；
 * 段从哪来（重要时期 / ctx.protectRange）与本函数无关。
 *
 * ⚠️ **「整列都在、却一个都解析不出」要抛错**，这是本函数特意加的第三条防线：
 *   · 列整根不在 -> requireColumn 抛（C5），已有
 *   · 列在、行也非空，但时间格式整体变成 cellDateOnly 认不出的样子（比如平台把时间
 *     导成 Excel 裸序列号 `46000`）-> 若静默跳过，结果会是 **0** —— 而那与"这段时间
 *     真的没有告警/事件"长得一模一样。这正是 R10 / H6「缺数不静默」要拦的那种情况，
 *     所以这里抛，不数。
 *
 * @param {Array<Object>} rows 行对象数组（契约见 scripts/parse_table_rows.py 头注）
 * @param {string} column 判据列的表头文字
 * @param {string} tableLabel 报错文案里的表名，如「告警表」
 * @param {Array<{start: string, end: string}>} periods 日期段（闭区间，短横 YYYY-MM-DD）
 * @returns {number} 落在任一段内的行数
 * @throws {Error} 列不存在（C5）、或列在但整列的时间值一个都认不出
 */
function countRowsInPeriods(rows, column, tableLabel, periods) {
  requireColumn(rows, column, tableLabel);

  let count = 0;
  let nonEmpty = 0;
  let parsed = 0;

  for (const row of rows) {
    const raw = row ? row[column] : null;
    if (cellText(raw) !== '') nonEmpty += 1;

    const date = cellDateOnly(raw);
    if (!date) continue;
    parsed += 1;

    if (dateInAnyPeriod(date, periods)) count += 1;
  }

  if (nonEmpty > 0 && parsed === 0) {
    throw new Error(
      `${tableLabel}的「${column}」列有时间值（${nonEmpty} 行非空），但一个都认不出是日期 ——`
      + '平台可能改了时间的格式（取值层只认「日期文本」与「epoch 秒」两种形态，'
      + '见 stats/metrics/rows.js 的 cellDateOnly）；这里不能静默数出 0，'
      + '那与"一条都没有"长得一模一样（CELL_REGISTRY.md H6 / MIGRATION.md R10）'
    );
  }

  return count;
}

/**
 * D27「重要时期安全日志数」的取值。
 *
 * 值在**下载层**算好（报告期切成重要时期段、逐段问「网络安全日志 + 终端安全日志」、
 * 各段的数相加 —— 见 mssw_client.js 的 fetchMsswImportantPeriodLogCount 与
 * mssw_downloader.js 的 readImportantPeriodLogCount）。本函数与 G99 的
 * `securityLogCount` 同一形状：只负责把「接口不通」那一档翻成 UNAVAILABLE_TEXT。
 *
 * ⚠️ **任一段不通 = 整格不通**，不做"已通的段先加起来"（下载层把失败收成 `null`）——
 * 后者会把"少算了几段"伪装成"算完了"（同 D21 对 D23 的加法穿透口径，见 security_log.js）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number|string} 各重要时期段的日志条数之和；
 *   **接口不通（`ctx.importantPeriodLogCount === null`）时是 `UNAVAILABLE_TEXT`**
 */
function importantPeriodLogCount(ctx) {
  const total = ctx.importantPeriodLogCount;

  // 接口不通：与「0 条」刻意分开（见 stats/context.js 的 UNAVAILABLE_TEXT）。
  // 报告期内没有任何重要时期时下载层给的是 0（那是结论，走下面这条 return）。
  if (total === null) return UNAVAILABLE_TEXT;

  return total;
}

/**
 * D28「重要时期告警数」的取值 —— 告警表「最早发生时间」落在任一重要时期内的行数。
 *
 * @param {Object} ctx
 * @returns {number} 行数；报告期内无重要时期、或告警表 0 行时都是 0
 * @throws {Error} 见 countRowsInPeriods
 */
function importantPeriodAlarmCount(ctx) {
  const rows = ctx && ctx.alarmRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const periods = importantPeriods(ctx.range.start, ctx.range.end);
  // 报告期与任何节假日都不相交 -> 0（结论，不是缺数）。
  //
  // ⚠️ 这条 return 放在 requireColumn **之前**是刻意的，不是漏写：列名对不上只在
  // **真要去读那一列**的时候才报。报告期里一个节假日都没有时，这一格的答案是 0 且
  // **恒为 0** —— 跟告警表有没有「最早发生时间」这一列毫无关系，读都不用读。
  // 同一条口径在告警域已有先例（alarm.js 的 countGptVerdictHits：0 行就直接 0，
  // 不问列；G100「xdr告警数」更是整格只数行数、一个列名都不读）。
  //
  // 代价说清楚：平台真把列名改了，**只跑无节假日报告期**是发现不了的 —— 要等下个
  // 含节假日的报告期才会红。这里认这个代价：另一种做法是无论报告期都先要列，
  // 那会在"答案明明是 0"的时候把整份报告拦下来，为一个用不上的列名报错。
  // （要验"缺列 -> 记错误"这条，得拿含节假日的报告期，见 verify_write_layer.py 【29】。）
  if (periods.length === 0) return 0;

  return countRowsInPeriods(rows, EARLIEST_OCCURRENCE_COLUMN, '告警表', periods);
}

/**
 * D29「重要时期事件数」的取值 —— 事件表「事件创建时间」落在任一重要时期内的行数。
 *
 * 与 D28 是**同一段逻辑、不同的表与列**（H4：口径只写一次）—— 差别只在判据列：
 * 这列的单元格经 parse_table_rows 后是 **epoch 秒**，而告警表那列是文本；
 * 两种形态都由 rows.js 的 cellDateOnly 归一，所以这里不必分叉。
 *
 * @param {Object} ctx
 * @returns {number} 行数；报告期内无重要时期、或事件表 0 行时都是 0
 * @throws {Error} 见 countRowsInPeriods
 */
function importantPeriodEventCount(ctx) {
  const rows = ctx && ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const periods = importantPeriods(ctx.range.start, ctx.range.end);
  // 与 D28 逐字同构（含"这条 return 在 requireColumn 之前"的理由，见上面 D28 那条注释）
  if (periods.length === 0) return 0;

  return countRowsInPeriods(rows, CREATED_TIME_COLUMN, '事件表', periods);
}

/**
 * D90「重要时期值守次数」的取值 —— 报告期**命中的节假日个数**。
 *
 * 用户口径 2026-10-26：「D90 是重要时期值守次数，计算的是用户传入的起止时间内，
 * 命中的节假日的数量」。
 *
 * 「命中」= 该节假日的**放假整段**与报告期有交集（交集非空即可，不要求整段落在期内）。
 * 数的单位是**节假日条目**，不是天数、也不是段的天数之和：
 *   · 报告期 2026-09-24 ~ 2026-10-05 -> 中秋节 + 国庆节 = **2** 次
 *     （国庆右端被报告期裁短，仍是 1 次；中秋那 3 天、国庆那 5 天都不进这个数）
 *   · 2025 国庆中秋按官方原文**合并成一条**（stats/holidays.js），合并的那一段只算 **1** 次
 *   · 报告期里一个节假日都不相交 -> **0**（那是结论，不是缺数）
 *
 * 段从 stats/periods.js 的 `importantPeriods` 来 —— 它逐节日一条、已裁到报告期内、
 * 两两不重叠，所以**数出来的条数就是命中的节假日个数**（H4：本格不自己扫 holidays 表、
 * 不另写一份相交判断）。⚠️ 报告期越出假期表覆盖范围时 importantPeriods **抛错**
 * （见那里的说明：表不够用是配置错，不能静默当"这段没有节假日"）。
 *
 * ⚠️ **上限是 7**（用户口径 2026-10-29）：法定节假日表本身一年最多 7 条，
 * 但**跨年**报告期会命中两年合起来的条目 —— 如 2026-01-01 ~ 2027-12-31 共 14 条。
 * 报告上只有 7 个槽位（F91:F97 / L4:L10，取最晚 7 条），客户看到的也是这 7 条，
 * 所以值守次数跟着封顶 7，不数出 14（与「超过 12 个月取最晚 12 个」同一条约定）。
 * 数与槽位走**同一份** `importantPeriodDisplayRows`（H4），两处不会各算一份。
 *
 * 与 D27/D28/D29 是同一个「重要时期」定义的两个侧面：那三格问"这段时间里有多少
 * 日志/告警/事件"，本格问"这段时间里**有几个节假日**"—— 数据源是中性的日期表，
 * 一张总表都不读。
 *
 * @param {Object} ctx 由 stats/context.js 构造，只用 ctx.range
 * @returns {number} 命中的节假日个数（**最多 7**）；一个都不相交时是 0
 * @throws {Error} 报告期非法 / 起止倒置 / 越出法定节假日表覆盖范围
 */
function importantPeriodDutyCount(ctx) {
  // 不直接返回 importantPeriods(...).length：跨年会数出 8~14 条，与报告上的 7 个槽位对不上。
  // 走 importantPeriodDisplayRows（= periods.slice(-7)）既是封顶，也保证与 F / L / M 列
  // 逐槽对齐 —— 本格数出来的条数，就是那 7 个槽位里真正填了行的那几行。
  return importantPeriodDisplayRows(ctx).length;
}

// ---------------------------------------------------------------------------
// F91:F97 / H91:H97「重要时期安全态势分布」
// ---------------------------------------------------------------------------
//
// 用户口径 2026-10-26：F91:F97 逐行填**报告期内命中的节假日**，起名规则是
// 「节假日名（裁剪后起止日期）」、日期用斜杠 `YYYY/MM/DD`；H91:H97 是同一行的
// 「防御率」，有节假日的行一律 **100%**（其余行留空）。
//
//   F91 中秋（2026/09/25-2026/09/27）
//   F92 国庆（2026/10/01-2026/10/05）     <- 报告期 2026-09-24 ~ 2026-10-05 的右裁
//   H91 1（模板数字格式 `0%` 显示成 100%）
//   H92 1
//
// 三条边界：
//   · **最多 7 行**（用户：「理论上最多就是这七种节假日，有几个填几个」）。
//     跨年报告期可能出现 8 个以上条目（同一节日两年各一次），用户 2026-10-26 定
//     「取最晚 7 个」—— 与 C58:N59「超过 12 个月取最晚 12 个」同一条约定。
//   · 段与裁剪都来自 `importantPeriods`（H4），本域**不重扫** stats/holidays.js、
//     不自己判相交 —— 与 D90 同一条口径，只是出口从"数条数"换成"逐行写名字"。
//   · 名字用**简称**（用户 2026-10-26 明确选的写法）：
//     清明节 -> 清明、劳动节 -> 五一、端午节 -> 端午、中秋节 -> 中秋、国庆节 -> 国庆；
//     2025 那条官方合并条目「国庆节、中秋节」->「国庆、中秋」。
//     表里以后新增、这里没登记的节日名**原样输出**（不猜简称、也不丢行）。

/** F91:H97 的槽位数：七个节日（用户口径 2026-10-26）。 */
const MAX_IMPORTANT_PERIOD_ROWS = 7;

/** 节假日表原名 -> 报告上的简称（用户口径 2026-10-26）。 */
const HOLIDAY_SHORT_NAME = {
  元旦: '元旦',
  春节: '春节',
  清明节: '清明',
  劳动节: '五一',
  端午节: '端午',
  中秋节: '中秋',
  国庆节: '国庆',
  '国庆节、中秋节': '国庆、中秋'
};

/**
 * 报告期内命中的节假日（裁后、升序），只留**最晚的 7 条** —— F91:F97 / H91:H97 共用的
 * 那一份序列（H4：七个 F 格与七个 H 格按同一个槽位取值，不各算一份）。
 *
 * @param {Object} ctx
 * @returns {Array<{name: string, start: string, end: string, source: string}>} 长度 0..7
 */
function importantPeriodDisplayRows(ctx) {
  const periods = importantPeriods(ctx.range.start, ctx.range.end);
  return periods.slice(-MAX_IMPORTANT_PERIOD_ROWS);
}

/**
 * F91:F97 第 `index` 个槽位的节日名（`index` 从 0 起）。
 * 槽位越界（报告期内节假日不够 7 个）-> 写空串，不清空、不填 0（那是结论）。
 *
 * @param {Object} ctx
 * @param {number} index 0..6
 * @returns {string} 形如 `中秋（2026/09/25-2026/09/27）`；该槽位没有节日时是 ''
 */
function importantPeriodLabelAt(ctx, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMPORTANT_PERIOD_ROWS) {
    throw new Error(`importantPeriodLabelAt 槽位越界: ${index}（0..${MAX_IMPORTANT_PERIOD_ROWS - 1}）`);
  }

  const rows = importantPeriodDisplayRows(ctx);
  if (index >= rows.length) return '';

  const row = rows[index];
  const name = HOLIDAY_SHORT_NAME[row.name] || row.name;
  return `${name}（${formatReportDateRange(row.start, row.end)}）`;
}

/**
 * H91:H97 第 `index` 个槽位的防御率 —— 有节假日的行恒为 **1**（模板数字格式 `0%`，
 * 显示成 100%），没有节假日的行写空串。
 *
 * 防御率在这个块里没有任何数据源：用户口径 2026-10-26「自动把对应有效行的 H 列填上 100%」，
 * 所以它不是从告警/事件/日志算出来的，也不读任何表 —— 只跟 F 列那个槽位有没有节日走。
 *
 * @param {Object} ctx
 * @param {number} index 0..6
 * @returns {number|string} 1，或该槽位没有节日时的 ''
 */
function importantPeriodDefenseRateAt(ctx, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMPORTANT_PERIOD_ROWS) {
    throw new Error(`importantPeriodDefenseRateAt 槽位越界: ${index}（0..${MAX_IMPORTANT_PERIOD_ROWS - 1}）`);
  }

  const rows = importantPeriodDisplayRows(ctx);
  return index < rows.length ? 1 : '';
}

/**
 * L4:L10「重保周期清单 · 节日名」第 `index` 个槽位的**简称**（用户口径 2026-10-27）。
 *
 * 与 F91:F97 共用同一份 `importantPeriodDisplayRows`（H4：7 个槽位、按时间升序、
 * 最多取最晚 7 条）。区别只在落法：F 列把「简称（日期范围）」写在一个格子里，
 * 这里 L 列只写简称、M 列另写日期范围（见 importantPeriodRangeAt）。
 *
 * 槽位越界（报告期内节假日不够 7 个）-> 写空串，不清空、不填 0（那是结论）。
 *
 * @param {Object} ctx
 * @param {number} index 0..6
 * @returns {string} 形如 `中秋`；该槽位没有节日时是 ''
 */
function importantPeriodNameAt(ctx, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMPORTANT_PERIOD_ROWS) {
    throw new Error(`importantPeriodNameAt 槽位越界: ${index}（0..${MAX_IMPORTANT_PERIOD_ROWS - 1}）`);
  }

  const rows = importantPeriodDisplayRows(ctx);
  if (index >= rows.length) return '';

  const row = rows[index];
  return HOLIDAY_SHORT_NAME[row.name] || row.name;
}

/**
 * M4:M10「重保周期清单 · 时间范围」第 `index` 个槽位的日期范围。
 *
 * 与 L 列同一行、同一个节假日（同一份 `importantPeriodDisplayRows`，H4）。
 * 段已按报告期裁剪，日期用**斜杠** `YYYY/MM/DD`、中间短横连接（与 F91:F97 同一个
 * `formatReportDateRange`）；该槽位没有节日 -> 空串。
 *
 * @param {Object} ctx
 * @param {number} index 0..6
 * @returns {string} 形如 `2026/09/25-2026/09/27`；该槽位没有节日时是 ''
 */
function importantPeriodRangeAt(ctx, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMPORTANT_PERIOD_ROWS) {
    throw new Error(`importantPeriodRangeAt 槽位越界: ${index}（0..${MAX_IMPORTANT_PERIOD_ROWS - 1}）`);
  }

  const rows = importantPeriodDisplayRows(ctx);
  if (index >= rows.length) return '';

  const row = rows[index];
  return formatReportDateRange(row.start, row.end);
}

/**
 * G91:G97「日均攻击数」第 `index` 个槽位的取值（用户口径 2026-10-27）：
 * **该重要时期段的日志量 ÷ 该段天数**（闭区间首尾都算）。
 *
 * 数据源是 `ctx.importantPeriodLogCounts` —— 与 D27 的 `ctx.importantPeriodLogCount`
 * 来自**同一次逐段问**（下载层 mssw_downloader.js 的 readImportantPeriodLogCount）：
 * 那个字段是各段之和，本字段是逐段原值，两者同生共死（某一段不通两个都是「不通」）。
 *
 * 三档与其余接口字段同一套：
 *   · `null`  -> 接口不通 -> 写 UNAVAILABLE_TEXT（7 格都写，不写 0）
 *   · 数组    -> 逐段原值；报告期内没有节日时是 `[]`（7 格都写空串，那是结论）
 *   · 段数对不上（数组比显示槽位短）-> **抛错**，不静默补 0 / 截断（H6）
 *
 * 不做舍入 —— 与 D35/D36 那几个时长均值格同一条：值原样落，显示格式由模板的
 * `0.0,"万"` 决定（那一格的数值单位是"条/天"，不是"万"）。
 *
 * @param {Object} ctx
 * @param {number} index 0..6
 * @returns {number|string} 日均日志量；接口不通时是 UNAVAILABLE_TEXT；空槽位是 ''
 * @throws {Error} 槽位越界、`importantPeriodLogCounts` 段数不够、元素不是数字
 */
function importantPeriodDailyAverageAt(ctx, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_IMPORTANT_PERIOD_ROWS) {
    throw new Error(`importantPeriodDailyAverageAt 槽位越界: ${index}（0..${MAX_IMPORTANT_PERIOD_ROWS - 1}）`);
  }

  const rows = importantPeriodDisplayRows(ctx);
  if (index >= rows.length) return '';

  const counts = ctx.importantPeriodLogCounts;
  if (counts === null) return UNAVAILABLE_TEXT;

  // 与 importantPeriodDisplayRows 同一个「取最晚 7 条」的槽位轴：段数超过 7 时，
  // 数组也只看最后 7 个，第 i 个就是显示列表里的第 i 行。
  const aligned = counts.slice(-MAX_IMPORTANT_PERIOD_ROWS);
  if (aligned.length < rows.length) {
    throw new Error(
      `ctx.importantPeriodLogCounts 只有 ${aligned.length} 段，少于显示的 ${rows.length} 段 `
      + '（缺数不静默：不补 0、不截断）'
    );
  }

  const total = aligned[index];
  if (typeof total !== 'number' || !Number.isFinite(total)) {
    throw new Error(`ctx.importantPeriodLogCounts[${index}] 必须是数字，收到: ${JSON.stringify(total)}`);
  }

  const row = rows[index];
  return total / inclusiveDayCount(row.start, row.end);
}

/**
 * D130「hw 时间事件总数」的取值 —— 事件表「事件创建时间」落在 **HW 起止时间**
 * （`ctx.protectRange`，由 CLI `--protect-start` / `--protect-end` 传入）内的行数。
 *
 * 判据与 D29 逐字相同（按**日期**比较、两端闭区间、一行一票、不去重、空值跳过、
 * 整列解析不出抛错），差别只有时间窗的来源：
 *   · D29 的窗口是「重要时期」（报告期 ∩ 法定节假日放假整段，stats/periods.js）
 *   · D130 的窗口是用户输入的那一对 HW 日期（ctx.protectRange）
 * 所以数行那一步直接复用 countRowsInPeriods（H4），这里只负责把窗口归一成
 * `[{start, end}]` 并守住「没传 HW 时间」那一档。
 *
 * ⚠️ **没传 HW 起止时间写 0**（用户口径 2026-10-21）：`--protect-start` / `--protect-end`
 * 是**可选参数**，没传就是"这次报告不按 HW 窗口统计"，与"窗口里一条事件都没有"在报告上
 * 都表现为 0 —— 这是用户点名要的口径，不是静默缺数（H6 拦的是"该有数却悄悄写 0"，
 * 这里用户已经明确说了没传就是 0）。两端只传一个属于参数错，在下载层就被 badRequest
 * 拦住，不会走到这里。
 *
 * ⚠️ 事件表是**按 `--start` / `--end` 导出的**（mssw_downloader.js 的 TIME_RANGE_TYPES
 * 含 'event'）。所以 HW 窗口超出报告期的部分，表里本来就没有那些行 —— 本格实际数到的是
 * 「报告期 ∩ HW 窗口」里的行，这是数据源的边界，不是本函数又裁了一刀（本函数只按 HW 窗口筛）。
 *
 * @param {Object} ctx
 * @returns {number} 行数；没传 HW 起止时间、事件表 0 行时都是 0
 * @throws {Error} 列不存在、或列在但整列的时间值一个都认不出
 */
function hwEventCount(ctx) {
  const range = ctx && ctx.protectRange;
  // 没传 HW 时间 -> 0（用户口径 2026-10-21）。它是可选参数：不传等于"这次不按 HW 窗口
  // 统计"，不是"缺数"。方向说清楚：H6 拦的是"该有数却悄悄写 0"，这里是用户明确指定的 0。
  if (!range) return 0;

  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const period = {
    start: toDateOnly(range.start, 'ctx.protectRange.start'),
    end: toDateOnly(range.end, 'ctx.protectRange.end')
  };

  return countRowsInPeriods(rows, CREATED_TIME_COLUMN, '事件表', [period]);
}

module.exports = {
  importantPeriodLogCount,
  importantPeriodAlarmCount,
  importantPeriodEventCount,
  importantPeriodDutyCount,
  importantPeriodDisplayRows,
  importantPeriodLabelAt,
  importantPeriodDefenseRateAt,
  importantPeriodNameAt,
  importantPeriodRangeAt,
  importantPeriodDailyAverageAt,
  MAX_IMPORTANT_PERIOD_ROWS,
  HOLIDAY_SHORT_NAME,
  hwEventCount
};
