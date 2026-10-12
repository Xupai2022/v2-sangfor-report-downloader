'use strict';

/**
 * 漏洞表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 四处落在本文件：
 *   · 核心业务系统的风险总数（D7/D8/D9）里，「漏洞风险」那一段 = exploitableVulnCount
 *   · D10「高危可利用漏洞数」= highExploitableVulnCount（全表、只认「高可利用」）
 *   · D12「最新漏洞影响资产数」= hotVulnAssetCount（全表、只认「热点漏洞」，按「风险资产」去重）
 *   · D15「已修复漏洞数」= settledVulnCount（全表、只认「处置状态」精确等于「处置完成」的行）
 * D10 与 D12 只差一个关键词、只差归总方式（数行 vs 去重数台），共用 taggedVulnRows；
 * 判据都走下面的 hasAnyTag —— 同一个「标签串包含」动作只写一处（H4）。
 *
 * D10 / D12 / D15 三格读的是**同一张表**、走的是同一套「选哪些行」的骨架 ——
 * 那几步提到 vulnRowsWhere（H4），三格共用，免得三处各写一遍、改一处漏两处。
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');

/**
 * 「风险资产」的表头文字（要拿去和资产表的 IP 比对）。
 *
 * 依据：`tmp/probe_vuln/vuln_raw.xlsx`（平台导出的漏洞表，13301 行）表头行逐字命中
 * 「风险资产」；同一列名也出现在 `outputs/20261008_143946/一致性验收客户_report.xlsx`
 * 的「资产漏洞表」sheet 表头（报告里那张 sheet 就是这张表原样搬进去的）。
 */
const RISK_ASSET_COLUMN = '风险资产';

/**
 * 「威胁标签」的表头文字。
 *
 * 依据：同上两份样本的表头。「资产漏洞表」31 列里只有这一列含「标签」，不会误撞。
 * 取值形态是**顿号分隔的若干标签**，例如 `勒索利用、APT利用、病毒利用、高可利用`，
 * 也可能是空的（实测 13301 行里有 2430 行是空）。
 */
const THREAT_TAG_COLUMN = '威胁标签';

/**
 * 算一条有效漏洞风险的标签（用户口径）：标签里出现其中**任意一个**即可。
 *
 * 判据是「标签串里包含这四个字」，不是「某一整段标签等于它」—— 标签串是顿号拼起来的
 * 一整格文本，`活跃漏洞、高可利用` 里含「高可利用」，就算一条。
 *
 * 「一行只算一条」这条不是空话：实测 `tmp/probe_vuln/vuln_raw.xlsx` 的 13301 行里，
 * 含「高可利用」429 行、含「热点漏洞」79 行，其中 **77 行两者都含** ——
 * 按标签个数算会多算 77 条。
 */
const HIGH_EXPLOITABLE_TAG = '高可利用';
const HOT_VULN_TAG = '热点漏洞';
const EXPLOITABLE_TAGS = [HIGH_EXPLOITABLE_TAG, HOT_VULN_TAG];

/** D10「高危可利用漏洞数」的判据：只要「高可利用」这一个标签，**不含**「热点漏洞」。 */
const HIGH_EXPLOITABLE_ONLY = [HIGH_EXPLOITABLE_TAG];

/** D12「最新漏洞影响资产数」的判据：只要「热点漏洞」这一个标签，**不含**「高可利用」。 */
const HOT_VULN_ONLY = [HOT_VULN_TAG];

/**
 * 「处置状态」的表头文字（D15 要读它）。
 *
 * 依据：`outputs/<各次时间戳>/一致性验收客户_report.xlsx` 的「资产漏洞表」sheet 表头里逐字命中这一列
 * （4 份产物都有；同一张表还有一列叫「处置标签」，是另一码事，本格不读它）。
 */
const DISPOSITION_COLUMN = '处置状态';

