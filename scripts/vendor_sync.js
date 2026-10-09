#!/usr/bin/env node
'use strict';

/**
 * vendor/ 快照同步与校验。
 *
 * 规则与基线都在 vendor/MANIFEST.json 一份里（exclude 段是规则，files 段是 sha256 基线），
 * 本脚本只负责执行它们 —— 不在这里另写一套排除逻辑，避免规则两处维护后漂移。
 * pptgen/doctor.py 读的是同一份 MANIFEST.json。
 *
 * 用法：
 *   node scripts/vendor_sync.js            按 MANIFEST.json 重拉快照，回写 sha256
 *   node scripts/vendor_sync.js --check    只校验：vendor/ 是否与基线逐字一致（不写盘）
 *   node scripts/vendor_sync.js --dry-run  只列出会拷/会删的文件
 *   node scripts/vendor_sync.js --json     结果打到 stdout
 *
 * --check 的退出码：有漂移为 1，便于挂 CI。
 *
 * 注意：vendor/ 里的文件**永远不手改**。手改会破坏「目录级 1:1」，--check 能查出来。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'vendor', 'MANIFEST.json');

// ---------- MANIFEST ----------

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`缺少 ${path.relative(ROOT, MANIFEST_PATH)}。它是快照规则的唯一真相，必须先存在。`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** 只回写数据段，保留规则段与注释键（MANIFEST 里以 _ 开头的键，以及 exclude/fingerprints）。 */
function writeManifest(manifest, files, totalBytes) {
  const next = { ...manifest };
  next.copied_at = new Date().toISOString();
  next.file_count = Object.keys(files).length;
  next.total_bytes = totalBytes;
  next.files = files;
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

// ---------- 排除规则 ----------

/**
 * 把 glob 编译成正则，路径分隔符固定为 /。
 *
 * 逐个字符扫，因为「双星跟着斜杠」与「双星在末尾」含义不同：前者是零层或多层目录，
 * 后者是任意内容（可为空）。用 replace 串着写会把后者的尾巴也当成目录前缀，
 * 结果一条都匹配不上。
 */
function globToRegExp(glob) {
  let out = '';
  const s = String(glob);

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];

    if (ch === '*') {
      if (s[i + 1] === '*') {
        if (s[i + 2] === '/') {
          out += '(?:.*/)?';   // **/  -> 零层或多层目录
          i += 2;
        } else {
          out += '.*';         // **   -> 任意内容
          i += 1;
        }
        continue;
      }
      out += '[^/]*';          // *    -> 单层内任意
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

/**
 * 归一化排除规则：把显式排除的目录展开成前缀，供快速判断用。
 * 返回 { dirPrefixes, files:Set, globRes }。
 */
function buildExcluder(exclude = {}) {
  const dirPrefixes = (exclude.dirs || []).map((d) => `${normalizeRel(d)}/`);
  const files = new Set((exclude.files || []).map(normalizeRel));
  const globRes = (exclude.globs || []).map(globToRegExp);

  return function isExcluded(rel) {
    const normalized = normalizeRel(rel);
    for (const prefix of dirPrefixes) {
      if (normalized.startsWith(prefix)) return true;
    }
    if (files.has(normalized)) return true;
    for (const re of globRes) {
      if (re.test(normalized)) return true;
    }
    return false;
  };
}

function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

// ---------- 遍历 ----------

/** 递归收集 root 下所有文件的相对路径（/ 分隔，字典序）。 */
function walkFiles(root, rel = '', out = []) {
  const abs = rel ? path.join(root, rel) : root;
  if (!fs.existsSync(abs)) return out;

  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkFiles(root, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function sha256(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** 列出一棵树的 sha256 表。文件路径统一存成相对 vendor_dir 的形式。 */
function hashTree(absDir) {
  const files = {};
  let totalBytes = 0;
  for (const rel of walkFiles(absDir)) {
    const abs = path.join(absDir, rel);
    files[rel] = sha256(abs);
    totalBytes += fs.statSync(abs).size;
  }
  return { files, totalBytes };
}

// ---------- 命令 ----------

/** 期望的 vendor 内容：上游源树 − 排除规则。 */
function expectedFiles(manifest) {
  const srcPkg = path.join(manifest.source_root, manifest.source_package);
  if (!fs.existsSync(srcPkg)) {
    throw new Error(`上游源目录不存在: ${srcPkg}\n可从 MANIFEST.json 的 source_root 修正。`);
  }
  const isExcluded = buildExcluder(manifest.exclude);
  const kept = [];
  const excluded = [];
  for (const rel of walkFiles(srcPkg)) {
    (isExcluded(rel) ? excluded : kept).push(rel);
  }
  return { srcPkg, kept, excluded };
}

function cmdCheck(manifest) {
  const vendorDir = path.join(ROOT, manifest.vendor_dir);
  if (!fs.existsSync(vendorDir)) {
    return { ok: false, reason: 'missing_vendor_dir', vendor_dir: path.relative(ROOT, vendorDir) };
  }

  const actual = hashTree(vendorDir).files;
  const baseline = manifest.files || {};

  const missing = [];   // 基线有、vendor 没有
  const modified = [];  // 两边都有但 sha256 不同
  const added = [];     // vendor 有、基线没有（手加的文件）

  for (const [rel, hash] of Object.entries(baseline)) {
    if (!(rel in actual)) missing.push(rel);
    else if (actual[rel] !== hash) modified.push(rel);
  }
  for (const rel of Object.keys(actual)) {
    if (!(rel in baseline)) added.push(rel);
  }

  const drift = missing.length + modified.length + added.length;
  return {
    ok: drift === 0,
    reason: drift === 0 ? 'clean' : 'drift',
    baseline_count: Object.keys(baseline).length,
    actual_count: Object.keys(actual).length,
    missing,
    modified,
    added
  };
}

function cmdSync(manifest, { dryRun }) {
  const { srcPkg, kept } = expectedFiles(manifest);
  const vendorDir = path.join(ROOT, manifest.vendor_dir);

  const actual = fs.existsSync(vendorDir) ? walkFiles(vendorDir) : [];
  const expectedSet = new Set(kept);

  const toCopy = kept.filter((rel) => {
    const abs = path.join(vendorDir, rel);
    if (!fs.existsSync(abs)) return true;
    return sha256(abs) !== sha256(path.join(srcPkg, rel));
  });
  const toDelete = actual.filter((rel) => !expectedSet.has(rel));

  if (dryRun) {
    return { ok: true, dry_run: true, copy: toCopy, delete: toDelete, kept_count: kept.length };
  }

  for (const rel of toCopy) {
    const dest = path.join(vendorDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcPkg, rel), dest);
  }

  for (const rel of toDelete) {
    fs.unlinkSync(path.join(vendorDir, rel));
  }

  // 删掉因删文件而变空的目录（只清 vendor_dir 内部）
  for (const dir of listDirsDeep(vendorDir)) {
    if (dir !== vendorDir && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  }

  const { files, totalBytes } = hashTree(vendorDir);
  writeManifest(manifest, files, totalBytes);

  return {
    ok: true,
    copied: toCopy.length,
    deleted: toDelete.length,
    file_count: Object.keys(files).length,
    total_bytes: totalBytes
  };
}

function listDirsDeep(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    out.push(abs);
    listDirsDeep(abs, out);
  }
  // 深度优先：先列子目录，便于自底向上删空目录
  return out.sort((a, b) => b.length - a.length);
}

// ---------- 入口 ----------

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const check = argv.includes('--check');

  const emit = (payload, exitCode) => {
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    process.exitCode = exitCode;
  };

  try {
    const manifest = readManifest();
    const result = check ? cmdCheck(manifest) : cmdSync(manifest, { dryRun });

    if (!asJson) {
      if (check) {
        if (result.ok) {
          console.error(`vendor 快照一致：${result.actual_count} 个文件与 MANIFEST.json 基线逐字相同`);
        } else {
          console.error(`vendor 快照有漂移（基线 ${result.baseline_count} / 实际 ${result.actual_count}）:`);
          for (const rel of result.missing) console.error(`  缺失: ${rel}`);
          for (const rel of result.modified) console.error(`  被改: ${rel}`);
          for (const rel of result.added) console.error(`  多余: ${rel}`);
          console.error('修法：node scripts/vendor_sync.js（vendor/ 永远不手改）');
        }
      } else if (dryRun) {
        console.error(`会拷 ${result.copy.length} 个、会删 ${result.delete.length} 个（保留 ${result.kept_count} 个）`);
        for (const rel of result.copy) console.error(`  + ${rel}`);
        for (const rel of result.delete) console.error(`  - ${rel}`);
      } else {
        console.error(
          `vendor 快照已同步：拷贝 ${result.copied} 个，删除 ${result.deleted} 个，`
          + `现存 ${result.file_count} 个文件 / ${(result.total_bytes / 1048576).toFixed(1)}M`
        );
      }
    }

    emit(result, result.ok ? 0 : 1);
  } catch (error) {
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: { message: error.message } }, null, 2));
    } else {
      console.error(`失败: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { readManifest, cmdCheck, cmdSync, buildExcluder, hashTree, walkFiles, MANIFEST_PATH };
