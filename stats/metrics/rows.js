'use strict';

/**
 * 读取层行对象的共用小工具 —— CELL_REGISTRY.md §7（C4–C7）在取值层的落点。
 *
 * 这一份不是**数据域**（§8 里 event / alarm / vuln / … 那些是域），而是四个域文件
 * 都要用的那几句判空与归一：列在不在、单元格文本怎么取、IP 怎么对齐。放在 metrics/
 * 是因为它只服务 metrics/ 与 cells/，别的层不碰它。
 *
 * 三条规矩的来由都在 §7 里（C4 按表头文字取、C5 列存在性、C7 时间单位），这里只实现：
 *   1. 按**表头文字**取列，绝不按列下标（C4）
 *   2. 「列不在」和「列在但整列为空」是两件事：前者抛错，后者交给调用方安静处理（C5）
 *   3. IP 两侧用同一把尺子量（见 normalizeIp 的说明）
 */

/**
 * 「这一列在不在」的防线（C5）。
 *
 * 读表时请求了某列而表头没有它，**一行都不会带这个键** —— 于是 `row['威胁标签']`
 * 恒为 undefined，过滤条件恒为假，结果安静地数出 0，报告看着完全正常（R10 说的
 * 「缺数不静默」就是为了拦这个）。所以：有行数据、却没有任何一行带这个键 = 列名对不上，
 * 抛错，别算。
 *
 * @param {Array<Object>} rows 行对象数组（契约见 scripts/parse_table_rows.py 头注）
 * @param {string} column 表头文字
 * @param {string} tableLabel 报错文案里的表名，如「漏洞表」
 * @throws {Error} 所有行都不带这个键时
 */
function requireColumn(rows, column, tableLabel) {
  const hasColumn = rows.some(
    (row) => row && Object.prototype.hasOwnProperty.call(row, column)
  );
  if (!hasColumn) {
    throw new Error(
      `${tableLabel}里找不到「${column}」列：${rows.length} 行数据没有一行带这个表头，`
      + '平台可能改了列名（禁止按列下标取，见 CELL_REGISTRY.md §7 C4）'
    );
  }
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
 * 那边处理事件表、这边处理取值层，两边都必须认同一串 IP 才算同一个 IP）：
 *   1. 去首尾空白
 *   2. 剥掉末尾的括号说明 —— 平台实测会给出 `33.33.35.57(未归类组)` 这种形态，
 *      剥完为空（整格就是个括号说明）就退回原值，不做无中生有
 *   3. 转小写 —— IPv6 的十六进制按 RFC 4291 大小写不敏感，两张表一处大写一处小写
 *      不该算成两个 IP
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

module.exports = { requireColumn, cellText, normalizeIp };
