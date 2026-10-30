'use strict';

/**
 * 报告期 / 重要时期的日期处理。
 * CELL_REGISTRY.md §8 把本模块定位为「日期区间 / 重要时期切分」。
 *
 * 现在有三件事：
 *   · `formatReportDate` 那一组格式化（L1 / M1 两个报告参数格用）
 *   · `monthRange`（C58:N59「按月平均响应时长」的月份桶，用户口径 2026-10-14）
 *     与它的逐月时间段版 `monthPeriods`（C71:N72「外部攻击数」逐月调接口的日期范围，
 *     用户口径 2026-10-20 —— 两个函数共用同一条月份轴）
 *   · `importantPeriods`（重要时期 = 报告期 ∩ 法定节假日放假整段，用户口径 2026-10-14）
 *
 * ⚠️ **重要时期（= 重保，重要节假日）与护网时间无关。** 重要时期（本模块）只算节假日，
 * 与 CLI 的 `--protect-start` / `--protect-end`（护网时间）无关（用户口径 2026-10-14 原话：
 * 「重要时期与 cli 传入的重保时间无关」；2026-10-27 起那两个参数只叫**护网时间**）。
 * 报告里的 M3「护网时间」走的是 ctx.protectRange，是另一回事。
 *
 * ⚠️ 重要时期**已经有格子消费它**（2026-10-15 接线）：D27「重要时期安全日志数」在**下载层**
 * 按段发日志量请求（mssw_downloader.js 的 readImportantPeriodLogCount），
 * D28「重要时期告警数」/ D29「重要时期事件数」在**取值层**按段过滤行
 * （stats/metrics/important_period.js）。三格口径见 stats/cells/_baseline.js。
 * 同一批里 D90/D91、F91:H97 已在 2026-10-26 转正（口径见各文件头注）；
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
 * ⚠️ 同理 `monthRange` 输出的是**短横**的 `2026-07`，那是**桶键**不是给人看的日期，
 * 而且必须与预处理写进事件表「事件创建月份」列的形态逐字相等（不相等就一个桶都落不进去）。
 * 两种写法各有各的下游，别顺手统一。
 */

const { HOLIDAYS, COVERAGE_START, COVERAGE_END } = require('./holidays');

/** 只认纯日期字符串，不走 Date：避免时区把日期挪一天 */
const DATE_ONLY = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;

/** 同上，只到月份（`2026-07`）—— 月份桶键的输入形态之一 */
const MONTH_ONLY = /^(\d{4})[-/](\d{2})$/;

/** C58:N59 的槽位数：月份桶最多 12 个（用户口径 2026-10-14「超过12个月就取最晚的12个月」）。 */
const MAX_MONTHS = 12;

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

/**
 * 一个日期值 -> `{year, month}`（month 从 1 起）。
 *
 * 字符串走**纯文本解析**、不经过 Date：`new Date('2026-07-01')` 按 UTC 解析，
 * 在负偏移时区上本地月会退到上一个月 —— 而「报告期切月份」这件事上退一个月就是
 * 整列错位。这与 formatReportDate 里那条同样口径的短路是同一个理由。
 * Date 对象只能走本地 getter（拿不到原始文本），与 formatReportDate 的兜底分支一致。
 */
function monthParts(value, fieldName) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`monthRange 收到非法日期: ctx.range.${fieldName} = ${value}`);
    }
    return { year: value.getFullYear(), month: value.getMonth() + 1 };
  }

  if (value === null || value === undefined || value === '') {
    throw new Error(`monthRange 收到空值: ctx.range.${fieldName} = ${JSON.stringify(value)}`);
  }

  const text = String(value).trim();
  const matched = MONTH_ONLY.exec(text) || DATE_ONLY.exec(text);
  if (!matched) {
    throw new Error(`monthRange 收到认不出的日期: ctx.range.${fieldName} = ${JSON.stringify(value)}`);
  }

  const month = Number(matched[2]);
  if (month < 1 || month > 12) {
    throw new Error(`monthRange 收到非法月份: ctx.range.${fieldName} = ${JSON.stringify(value)}`);
  }
  return { year: Number(matched[1]), month };
}

