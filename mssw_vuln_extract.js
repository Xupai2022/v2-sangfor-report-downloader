'use strict';

/**
 * 漏洞表解包层 —— 「下载之后、解析之前」那一步（漏洞表专用）。
 *
 * **用户口径（2026-10-16）：漏洞表要变成下载两份表。** 平台把它拆成内网 / 外网两份报表、
 * 下载产物是 **zip**，所以拿到 zip 之后必须先解包、把两份里那张完整清单
 * （`4-漏洞清单+跟踪记录`）抽出来，才能往下走：
 *
 *   zip ──本文件──▶ 一个两-sheet 的 xlsx（「内网漏洞表」/「互联网漏洞表」）
 *                       ├─▶ scripts/parse_table_rows.py：两张各按同一份三列白名单读，
 *                       │   行顺序拼成 ctx.vulnRows（「全表」= 两份相加）
 *                       └─▶ scripts/build_report.py：按 sheet 名搬进报告的两张 sheet
 *
 * 实际干活的是 scripts/extract_vuln_report.py 的 `extract_vuln_report`，本文件只负责
 * 拉起它、把结果与错误翻译成人话 —— 与 mssw_preprocess.js / mssw_parser.js 的分工同款。
 *
 * ⚠️ **与 mssw_client.exportMsswVulnList 的分界**：那一层只负责「把 zip 字节原样落到
 * 磁盘」，一个字都不改（scripts/verify_vuln_async.js 明确钉着这条）。解包放在它**之外**，
 * 就是这个文件 —— 别把 unzip 塞进 client 里，那会让那条验收门当场变红。
 *
 * ⚠️ **预处理（用户口径 2026-10-21）：删「处置状态 = 处置完成（误报）」的整行**。
 * 用户原话「所有的漏洞操作都是等预处理后才做的」—— 删行发生在 extract_vuln_report.py
 * 搬表之前，所以取值层与报告 sheet 看到的都是删过的行集合。
 * 2026-10-16 那版「靠 fixed_status 筛、本层不删」的口径**已作废**：现在不把筛选押在接口上。
 * stats/metrics/vuln.js 的 SETTLED_DISPOSITION_VALUE 按整格精确相等（2026-10-22 起），
 * 误报行由本层先删掉（带括号的本来也不算，删行是为了报告上的表本身干净）。
 */

const fs = require('fs');
const path = require('path');

const { encodePayload } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');

const EXTRACT_SCRIPT = path.join(__dirname, 'scripts', 'extract_vuln_report.py');

/**
 * 与 mssw_preprocess.js / mssw_parser.js 的 PYTHON_OPTIONS 同款。
 *
 * 两份报表都比单份大（实测内网 1775 行 × 30 列），openpyxl 读两个 + 写一个要几秒，
 * 超时给 10 分钟 —— 纯本地读盘，超时说明卡住了。env 走 workdir.childEnv()：
 * 关掉 __pycache__（集群上 skill 根是只读挂载）+ TMPDIR 指到可写区。
 */
const PYTHON_OPTIONS = {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 600000,
  env: workdir.childEnv()
};

/**
 * 从 zip 路径推出中间件（xlsx）的路径：同目录、同主名、换后缀。
 *
 * 由**调用方**（mssw_downloader.js）显式算好传进来，不在 Python 侧推：
 * 输出路径要能进幂等闸（同一份 zip 重跑要落到同一个地方），也需要在日志里
 * 提前出现 —— 两处用同一条规则推，就只能有一处实现。
 */
function vulnWorkbookPath(zipPath) {
  if (!zipPath) return '';
  return zipPath.replace(/\.zip$/i, '') + '.xlsx';
}

/**
 * 把 Python 侧的失败翻译成人话。
 *
 * 脚本失败时把 stderr 写成 {"diag":"error","message","logs"}，message 已经是人话
 * （哪份文件、缺哪张 sheet、是不是 zip 坏了），直接用。解析不出来（比如解释器压根没起来）
 * 就原样交回 error.message。
 */
function extractFailure(error) {
  const raw = String((error && error.message) || '').trim();
  try {
    const diag = JSON.parse(raw);
    if (diag && typeof diag === 'object' && typeof diag.message === 'string') {
      const failure = new Error(diag.message);
      // 失败前的日志不能丢：解包失败时「已经读到哪一份」就在那几行里
      if (Array.isArray(diag.logs) && diag.logs.length) {
        failure.logs = diag.logs;
      }
      return failure;
    }
  } catch (ignored) {
    // 不是 JSON：走下面原样交回
  }
  return new Error(raw || '漏洞表解包失败（Python 侧没有给出原因）');
}

/**
 * 漏洞表 zip -> 两-sheet 工作簿。
 *
 * @param {Object} options
 * @param {string} options.zipPath 下载下来的 zip（exportMsswVulnList 的 filePath）
 * @param {string} [options.outputPath] 中间件的输出路径。省略时按 vulnWorkbookPath 推
 *   （与 zip 同目录、同主名、换 .xlsx）。
 * @returns {Promise<{ran: boolean, alreadyPresent: boolean, filePath: string,
 *   sheets: Array<Object>, logs: string[]}>}
 *   `ran=false, alreadyPresent=true` = 幂等闸跳过（输出已存在且两张 sheet 齐），
 *   此时 `sheets` 是空数组（没重读，也就没有行数可报）。
 * @throws {Error} 脚本缺失 / zip 不存在或不是 zip / 两份里缺那张清单 sheet /
 *   输出文件已存在但不是本脚本的形态（写到一半的中间件）
 */
function extractVulnReport({ zipPath, outputPath } = {}) {
  if (!zipPath) {
    return Promise.reject(new Error('漏洞表下载件（zip）路径为空，无法解包'));
  }
  if (!fs.existsSync(EXTRACT_SCRIPT)) {
    // 早失败给个人话的错误，不然 execFile 只会抛 ENOENT 这种看不出所以然的信息
    return Promise.reject(new Error(`解包脚本不存在: ${EXTRACT_SCRIPT}`));
  }

  const payload = {
    zip: zipPath,
    output: outputPath || vulnWorkbookPath(zipPath)
  };

  return pythonCmd
    .execFilePython(EXTRACT_SCRIPT, [encodePayload(payload)], PYTHON_OPTIONS)
    .then((result) => {
      let parsed;
      try {
        parsed = JSON.parse(String(result.stdout).trim());
      } catch (parseError) {
        throw new Error(`解包脚本输出无法解析: ${result.stdout}`);
      }
      // 形状对不上就当契约破了，早说 —— 少一个 filePath 会让下游把「没解出来」
      // 当成「下载件就是这个」，然后把 zip 当 xlsx 读
      const missing = ['ran', 'filePath', 'sheets', 'logs']
        .filter((key) => parsed[key] === undefined);
      if (missing.length) {
        throw new Error(`解包脚本返回的 JSON 缺字段: ${missing.join('、')}`);
      }
      return parsed;
    }, (error) => {
      throw extractFailure(error);
    });
}

module.exports = { extractVulnReport, vulnWorkbookPath, EXTRACT_SCRIPT };
