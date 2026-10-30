#!/usr/bin/env node
'use strict';

/**
 * 漏洞表**解包层**验收 —— 「zip -> 两-sheet 工作簿」这一步的验证门：
 * `node scripts/verify_vuln_extract.js`（退出码 0 = 通过）。
 *
 * 为什么需要这一道门：2026-10-16 起下载产物是 zip，解包 + 抽 sheet 是新长出来的一层，
 * 而它**两边都不是**：
 *   · scripts/verify_vuln_async.js 只钉到「zip 字节原样落盘」—— 它明确不看解包
 *     （那条断言正是"别把 unzip 塞进 client 里"的护栏）；
 *   · scripts/verify_write_layer.js 从「磁盘上已经有一个两-sheet 的 xlsx」开始验，
 *     解包这一步在它之外。
 * 于是「zip 里的两张 → 两张 sheet」中间是空的：取错 sheet、少搬一份、顺手删了误报行，
 * 这三件事都不会让任何别的门变红。
 *
 * 分工仍是本仓那一条（见 scripts/verify_write_layer.js 的头注）：**文件里到底落了什么
 * 只能由 Python 读回来看**（openpyxl 在那一侧，JS 连读 xlsx 都做不到），所以：
 *
 *   verify_vuln_extract.js（本文件）   JS 才做得了的事：调**真的 extractVulnReport**
 *                                      （生产那一层，mssw_downloader.js 直接调它）、
 *                                      钉 mssw_vuln_extract.js 自己的契约
 *   scripts/verify_vuln_extract.py     造 zip fixture + 读回产物逐格断言
 *
 * 子命令（供 Python 主体回调，与 verify_write_layer.js 的 plan/build 同款）：
 *   extract <B64 json>   跑一次真的 extractVulnReport({zipPath, outputPath})，
 *                        把 {ok, result|message, logs} 打到 stdout
 *   （不带子命令）        验收入口：本文件自己的 JS 断言 + 拉起 Python 主体
 */

const path = require('path');
const { execFile } = require('child_process');

const { encodePayload } = require('../path_helper');
const pythonCmd = require('../python_cmd');
const workdir = require('../workdir');
const { extractVulnReport, vulnWorkbookPath, EXTRACT_SCRIPT } = require('../mssw_vuln_extract');

const PY_SCRIPT = path.join(__dirname, 'verify_vuln_extract.py');

/** 验收未通过（Python 侧断言挂了）的退出码。刻意避开 1，理由见 verify_write_layer.js。 */
const ACCEPTANCE_FAILED = 2;

/**
 * 子命令：调真的 extractVulnReport，把结果或错误**原样**交回 Python 主体。
 *
 * 成功失败都打到 stdout、都用退出码 0 —— Python 侧只解析 stdout 这一个通道，
 * 不必再分「node 崩了」和「解包失败」两种读法（前者会表现为 stdout 为空，
 * 主体那边当场报得出来）。
 */
function runExtractCommand(argument) {
  let request;
  try {
    request = JSON.parse(Buffer.from(String(argument).replace(/^B64:/, ''), 'base64').toString('utf8'));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, message: `子命令参数不是 B64 JSON: ${error.message}` }));
    return 0;
  }

  return extractVulnReport(request).then(
    (result) => {
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return 0;
    },
    (error) => {
      process.stdout.write(JSON.stringify({
        ok: false,
        message: error.message,
        // 解包失败那一刻的日志（"已经读到哪一份"就在里面）—— 有就带回去
        logs: Array.isArray(error.logs) ? error.logs : []
      }));
      return 0;
    }
  );
}

/** 本文件自己的断言（逐条打 PASS/FAIL，与另几道门的输出形状一致）。 */
const CASES = [];
const check = (name, fn) => CASES.push({ name, fn });
const assert = require('assert');

