'use strict';

/**
 * 「管理员弱口令数量」（D11）与「管理员弱口令去重资产数」（D113）的派生量
 * （CELL_REGISTRY.md §8 F1）。
 *
 * 这一格跨三份总表：资产表定范围（「重要级别 = 核心」的资产 IP 集合），
 * 弱密码表与事件表各出一段，两段相加。D11 数**行数**、D113 数**台数**——
 * 同一批命中行、两种归总，选行判据一个字都不重写（H4）。
 *
 * 单独放一份、不塞进 core_system.js：那边是「核心业务系统」（按 --business-systems
 * 传进来的系统名圈 IP），这边是「核心资产」（按资产表的重要级别圈 IP）——
 * 只共用「核心」两个字，口径是两回事。塞在一起会让「找一格先按域定位文件」失效。
 *
 * 两段的数法**一个字都不重写**（H4）：weakPwdRiskCount 与 accountRiskEventCount
 * 本来就收一个 IP 集合，把集合换成「核心资产」就正好是这两段。
 */

const { coreAssetIps } = require('./asset');
const { weakPwdRiskCount, weakPwdRiskAssetIps } = require('./weakpwd');
const { accountRiskEventCount, accountRiskEventAssetIps } = require('./event');

/**
 * 核心资产（资产表「重要级别」=「核心」）上的弱口令数量 —— D11。
 *
 * 两段相加（用户口径），互不重叠、不去重：
 *   ① 弱密码表（**内网 + 互联网两份**，ctx.weakPwdRows 已是拼接结果）里
 *      「风险资产」属于核心资产集合的行数
 *   ② 事件表里「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」、
 *      且「影响资产」属于核心资产集合的行数
 * 两段都按行计数、一行最多一条。
 *
 * @returns {number} 两段之和。两份风险表各自为空（0 行）时那一段是 0，照加
 *   （0 是结论，不是缺数）。本函数**没有「取不到数」这条路**：下载一定发生，
 *   资产表为空就是「一台核心资产都没有」-> 核心资产集合是空集 -> 两段都是 0
 *   （用户口径 2026-10-10）
 * @throws {Error} 资产表有行、但读不出「重要级别」/「IP地址」列（列名对不上，
 *   不许静默数出 0）—— 由 coreAssetIps 抛出
 */
function adminWeakPwdCount(ctx) {
  const ips = coreAssetIps(ctx);

  // 两份风险表各出一段；各自为空（0 行）时那一段是 0，直接加
  return weakPwdRiskCount(ctx, ips) + accountRiskEventCount(ctx, ips);
}

/**
 * 核心资产上的弱口令**去重资产数** —— D113。
 *
 * 与 D11 同一批命中行、同一个核心资产范围（用户口径 2026-10-22：
 * 「D113是管理员弱口令去重资产数，取值是D11的分两步取值的时候，对命中的
 * 事件/弱密码，对事件表的『影响资产』列/两个弱密码表的风险资产列进行去重计数，求和」）：
 *   ① 弱密码表（**内网 + 互联网两份**）里「风险资产」属于核心资产集合的行，
 *      按「风险资产」归一去重 —— 数**多少台**资产
 *   ② 事件表里「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」、
 *      且「影响资产」属于核心资产集合的行，按「影响资产」归一去重 —— 数**多少台**资产
 * 两段的去重**各做各的**（不跨表并集），结果**相加**：同一台资产既在弱密码表里
 * 命中、又在事件表里命中，两段各计 1 台（用户口径是「去重计数，求和」，
 * 不是跨两表并成一个集合）。
 *
 * ⚠️ 与 D11 的区别只有归总方式：D11 数行数（同一台资产上两条就是 2），
 * 本函数数台数（同一台资产上两条只算 1）。选行判据一个字都不重写（H4）：
 * 两段分别复用 weakPwdRiskAssetIps / accountRiskEventAssetIps。
 *
 * @returns {number} 两段去重资产数之和。弱密码表 / 事件表为空、或一台核心资产
 *   都没命中时，对应那段是 0，照加（0 是结论，不是缺数）
 * @throws {Error} 资产表有行、但读不出「重要级别」/「IP地址」列，或弱密码表 /
 *   事件表缺判据列 —— 由各自的 metrics 函数抛出
 */
function adminWeakPwdAssetCount(ctx) {
  const ips = coreAssetIps(ctx);

  return weakPwdRiskAssetIps(ctx, ips).size + accountRiskEventAssetIps(ctx, ips).size;
}

module.exports = { adminWeakPwdCount, adminWeakPwdAssetCount };
