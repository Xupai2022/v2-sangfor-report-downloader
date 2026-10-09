'use strict';

/**
 * 漏洞表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 核心业务系统的风险总数（D7/D8/D9）里，「漏洞风险」那一段落在这里。
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
const EXPLOITABLE_TAGS = ['高可利用', '热点漏洞'];

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
 * @returns {number|undefined} 行数；漏洞表没读到（上下文里没有总表）时返回 undefined
 *   —— 缺数不静默（R10/H6），由写层记入错误列表、绝不填 0
 * @throws {Error} 有行数据但表头里没有「风险资产」或「威胁标签」列
 */
function exploitableVulnCount(ctx, ips) {
  const rows = ctx.vulnRows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  requireColumn(rows, RISK_ASSET_COLUMN, '漏洞表');
  requireColumn(rows, THREAT_TAG_COLUMN, '漏洞表');

  let count = 0;
  for (const row of rows) {
    if (!ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) continue;
    const tags = cellText(row[THREAT_TAG_COLUMN]);
    if (EXPLOITABLE_TAGS.some((tag) => tags.includes(tag))) count += 1;
  }
  return count;
}

module.exports = { RISK_ASSET_COLUMN, THREAT_TAG_COLUMN, EXPLOITABLE_TAGS, exploitableVulnCount };
