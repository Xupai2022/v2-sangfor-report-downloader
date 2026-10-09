'use strict';

/**
 * 「数据统计」sheet 的**唯一写入决策点**（CELL_REGISTRY.md §8 F2）。
 * 别处不得决定这个 sheet 写哪一格、写什么。别处也不得直接写它。
 *
 * ⚠️ 这个模块**不再直接碰工作表**。
 *
 * 本仓库的 Excel 读写已全部交给 openpyxl（scripts/build_report.py），SheetJS 连同它
 * 那个唯一的 npm 依赖一起删掉了。本模块的职责因此收窄成"决定写什么"：
 * 算出 [{addr, value, mode}] 这份**写入计划**，交给 build_report.py 执行。
 *
 * F2 的约束一点没松，反而更硬：地址和值仍然只从这里出，而真正落笔的地方
 * 只有 build_report.py 的 apply_statistics_writes()，它不自己决定写哪一格。
 *
 * 写模式的语义见 CELL_REGISTRY.md §4。三种特殊写行为
 * （清空 / 百分号 / 字面量）在这里都是登记表上的显式 mode 字段，没有隐式规则。
 *
 * M1 阶段绝大多数记录是 mode:'unresolved'，因此**不写**；真正落值的只有已转正的记录
 * （当前 3 个报告参数格：J1/L1/M1）。没有 ctx 时整个写入层跳过，模板原样。
 */

const { CELLS, aliasedBy } = require('./index');

const SHEET_NAME = '数据统计';

/** 百分号格的数字格式（CELL_REGISTRY.md §4）。 */
const PERCENT_FORMAT = '0.00%';

/**
 * 算出「数据统计」sheet 的写入计划。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Array} [cells] 登记表，默认取 stats/index.js 的 CELLS。仅为测试注入用，生产不要传。
 * @returns {{writes: Array<{addr: string, value: *, mode: string}>,
 *            written: string[],
 *            unresolved: string[],
 *            errors: Array<{addr: string, message: string}>}}
 *   writes     —— 交给 build_report.py 执行的计划。mode 只有 value / percent / blank 三种
 *                 （unresolved 的格子一个字都不出现在这里）
 *   written    —— 落值的地址，顺序与 writes 一致
 *   unresolved —— 口径未定、刻意不写的地址（H7）
 *   errors     —— 取不到数的格子（R10 / H6：缺数不静默，也绝不填 0）
 */
function buildStatisticsWrites(ctx, cells = CELLS) {
  const writes = [];
  const written = [];
  const unresolved = [];
  const errors = [];
  /** addr -> 值，供 alias 引用 */
  const resolved = new Map();

  const push = (addr, value, mode) => {
    writes.push({ addr, value, mode });
    written.push(addr);
  };

  // 第一遍：算所有非 alias 的格子
  for (const cell of cells) {
    const { addr, mode } = cell;

    if (cell.alias) continue; // 第二遍处理

    if (mode === 'unresolved') {
      // H7：口径未定的格子**什么都不写** —— 既不写值也不清空，更不填 0
      unresolved.push(addr);
      continue;
    }

    if (mode === 'blank') {
      push(addr, '', 'blank');
      resolved.set(addr, '');
      continue;
    }

    if (mode === 'literal') {
      push(addr, cell.value, 'value');
      resolved.set(addr, cell.value);
      continue;
    }

    if (typeof cell.compute !== 'function') {
      throw new Error(`${addr} 缺少 compute（CELL_REGISTRY.md §2）`);
    }

    let value;
    try {
      value = cell.compute(ctx);
    } catch (error) {
      // R10 / H6：取不到数不静默、不填 0，记进 errors 由调用方决定怎么报
      errors.push({ addr, message: error.message });
      continue;
    }

    if (value === undefined) {
      errors.push({ addr, message: 'compute 返回 undefined（缺数，禁止填 0，见 R10/H6）' });
      continue;
    }

    resolved.set(addr, value);
    push(addr, value, mode === 'percent' ? 'percent' : 'value');
  }

  // 第二遍：alias 指向已算出的值
  for (const cell of cells) {
    if (!cell.alias) continue;

    if (!resolved.has(cell.alias)) {
      errors.push({ addr: cell.addr, message: `alias 目标 ${cell.alias} 没有算出值` });
      continue;
    }

    const value = resolved.get(cell.alias);
    push(cell.addr, value, cell.mode === 'percent' ? 'percent' : 'value');
    resolved.set(cell.addr, value);
  }

  return { writes, written, unresolved, errors };
}

module.exports = {
  buildStatisticsWrites,
  aliasedBy,
  SHEET_NAME,
  PERCENT_FORMAT
};
