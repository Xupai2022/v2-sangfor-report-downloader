'use strict';

/**
 * 读取层行对象的共用小工具 —— CELL_REGISTRY.md §7（C4–C7）在取值层的落点。
 *
 * 这一份不是**数据域**（§8 里 event / alarm / vuln / … 那些是域），而是四个域文件
 * 都要用的那几句判空与归一：列在不在、单元格文本怎么取、IP 怎么对齐、时间格落在哪一天。
 * 放在 metrics/ 是因为它只服务 metrics/ 与 cells/，别的层不碰它。
 *
 * 四条规矩的来由都在 §7 里（C4 按表头文字取、C5 列存在性、C7 时间单位），这里只实现：
 *   1. 按**表头文字**取列，绝不按列下标（C4）
 *   2. 「列不在」和「列在但整列为空」是两件事：前者抛错，后者交给调用方安静处理（C5）
 *   3. IP 两侧用同一把尺子量（见 normalizeIp 的说明）
 *   4. 时间格还原成「哪一天」时，epoch 秒走 UTC、文本取日期前缀（见 cellDateOnly 的说明）
 */

/**
 * 这一列**在不在**（C5 的判据，不抛版）。
 *
 * 与 requireColumn 同一句检查，只是把答案交回调用方：有些格子对"缺列"有自己的落法
 * （用户口径 2026-10-19：告警表缺「GPT研判结论」时 G5/G6/H6/I6 写一句**结论文字**，
 * 那不是缺数、也不记错误），这时不能直接抛。
 *
 * ⚠️ 判据同 requireColumn：**至少有一行**带这个键。空数组一律返回 false ——
 * 调用方本来就有"表为空 -> 0"的短路，别用这个函数去区分"空表"与"缺列"。
 *
 * @param {Array<Object>} rows 行对象数组（契约见 scripts/parse_table_rows.py 头注）
 * @param {string} column 表头文字
 * @returns {boolean}
 */
function hasColumn(rows, column) {
  return Array.isArray(rows) && rows.some(
    (row) => row && Object.prototype.hasOwnProperty.call(row, column)
  );
}

/**
 * 「这一列在不在」的防线（C5）。
 *
 * 读表时请求了某列而表头没有它，**一行都不会带这个键** —— 于是 `row['威胁标签']`
 * 恒为 undefined，过滤条件恒为假，结果安静地数出 0，报告看着完全正常（R10 说的
 * 「缺数不静默」就是为了拦这个）。所以：有行数据、却没有任何一行带这个键 = 列名对不上，
 * 抛错，别算。
 *
 * ⚠️ 判据是"**至少有一行**带这个键" —— 这一版对**同一张 sheet 读出来的行**恰好够用
 * （表头只有一行，键要么全有要么全无），但**撑不住做行键集不一致的表**：
 *   · 设备列表那种接口 JSON 行，本来就可能某几行带 `devType`、某几行不带（合法的）；
 *   · 漏洞表 2026-10-16 起是**两份 sheet 拼起来**的（列集 30 / 21 列都不一样）。
 * 后一种要用 [requireColumnInEveryRow](#requireColumnInEveryRow)。
 *
 * @param {Array<Object>} rows 行对象数组（契约见 scripts/parse_table_rows.py 头注）
 * @param {string} column 表头文字
 * @param {string} tableLabel 报错文案里的表名，如「漏洞表」
 * @throws {Error} 所有行都不带这个键时
 */
function requireColumn(rows, column, tableLabel) {
  if (!hasColumn(rows, column)) {
    throw new Error(
      `${tableLabel}里找不到「${column}」列：${rows.length} 行数据没有一行带这个表头，`
      + '平台可能改了列名（禁止按列下标取，见 CELL_REGISTRY.md §7 C4）'
    );
  }
}

