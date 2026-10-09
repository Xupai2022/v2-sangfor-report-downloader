'use strict';

/**
 * 资产表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 核心业务系统那 6 格（D3/D4/D5 系统名 + D7/D8/D9 风险总数）都要先把「业务系统名」
 * 翻成「该系统下的资产 IP 集合」，再拿这个集合去三份风险表里数数 —— 这段映射落在这里，
 * 只算一次（H4）。
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');

/**
 * 「所属业务」的表头文字。
 *
 * 依据：`outputs/20261008_143946/一致性验收客户_report.xlsx` 的「资产表」sheet 表头行
 * （第 2 行，第 1 行是空的）里逐字命中「所属业务」。
 *
 * 这里读的是**中间件原表**（下载得到的资产表，经 scripts/process_asset_table.py 加工过），
 * 而报告里的「资产表」sheet 就是把那张表原样搬进去的（见 scripts/build_report.py 头注），
 * 所以两边表头逐字相同。
 *
 * 加工那一步会把这一列按逗号拆开、每段去掉 `/` 及其前面的部分（`财务系统/一级` -> `一级`），
 * 多段再用 `, ` 拼回来，所以一格里可能有多个业务名。
 */
const BUSINESS_COLUMN = '所属业务';

/** 「IP地址」的表头文字。依据同上（同一行表头，全表唯一）。 */
const IP_COLUMN = 'IP地址';

/** 比对用的业务名文本：去首尾空白 + 转小写（中文不受影响，英文名大小写不敏感）。 */
function normalizeBusiness(value) {
  return cellText(value).toLowerCase();
}

/**
 * 业务系统名 -> 该系统下的资产 IP 集合。
 *
 * 匹配口径（用户口径）：**整格子串包含**。传入 `oa系统`，格子里是 `OA系统1`、
 * `财务系统, OA系统` 的资产都算 —— 大小写与首尾空白不敏感，但不做分词，
 * 所以 `oa` 也会命中 `oa系统1`（这是「模糊匹配」的字面含义，由投喂口径决定）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} name 业务系统名（来自 CLI 的 --business-systems）
 * @returns {Set<string>|undefined} 命中资产的 IP 集合（**可能是空集**：这一列整个是空的、
 *   或该系统名下确实没有资产 —— 两种都按 0 算，不是缺数，见下）。返回 undefined 才表示
 *   **取不到数**，由写层记入错误列表、不写值（R10/H6）：
 *     · 资产表没读到（ctx.assetRows 为空）
 *     · 系统名是空串（没传这个槽位）
 * @throws {Error} 有行数据但表头里没有「所属业务」或「IP地址」列（列名对不上，不许静默数出 0）
 */
function assetIpsOfBusinessSystem(ctx, name) {
  const rows = ctx.assetRows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;

  requireColumn(rows, BUSINESS_COLUMN, '资产表');
  requireColumn(rows, IP_COLUMN, '资产表');

  const needle = normalizeBusiness(name);
  if (!needle) return undefined;

  // 「所属业务」为空的行直接跳过 —— 这是**用户口径**：这一列整列都是空的客户，
  // 三个系统的风险总数就是 0，不是缺数（真实样本 116 行里这一列一个字都没有，
  // 见 outputs/20261008_143946/一致性验收客户_report.xlsx）。
  // 刻意不与 stats/metrics/alarm.js 那条「整列为空 -> 缺数」对齐：那边整列为空意味着
  // 「定性统计无从谈起」，这边整列为空意味着「这些机器不属于任何核心系统」——
  // 后者是与「数出来是 0」同一件事，别顺手把两处「修」成一致。
  const ips = new Set();
  for (const row of rows) {
    if (!normalizeBusiness(row[BUSINESS_COLUMN]).includes(needle)) continue;
    // 命中业务但没写 IP 的资产无法参与后面三份表的比对，跳过（不影响命中判定）
    const ip = normalizeIp(row[IP_COLUMN]);
    if (ip) ips.add(ip);
  }
  return ips;
}

module.exports = { BUSINESS_COLUMN, IP_COLUMN, assetIpsOfBusinessSystem };
