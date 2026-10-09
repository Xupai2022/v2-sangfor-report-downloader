#!/usr/bin/env node
'use strict';

/**
 * 单元格登记表查询 / 校验命令（CELL_REGISTRY.md §9）。
 *
 * 用法：
 *   node scripts/cell.js D24           查一格：label / desc / 算法出处 / mode / verify
 *   node scripts/cell.js --list        全部地址 + label
 *   node scripts/cell.js --unresolved  口径未定清单（H7），即当前待办
 *   node scripts/cell.js --check       校验 K1–K5
 *   node scripts/cell.js --impact D12  反向查：D12 被哪些地址 alias
 *
 * 退出码：--check 有 ERROR 时为 1，便于挂 CI。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { CELLS, byAddr, aliasedBy, BASELINE } = require(path.join(ROOT, 'stats'));

// ---------- 定位一条记录在源码里的位置（"算法出处"） ----------

/**
 * verify 是否「填了」（V2：未填不得进入验收）。
 *
 * 判据就是非空。内容格式由测试人员自定（CELL_REGISTRY.md §6 V4），本脚本不做格式校验 ——
 * 校验格式只会逼着人凑格式，凑出来的字符串照样进不了验收。
 *
 * verify 由测试人员填写，写代码的人与 AI 都不填（V3），所以「非空」等价于
 * 「测试人员看过了」。这正是 V2 想拦的东西。
 */
function isVerifyFilled(verify) {
  return String(verify || '').trim() !== '';
}

const CELLS_DIR = path.join(ROOT, 'stats', 'cells');

function listSourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SOURCE_FILES = listSourceFiles(CELLS_DIR);

/** 在 cells/ 源码里找 addr 出现在哪一行 */
function locate(addr) {
  const needle = new RegExp(`['"\`]${addr}['"\`]`);
  for (const file of SOURCE_FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (needle.test(lines[i])) {
        return `${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}`;
      }
    }
  }
  return '（未在 cells/ 源码中定位到）';
}

// ---------- 输出 ----------

function printCell(cell) {
  const rel = path.relative(ROOT, path.join(CELLS_DIR)).replace(/\\/g, '/');
  console.log(`${cell.addr}  ${cell.label || '（label 待补）'}`);
  console.log(`  desc    ${cell.desc || '（待补，见 CELL_REGISTRY.md §5）'}`);
  if (cell.alias) {
    console.log(`  alias   -> ${cell.alias}${byAddr.has(cell.alias) ? ` (${byAddr.get(cell.alias).label})` : ' ← 目标不存在！'}`);
  } else if (typeof cell.compute === 'function') {
    console.log(`  compute ${locate(cell.addr)}`);
  }
  if (cell.mode) {
    console.log(`  mode    ${cell.mode}${cell.mode === 'literal' ? ` = ${JSON.stringify(cell.value)}` : ''}`);
  }
  if (cell.note) console.log(`  note    ${cell.note}`);
  const back = aliasedBy(cell.addr);
  if (back.length) console.log(`  被指向  ${back.join(', ')}`);
  console.log(`  verify  ${cell.verify || '（待测试人员填写，CELL_REGISTRY.md §6）'}`);
  console.log(`  (${rel} 域文件)`);
}

// ---------- 校验 ----------

const ADDR_IDENTIFIER = /\b(?:const|let|var|function)\s+([A-Za-z]\d+)\b/g;

