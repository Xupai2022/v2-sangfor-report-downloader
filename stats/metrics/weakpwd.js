'use strict';

/**
 * 弱密码表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 两处落在本文件：
 *   · 核心业务系统的风险总数（D7/D8/D9）里，「弱密码风险」那一段 = weakPwdRiskCount
 *   · D16「已处置弱口令数量」的**第一段** = disposedWeakPwdRowCount
 *     （第二段在事件表上，见 stats/metrics/event.js；两段相加在
 *     stats/metrics/disposed_weakpwd.js —— 那一格跨两份表，与 D11 同一个形状）
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');

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
 * @returns {number} 行数；弱密码表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「风险资产」列
 */
function weakPwdRiskCount(ctx, ips) {
  const rows = ctx.weakPwdRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, RISK_ASSET_COLUMN, '弱密码表');

  let count = 0;
  for (const row of rows) {
    if (ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) count += 1;
  }
  return count;
}

/**
 * 「处置状态」的表头文字 —— D16 第一段要读的列。
 *
 * 依据（三处独立样本逐字命中，前后无空格）：
 *   · `tmp/probe_vuln/weakpwd_raw.xlsx`（平台导出的弱密码表，94 行）表头第 24 列；
 *   · `tmp/verify_vuln_filter/weakpwd_case.xlsx` 的「弱密码」sheet（验时间过滤用的小表）；
 *   · `outputs/20261010_152149/一致性验收客户_report.xlsx` 的「弱密码表」sheet（29 列）
 *     —— 报告里那张 sheet 就是这张表原样搬进去的。
 * 同一张表另有「处置标签」「加白状态」「验证状态」三列，不是一回事，别取错。
 */
const DISPOSITION_COLUMN = '处置状态';

/**
 * D16 第一段认的处置状态 —— **整格精确相等**（与 D15 的 settledVulnCount 同一把尺子）。
 *
 * 实测取值：`待处置`（weakpwd_raw.xlsx 那 94 行全是它）、`处置完成`、
 * 以及 `处置完成（误报）` / `处置完成(误报)`（全角半角的括号都出现过，
 * 见 tmp/verify_vuln_filter/weakpwd_case.xlsx）。后两种**不算** ——
 * 与「处置完成」不是同一个字符串；比较前只去首尾空白，不做全半角 / 括号归一
 * （真做了归一就等于口径变了，那要重新投喂、重新登记）。
 */
const DISPOSED_WEAKPWD_STATUS = '处置完成';

/**
 * 弱密码表要读进 ctx 的列白名单：**各处需要的并集**。
 *
 * 读弱密码表的有两处：核心业务系统的风险总数 D7/D8/D9 与 D11（要「风险资产」）、
 * D16 第一段（要「处置状态」）。并成一次读，见 mssw_downloader.js 的 WEAKPWD_TABLE_SPEC
 * —— 读两遍不只是白解析一遍，后一遍还会把前一遍的行对象盖掉。
 */
const WEAKPWD_TABLE_COLUMNS = [RISK_ASSET_COLUMN, DISPOSITION_COLUMN];

/**
 * D16 第一段：弱密码表里「处置状态」**精确等于**「处置完成」的**行数**。
 *
 * 计数口径：按行计数、一行一票，不去重、不按账号 / 端口 / 资产合并 ——
 * 同一台资产上两个账号各有一条已处置的弱口令，就是两条。
 * 数的是**全表**：不看 IP、与 --business-systems 传没传、传了什么都无关。
 * 不按报告期过滤 —— 弱密码表导出时已按「首次发现时间」圈定（mssw_client.js 的
 * MSSW_VUL_MANAGE_TIME_RANGE_KEY，与漏洞表同一处；见 mssw_downloader.js 的
 * TIME_RANGE_TYPES 注释），本仓取值层不叠加第二道时间过滤。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；弱密码表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （报告期窗口里一条弱密码都没有，本来就会是空表）
 * @throws {Error} 弱密码表有行数据、但没有任何一行带「处置状态」列（平台改了列名）
 */
function disposedWeakPwdRowCount(ctx) {
  const rows = ctx.weakPwdRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, DISPOSITION_COLUMN, '弱密码表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[DISPOSITION_COLUMN]) === DISPOSED_WEAKPWD_STATUS) count += 1;
  }
  return count;
}

module.exports = {
  RISK_ASSET_COLUMN,
  weakPwdRiskCount,
  DISPOSITION_COLUMN,
  DISPOSED_WEAKPWD_STATUS,
  WEAKPWD_TABLE_COLUMNS,
  disposedWeakPwdRowCount
};
