'use strict';

/**
 * 告警表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 这里只放**被两个以上地址共用**的量（H4）。只有一格用得上的算法，写在 cells/ 那条记录里。
 *
 * 「告警定性」这一列被 14 格共用（第 133 行 7 格名称 + 第 134 行 7 格占比，名次一一对应），
 * 所以它的频次排行落在这里，只算一次。
 *
 * 排行算法本体在 stats/metrics/ranking.js —— 与事件定性（C135:I137 读「GPT定性标签」）
 * 是同一套，两处共用一份实现，只有数据源与列名不同。
 *
 * 「GPT研判结论」这一列另被 G5「威胁告警总」与 G6/H6/I6「核心系统威胁告警数量」共用
 * （同一个"精确等于「真实攻击未成功」"的选行，一处数整表、一处再按「主机IP」落在
 * 业务系统 IP 集合里圈定），所以也落在本文件。⚠️ 这一列**不是每份告警导出都有**
 * （用户口径 2026-10-19）：缺列时那四格落 `GPT_VERDICT_MISSING_TEXT` 那句结论文字，
 * 不记错误、也不填 0。
 *
 * G100「xdr告警数」（用户口径 2026-10-13）也落在本文件，但它与上面两处**没有任何共用**：
 * 它数的是整张告警表的**行数**（alarmRowCount），一个列名都不读，与「告警定性」
 * 「GPT研判结论」两列都无关 —— 放这里只是因为**域**相同（告警表域，CELL_REGISTRY.md §8 F1）。
 *
 * D24「恶意外联告警数」（用户口径 2026-10-14）同样落在本文件：它按「访问方向」列
 * 精确等于「内➝外」数行（outboundAlarmCount），与上面前两处也没有共用 ——
 * 同 G100 一样只是因为域相同。
 *
 * C75:N75「告警数（按月）」（用户口径 2026-10-20）也落在本文件：它把告警表
 * 「最早发生时间」按报告期的月份桶分桶数行（monthlyAlarmSeries），与 D28 读同一列、
 * 但 D28 比的是重要时期段、本组比的是月份桶 —— 判据列同一根，口径不同。
 */

const { buildRanking, labelAt, shareAt } = require('./ranking');
const { hasColumn, requireColumn, cellText, cellDateOnly, normalizeIp } = require('./rows');
const { monthPeriods } = require('../periods');

/**
 * 「告警表」总表里承载告警定性这一列的**表头文字**。
 *
 * 依据：`outputs/20260930_103921/一致性验收客户_report.xlsx` 的「告警表」sheet 第 1 行表头，
 * 63 个表头里逐字命中「告警定性」（前后无空格），全表唯一 —— 另一个含「定性」的表头是
 * 「确定性等级」，不会误撞。
 *
 * **必须按表头文字找，不得按列下标取。** 告警导出的列集是数据相关的：同一接口同一参数，
 * 116 条数据出 77 列、0 条数据只出 68 列，整列无值的列直接不出现
 * （见 mssw_client.js 里 MSSW_ALERT_TABLE_FIELDS 的注记）。
 * 按列下标写死的代码，换一份数据就会静默数到别的列上。
 */
const QUALIFICATION_COLUMN = '告警定性';

/**
 * 「告警定性」的频次排行 —— 第 133 / 134 行共用的那个量（H4）。
 *
 * 排序、计数、缺值、缺列防线的口径一律见 stats/metrics/ranking.js 的头注。
 * 这里只把数据源（ctx.alarmRows）和列名绑上去。
 *
 * @returns {{items: Array<{label: string, count: number}>, total: number}}
 *   告警表为空、或所有行的定性都为空 / 都是占位符时 items 为空、total 为 0
 *   —— 没有定性就是没有定性（那是结论），名次槽位跟着写空串，不记错误（R10 不适用）
 * @throws 告警表有数据、但没有任何一行带「告警定性」这一列时抛错
 *   —— 这正是「猜错列名会静默返回 0」的防线：列名对不上就必须炸，而不是安静地数出 0。
 */
function qualificationRanking(ctx) {
  return buildRanking(ctx && ctx.alarmRows, QUALIFICATION_COLUMN, '告警表');
}

/**
 * 排行第 rank 名（从 0 起）的定性名称。
 *
 * @returns {string} 名次不存在（含表为空）时返回**空串**（该槽位就是空的，不是取不到数）
 */
function qualificationLabelAt(ctx, rank) {
  return labelAt(qualificationRanking(ctx), rank);
}