/**
 * 报告期 -> **连续**的月份桶键（`['2026-07','2026-08','2026-09']`）。
 *
 * 用户口径 2026-10-14：C58:N59「按月平均响应时长」按传入的时间起止划分月份 ——
 * 起止两端所在的那两个月**都算在内、中间一个月不落**（2026-07-15 ~ 2026-09-10 是三个桶，
 * 不是"只算整月"的零个或两个）。
 *
 * ⚠️ **超过 12 个月取最晚的 12 个**（用户口径原文）。C58:N59 只有 12 个槽位，
 * 报告期短于 12 个月时多出来的槽位由取值层写空串（标签与值都空，用户口径）；
 * 长于 12 个月时**丢的是最早的那几头**，因为报告期越近的数据越要紧。
 * 截断就在这里做、只做一次 —— 取值层拿到的就是这个已经定长的序列（H4）。
 *
 * ⚠️ **不按事件表里的月份补齐**：这个函数的输入只有报告期，与表里有没有那个月的数据无关。
 * 某个月一行事件都没有时，它仍然是序列里的一格、只是取值层的均值落 0（用户口径 2026-10-14
 * 「写 0」），而不是整个桶消失 —— 桶消失会让后面所有月份整体左移一位。
 *
 * @param {Date|string} start 报告期起（ctx.range.start）
 * @param {Date|string} end 报告期止（ctx.range.end），闭区间
 * @returns {string[]} 月份桶键，`YYYY-MM`（**短横**，与预处理写进事件表「事件创建月份」
 *   列的形态逐字相等）；长度 1..12，按时间升序，最后一个就是报告期止所在的那个月
 * @throws {Error} 任一端取不到合法年月、或起止倒置（ctx 构造时 normalizeRange 已经挡过一道，
 *   这里是防守）
 */
function monthRange(start, end) {
  const from = monthParts(start, 'start');
  const to = monthParts(end, 'end');

  const first = from.year * 12 + (from.month - 1);
  const last = to.year * 12 + (to.month - 1);
  if (last < first) {
    throw new Error(`monthRange 起止倒置: ${from.year}-${pad2(from.month)} > ${to.year}-${pad2(to.month)}`);
  }

  const begin = Math.max(first, last - (MAX_MONTHS - 1));
  const labels = [];
  for (let index = begin; index <= last; index += 1) {
    // 年份不补零（与 formatReportDate 的 `${date.getFullYear()}` 同一写法）
    labels.push(`${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`);
  }
  return labels;
}

/** 某年某月的天数（month 从 1 起）。只走本地 Date，不碰时区换算。 */
function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * 报告期里的某一端 -> 纯日期。只到月份的输入按端补成月初 / 月末
 * （`monthRange` 认 `YYYY-MM`，本函数与它同一把尺子；ctx 里那一端永远是 Date）。
 */
function boundaryDate(value, fieldName, edge) {
  if (value instanceof Date) return toDateOnly(value, fieldName);

  const text = value === null || value === undefined ? '' : String(value).trim();
  const matched = MONTH_ONLY.exec(text);
  if (matched) {
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    if (month < 1 || month > 12) {
      throw new Error(`monthPeriods 收到非法月份: ${fieldName} = ${JSON.stringify(value)}`);
    }
    const day = edge === 'start' ? 1 : lastDayOfMonth(year, month);
    return `${matched[1]}-${matched[2]}-${pad2(day)}`;
  }
  return toDateOnly(value, fieldName);
}

/**
 * 报告期 -> **逐月的时间段**：`[{label, start, end}]`（`YYYY-MM-DD` 闭区间）。
 *
 * C71:N72「外部攻击数（按月）」的取数范围（用户口径 2026-10-20）：这一块与 C58:N59
 * 共用同一条月份轴 —— `label` 就是 `monthRange` 的输出（含首尾两端所在的那两个月、
 * 超过 12 个月取最晚的 12 个），本函数只把每个桶翻译成**发给接口的那一对日期**：
 *
 *   · **首月从报告期的起始日算起**（报告期 2026-01-15 起 -> 2026-01 那段是 01-15 ~ 01-31，
 *     不是整月）—— 用户原话「首尾月要限定在输入的时间范围里」；
 *   · **末月到报告期的结束日为止**（2026-03-10 止 -> 2026-03 那段是 03-01 ~ 03-10）；
 *   · 中间各月就是整月（月初 ~ 月末）。
 *
 * 逐月下发与 `monthRange` 逐字对齐：两个函数的桶清单来自同一次 `monthRange` 调用，
 * 所以「第 N 个槽位」在哪一边都是同一个月（取值层按槽位取，H4）。
 *
 * @param {Date|string} start 报告期起（ctx.range.start）
 * @param {Date|string} end   报告期止（ctx.range.end），闭区间
 * @returns {Array<{label: string, start: string, end: string}>} 升序，长度 1..12
 * @throws {Error} 任一端取不到合法日期 / 起止倒置（同 monthRange）
 */
