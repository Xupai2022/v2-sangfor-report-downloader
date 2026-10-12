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
 * 业务系统 IP 集合里圈定），所以也落在本文件。
 */

const { buildRanking, labelAt, shareAt } = require('./ranking');
const { requireColumn, cellText, normalizeIp } = require('./rows');

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
 * （与 D15「处置完成」那条精确相等的分界同一条思路，见 stats/metrics/vuln.js）。
 * 实测同一列的其它取值形如「等待GPT研判」「主机失陷活动」「-」，一个都不算命中。
 */
const GPT_VERDICT_HIT = '真实攻击未成功';

/**
 * 告警表要读进 ctx 的列白名单：**两处需要的并集**（H4 之外的读取层约定）。
 *
 * 读告警表的有两处：告警定性那 14 格（要「告警定性」）与 G5/G6/H6/I6（要「GPT研判结论」，
 * 后三格另要「主机IP」）。并成一次读，见 mssw_downloader.js 的 readAlarmRows ——
 * 读两遍不只是白解析十万行，后一遍还会把前一遍的行对象盖掉。
 */
const ALARM_TABLE_COLUMNS = [QUALIFICATION_COLUMN, GPT_VERDICT_COLUMN, HOST_IP_COLUMN];

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
 * @returns {number} 行数；告警表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *   scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出）
 * @throws {Error} 有行数据、但表头里没有「GPT研判结论」列（列名对不上，不许静默数出 0）；
 *   按 IP 圈定时另要求「主机IP」列存在 —— 缺了它，集合与行的比对无从谈起，
 *   那时安静返回 0 会被读成"这些系统上一条这样的告警都没有"。
 */
function countGptVerdictHits(ctx, ips) {
  const rows = ctx && ctx.alarmRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, GPT_VERDICT_COLUMN, '告警表');
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
 * @returns {number} 见 countGptVerdictHits
 */
function gptVerdictAlarmCount(ctx) {
  return countGptVerdictHits(ctx, undefined);
}

/**
 * 指定 IP 集合上「真实攻击未成功」的告警行数 —— G6/H6/I6 的第二段（H4：三格共用一份）。
 *
 * 第一段（核心业务系统名 -> 资产表「所属业务」-> IP 集合）在
 * stats/metrics/core_system.js 的 coreSystemThreatAlarmTotalAt，那里把两段串成一步。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 见 countGptVerdictHits
 */
function gptVerdictAlarmCountOnIps(ctx, ips) {
  return countGptVerdictHits(ctx, ips);
}

module.exports = {
  QUALIFICATION_COLUMN,
  ALARM_TABLE_COLUMNS,
  GPT_VERDICT_COLUMN,
  HOST_IP_COLUMN,
  GPT_VERDICT_HIT,
  qualificationRanking,
  qualificationLabelAt,
  qualificationShareAt,
  gptVerdictAlarmCount,
  gptVerdictAlarmCountOnIps
};