/**
 * 排行第 rank 名（从 0 起）的定性占比，小数形式（写层按 '0.00%' 落格式）。
 *
 * 分母是全部定性的出现总次数，不是前若干名之和 —— 所以第 133 行 7 个名称的占比
 * 加起来通常小于 100%。
 *
 * @returns {number|string} 名次不存在（含表为空）时返回**空串**
 */
function qualificationShareAt(ctx, rank) {
  return shareAt(qualificationRanking(ctx), rank);
}

/**
 * 「GPT研判结论」的表头文字 —— G5「威胁告警总」与 G6/H6/I6「核心系统威胁告警数量」
 * 共用的那根判据列（H4）。
 *
 * 依据：平台直出的告警中间件（`tmp/verify_vuln/cli_downloads/alert_20261008122724.xlsx`
 * 的「安全告警」sheet，73 列表头）逐字命中「GPT研判结论」，全表唯一 ——
 * 同一张表另有「研判标签」「GPT定性标签」两列，都不会误撞。
 *
 * ⚠️ 报告里的「告警表」sheet 是**另一个列集**（较早几次产物是 63 列，没有这一列）：
 * 取值层读的是**下载得到的中间件**（WORKFLOW.md §二），不是报告里那张 sheet，
 * 所以以中间件的表头为准（与 stats/metrics/event.js 里两处取证的写法一致）。
 */
const GPT_VERDICT_COLUMN = 'GPT研判结论';

/**
 * 告警表里有数据行、却没有「GPT研判结论」列时，G5/G6/H6/I6 落的那句**结论文字**
 * （用户口径 2026-10-19）。
 *
 * 背景：这一列**不是每份告警导出都有** —— 只有部分客户的下载件带它。缺列不再算
 * 「平台改了列名」那种真异常（不记错误、也不填 0），而是这一格算不出来的**结论**：
 * 报告上原样写这句话，读报告的人一眼能看出"不是 0 条，是这张表没有这一列"。
 * 与「接口不通无值」同一档思路（都是"取不到、但把原因写在格子里"），只是数据源不同。
 *
 * 空表（0 行）**不走这一档**：那还是 0（这段时间确实没有告警，0 是结论）——
 * 0 行的行数组里没有任何键，判不出列在不在，也不该判。
 */
const GPT_VERDICT_MISSING_TEXT = '该客户告警表无GPT研判结论，无法计算';

/**
 * 「主机IP」的表头文字 —— G6/H6/I6 拿它去和业务系统的 IP 集合比对。
 *
 * 依据：同一份中间件的表头逐字命中「主机IP」。同表并排还有「主机IP业务」一列，
 * 差两个字 —— 按列名取时**必须整名相等**，用子串找会把两列一起命中
 * （从前 scripts/report_preprocess.py 剥后缀那一步踩过同一个坑：那一步已于 2026-10-12
 * 删除，报告 sheet 上这一列现在与中间件一样是原样，但「整名相等」这条没变）。
 *
 * 实测该列是**单值**（一个 IP + 可选括号说明，如 `10.223.4.115(管理IP范围)`），
 * 所以不需要像「威胁标签」那样拆多值；括号说明由 normalizeIp 剥掉 ——
 * **剥只发生在比对这一刻**，报告里那份是平台原样（见 stats/metrics/rows.js 的 normalizeIp）。
 */
const HOST_IP_COLUMN = '主机IP';

/**
 * 命中「真实攻击」的那条研判结论（用户口径：**精确匹配**这六个字）。
 *
 * 判据是整格相等（比较前只去首尾空白），不是包含 —— 「真实攻击未成功」与
 * 「真实攻击成功」是同一前缀的两种结论，用包含去比，G5 会把两者一起数进去
 * （同一前缀的两种结论绝不能混：用包含去比会把「真实攻击成功」也算成
 *  「真实攻击未成功」，这与 D15 的包含判据是两条不同的取舍，别照着 D15 抄）。
 * 实测同一列的其它取值形如「等待GPT研判」「主机失陷活动」「-」，一个都不算命中。
 */
const GPT_VERDICT_HIT = '真实攻击未成功';

/**
 * 「访问方向」的表头文字 —— D24「恶意外联告警数」的那根判据列（用户口径 2026-10-14）。
 *
 * 依据：平台直出的告警中间件（`tmp/verify_vuln/cli_downloads/alert_20261008122724.xlsx`
 * 的「安全告警」sheet，73 列表头）逐字命中「访问方向」，全表唯一 ——
 * 报告里的「告警表」sheet 是另一个列集（63 列），同样带这一列。
 *
 * 与「主机IP」一样的坑：按列名取时**必须整名相等**，别用子串找
 * （同一张表另有「主机IP业务」这种"前缀相同"的列，「访问方向」同理不能靠包含匹配）。
 */
