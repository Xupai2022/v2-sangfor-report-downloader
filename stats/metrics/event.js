'use strict';

/**
 * 事件表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 本文件供两处用：
 *   · 核心业务系统的风险总数（D7/D8/D9）里「事件风险（账号安全类）」那一段；
 *   · 事件定性那 21 格（C135:I137，读「GPT定性标签」的频次排行）。
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');
const { buildRanking, labelAt, countAt, shareAt } = require('./ranking');

/**
 * 「影响资产」的表头文字（要拿去和资产表的 IP 比对）。
 *
 * 依据：`tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx`
 * （平台导出的事件表，2348 行）表头行逐字命中「影响资产」；同一列名也出现在
 * `outputs/20261008_143946/一致性验收客户_report.xlsx` 的「事件表」sheet 表头。
 *
 * ⚠️ 事件表在报告里还会被 scripts/report_preprocess.py 追加一列「内网外网资产」，
 * 但读取层读的是**预处理之前**的中间件（见 WORKFLOW.md §二），所以这里读不到那一列
 * —— 也不该读它。同表「目的IP」列带 `IP(资产组名:xx)` 后缀，取值一律走
 * stats/metrics/rows.js 的 normalizeIp（与预处理同一把尺子）。
 */
const IMPACT_ASSET_COLUMN = '影响资产';

/**
 * 「安全事件二级分类」的表头文字。
 *
 * 依据：同上两份样本的表头。「事件表」26 列里含「分类」的有两列，这里是**二级**分类，
 * 与「安全事件一级分类」（后门攻击事件 / 僵木蠕事件 …）不是一回事，别取错。
 */
const CATEGORY_COLUMN = '安全事件二级分类';

/**
 * 算一条有效事件风险的二级分类关键词（用户口径）：分类里出现其中**任意一个**即可。
 *
 * 判据是子串包含，不是整段相等 —— 实测平台的二级分类是 `Telnet弱口令`、`Web弱口令`、
 * `SSH账号暴力破解` 这种复合词，等值比较会一条都匹配不上；而 `SSH账号暴力破解`
 * 虽然含「账号」，却不含「账号安全」，所以它**不算**（这正是「账号安全」四个字要
 * 整块出现、而不是匹配「账号」的原因）。
 */
const ACCOUNT_RISK_KEYWORDS = ['弱口令', '弱密码', '账号安全'];

/**
 * 指定 IP 集合上、二级分类属账号安全类的事件**行数**。
 *
 * 计数口径：按行计数，一行最多算一条（分类里同时含「弱口令」和「账号安全」不重复算）；
 * 不去重、不按事件名称合并 —— 同一台机器上的同类事件有多少行就是多少条。
 * 不按报告期过滤：事件表导出时已按 --start/--end 取数（见 mssw_downloader.js 的
 * TIME_RANGE_TYPES），本仓取值层不叠加第二道时间过滤。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number|undefined} 行数；事件表没读到（上下文里没有总表）时返回 undefined
 *   —— 缺数不静默（R10/H6），由写层记入错误列表、绝不填 0
 * @throws {Error} 有行数据但表头里没有「影响资产」或「安全事件二级分类」列
 */
function accountRiskEventCount(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  requireColumn(rows, IMPACT_ASSET_COLUMN, '事件表');
  requireColumn(rows, CATEGORY_COLUMN, '事件表');

  let count = 0;
  for (const row of rows) {
    if (!ips.has(normalizeIp(row[IMPACT_ASSET_COLUMN]))) continue;
    const category = cellText(row[CATEGORY_COLUMN]);
    if (ACCOUNT_RISK_KEYWORDS.some((keyword) => category.includes(keyword))) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 事件定性（C135:I137：第 135 行 7 格名称 / 136 行 7 格数量 / 137 行 7 格占比）
// ---------------------------------------------------------------------------

/**
 * 「GPT定性标签」的表头文字 —— 事件定性那 21 格要读的列。
 *
 * 依据（两处独立样本逐字命中，前后无空格，全表唯一）：
 *   · `outputs/20261008_143946/一致性验收客户_report.xlsx` 的「事件表」sheet，26 列表头；
 *   · `tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx` 的
 *     「事件表」sheet，25 列表头（差的那一列是报告预处理追加的「内网外网资产」）。
 * 同一张表另有「GPT研判结论」列，不会误撞。
 *
 * 该列实测是**单值**：两处样本的每一格都不含顿号 / 逗号 / 分号之类的分隔符，
 * 所以「按行计数」就是「按定性计数」，不需要像「威胁标签」那样拆多值。
 *
 * 列名一律按表头文字找，不得按列下标取 —— 事件表的列集同样是数据相关的。
 */
const GPT_LABEL_COLUMN = 'GPT定性标签';

/**
 * 事件表要读进 ctx 的列白名单：**两处需要的并集**。
 *
 * 读事件表的有两处：事件定性那 21 格（要「GPT定性标签」）和核心业务系统的风险总数
 * D7/D8/D9（要「影响资产」「安全事件二级分类」）。并成一次读，见 mssw_downloader.js 的
 * EVENT_TABLE_SPEC —— 读两遍不只是白解析 6000 行，后一遍还会把前一遍的行对象盖掉。
 */
const EVENT_TABLE_COLUMNS = [GPT_LABEL_COLUMN, IMPACT_ASSET_COLUMN, CATEGORY_COLUMN];

/**
 * 「GPT定性标签」的频次排行 —— 第 135 / 136 / 137 三行共用的那个量（H4）。
 *
 * 排序、计数、缺值、缺列防线的口径一律见 stats/metrics/ranking.js 的头注。关键是
 * **占位符 `-` 不算一种定性、也不进分母**：真实事件表里那一列绝大多数行都是 `-`
 * （华能集团样本 2347 行里 2290 行），当成定性的话报告的第 1 名就会是一个横杠。
 *
 * @returns {{items: Array<{label: string, count: number}>, total: number}|undefined}
 *   事件表为空、或所有行都没有定性时返回 undefined（缺数，R10 / H6）。
 * @throws 事件表有数据、但没有任何一行带「GPT定性标签」这一列时抛错（猜错列名的防线）。
 */
function gptRanking(ctx) {
  return buildRanking(ctx && ctx.eventRows, GPT_LABEL_COLUMN, '事件表');
}

/** 排行第 rank 名（从 0 起）的定性名称；名次不存在时空串，事件表无数据时 undefined。 */
function gptLabelAt(ctx, rank) {
  const ranking = gptRanking(ctx);
  return ranking ? labelAt(ranking, rank) : undefined;
}

/** 排行第 rank 名（从 0 起）的出现行数；名次不存在时空串，事件表无数据时 undefined。 */
function gptCountAt(ctx, rank) {
  const ranking = gptRanking(ctx);
  return ranking ? countAt(ranking, rank) : undefined;
}

/**
 * 排行第 rank 名（从 0 起）的占比，小数形式（写层按 '0.00%' 落格式）。
 * 分母是全部定性的出现总次数，不是前几名之和；名次不存在时空串，事件表无数据时 undefined。
 */
function gptShareAt(ctx, rank) {
  const ranking = gptRanking(ctx);
  return ranking ? shareAt(ranking, rank) : undefined;
}

module.exports = {
  IMPACT_ASSET_COLUMN,
  CATEGORY_COLUMN,
  ACCOUNT_RISK_KEYWORDS,
  accountRiskEventCount,
  GPT_LABEL_COLUMN,
  EVENT_TABLE_COLUMNS,
  gptRanking,
  gptLabelAt,
  gptCountAt,
  gptShareAt
};
