'use strict';

/**
 * 单元格登记表汇总入口。
 *
 * CELLS 是「数据统计」sheet 全部取值逻辑的唯一真相源（CELL_REGISTRY.md R14）。
 * 地址集合必须等于 r1_baseline.js 的 429 个地址 —— 由 scripts/cell.js --check 校验（K1）。
 *
 * 域划分见 CELL_REGISTRY.md §8 F1。
 * M1 阶段全部走 _baseline（过渡态：426 条 unresolved + 3 个已转正的报告参数格）；
 * M1.5 按数据源拆成域文件后，把下面 GROUPS 里的 _baseline 替换成域文件即可。
 */

const BASELINE = require('./r1_baseline');

const GROUPS = [
  require('./cells/_baseline')
  // M1.5 起逐个替换为：
  // require('./cells/event'), require('./cells/alarm'), require('./cells/vuln'),
  // require('./cells/weakpwd'), require('./cells/asset'), require('./cells/exposed'),
  // require('./cells/protection'), require('./cells/literal')
];

const CELLS = GROUPS.flat();

/** addr -> 记录。重复地址违反 H1，直接抛。 */
const byAddr = new Map();
for (const cell of CELLS) {
  if (!cell || typeof cell.addr !== 'string' || !cell.addr) {
    throw new Error(`登记表存在没有 addr 的记录: ${JSON.stringify(cell)}`);
  }
  if (byAddr.has(cell.addr)) {
    throw new Error(`地址重复登记: ${cell.addr}（违反 CELL_REGISTRY.md H1）`);
  }
  byAddr.set(cell.addr, cell);
}

/** 反向索引：被哪些地址 alias 指过来（CELL_REGISTRY.md §9 --impact） */
function aliasedBy(addr) {
  return CELLS.filter((cell) => cell.alias === addr).map((cell) => cell.addr);
}

module.exports = { CELLS, byAddr, aliasedBy, BASELINE };