function monthPeriods(start, end) {
  const labels = monthRange(start, end);
  const from = boundaryDate(start, 'ctx.range.start', 'start');
  const to = boundaryDate(end, 'ctx.range.end', 'end');

  return labels.map((label) => {
    const [year, month] = label.split('-').map(Number);
    const monthStart = `${label}-01`;
    const monthEnd = `${label}-${pad2(lastDayOfMonth(year, month))}`;
    return {
      label,
      start: monthStart < from ? from : monthStart,
      end: monthEnd > to ? to : monthEnd
    };
  });
}

/**
 * Date | 'YYYY-MM-DD' | 'YYYY/MM/DD' -> `YYYY-MM-DD`（短横，纯文本）。
 *
 * 由 `importantPeriods`（报告期）与 stats/metrics/important_period.js 的 D130
 * （HW 起止时间，ctx.protectRange）共用 —— 两个消费方的入参都可能是 Date（ctx 里那一端
 * 永远是 Date）或纯日期文本，归一口径只留这一处（H4）。
 *
 * ⚠️ 输出**短横**、与 `formatReportDate` 的**斜杠**不同 —— 这不是笔误：
 * 本函数的输出是拿去跟 stats/holidays.js 那张表（短横）逐字比较的**机器形态**，
 * 不是给人看的日期。给人看的形态由消费它的那格自己用 formatReportDate /
 * formatReportDateRange 转（那才是斜杠）。两种写法各有各的下游，别顺手统一。
 *
 * Date 对象只走本地 getter（`getFullYear/getMonth/getDate`），不走 toISOString ——
 * `toISOString` 是 UTC，在负偏移时区上会把日期退回前一天，与 monthParts 里那条
 * 同样口径的说明是同一个理由。
 */
function toDateOnly(value, fieldName) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`importantPeriods 收到非法日期: ${fieldName} = ${value}`);
    }
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }

  if (value === null || value === undefined || value === '') {
    throw new Error(`importantPeriods 收到空值: ${fieldName} = ${JSON.stringify(value)}`);
  }

  const matched = DATE_ONLY.exec(String(value).trim());
  if (!matched) {
    throw new Error(`importantPeriods 收到认不出的日期: ${fieldName} = ${JSON.stringify(value)}`);
  }
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

/**
 * 重要时期 = 报告期 ∩ 中国法定节假日放假整段（用户口径 2026-10-14）。
 *
 * 产出**逐节日一条、带名字**，每条都已裁到报告期内 —— 不是裁完再合并成一大块。
 * 用户给的两个例子（原话）：
 *
 *   报告期 2026-09-30 ~ 2026-10-10  ->  国庆节 2026-10-01 ~ 2026-10-07（整段落在期内）
 *   报告期 2026-09-24 ~ 2026-10-05  ->  中秋节 2026-09-25 ~ 2026-09-27（整段在期内）
 *                                       ＋ 国庆节 2026-10-01 ~ 2026-10-05（右端被切）
 *
 * 四条规则：
 *   · 完全落在报告期内 -> 原样返回
 *   · 一头被切        -> 只留相交那段（上例第二条的国庆）
 *   · 与报告期不相交  -> 不出现（上例第一条里的中秋节）
 *   · 一个都不相交    -> 返回空数组（那是结论，不是缺数）
 *
 * ⚠️ **裁剪是按节日各自的段做的**，两条各留各的、不会因为挨着就并成一条
 * （2026-09-24~10-05 那次中秋与国庆只隔三天，仍是两条）。
 *
 * ⚠️ 假期表只覆盖 2025-01-01 ~ 2028-12-31，**报告期任一端越界就抛错**，不静默返回空 ——
 * 「表里没有这个年」和「这一年真的没有节假日」的结果长得一模一样，悄悄返回空会让报告
 * 少算都不吭声（R10 / H6 缺数不静默）。表不够就往下续表，见 stats/holidays.js。
 *
 * @param {Date|string} start 报告期起（ctx.range.start），闭区间
 * @param {Date|string} end   报告期止（ctx.range.end），闭区间
 * @returns {Array<{name: string, start: string, end: string, source: string}>}
 *   按时间升序，`start`/`end` 是**短横**的 `YYYY-MM-DD`（裁后，见 toDateOnly）；
 *   `source` 是假期表的来源标记，'inferred' 表示那条是惯例推测、待官方核定
 * @throws {Error} 任一端取不到合法日期、起止倒置、或报告期越出假期表覆盖范围
 */