const DIRECTION_COLUMN = '访问方向';

/**
 * 「访问方向」列上代表**外联**的那条取值（用户口径 2026-10-14：D24 = 该列精确匹配
 * 这个值的行数）。
 *
 * ⚠️ 逐字照**数据里实际写的**：中间那个字符是 `➝`（U+279D，实心三角箭头），
 * 不是「到」、不是「→」（U+2192）、也不是 `->`。用户口述时写的是「内到外」，
 * 但表里没有「内到外」这个值 —— 按口述去匹配会数出 0（并且**不会报错**，
 * 因为"一个都没匹配上"和"这类告警一条都没有"在结果上长得一模一样）。
 * 这一点已当场跟用户核对过，用户确认按**表里实际的值**匹配。
 *
 * 判据是整格相等（比较前只去首尾空白，见 cellText），不是包含 —— 「外➝内」
 * 「内➝内」都含「内」「外」两个字，用包含去比会把它们一起数进来
 * （同 GPT_VERDICT_HIT 那条精确相等的分界 —— 别拿 D15 的包含判据来套）。
 */
const OUTBOUND_DIRECTION = '内➝外';

/**
 * 「最早发生时间」的表头文字 —— D28「重要时期告警数」的那根判据列（用户口径 2026-10-14）。
 *
 * 依据：报告里的「告警表」sheet（63 列）逐字带这一列，全表唯一（已用真实产物
 * `outputs/20261014_141541/一致性验收客户_report.xlsx` 核过）。
 *
 * ⚠️ 实测这一列是**文本**（openpyxl `data_type='s'`），形如 `'2026-09-30 20:56:18'`
 * —— 与事件表「事件创建时间」那列（真 datetime，经 parse_table_rows 后是 **epoch 秒**）
 * **形态不同**。所以 D28 与 D29 不能共用一句朴素数值比较，两边都走
 * stats/metrics/rows.js 的 cellDateOnly 归一成 `YYYY-MM-DD` 再比。
 */
const EARLIEST_OCCURRENCE_COLUMN = '最早发生时间';

/**
 * 告警表要读进 ctx 的列白名单：**各处需要的并集**（H4 之外的读取层约定）。
 *
 * 读告警表的有五处：告警定性那 14 格（要「告警定性」）、G5/G6/H6/I6（要「GPT研判结论」，
 * 后三格另要「主机IP」）、D24（要「访问方向」）、D28 与 C75:N75（要「最早发生时间」——
 * 前者 2026-10-15 为「重要时期告警数」加长，后者 2026-10-20 为「告警数（按月）」）。
 * 并成一次读，见 mssw_downloader.js 的 readAlarmRows —— 读两遍不只是白解析十万行，
 * 后一遍还会把前一遍的行对象盖掉。
 */
const ALARM_TABLE_COLUMNS = [QUALIFICATION_COLUMN, GPT_VERDICT_COLUMN, HOST_IP_COLUMN,
                             DIRECTION_COLUMN, EARLIEST_OCCURRENCE_COLUMN];

/**
 * 告警表的**告警行数**（整张表有多少行）—— G100「xdr告警数」（用户口径 2026-10-13
 * 「G100 是告警数，取告警表的告警行数」）。
 *
 * ⚠️ 本函数**一个列名都不读**：数的是下载件里有多少行数据，告警定性 / 研判结论 /
 * 主机IP 那些列在不在、写成什么样都跟它无关（C5 的缺列防线在这里无从谈起 ——
 * 没有要读的列，也就没有列名可对不上）。所以这一格是**唯一**不会因为平台改列名而不写值的表格子。
 *
 * 计数口径：**按行计数，一行一票**，不去重、不按告警 ID / 主机IP 合并；
 * 也不看任何一列的内容（不看处置状态、不看定性、不看研判结论）。
 * 不按报告期过滤：告警表导出时已按首次发生时间取数（mssw_downloader.js 的
 * TIME_RANGE_TYPES），本仓取值层不叠加第二道时间过滤 —— 与同表其它格子同一条。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；告警表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *   scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出）
 */
