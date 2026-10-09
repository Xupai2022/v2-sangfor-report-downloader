'use strict';

/**
 * 弱密码表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 核心业务系统的风险总数（D7/D8/D9）里，「弱密码风险」那一段落在这里。
 */

const { requireColumn, normalizeIp } = require('./rows');

/**
 * 「风险资产」的表头文字（与漏洞表同名，含义相同：这一行风险落在哪台资产上）。
 *
 * 依据：`tmp/probe_vuln/weakpwd_raw.xlsx`（平台导出的弱密码表，95 行）表头行逐字命中
 * 「风险资产」；同一列名也出现在 `outputs/20261008_143946/一致性验收客户_report.xlsx`
 * 的「弱密码表」sheet 表头（报告里那张 sheet 就是这张表原样搬进去的）。
 */
const RISK_ASSET_COLUMN = '风险资产';

/**
 * 指定 IP 集合上的弱密码风险**行数**。
 *
 * 计数口径（用户口径）：命中一行就是一条风险，一行一条，不去重、不按账号或端口合并 ——
 * 同一台机器上两个账号的弱密码是两行，就是两条。
 * 不按报告期过滤：弱密码表导出时已按平台口径取数（与 stats/metrics/vuln.js 同一口径）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number|undefined} 行数；弱密码表没读到（上下文里没有总表）时返回 undefined
 *   —— 缺数不静默（R10/H6），由写层记入错误列表、绝不填 0
 * @throws {Error} 有行数据但表头里没有「风险资产」列
 */
function weakPwdRiskCount(ctx, ips) {
  const rows = ctx.weakPwdRows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  requireColumn(rows, RISK_ASSET_COLUMN, '弱密码表');

  let count = 0;
  for (const row of rows) {
    if (ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) count += 1;
  }
  return count;
}

module.exports = { RISK_ASSET_COLUMN, weakPwdRiskCount };
