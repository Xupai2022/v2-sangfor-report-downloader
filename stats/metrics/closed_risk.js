'use strict';

/**
 * D13「已闭环风险总数」—— **D14 + D15 + D16 + D17 四个数相加**
 * （用户口径 2026-10-22「D13是已闭环风险总数，取值是D14+D15+D16+D17」）。
 *
 * 四个加数各自都是**有名字的格子**，所以本格只做加法、一个字都不重算（H4）：
 *   · D14「已防护漏洞数」= protectedVulnCount（内网漏洞表：AF 防护规则 = 有效 且
 *     处置状态 = 处置完成（已缓解））
 *   · D15「已修复漏洞数」= settledVulnCount（漏洞表全表：处置状态**包含**「处置完成」，
 *   · D16「已处置弱口令数量」= disposedWeakPwdCount（弱密码表两段 + 事件表一段）
 *   · D17「受影响的最新漏洞数」= hotVulnCount（漏洞表全表：威胁标签含「热点漏洞」的行数）
 *
 * ⚠️ 四个加数**量纲不同、口径互不重叠的设计**：漏洞数（D14/D15/D17 三个都数漏洞行）
 * 与弱口令处置数（D16 数弱密码行 + 事件行）各自按用户给的口径算，本格只照抄加式。
 * 也不去重 —— D14 命中的行同时也会被 D15 计入（D14 要求「处置完成（已缓解）」，
 * 它同样满足 D15 的「处置完成」）：用户给的就是这个加式，本格不额外做交集 / 去重，
 * 别看到「同一个数被数了两遍」就自作主张改成集合运算。
 *
 * 边界与四个加数一致（本格自己不做任何筛选）：
 *   · 四份数据源都为空（0 行）-> 四个加数都是 0、本格写 0（结论，不是缺数）；
 *   · 任何一个加数**抛错**（例如内网漏洞表缺「AF 防护规则」列）-> 本格同样不写值、记错误：
 *     少了一个加数却看上去"算完了"，比明说"没取到数"更容易被当成结论。
 *     错误文案就是那个加数自己的（能直接看出是哪一列缺了）。
 */

const { protectedVulnCount, settledVulnCount, hotVulnCount } = require('./vuln');
const { disposedWeakPwdCount } = require('./disposed_weakpwd');

/**
 * D13「已闭环风险总数」= D14 + D15 + D16 + D17。
 *
 * 加式顺序按用户投喂原话（D14+D15+D16+D17）写；加法本身与顺序无关，
 * 顺序只是让出错时的栈 / 报错点落在最靠前的那个加数上，便于排查。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 四个加数之和
 * @throws {Error} 任一加数缺列 / 读不到时原样抛出（整格不写值）
 */
function closedRiskTotal(ctx) {
  return closedRiskTotalOnIps(ctx, undefined);
}

/**
 * **指定 IP 集合上**的 D13「已闭环风险总数」—— C18/D18/E18「核心系统 1/2/3 的
 * 已闭环风险总数」的派生量（用户口径 2026-10-22）。
 *
 * 口径就是 closedRiskTotal 那个加式，**四项各多一道「IP 落在集合里」的筛**：
 *   · D14 已防护：内网漏洞表里「AF 防护规则」=有效 且「处置状态」=处置完成（已缓解）
 *     且「风险资产」∈ 集合（protectedVulnCount 的可选 ips 档）
 *   · D15 已修复：漏洞表全表里「处置状态」含处置完成 且「风险资产」∈ 集合
 *   · D16 已处置弱口令：弱密码表（「风险资产」∈ 集合）+ 事件表（「影响资产」∈ 集合）
 *   · D17 热点漏洞：漏洞表全表里「威胁标签」含「热点漏洞」且「风险资产」∈ 集合
 *
 * ⚠️ 数的是**行数**、不是去重 IP 台数；四个加数之间照旧**不去重**（D14 命中的行
 * 也会被 D15 计入）—— 与 D13 逐字同一条口径，本格只是把它按 IP 圈小。
 * ⚠️ 「风险资产」/「影响资产」为空的行不属于任何系统，所以
 * `C18 + D18 + E18 ≤ D13` 是常态；一台资产同属两个系统时那一行在两个槽位各计一次
 * （与 D7/D8/D9 逐系统各圈各的集合一致），这时三者之和可能大于 D13 —— 都是口径内的。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {Set<string>} ips 已归一的 IP 集合（来自 asset.js 的 assetIpsOfBusinessSystem）。
 *   空集合 = 这个系统名下一台资产都没有 -> 四项都是 0（0 是结论，不是缺数）
 * @returns {number} 四项之和
 * @throws {Error} 任一加数缺列 / 读不到时原样抛出（整格不写值，不拿剩下三项凑数）
 */
function closedRiskTotalOnIps(ctx, ips) {
  return protectedVulnCount(ctx, ips)
    + settledVulnCount(ctx, ips)
    + disposedWeakPwdCount(ctx, ips)
    + hotVulnCount(ctx, ips);
}

module.exports = { closedRiskTotal, closedRiskTotalOnIps };
