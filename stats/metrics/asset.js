'use strict';

/**
 * 资产表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 本文件供两处用：
 *   · 核心业务系统那 7 格（D3/D4/D5 系统名 + D6 安全风险总数 + D7/D8/D9 风险总数）——
 *     把「业务系统名」翻成「该系统下的资产 IP 集合」再拿这个集合去三份风险表里数数（H4）；
 *   · D11「管理员弱口令数量」—— 把「重要级别 = 核心」翻成「核心资产 IP 集合」，
 *     同样拿这个集合去弱密码表 / 事件表里数数。两个集合的取法不同（一个是模糊匹配业务名，
 *     一个是精确匹配级别值），但都是「资产表 -> IP 集合」这一步，所以同放一份。
 *   · G17「服务器资产数量」/ G18「PC资产数量」—— 数「资产类型(一级)」这一列里
 *     整格精确等于某个值的**行数**。两格只差一个待匹配的类型值，所以共用
 *     assetCountByPrimaryType（H4：同一段过滤条件只写一遍）。
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');
const { isBlankValue } = require('./ranking');

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

/**
 * 「重要级别」的表头文字 —— D11 定「核心资产」范围要读的列。
 *
 * 依据：`outputs/20261008_152843/一致性验收客户_report.xlsx` 的「资产表」sheet 表头行
 * （第 2 行）逐字命中「重要级别」（同一行表头里只有这一列名含「级别」）。实测取值形如
 * 「普通」，平台另有「核心」这一档 —— 是哪一档由投喂口径决定，见下 CORE_LEVEL。
 */
const IMPORTANT_LEVEL_COLUMN = '重要级别';

/**
 * 「资产类型(一级)」的表头文字 —— G17/G18 定「服务器 / PC」台数要读的列。
 *
 * 依据：`outputs/20261012_121436/一致性验收客户_report.xlsx` 的「资产表」sheet 表头行
 * （第 2 行，第 1 行是空的）里逐字命中「资产类型(一级)」—— **半角括号**，不是全角
 * （同一行还有一列叫「资产类型(二级)」，那是另一列，本域两格都不读）。
 * 报告里的「资产表」sheet 就是下载件原样搬进去的（见 scripts/build_report.py 头注），
 * 所以两边表头逐字相同；实测这一列的取值形如 `服务器` / `终端` / `网络设备`。
 *
 * 这一列**不是**平台分页导出接口的请求字段，是资产表下载件里本来就有的列
 * （加工脚本 scripts/process_asset_table.py 只清洗「所属业务」、不增删别的列）。
 */
const PRIMARY_ASSET_TYPE_COLUMN = '资产类型(一级)';

/**
 * G17「服务器资产数量」认的资产类型值（用户口径 2026-10-12）—— 整格**精确相等**。
 */
const SERVER_ASSET_TYPE = '服务器';

/**
 * G18「PC资产数量」认的资产类型值（用户口径 2026-10-12）—— 整格**精确相等**。
 *
 * 平台这一列给的是「终端」（实测 117 行里 99 行），报告口径把它叫作 PC。
 */
const PC_ASSET_TYPE = '终端';

/**
 * 「重要级别」列里表示核心资产的那个值（用户口径）。
 *
 * 判据是**精确相等**，不是包含 —— 「核心业务」「非核心」这类更长的值都不算。
 * 这与「所属业务」那一列刻意的模糊匹配不同，别顺手统一。
 */
const CORE_LEVEL = '核心';

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
 * @returns {Set<string>} 命中资产的 IP 集合（**可能是空集**：资产表 0 行、这一列整个是空的、
 *   或该系统名下确实没有资产 —— 三种都按 0 算，不是缺数，见下）。
 *   本函数**没有「取不到数」这条路**：下载一定发生，资产表为空就是「一台资产都没有」，
 *   集合是空的、后面的数都是 0（用户口径 2026-10-10）
 * @throws {Error} 有行数据但表头里没有「所属业务」或「IP地址」列（列名对不上，不许静默数出 0）
 */