function alarmRowCount(ctx) {
  const rows = ctx && ctx.alarmRows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * 「GPT研判结论」精确等于「真实攻击未成功」的告警行数 —— G5 与 G6/H6/I6 共用的那份选行（H4）。
 *
 * 计数口径：**按行计数，一行一票**，不去重、不按告警 ID 合并 —— 同一台机器上
 * 有多少条这样的告警就是多少条（D12 那种「按资产去重数台数」是另一套口径，
 * 别顺手统一：用户这一格说的是"总数"）。
 * 不按报告期过滤：告警表导出时已按首次发生时间取数（mssw_downloader.js 的
 * TIME_RANGE_TYPES），本仓取值层不叠加第二道时间过滤 —— 与告警定性那 14 格同一条。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>|undefined} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）；
 *   **undefined = 不按 IP 圈定，数整张表**（G5）；空集 = 圈定后一个 IP 都没命中（0 是结论）
 * @returns {number|string} 行数；告警表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *   scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出）；
 *   表里有行、却没有「GPT研判结论」列时是**结论文字** `GPT_VERDICT_MISSING_TEXT`
 *   （用户口径 2026-10-19：有些客户的告警表本来就没有这一列 —— 不是缺数、不记错误）
 * @throws {Error} 按 IP 圈定时表头里没有「主机IP」列 —— 缺了它，集合与行的比对无从谈起，
 *   那时安静返回 0 会被读成"这些系统上一条这样的告警都没有"。
 *   ⚠️ 「GPT研判结论」缺列**不再**抛 —— 见上一条。
 */
function countGptVerdictHits(ctx, ips) {
  const rows = ctx && ctx.alarmRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  if (!hasColumn(rows, GPT_VERDICT_COLUMN)) return GPT_VERDICT_MISSING_TEXT;
  if (ips !== undefined) requireColumn(rows, HOST_IP_COLUMN, '告警表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[GPT_VERDICT_COLUMN]) !== GPT_VERDICT_HIT) continue;
    // 「主机IP」为空的行无法归到任何业务系统，跳过（不影响命中判定）；
    // 归一走 normalizeIp（剥掉 `(管理IP范围)` 这类后缀），与资产表的 IP 同一把尺子。
    if (ips !== undefined && !ips.has(normalizeIp(row[HOST_IP_COLUMN]))) continue;
    count += 1;
  }
  return count;
}

/**
 * 整张告警表上「真实攻击未成功」的告警行数 —— G5「威胁告警总」。
 *
 * @returns {number|string} 见 countGptVerdictHits（缺「GPT研判结论」列时是那句话）
 */
function gptVerdictAlarmCount(ctx) {
  return countGptVerdictHits(ctx, undefined);
}

/**
 * 「访问方向」精确等于「内➝外」的告警行数 —— **D24「恶意外联告警数」**
 * （用户口径 2026-10-14：「精确查找告警表『访问方向』列，精确匹配值是『内到外』，统计行数」）。
 *
 * 计数口径：**按行计数，一行一票**，不去重、不按告警 ID / 主机IP 合并，也不看别的列
 * （不看处置状态、不看定性、不看研判结论）—— 与同表 G100 / G5 同一套"一行一票"。
 * 不按报告期过滤：告警表导出时已按首次发生时间取数（mssw_downloader.js 的
 * TIME_RANGE_TYPES），本仓取值层不叠加第二道时间过滤。
 *
 * ⚠️ 这一格数的是**告警行数**，与 D23「已拦截外联次数」（日志条数，日志接口）是两套
 * 完全不同的数据源 —— 别把两者当成"同一个东西的两种算法"。D21 把两者相加，正是因为
 * 它们是两条独立的路（用户口径 2026-10-14）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；告警表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *   scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出）
 * @throws {Error} 有行数据、但表头里没有「访问方向」列（列名对不上，不许静默数出 0）
 */
function outboundAlarmCount(ctx) {
  const rows = ctx && ctx.alarmRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, DIRECTION_COLUMN, '告警表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[DIRECTION_COLUMN]) !== OUTBOUND_DIRECTION) continue;
    count += 1;
  }
  return count;
}