/**
 * 「**每一行**都带这一列」的加强版 —— 只给**由多份 sheet 拼起来的行数组**用（漏洞表）。
 *
 * 为什么非要有这一版：拼接出来的行数组里，两份 sheet 的行键集本来就可以不同
 * （内网 30 列、外网 21 列，白名单里那几列由各自的表头决定）。这时用上面那条
 * 「有一行带就算有」，漏掉的恰好是最要命的一种：
 *   · 外网那份缺「处置状态」、内网那份带着 -> 旧判据放行，D15 只数内网那几行、
 *     静默少一批，报告上完全看不出来。
 * 逐行判之后，"某一份缺列"与"两份都缺"同样当场抛（C5/R10 的防线照旧成立）。
 * 同一张 sheet 读出来的行是齐的（表头只有一行），所以对单-sheet 的漏洞表也与
 * 旧判据等价。
 *
 * 空数组不管（调用方本来就有"表为空 -> 0"的短路）—— 这里只回答"缺列了没有"。
 *
 * @param {Array<Object>} rows 行对象数组（契约见 scripts/parse_table_rows.py 头注）
 * @param {string} column 表头文字
 * @param {string} tableLabel 报错文案里的表名，如「漏洞表」
 * @throws {Error} 有行不带这个键时（= 其中一份 sheet 的表头里没有这一列）
 */
function requireColumnInEveryRow(rows, column, tableLabel) {
  const missing = rows.filter(
    (row) => !row || !Object.prototype.hasOwnProperty.call(row, column)
  ).length;
  if (missing === 0) return;

  const detail = missing === rows.length
    ? `${rows.length} 行数据没有一行带这个表头`
    : `${rows.length} 行里有 ${missing} 行不带这个表头（漏洞表是多份 sheet 拼起来的，`
      + '这通常意味着其中一份的表头少了这一列 —— 漏算它们同样安静，所以按缺列处理）';
  throw new Error(
    `${tableLabel}里找不到「${column}」列：${detail}，`
    + '平台可能改了列名（禁止按列下标取，见 CELL_REGISTRY.md §7 C4）'
  );
}

/** 单元格值 -> 去首尾空白的文本；空值 / 缺值都给空串（读表层已把空格子写成 ''）。 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 单元格值 -> IP 比对用文本。
 *
 * **与 scripts/report_preprocess.py 的 normalize_ip 是同一把尺子**（刻意的镜像，
 * 那边处理事件表的「影响资产」查映射、这边处理取值层，两边都必须认同一串 IP
 * 才算同一个 IP）：
 *   1. 去首尾空白
 *   2. 剥掉末尾的括号说明 —— 平台实测会给出 `33.33.35.57(未归类组)` 这种形态，
 *      剥完为空（整格就是个括号说明）就退回原值，不做无中生有
 *   3. 转小写 —— IPv6 的十六进制按 RFC 4291 大小写不敏感，两张表一处大写一处小写
 *      不该算成两个 IP
 *
 * ⚠️ **剥只发生在比对这一刻**：报告「告警表」sheet 上的「主机IP」是平台原样
 * （带括号那种）—— 2026-10-12 起合并阶段不再做清洗，所以这里剥掉的量没有任何
 * "上游已经剥过"可以依赖，本函数自己剥全（从前有一处合并阶段的剥后缀与它分工，
 * 那一步已删除）。
 *
 * 不做其它规范化（不去前导零、不展开 `::`）：两张表同源，逐字相等就是相等，
 * 多做的规范化反而会把两个真的不同的地址并成一个。
 */
function normalizeIp(value) {
  const text = cellText(value);
  if (!text) return '';
  const stripped = text.replace(/[（(][^）)]*[）)]\s*$/, '').trim();
  return (stripped || text).toLowerCase();
}

/** 占位符：`-` / `—` / `－`（全角）/ `–`（短破折）—— 与 report_preprocess.py 同一把尺子。 */
const DATE_PLACEHOLDER = /^[-—－–]+$/;

/** 纯数字文本、且长到不像年份（`^\d{9,}$`）—— 数值列被平台导成文本时的 epoch 秒形态。 */
const EPOCH_TEXT = /^\d{9,}$/;

/** 日期文本的前缀：`2026-09-30`、`2026/9/30 20:56:18`、`2026-09-30T20:56:18` 都取前三段。 */
const DATE_PREFIX = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/;

/**
 * epoch 秒的可信区间 —— 2000-01-01 ~ 2100-01-01。
 *
 * 目的是把**裸序列号**（Excel 的日期序列，2026 年形如 `46000` 上下）挡在外面：那种值
 * 当 epoch 秒硬解会得到一个 1970 年的日期，看着像个正经答案、其实是胡说。落进这个区间
 * 之外的数字一律当"认不出"（回 null），由调用方那条"整列都解析不出就抛"的防线兜住。
 */