function assetIpsOfBusinessSystem(ctx, name) {
  const rows = Array.isArray(ctx.assetRows) ? ctx.assetRows : [];
  if (rows.length === 0) return new Set();

  requireColumn(rows, BUSINESS_COLUMN, '资产表');
  requireColumn(rows, IP_COLUMN, '资产表');

  const needle = normalizeBusiness(name);
  // 系统名是空的（理论上到不了这：coreSystemNameAt 已经拦过没传槽位的情况）——
  // 空串做子串包含会**命中每一行**，那不是「没有这个系统」，是匹配条件失效，
  // 所以这里回空集而不是放行（回空集 = 这个系统名下 0 台资产）。
  if (!needle) return new Set();

  // 「所属业务」为空的行直接跳过 —— 这一列整列都是空的客户，三个系统的风险总数
  // 就是 0（真实样本 116 行里这一列一个字都没有，见
  // outputs/20261008_143946/一致性验收客户_report.xlsx）。
  // 这与「表 0 行 -> 0」是同一条思路：这些机器不属于任何核心系统，不是缺数。
  const ips = new Set();
  for (const row of rows) {
    if (!normalizeBusiness(row[BUSINESS_COLUMN]).includes(needle)) continue;
    // 命中业务但没写 IP 的资产无法参与后面三份表的比对，跳过（不影响命中判定）
    const ip = normalizeIp(row[IP_COLUMN]);
    if (ip) ips.add(ip);
  }
  return ips;
}

/**
 * 资产表里「重要级别」精确等于「核心」的那些资产的 IP 集合 —— D11 的取数范围。
 *
 * 与 assetIpsOfBusinessSystem 的差别只有「怎么挑行」：那边按业务名做子串包含，
 * 这边按级别值做精确相等；挑出来的都是「一批 IP」，后面拿去数数的动作完全一样。
 *
 * 「重要级别」为空、或取别的档（普通 / 重要 …）的行直接跳过 —— 一台核心资产都没有时，
 * D11 就是 0，不是缺数（与 assetIpsOfBusinessSystem 那条「资产表 0 行 -> 空集」同一思路）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {Set<string>} 核心资产的 IP 集合（**可能是空集**：资产表 0 行、或一台核心资产
 *   都没有 —— 都按 0 算，不是缺数）。本函数**没有「取不到数」这条路**：下载一定发生，
 *   资产表为空就是「一台资产都没有」（用户口径 2026-10-10）
 * @throws {Error} 有行数据但表头里没有「重要级别」或「IP地址」列（列名对不上，
 *   不许静默数出 0）
 */
function coreAssetIps(ctx) {
  const rows = Array.isArray(ctx.assetRows) ? ctx.assetRows : [];
  if (rows.length === 0) return new Set();

  requireColumn(rows, IMPORTANT_LEVEL_COLUMN, '资产表');
  requireColumn(rows, IP_COLUMN, '资产表');

  const ips = new Set();
  for (const row of rows) {
    if (cellText(row[IMPORTANT_LEVEL_COLUMN]) !== CORE_LEVEL) continue;
    // 核心资产但没写 IP 的，无法参与后面两份表的比对，跳过（不影响判定）
    const ip = normalizeIp(row[IP_COLUMN]);
    if (ip) ips.add(ip);
  }
  return ips;
}

/**
 * 资产表「所属业务」列里**出现过的不同内容**（去重后的集合）—— G16「业务系统数量」的取数范围。
 *
 * 口径（用户口径 2026-10-12）：**精确**读这一列 —— 把**整格内容**当作一个条目，
 * 不做子串包含、不按逗号拆开、不做分词。所以一格里是 `财务系统, OA系统`（加工脚本
 * scripts/process_asset_table.py 按逗号拆过再拼回来的形态）时，它是**一个**条目，
 * 不是两个 —— 本格数的是"这一列出现过多少种**不同的内容**"。
 *
 * 比较前只做一件事：去首尾空白 + 转小写（与 assetIpsOfBusinessSystem 同一把尺子
 * normalizeBusiness）。所以 `  财务系统 ` 与 `财务系统` 算一个、`OA系统` 与 `oa系统` 算一个。
 *
 * **没有内容的不算一种业务系统**（用户口径 2026-10-12「`-` 不算」）：空串、纯空白、
 * 以及平台的**横杠占位符**（`-` / `－` / `—` / `–`）都跳过 —— 判据直接用
 * ranking.js 的 isBlankValue，与那 35 格名次格是**同一把尺子**（横杠在 mssw 导出里
 * 是列级的「无 / 不适用」标记，不是一种取值；再写一遍正则就会分叉）。
 * 真实样本里这一列大面积为空（outputs/20261010_152149/一致性验收客户_report.xlsx
 * 的「资产表」sheet：117 行里只有 1 行非空），那种客户本格就是 0 —— 是**结论**，不是缺数。
 *
 * 与 `--business-systems` 无关：这一格问的是"资产表里到底登记了几种业务系统"，
 * 不是"传进来的那几个系统"，所以不拿 D3/D4/D5 去过滤、也不做子串匹配。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {Set<string>} 归一后的不同内容（**可能是空集**：资产表 0 行、或这一列整列为空 /
 *   全是占位符 —— 都按 0 算，不是缺数）
 * @throws {Error} 有行数据但表头里没有「所属业务」列（列名对不上，不许静默数出 0）。
 *   注意只要求这一列：本格不读「IP地址」，所以资产表缺 IP 列不影响它。
 */
