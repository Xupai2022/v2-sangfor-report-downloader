'use strict';

/**
 * 「按某一列的值做频次排行」—— 告警定性（C133:I134）与事件定性（C135:I137）共用的实现。
 *
 * 两处是同一套算法，只有数据源（ctx.alarmRows / ctx.eventRows）与列名不同，所以排行逻辑
 * 只留一份（H4：只有被两格以上共用的量才放进 metrics/）。列名与对外函数见
 * stats/metrics/alarm.js 与 stats/metrics/event.js。
 *
 * 三条硬口径（都写在各自的 desc 里，H10）：
 *   · 按行计数，一行一票；一行只有一个值，不拆分、不去重
 *   · 出现次数降序；次数相同时，在**该表**中首次出现的行序靠前的排在前
 *   · 没有值的行不算一项，**也不进占比分母**
 *
 * 缺列的防线（hasOwnProperty）是读取层契约的落点：CELL_REGISTRY.md §7 C4–C7 保证
 * 「列不存在」时一行都不带这个键、「列存在但整列为空」时每行带键且值为空串。所以
 * 「有行数据、但一行都没有这个键」只可能是**列名对不上**，必须抛错 —— 安静地数出 0
 * 与「这段时间真的没有数据」在报告上一模一样，那正是 R10 要防的事。
 */

/**
 * 一格的原始值算不算「没有值」。
 *
 * 除空串外还要认平台的**横杠占位符**：`-` 在 mssw 导出里是列级的「无 / 不适用」标记，
 * 不是一种取值。实测两处：
 *   · 同一份「事件表」里，「IOC」「状态说明」两列 6033 行**全部**是 `-`，
 *     「事件闭环时间」6021 行是 `-`（outputs/20261008_143946）；
 *   · 「GPT定性标签」列本身：华能集团的事件表 2347 行里 2290 行是 `-`（97.6%）。
 * 把 `-` 当成一种定性，报告上就会出现一个叫「-」的威胁类型，甚至是第 1 名。
 *
 * 只认横杠的几种写法（半角、全角、长破折号），别的值一概不猜：像「未知威胁」在告警表里
 * 是真的定性（实测 202 行），把它当占位符会凭空吃掉一整类。
 */
const PLACEHOLDER_RE = /^[-—－–]+$/;

function isBlankValue(raw) {
  if (raw === null || raw === undefined) return true;
  const text = String(raw).trim();
  return text === '' || PLACEHOLDER_RE.test(text);
}

/**
 * 频次排行。
 *
 * @param {Array} rows 总表行对象（键是表头文字，CELL_REGISTRY.md §7）
 * @param {string} column 承载定性 / 标签的表头文字
 * @param {string} tableLabel 表的中文名，只用于错误信息
 * @returns {{items: Array<{label: string, count: number}>, total: number}|undefined}
 *   total 是全部有效值的出现总次数，即占比的分母
 *   （全量，不是前几名之和）。表为空、或所有行都没有值时返回 undefined
 *   —— 缺数不静默（R10 / H6），由写层记入错误列表，绝不填 0。
 * @throws {Error} 有行数据、但没有任何一行带 column 这个键（= 猜错列名）
 */
function buildRanking(rows, column, tableLabel) {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  const hasColumn = rows.some(
    (row) => row && Object.prototype.hasOwnProperty.call(row, column)
  );
  if (!hasColumn) {
    throw new Error(
      `${tableLabel}里找不到「${column}」列：${rows.length} 行数据没有一行带这个表头，`
      + '平台可能改了列名（禁止按列下标取，见 stats/metrics/ranking.js）'
    );
  }

  const tally = new Map();
  let total = 0;

  rows.forEach((row, index) => {
    const raw = row ? row[column] : undefined;
    if (isBlankValue(raw)) return; // 空值 / 占位符不算一项，也不进分母

    const label = String(raw).trim();
    total += 1;
    const hit = tally.get(label);
    if (hit) hit.count += 1;
    else tally.set(label, { label, count: 1, firstSeenAt: index });
  });

  if (total === 0) return undefined; // 有行但一个值都没有，同样是取不到数

  const items = [...tally.values()]
    .sort((left, right) => right.count - left.count || left.firstSeenAt - right.firstSeenAt)
    .map((entry) => ({ label: entry.label, count: entry.count }));

  return { items, total };
}

/**
 * 名次 rank（从 0 起）的名称 / 数量 / 占比。
 *
 * 名次不存在（表里的值不足 rank+1 种）时返回**空串** —— 那个槽位本来就是空的，
 * 不是取不到数。表本身没读到 / 没有值时才由调用方回 undefined（R10 / H6）。
 */
function labelAt(ranking, rank) {
  const item = ranking.items[rank];
  return item ? item.label : '';
}

function countAt(ranking, rank) {
  const item = ranking.items[rank];
  return item ? item.count : '';
}

/** 小数形式，写层按 '0.00%' 落格式（mode: 'percent'）。 */
function shareAt(ranking, rank) {
  const item = ranking.items[rank];
  return item ? item.count / ranking.total : '';
}

module.exports = { PLACEHOLDER_RE, isBlankValue, buildRanking, labelAt, countAt, shareAt };