const EPOCH_MIN = Date.UTC(2000, 0, 1) / 1000;
const EPOCH_MAX = Date.UTC(2100, 0, 1) / 1000;

/**
 * 单元格值 -> `'YYYY-MM-DD'`（短横）或 `null`。
 *
 * ⚠️ **这是取值层唯一的日期解析器**（2026-10-15，为 D28/D29 建的）。建它是因为告警表
 * 与事件表的**同一件事有两种形态**，而两张表的可用解析器不一样：
 *
 *   1. **epoch 秒**（数字）—— 事件表「事件创建时间」是平台导出的真 datetime，经
 *      `scripts/parse_table_rows.py` 的 `format_cell_value` 转成了 epoch 秒。
 *      ⚠️ **还原必须走 UTC**（`toISOString`）：那边把 naive datetime **当 UTC** 转，
 *      用本地 getter（getFullYear/getMonth/getDate 或 toLocaleDateString）在 +08:00 上
 *      会把 00:00~08:00 段的时间退回**前一天** —— 与 stats/periods.js 的 toDateOnly
 *      里那条同样口径的说明是同一个理由。
 *   2. **日期文本**（字符串）—— 告警表「最早发生时间」实测是 `'2026-09-30 20:56:18'`
 *      （openpyxl `data_type='s'`）。只取前缀那三段，时分秒丢掉（本函数只回答"哪一天"）。
 *
 * ⚠️ **与 stats/metrics/event.js 的 `CREATE_MONTH_COLUMN` 那段告诫的关系**：
 * 那边说取值层不解析日期，因为平台的**事件表时间列有三种形态**（文本 / 真 datetime /
 * 裸序列号），只有预处理的 `parse_time_cell` 三种全认。本函数**只服务 D28/D29 的
 * "落在哪一天"**，吃的是**已经被上游归一过**的两种形态（告警表本来就没有预处理环节，
 * 那列也不在 `parse_time_cell` 的覆盖面上）。别把它当成通用时间解析器往别处接 ——
 * 凡是要"时分秒"或要认裸序列号的地方，仍旧走 scripts/report_preprocess.py。
 *
 * **认不出的一律回 `null`，由调用方跳过该行**（不是抛错）：空值、占位符、区间外的数字、
 * 前缀对不上的文本、月/日超界的文本都算"这一行没给出可用日期"。注意这与 C5 的"整列不在"
 * 是两回事：列整根不在仍由 requireColumn 拦。而"整列都在、却一个都解析不出"这一档 ——
 * 那与"一条都没有"长得一模一样 —— 由消费方（stats/metrics/important_period.js）
 * 显式抛错兜住，见那里的说明。
 *
 * @param {*} value 行对象里某一列的原值
 * @returns {string|null} `'YYYY-MM-DD'`（短横，可直接与 stats/periods.js 的
 *   `importantPeriods` 输出的段做字典序比较）；认不出时 `null`
 */
function cellDateOnly(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return epochSecondsToDate(value);
  }

  const text = cellText(value);
  if (!text || DATE_PLACEHOLDER.test(text)) return null;

  // 数值列被导成文本的形态：整串都是数字且够长 —— 当 epoch 秒解
  if (EPOCH_TEXT.test(text)) return epochSecondsToDate(Number(text));

  const matched = DATE_PREFIX.exec(text);
  if (!matched) return null;

  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 补零：`2026/9/30` 也要给出 `2026-09-30`（比较用的是字典序，位数不齐就比错）
  return `${matched[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** epoch 秒 -> `YYYY-MM-DD`；不在 EPOCH_MIN ~ EPOCH_MAX 内（含非有限值）回 null。 */
function epochSecondsToDate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const seconds = Math.trunc(value);
  if (seconds < EPOCH_MIN || seconds >= EPOCH_MAX) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

module.exports = {
  hasColumn,
  requireColumn,
  requireColumnInEveryRow,
  cellText,
  normalizeIp,
  cellDateOnly
};