function businessSystemNames(ctx) {
  const rows = Array.isArray(ctx.assetRows) ? ctx.assetRows : [];
  if (rows.length === 0) return new Set();

  requireColumn(rows, BUSINESS_COLUMN, '资产表');

  const names = new Set();
  for (const row of rows) {
    // 空 / 占位符先判、再归一：占位符是"这一格没有值"，不是一种业务系统名
    if (isBlankValue(row[BUSINESS_COLUMN])) continue;
    names.add(normalizeBusiness(row[BUSINESS_COLUMN]));
  }
  return names;
}

/**
 * 资产表「所属业务」列里非空内容的**条目数量** —— G16「业务系统数量」。
 *
 * 就是 businessSystemNames 这个集合的条目数（H4：派生量在 metrics 里具名导出，
 * 本函数只负责"数一数"）。
 *
 * @returns {number} 不同内容的个数。资产表 0 行、或这一列整列为空 / 全是占位符时是 **0**
 *   （0 是结论，不是缺数 —— 那正是"一台资产都没登记过业务归属"）。
 * @throws {Error} 有行数据但读不出「所属业务」列（businessSystemNames 抛出）
 */
function businessSystemCount(ctx) {
  return businessSystemNames(ctx).size;
}

/**
 * 资产表「资产类型(一级)」列里**整格精确等于**某个类型值的**行数** ——
 * G17「服务器资产数量」（传 `服务器`）与 G18「PC资产数量」（传 `终端`）共用的这一段。
 *
 * 口径（用户口径 2026-10-12）：逐行看「资产类型(一级)」这一格，**整格内容**就是那个值
 * 才加 1。比较前只去首尾空白（cellText），**不做**包含 / 前缀匹配 —— 所以 `服务器区`、
 * `X86服务器` 都不算；也不做全半角归一，两格**只认自己那一个值**
 * （「网络设备」之类既不进 G17 也不进 G18），也**不读**「资产类型(二级)」那一列。
 *
 * 计数单位是**资产行数**（一台资产一行），不按 IP 去重 —— 同一台机器在表里出现两行就是 2。
 * 与 `--business-systems` 无关（本函数两格圈的是资产类型，不是业务系统），
 * 也不叠加报告期过滤：资产表导出的是当前台账，本仓不另加时间条件。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} assetType 待精确匹配的资产类型值（G17 传 SERVER_ASSET_TYPE、G18 传 PC_ASSET_TYPE）
 * @returns {number} 命中行数。资产表 0 行、或这一列整列为空 / 一台都不命中时是 **0**
 *   （0 是结论，不是缺数 —— 那正是"台账里没有这类资产"）
 * @throws {Error} 有行数据但表头里没有「资产类型(一级)」列（列名对不上，不许静默数出 0）
 */
function assetCountByPrimaryType(ctx, assetType) {
  const rows = Array.isArray(ctx.assetRows) ? ctx.assetRows : [];
  if (rows.length === 0) return 0;

  requireColumn(rows, PRIMARY_ASSET_TYPE_COLUMN, '资产表');

  return rows.filter(
    (row) => cellText(row[PRIMARY_ASSET_TYPE_COLUMN]) === assetType
  ).length;
}

module.exports = {
  BUSINESS_COLUMN,
  IP_COLUMN,
  IMPORTANT_LEVEL_COLUMN,
  PRIMARY_ASSET_TYPE_COLUMN,
  CORE_LEVEL,
  SERVER_ASSET_TYPE,
  PC_ASSET_TYPE,
  assetIpsOfBusinessSystem,
  coreAssetIps,
  businessSystemNames,
  businessSystemCount,
  assetCountByPrimaryType
};