/**
 * D15「已修复漏洞数」认的处置状态 —— **精确相等**，不是包含（用户口径）。
 *
 * 口径是这么来的：用户最早列了四种「已处置」的形态（已修复 / 已缓解 / 接受风险 / 忽略），
 * 但实测发现**漏洞表里这几种状态一律记成同一个值**，不带任何括号 ——
 *   · `tmp/probe_vuln/vuln_raw.xlsx` 13301 行：待处置 13286 / 处置完成 15
 *   · `tmp/probe_vuln/vuln_0924.xlsx` 3366 行：待处置 3353 / 处置完成 13
 *   · `tmp/probe_vuln/vuln_sep.xlsx` 7056 行：全部待处置
 *   · `outputs/<各次时间戳>/一致性验收客户_report.xlsx` 的「资产漏洞表」：全部「待处置」
 * 用户据此定的口径是：**只看「处置完成」这一个值，精确匹配**。
 * 所以这里不必列那四个带括号的形式 —— 它们在数据里一条都没有；真出现了也**不算**
 * （`处置完成（已修复）` 与 `处置完成` 不是同一个字符串，见下面的精确相等判据）。
 * 将来平台若真把「处置完成」拆成带括号的几类，那是口径变了，要重新投喂、重新登记。
 *
 * 「处置完成（误报）」同样不在内（与「待处置」一样被排除）。
 */
const SETTLED_DISPOSITIONS = ['处置完成'];

/**
 * 这一行的「威胁标签」里有没有出现给定标签中的任意一个（H4：判据只写这一处）。
 *
 * @param {Object} row 行对象（键是表头文字，见 CELL_REGISTRY.md §7）
 * @param {string[]} tags 关键词
 */
function hasAnyTag(row, tags) {
  const text = cellText(row[THREAT_TAG_COLUMN]);
  return tags.some((tag) => text.includes(tag));
}

/**
 * 指定 IP 集合上、标签含「高可利用 / 热点漏洞」的漏洞**行数**。
 *
 * 计数口径：按行计数，一行最多算一条（同一行里既含高可利用又含热点漏洞不重复算）；
 * 不去重、不按漏洞名称合并 —— 同一台机器上的同一个漏洞被导出多次就是多行。
 * 不按报告期过滤：漏洞表导出时已按平台口径取数（本仓取值层不叠加时间过滤，
 * 与 stats/metrics/alarm.js 的告警定性统计同一口径）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 行数；漏洞表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「风险资产」或「威胁标签」列
 */
function exploitableVulnCount(ctx, ips) {
  const rows = ctx.vulnRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, RISK_ASSET_COLUMN, '漏洞表');
  requireColumn(rows, THREAT_TAG_COLUMN, '漏洞表');

  let count = 0;
  for (const row of rows) {
    if (!ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) continue;
    if (hasAnyTag(row, EXPLOITABLE_TAGS)) count += 1;
  }
  return count;
}

/**
 * 漏洞表的**选行骨架** —— D10 / D12 / D15 共用的那几步（H4）。
 *
 * 三格读的是同一张表、同一套取法，只有「选哪些行」不同：
 *   · 数整张表（与 --business-systems 传没传无关，不按 IP 集合圈定）
 *   · 不叠加报告期过滤（漏洞表导出时已按「首次发现时间」落在报告期内，同 D7）
 *   · 表为空（0 行）就是「这段时间一条漏洞都没有」-> 返回**空数组**，各格自己归总成 0
 *     （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *     scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出；所以取值层
 *     见到的表一定在，0 行是正常数据，不是缺数）
 *   · 列名对不上（平台改了列名）时 requireColumn 抛错 —— 按 0 算等于拿一份没读到的数据
 *     当没有（C5/R10）。这是本函数唯一还会抛的情况。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} column 选行所依据的那一列的表头文字（不存在就抛错）
 * @param {(row: Object) => boolean} matches 选行判据
 * @param {string} what 报错文案里的量名（各格自己说的话）
 * @returns {Object[]} 选中的行；表为空时是空数组
 * @throws {Error} 表头里没有 column 那一列
 */
function vulnRowsWhere(ctx, column, matches, what) {
  const rows = Array.isArray(ctx.vulnRows) ? ctx.vulnRows : [];
  if (rows.length === 0) return [];

  requireColumn(rows, column, '漏洞表');

  return rows.filter(matches);
}

/**
 * 漏洞表**全表**里、标签含给定关键词的**行** —— D10 / D12 共用的那一步筛选（H4）。
 *
 * 两格的关键词不同（D10 认「高可利用」、D12 认「热点漏洞」），选行的规矩逐字相同 ——
 * 都在 vulnRowsWhere 里；两格的差别只在选中之后**怎么归总**：D10 数行数、
 * D12 数去重后的资产台数（见 highExploitableVulnCount / hotVulnAssetCount）。
 *
 * @param {string[]} tags 关键词，标签串里出现其中一个即选中
 */
