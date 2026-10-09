'use strict';

/**
 * 报告期 / 重保期的日期处理。
 * CELL_REGISTRY.md §8 把本模块定位为「日期区间 / 重保切分」。
 *
 * 目前只有格式化，没有区间切分 —— 切分要给 D90/D91 那几个按重保期拆分的格子用，
 * 那些格子的口径还没定（mode:'unresolved'），所以先不做。
 *
 * ---------------------------------------------------------------------------
 * 为什么输出 YYYY/MM/DD（斜杠）而不是 YYYY-MM-DD
 * ---------------------------------------------------------------------------
 * 这是**口径决定**，不是随手选的：用户 2026-09-23 定「跟老仓库用 2026/09/12」。
 * 同一份报告里会同时出现两种写法，这是刻意的：
 *
 *   - 「数据统计」sheet 的 L1/M1（本模块）→ 2026/09/12   斜杠
 *   - PPT 封面的 period_start/period_end（引擎那边）→ 2026-09-12  短横
 *
 * 别为了"统一"把这里改成短横 —— 那会改掉交付物上肉眼可见的形态。
 */

/** 只认纯日期字符串，不走 Date：避免时区把日期挪一天 */
const DATE_ONLY = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Date | 'YYYY-MM-DD' | 'YYYY/MM/DD' -> 'YYYY/MM/DD'
 *
 * 取不到合法日期时**抛错**，不返回空串（MIGRATION.md R10 / CELL_REGISTRY.md H6：
 * 缺数不静默）。ctx 构造时 normalizeRange 已经保证 range 里的日期合法，
 * 所以这里的抛错是防守，正常跑不到。
 *
 * @param {Date|string} value
 * @returns {string}
 */
function formatReportDate(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error(`formatReportDate 收到空值: ${JSON.stringify(value)}`);
  }

  const text = String(value).trim();
  const matched = DATE_ONLY.exec(text);
  if (matched) {
    return `${matched[1]}/${matched[2]}/${matched[3]}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatReportDate 收到非法日期: ${JSON.stringify(value)}`);
  }
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`;
}

/**
 * 起止两端 -> '起-止'（如 '2026/05/12-2026/05/13'）。
 * 两端都用同一个 formatReportDate，所以格式与单日期一致。
 */
function formatReportDateRange(start, end) {
  return `${formatReportDate(start)}-${formatReportDate(end)}`;
}

module.exports = { formatReportDate, formatReportDateRange };