/**
 * C75:N75「告警数（按月）」的共用量 —— 月份桶 + 每个桶内的告警行数（H4）。
 *
 * 用户口径 2026-10-20：「C75:N75是每个月的告警数：按照告警表精确查找『最早发生时间』列，
 * 也是按照月份划分。看这些告警在每个月时间范围内的个数」。
 *
 * 口径：
 *   · 月份桶 = `monthPeriods(ctx.range.start, ctx.range.end)` —— 与 C71:N71 / C73:N73
 *     **同一条月份轴**（报告期切月、含首尾两端所在的两个月、最多 12 个月取最晚的 12 个，
 *     **首尾月裁到报告期**）。本行 75 只有值格，月份标签共用 C71:N71 那一行。
 *   · 判据列 = 告警表的「最早发生时间」（整名相等，见 EARLIEST_OCCURRENCE_COLUMN）。
 *     这列是**文本**（如 `'2026-09-30 20:56:18'`），经 `cellDateOnly` 归一成
 *     `YYYY-MM-DD` 后按**日期**与每个桶的 `[start, end]`（两端闭区间）比 ——
 *     时刻不影响归属，落在报告期外的日期也不进任何桶。
 *   · **一行一票**、不去重、不按告警 ID / 主机IP 合并，也不看别的列。
 *   · 告警表空（0 行）-> 报告期内每个月都是 **0**（结论，不是缺数；不检查列）。
 *   · 空值 / 认不出的时间 -> 跳过那一行；该列在、也有非空值、但一个都解析不出 -> **抛错**
 *     （与 D28/D29 的 `countRowsInImportantPeriods` 同一条防线：否则会静默数出 0）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {{labels: string[], counts: number[]}} 两个等长数组，长度 1..12，升序
 * @throws {Error} 告警表有行、却没有「最早发生时间」列；或该列整列时间都认不出
 */
function monthlyAlarmSeries(ctx) {
  const periods = monthPeriods(ctx.range.start, ctx.range.end);
  const labels = periods.map((period) => period.label);
  const rows = ctx && ctx.alarmRows;

  // 空表不是缺数：报告期里那几个月确实一条告警都没有，逐个写 0（不读列，见上）
  if (!Array.isArray(rows) || rows.length === 0) {
    return { labels, counts: labels.map(() => 0) };
  }

  requireColumn(rows, EARLIEST_OCCURRENCE_COLUMN, '告警表');

  const counts = labels.map(() => 0);
  let nonEmpty = 0;
  let parsed = 0;

  for (const row of rows) {
    const raw = row ? row[EARLIEST_OCCURRENCE_COLUMN] : null;
    if (cellText(raw) !== '') nonEmpty += 1;

    const date = cellDateOnly(raw);
    if (!date) continue;
    parsed += 1;

    const index = periods.findIndex((period) => date >= period.start && date <= period.end);
    // 报告期之外的日期不进任何桶（不是错误：告警表导出时已按报告期圈定，这里只是防守）
    if (index >= 0) counts[index] += 1;
  }

  if (nonEmpty > 0 && parsed === 0) {
    throw new Error(
      `告警表的「${EARLIEST_OCCURRENCE_COLUMN}」列有时间值（${nonEmpty} 行非空），`
      + '但一个都认不出是日期 —— 平台可能改了时间的格式（取值层只认「日期文本」与'
      + '「epoch 秒」两种形态，见 stats/metrics/rows.js 的 cellDateOnly）；'
      + '这里不能静默数出 0，那与"一条都没有"长得一模一样（CELL_REGISTRY.md H6 / MIGRATION.md R10）'
    );
  }

  return { labels, counts };
}

/**
 * 第 index 个槽位（从 0 起）的告警行数（C75:N75）；槽位越界（报告期不足 12 个月时
 * 空出来的那几格）时是**空串** —— 那个槽位没有对应的月份。
 *
 * 月份标签不在这里读 —— 75 行没有自己的标签行，用的是 C71:N71 那一行（同一条月份轴）。
 */
function monthlyAlarmCountAt(ctx, index) {
  const series = monthlyAlarmSeries(ctx);
  if (index >= series.labels.length) return '';

  return series.counts[index];
}

/**
 * 指定 IP 集合上「真实攻击未成功」的告警行数 —— G6/H6/I6 的第二段（H4：三格共用一份）。
 *
 * 第一段（核心业务系统名 -> 资产表「所属业务」-> IP 集合）在
 * stats/metrics/core_system.js 的 coreSystemThreatAlarmTotalAt，那里把两段串成一步。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number|string} 见 countGptVerdictHits
 */
function gptVerdictAlarmCountOnIps(ctx, ips) {
  return countGptVerdictHits(ctx, ips);
}

module.exports = {
  QUALIFICATION_COLUMN,
  ALARM_TABLE_COLUMNS,
  GPT_VERDICT_COLUMN,
  GPT_VERDICT_MISSING_TEXT,
  HOST_IP_COLUMN,
  GPT_VERDICT_HIT,
  DIRECTION_COLUMN,
  EARLIEST_OCCURRENCE_COLUMN,
  OUTBOUND_DIRECTION,
  alarmRowCount,
  qualificationRanking,
  qualificationLabelAt,
  qualificationShareAt,
  gptVerdictAlarmCount,
  gptVerdictAlarmCountOnIps,
  outboundAlarmCount,
  monthlyAlarmSeries,
  monthlyAlarmCountAt
};