function taggedVulnRows(ctx, tags) {
  return vulnRowsWhere(ctx, THREAT_TAG_COLUMN, (row) => hasAnyTag(row, tags));
}

/**
 * D10「高危可利用漏洞数」：全表里标签含「高可利用」的**行数**
 * （**不含**只含「热点漏洞」的）。
 *
 * 按行计数、一行最多算一条、不按资产去重 —— label 说的是「漏洞数」，
 * 同一台机器上的同一个漏洞被导出多次就是多条（D12 才是按资产去重，两格刻意不同）。
 */
function highExploitableVulnCount(ctx) {
  return taggedVulnRows(ctx, HIGH_EXPLOITABLE_ONLY).length;
}

/**
 * D12「最新漏洞影响资产数」：全表里标签含「热点漏洞」的漏洞**影响到的资产台数**
 * （**不含**只含「高可利用」的）。
 *
 * 归总是**按「风险资产」列去重**，不是数行数（用户口径）——
 * 同一台资产上有三条热点漏洞只算 1 台，与 label 里的「资产数」一致。
 *
 * 去重前先用 normalizeIp 归一（与 D7 那一段、与 report_preprocess.py 同一把尺子），
 * 于是 `10.0.0.4` 与 `10.0.0.4(未归类组)` 算同一台。
 * **「风险资产」为空的行不计入**（归一后是空串）：那一行指不到任何一台资产上，
 * 把空串当成一台资产会让台数虚增 1。
 */
function hotVulnAssetCount(ctx) {
  const rows = taggedVulnRows(ctx, HOT_VULN_ONLY);
  if (rows.length > 0) requireColumn(ctx.vulnRows, RISK_ASSET_COLUMN, '漏洞表');

  const assets = new Set();
  for (const row of rows) {
    const ip = normalizeIp(row[RISK_ASSET_COLUMN]);
    if (ip) assets.add(ip);
  }
  return assets.size;
}

/**
 * D15「已修复漏洞数」：全表里「处置状态」**精确等于**「处置完成」的**行数**。
 *
 * 判据是**整格精确相等**，不是包含：`处置完成` 算，`待处置` 不算，
 * 带括号的 `处置完成（已修复）` / `（已缓解）` / `（接受风险）` / `（忽略）` 也**都不算**
 * —— 用户口径是「那几个状态在漏洞表里就是「处置完成」这一个值，精确匹配它就行」，
 * 所以带括号的形式不在判据里（真出现也不命中，那不是同一个字符串）；
 * `处置完成（误报）` 同样不算。
 * 比较前用 cellText 去掉首尾空白（单元格里多打一个空格不算另一种处置状态），
 * 但**不做全半角括号归一**：平台上写的是全角「（）」，半角 `()` 不命中。
 *
 * 按行计数，一行最多算一条；不去重、不按漏洞名称合并。数的是**全表**、
 * 不按报告期过滤（三条口径同 D10 / D12，见 vulnRowsWhere）。
 *
 * label 写的是「已修复」，口径却是「处置完成」这个状态的小计 ——
 * 这是用户投喂的口径，本格照它实现；label 是模板原文，按 R1/R2 一个字节都不改。
 */
function settledVulnCount(ctx) {
  return vulnRowsWhere(
    ctx,
    DISPOSITION_COLUMN,
    (row) => SETTLED_DISPOSITIONS.includes(cellText(row[DISPOSITION_COLUMN]))
  ).length;
}

module.exports = {
  RISK_ASSET_COLUMN,
  THREAT_TAG_COLUMN,
  DISPOSITION_COLUMN,
  HIGH_EXPLOITABLE_TAG,
  HOT_VULN_TAG,
  EXPLOITABLE_TAGS,
  HIGH_EXPLOITABLE_ONLY,
  HOT_VULN_ONLY,
  SETTLED_DISPOSITIONS,
  exploitableVulnCount,
  taggedVulnRows,
  highExploitableVulnCount,
  hotVulnAssetCount,
  settledVulnCount
};