/** K4：cells/ 与 metrics/ 里不得出现以单元格地址命名的标识符（H2） */
function checkNoAddressIdentifiers() {
  const hits = [];
  const dirs = [path.join(ROOT, 'stats', 'cells'), path.join(ROOT, 'stats', 'metrics')];
  for (const dir of dirs) {
    for (const file of listSourceFiles(dir)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return; // 注释不算
        for (const match of line.matchAll(ADDR_IDENTIFIER)) {
          hits.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${i + 1}  ${match[1]}`);
        }
      });
    }
  }
  return hits;
}

function runCheck() {
  const errors = [];
  const warnings = [];

  const addrs = CELLS.map((c) => c.addr);
  const unique = new Set(addrs);

  // K1：地址集合必须等于 R1 基准
  const baselineSet = new Set(BASELINE.addresses);
  const missing = BASELINE.addresses.filter((a) => !unique.has(a));
  const extra = [...unique].filter((a) => !baselineSet.has(a));
  if (missing.length) errors.push(`K1 缺失 ${missing.length} 个 R1 基准地址: ${missing.join(' ')}`);
  if (extra.length) errors.push(`K1 多出 ${extra.length} 个非基准地址: ${extra.join(' ')}`);
  if (addrs.length !== unique.size) errors.push(`K1 存在重复地址（${addrs.length} 条记录 / ${unique.size} 个唯一地址）`);
  if (BASELINE.count !== BASELINE.addresses.length) {
    errors.push(`K1 r1_baseline.count(${BASELINE.count}) 与 addresses 长度(${BASELINE.addresses.length}) 不一致`);
  }

  // K2：四字段齐全
  for (const cell of CELLS) {
    for (const field of ['label', 'desc', 'verify']) {
      if (!(field in cell)) errors.push(`K2 ${cell.addr} 缺少字段 ${field}`);
    }
    if (cell.label === undefined) errors.push(`K2 ${cell.addr} label 为 undefined`);
  }

  // K3：结构合法性
  for (const cell of CELLS) {
    if (cell.alias && cell.compute) errors.push(`K3 ${cell.addr} 同时有 alias 和 compute（H5）`);
    if (!cell.alias && !cell.compute && cell.mode !== 'unresolved' && cell.mode !== 'literal' && cell.mode !== 'blank') {
      errors.push(`K3 ${cell.addr} 既没有 alias 也没有 compute（mode=${cell.mode}）`);
    }
    if (cell.mode === 'literal' && cell.value === undefined) errors.push(`K3 ${cell.addr} mode:'literal' 但缺 value`);
    if (cell.mode === 'unresolved' && !cell.note) errors.push(`K3 ${cell.addr} mode:'unresolved' 但缺 note（H7）`);
    if (cell.alias && !byAddr.has(cell.alias)) errors.push(`K3 ${cell.addr} alias 指向不存在的地址 ${cell.alias}`);
    if (cell.alias && byAddr.has(cell.alias) && byAddr.get(cell.alias).alias) {
      errors.push(`K3 ${cell.addr} alias 指向的 ${cell.alias} 本身也是 alias，请直接指向最终地址`);
    }
  }

  // K4：无地址命名标识符
  const hits = checkNoAddressIdentifiers();
  for (const hit of hits) errors.push(`K4 出现以单元格地址命名的标识符（H2）: ${hit}`);

  // K5：覆盖率
  const coverage = (field) => CELLS.filter((c) => c[field]).length;
  const total = CELLS.length;
  const verifyDone = CELLS.filter((c) => isVerifyFilled(c.verify)).length;
  console.log(`地址总数        ${total}  (R1 基准 ${BASELINE.count})`);
  console.log(`唯一地址        ${unique.size}`);
  console.log(`label 覆盖      ${coverage('label')} / ${total}  (${pct(coverage('label'), total)})`);
  console.log(`desc  覆盖      ${coverage('desc')} / ${total}  (${pct(coverage('desc'), total)})`);
  console.log(`verify 覆盖     ${verifyDone} / ${total}  (${pct(verifyDone, total)})  [由测试人员填写]`);
  const byMode = {};
  for (const cell of CELLS) byMode[cell.mode || '(取值)'] = (byMode[cell.mode || '(取值)'] || 0) + 1;
  console.log(`mode 分布       ${Object.entries(byMode).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  if (verifyDone < total) {
    warnings.push(`V2 verify 未填满（${total - verifyDone} 格），不得进入验收（M6）`);
  }
  console.log('');

  for (const warning of warnings) console.log(`WARN   ${warning}`);
  for (const error of errors) console.log(`ERROR  ${error}`);

  if (!errors.length && !warnings.length) console.log('全部通过（K1–K5）');
  else if (!errors.length) console.log(`校验通过（K1–K4），有 ${warnings.length} 条 WARN`);

  return errors.length ? 1 : 0;
}

const pct = (n, total) => (total ? `${(n / total * 100).toFixed(1)}%` : 'n/a');

// ---------- 入口 ----------

function main() {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (!flag || flag === '--help' || flag === '-h') {
    console.log(`用法:
  node scripts/cell.js <地址>        查一格，如 D24
  node scripts/cell.js --list        全部地址 + label
  node scripts/cell.js --unresolved  口径未定清单（H7）
  node scripts/cell.js --check       校验 K1–K5
  node scripts/cell.js --impact <地址>  反向查 alias 引用`);
    return 0;
  }

  if (flag === '--check') return runCheck();

  if (flag === '--list') {
    for (const cell of CELLS) {
      const flags = [cell.mode, cell.alias ? `->${cell.alias}` : ''].filter(Boolean).join(' ');
      console.log(`${cell.addr.padEnd(6)} ${(cell.label || '（待补）').padEnd(34)} ${isVerifyFilled(cell.verify) ? '✓' : ' '} ${flags}`);
    }
    console.log(`\n共 ${CELLS.length} 格`);
    return 0;
  }

  if (flag === '--unresolved') {
    const list = CELLS.filter((c) => c.mode === 'unresolved');
    for (const cell of list) console.log(`${cell.addr.padEnd(6)} ${cell.label || '（待补）'}`);
    console.log(`\n共 ${list.length} 格口径未定`);
    return 0;
  }

  if (flag === '--impact') {
    const addr = args[1];
    if (!addr) {
      console.error('用法: node scripts/cell.js --impact <地址>');
      return 1;
    }
    const back = aliasedBy(addr);
    console.log(`${addr} 被 ${back.length} 个地址 alias 引用: ${back.join(' ') || '（无）'}`);
    return 0;
  }

  if (!byAddr.has(flag)) {
    console.error(`地址不在登记表中: ${flag}（R1 基准共 ${BASELINE.count} 个地址，用 --list 查看）`);
    return 1;
  }
  printCell(byAddr.get(flag));
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, runCheck };