function importantPeriods(start, end) {
  const from = toDateOnly(start, 'ctx.range.start');
  const to = toDateOnly(end, 'ctx.range.end');

  if (from > to) {
    throw new Error(`importantPeriods 起止倒置: ${from} > ${to}`);
  }

  // 越界即抛，两个方向都抛（早于表、晚于表）。用户口径只说「不会查 2025 年以前的」，
  // 但这里**不按那个方向放宽**：报告期会随时间往后走，晚于表的那个方向迟早会碰上，
  // 而早于表的那个方向放宽就成了"两个方向行为不同"，更容易被误读成"这段真没节假日"。
  if (from < COVERAGE_START || to > COVERAGE_END) {
    throw new Error(
      `重要时期：报告期 ${from} ~ ${to} 超出法定节假日表覆盖范围 `
      + `${COVERAGE_START} ~ ${COVERAGE_END} —— 表不够用，需补表（stats/holidays.js），`
      + '不能静默当作"这段没有节假日"'
    );
  }

  const periods = [];
  for (const holiday of HOLIDAYS) {
    // 纯文本比较：YYYY-MM-DD 的字典序就是时间序，不必走 Date（时区一碰就挪一天）
    const clippedStart = holiday.start > from ? holiday.start : from;
    const clippedEnd = holiday.end < to ? holiday.end : to;
    if (clippedStart > clippedEnd) continue;

    periods.push({
      name: holiday.name,
      start: clippedStart,
      end: clippedEnd,
      source: holiday.source
    });
  }
  return periods;
}

/**
 * 在一段 `YYYY-MM-DD` 日期上加减天数，回同一形态的字符串（短横、补零）。
 *
 * 唯一消费方是 D129「HW及前一周已加固中高危漏洞数」—— 它要把 `--protect-start`
 * 往前推 7 天当窗口起点。与 toDateOnly 的区别：那个负责**归一**（Date / 文本 ->
 * 机器形态），这个负责**算日期**，入参必须已经是 toDateOnly 的产物。
 *
 * 用 UTC 那一套 getter/setter 做纯日历运算（不经过 toISOString、不碰本地时区）：
 * 这里处理的是"年月日"本身，不是某个时刻，跨月 / 跨年 / 闰年都由 Date 兜住。
 *
 * @param {string} dateOnly `YYYY-MM-DD`
 * @param {number} days 可正可负
 * @returns {string} `YYYY-MM-DD`
 * @throws {Error} 入参不是 `YYYY-MM-DD`、或 days 不是整数
 */
function shiftDays(dateOnly, days) {
  const matched = DATE_ONLY.exec(String(dateOnly));
  if (!matched) {
    throw new Error(`shiftDays 收到认不出的日期: ${JSON.stringify(dateOnly)}`);
  }
  if (!Number.isInteger(days)) {
    throw new Error(`shiftDays 收到非整数天数: ${JSON.stringify(days)}`);
  }
  const date = new Date(Date.UTC(
    Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])
  ));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * 一段 `YYYY-MM-DD` 闭区间里有几天（首尾都算）：`2026-09-25` ~ `2026-09-27` = 3 天。
 *
 * 消费方是 G91:G97「日均攻击数」—— 每格 = 那一段的重要时期日志量 ÷ 这一段的天数
 * （见 stats/metrics/important_period.js 的 importantPeriodDailyAverageAt）。
 *
 * 与 shiftDays 一样用 UTC 那一套做纯日历运算：这里算的是"年月日"之差，不是时刻之差，
 * 所以不受本地时区 / 夏令时影响。
 *
 * @param {string} start `YYYY-MM-DD`
 * @param {string} end `YYYY-MM-DD`
 * @returns {number} 天数（闭区间，>= 1）
 * @throws {Error} 入参不是 `YYYY-MM-DD`、或起止倒置
 */
function inclusiveDayCount(start, end) {
  const startMatched = DATE_ONLY.exec(String(start));
  const endMatched = DATE_ONLY.exec(String(end));
  if (!startMatched) {
    throw new Error(`inclusiveDayCount 收到认不出的开始日期: ${JSON.stringify(start)}`);
  }
  if (!endMatched) {
    throw new Error(`inclusiveDayCount 收到认不出的结束日期: ${JSON.stringify(end)}`);
  }
  const startUtc = Date.UTC(Number(startMatched[1]), Number(startMatched[2]) - 1, Number(startMatched[3]));
  const endUtc = Date.UTC(Number(endMatched[1]), Number(endMatched[2]) - 1, Number(endMatched[3]));
  if (startUtc > endUtc) {
    throw new Error(`inclusiveDayCount 起止倒置: ${start} > ${end}`);
  }
  return (endUtc - startUtc) / 86400000 + 1;
}

module.exports = {
  formatReportDate,
  formatReportDateRange,
  monthRange,
  monthPeriods,
  importantPeriods,
  toDateOnly,
  shiftDays,
  inclusiveDayCount,
  MAX_MONTHS
};
