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
 */

const { buildRanking, labelAt, shareAt } = require('./ranking');

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
 * @returns {{items: Array<{label: string, count: number}>, total: number}|undefined}
 *   告警表为空、或所有行的定性都为空 / 都是占位符时返回 undefined
 *   —— 缺数不静默（R10 / H6），由写层记入错误列表，绝不填 0。
 * @throws 告警表有数据、但没有任何一行带「告警定性」这一列时抛错
 *   —— 这正是「猜错列名会静默返回 0」的防线：列名对不上就必须炸，而不是安静地数出 0。
 */
function qualificationRanking(ctx) {
  return buildRanking(ctx && ctx.alarmRows, QUALIFICATION_COLUMN, '告警表');
}

/**
 * 排行第 rank 名（从 0 起）的定性名称。
 *
 * @returns {string|undefined} 名次不存在时返回**空串**（该槽位就是空的，不是取不到数）；
 *   告警表无数据时返回 undefined（缺数，R10 / H6）。
 */
function qualificationLabelAt(ctx, rank) {
  const ranking = qualificationRanking(ctx);
  return ranking ? labelAt(ranking, rank) : undefined;
}

/**
 * 排行第 rank 名（从 0 起）的定性占比，小数形式（写层按 '0.00%' 落格式）。
 *
 * 分母是全部定性的出现总次数，不是前若干名之和 —— 所以第 133 行 7 个名称的占比
 * 加起来通常小于 100%。
 *
 * @returns {number|string|undefined} 名次不存在时返回**空串**；告警表无数据时返回 undefined。
 */
function qualificationShareAt(ctx, rank) {
  const ranking = qualificationRanking(ctx);
  return ranking ? shareAt(ranking, rank) : undefined;
}

module.exports = {
  QUALIFICATION_COLUMN,
  qualificationRanking,
  qualificationLabelAt,
  qualificationShareAt
};