// 1 -------------------------------------------------------------------------
// 中间件路径的推导规则：同目录、同主名、换后缀。**幂等闸就落在这个路径上** ——
// 推错一次（比如把主名也改了）会让同一份 zip 每次重跑都写出一个新文件。
check('vulnWorkbookPath：同目录同主名换后缀（幂等闸压在这个路径上）', () => {
  assert.strictEqual(vulnWorkbookPath('C:\\a\\漏洞_20261016.zip'), 'C:\\a\\漏洞_20261016.xlsx');
  assert.strictEqual(vulnWorkbookPath('/tmp/x.zip'), '/tmp/x.xlsx');
  // 大小写与"不以下载件后缀结尾"两种形态：不猜、只有 .zip 才换
  assert.strictEqual(vulnWorkbookPath('/tmp/x.ZIP'), '/tmp/x.xlsx');
  assert.strictEqual(vulnWorkbookPath('/tmp/x.zip.zip'), '/tmp/x.zip.xlsx');
  assert.strictEqual(vulnWorkbookPath(''), '', '空路径给空串（调用方要能一眼看出没值）');
  assert.strictEqual(vulnWorkbookPath(undefined), '');
});

// 2 -------------------------------------------------------------------------
check('zip 路径为空 -> 当场 reject，且一个进程都不拉起来', async () => {
  await assert.rejects(() => extractVulnReport({ zipPath: '' }),
    /zip|压缩包|解包/);
  await assert.rejects(() => extractVulnReport({}), /zip|压缩包|解包/);
});

// 3 -------------------------------------------------------------------------
// 走到真脚本里的那条错路：payload 的键名写错（zip -> file）会让 Python 侧报
// 「路径为空」而不是别的错 —— 这条钉的是**两个键的名字**，以及 diag 翻译那一段。
check('不存在的 zip -> 报错文案来自 Python 侧（payload 键名与 diag 翻译都通）', async () => {
  const missing = path.join(require('os').tmpdir(), 'vuln-extract-definitely-missing', 'nope.zip');
  await assert.rejects(() => extractVulnReport({ zipPath: missing }), /下载件不存在/);
});

// 4 -------------------------------------------------------------------------
check('脚本指针指向 scripts/ 下那个真脚本（解包逻辑只此一处）', () => {
  assert.strictEqual(path.basename(EXTRACT_SCRIPT), 'extract_vuln_report.py');
  assert.strictEqual(path.dirname(EXTRACT_SCRIPT), __dirname);
  assert.ok(require('fs').existsSync(EXTRACT_SCRIPT), `脚本不在: ${EXTRACT_SCRIPT}`);
});

(async () => {
  const [command, argument] = process.argv.slice(2);

  // 子命令：交给 Python 主体回调（不与下面的 JS 断言混在一起跑）
  if (command === 'extract') {
    process.exitCode = await runExtractCommand(argument);
    return;
  }

  let failed = 0;
  for (const item of CASES) {
    try {
      await item.fn();
      process.stdout.write(`PASS  ${item.name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL  ${item.name}\n      ${error.message}\n`);
    }
  }

  // 文件层的事（造 zip fixture + 读回产物）只能由 Python 做，交给它收尾
  const code = await runAcceptance();
  if (failed) {
    process.stdout.write(`\n${failed}/${CASES.length} 项失败\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code;
})().catch((error) => {
  process.stderr.write(`\n验收失败: ${error.message}\n`);
  process.exitCode = 1;
});

/** 拉起 Python 主体（照 verify_write_layer.js 的 runAcceptance：解释器不写死）。 */
function runAcceptance() {
  const list = pythonCmd.candidates();
  const args = [PY_SCRIPT, encodePayload({
    repo: path.join(__dirname, '..'),
    bridge: __filename
  })];
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: workdir.childEnv()
  };

  const attempt = (index) => new Promise((resolve, reject) => {
    const cmd = list[index];
    execFile(cmd, args, options, (error, stdout, stderr) => {
      // 退出码 2 = 断言没过（Python 侧刻意不用 1，理由见 verify_write_layer.js）
      if (!error || error.code === ACCEPTANCE_FAILED) {
        process.stdout.write(String(stdout || ''));
        if (stderr) process.stderr.write(String(stderr));
        resolve(error ? ACCEPTANCE_FAILED : 0);
        return;
      }

      const missing = pythonCmd.isInterpreterSpawnError(error)
        || pythonCmd.isInterpreterMissing(error.code, stderr);
      if (missing && index + 1 < list.length) {
        process.stderr.write(`[python] ${cmd} 不可用（${error.code}），改用 ${list[index + 1]} 重试 ...\n`);
        attempt(index + 1).then(resolve, reject);
        return;
      }

      process.stdout.write(String(stdout || ''));
      reject(new Error(String(stderr || '').trim() || `${cmd} 执行失败（退出码 ${error.code}）`));
    });
  });

  return attempt(0);
}
