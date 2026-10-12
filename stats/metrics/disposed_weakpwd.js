'use strict';

/**
 * 「已处置弱口令数量」（D16）的派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 这一格跨两份总表，两段相加：
 *   ① 弱密码表里「处置状态」精确等于「处置完成」的行数  -> stats/metrics/weakpwd.js
 *   ② 事件表里「安全事件二级分类」含「弱口令」且「处置状态」精确等于「处置完成」的行数
 *      -> stats/metrics/event.js
 *
 * 单独放一份、不塞进 weakpwd.js：那边是「弱密码表」这一个域，这边两段跨两个域 ——
 * 与 stats/metrics/admin_weakpwd.js（D11）是同一个理由：塞在一起会让
 * 「找一格先按域定位文件」失效。
 *
 * 两段的数法**一个字都不重写**（H4）：两个函数各自就是这两段，本文件只做相加。
 */

const { disposedWeakPwdRowCount } = require('./weakpwd');
const { disposedWeakPwdEventCount } = require('./event');

/**
 * D16「已处置弱口令数量」= 上面两段之和（用户口径：「两部分加起来」）。
 *
 * 两段各按行计数、一行最多算一条；两段来自两份不同的表，**不去重** ——
 * 同一台资产上既有一条已处置的弱密码、又有一条已处置的弱口令类事件，就是 2。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 两段之和。两份表各自为空（0 行）时那一段是 0，照加
 *   （0 是结论，不是缺数）
 * @throws {Error} 弱密码表有行但读不出「处置状态」列，或事件表有行但读不出
 *   「安全事件二级分类」/「处置状态」列（列名对不上，不许静默数出 0）
 *   —— 由那两段各自抛出
 */
function disposedWeakPwdCount(ctx) {
  return disposedWeakPwdRowCount(ctx) + disposedWeakPwdEventCount(ctx);
}

module.exports = { disposedWeakPwdCount };
