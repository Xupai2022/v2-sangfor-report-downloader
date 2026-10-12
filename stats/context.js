'use strict';

/**
 * 计算层输入契约 —— 「数据统计」sheet 取值层的**唯一入口**。
 * 约束见 CELL_REGISTRY.md §7（C1–C3）与 §2。
 *
 *   C1  ctx 只能在这里拼装，别处不得自行构造
 *   C2  六份总表各对应一个字段，字段名与总表一一对应，不起别名
 *   C3  ctx 只放只读数据与报告参数，不放函数、不放中间计算结果
 *
 * M1 阶段：只定义形状与校验。真实表数据要到 M2/M3 由 mssw_client 产出后才有。
 *
 * 六份表字段一律归一成数组：**表一定在，只是可能 0 行**。不存在「整份没下到」这种
 * 取值层看得见的状态 —— 某份表下不到时 scripts/build_report.py 会直接报
 * 「缺少 X 的下载结果」、整份报告不出（用户口径 2026-10-10），流程根本走不到这里。
 * 所以 0 行是正常数据：计数格写 0、名次格写空串，都不进错误列表。
 */

/**
 * 六份总表 -> ctx 字段名。
 * compute 里靠这些名字认数据源（CELL_REGISTRY.md §2），不要另起别名。
 */
const TABLE_FIELDS = [
  'assetRows',    // 资产表总表
  'eventRows',    // 事件表总表
  'alarmRows',    // 告警表总表
  'vulnRows',     // 漏洞表总表
  'weakPwdRows',  // 弱密码表总表
  'exposedRows'   // 暴露面表总表
];

/** 非表字段：报告参数 */
const PARAM_FIELDS = ['customer', 'customerId', 'range', 'protectRange', 'businessSystems'];

/**
 * 必填的只有报告参数。六份总表**刻意不设必填** ——
 * 下载行为一定发生，这里见到的表要么有数据行、要么 0 行，两者都是正常数据；
 * 真的没下到时流程在 scripts/build_report.py 就被拦了，走不到构造 ctx 这一步。
 */
const REQUIRED_FIELDS = ['customer', 'range'];

/** 报告期/护网期统一用 { start, end } 两个 Date 表示，闭区间。 */
function normalizeRange(value, fieldName) {
  if (value === null || value === undefined) return null;
  const start = value.start instanceof Date ? value.start : new Date(value.start);
  const end = value.end instanceof Date ? value.end : new Date(value.end);
  if (Number.isNaN(start.getTime())) throw new Error(`ctx.${fieldName}.start 非法: ${value.start}`);
  if (Number.isNaN(end.getTime())) throw new Error(`ctx.${fieldName}.end 非法: ${value.end}`);
  if (start.getTime() > end.getTime()) throw new Error(`ctx.${fieldName} 起止倒置: ${start} > ${end}`);
  return Object.freeze({ start, end });
}

/**
 * 构造 ctx。C1：这是唯一允许拼装 ctx 的地方。
 *
 * @param {Object} input
 * @param {string} input.customer
 * @param {string} [input.customerId]
 * @param {{start: Date|string, end: Date|string}} input.range        报告期，闭区间
 * @param {{start: Date|string, end: Date|string}|null} [input.protectRange]  --protect-start/--protect-end，未传为 null
 * @param {string[]} [input.businessSystems]
 * @param {Array} [input.assetRows] ... 六份总表
 */
function createContext(input = {}) {
  const missing = REQUIRED_FIELDS.filter((field) => input[field] === undefined || input[field] === null);
  if (missing.length) {
    throw new Error(`ctx 缺少必填字段: ${missing.join(', ')}（CELL_REGISTRY.md §7）`);
  }

  const ctx = {
    customer: String(input.customer),
    customerId: input.customerId === undefined || input.customerId === null ? '' : String(input.customerId),
    range: normalizeRange(input.range, 'range'),
    protectRange: normalizeRange(input.protectRange, 'protectRange'),
    businessSystems: Object.freeze(Array.isArray(input.businessSystems) ? [...input.businessSystems] : [])
  };

  // 表字段一律存在且是数组：没传 / 传了空表都归一成 []（= 0 行 = 「这段时间没有数据」，
  // 那是结论，不是缺数）。compute 里不用再判 Array，也没有「这份表没下到」这种状态可判。
  for (const field of TABLE_FIELDS) {
    ctx[field] = Object.freeze(Array.isArray(input[field]) ? input[field] : []);
  }

  return Object.freeze(ctx);
}

module.exports = { createContext, TABLE_FIELDS, PARAM_FIELDS, REQUIRED_FIELDS };
