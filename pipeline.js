#!/usr/bin/env node
'use strict';

/**
 * 端到端入口：下载 → Excel → PPT，一个命令。
 *
 *     node pipeline.js generate --customer <名> --start <Y-M-D> --end <Y-M-D>
 *
 * 登录态：默认集群模式（不传 --cookie-path），由 session-manager 代管；
 * 传 --cookie-path 则退回本地模式，直接读那个 cookie 文件。见 session.js。
 *     node pipeline.js rewrite   --slide 36 --prompt "更强调威胁运营的改进闭环，控制在 300 字内"
 *     node pipeline.js list-slides --rewritable
 *     node pipeline.js doctor --verify-vendor --probe-llm
 *
 * 与旧三层结构的关系：以前是 ai-ppt-pipeline 编排 → 本仓库的 mssw_downloader 出 Excel
 * → 再打 HTTP 到我部署的 report-generation 服务出 PPT。现在 PPT 那一段改成**进程内**
 * 跑 vendor/ 里的引擎（python -m pptgen），不再经过服务。
 *
 * `mssw_downloader.js` 一行没改，这里只是 require 它的 run()。所以：
 *     node mssw_downloader.js ...     ← 原命令行行为完全不变
 *
 * ---------------------------------------------------------------------------
 * 三条契约
 * ---------------------------------------------------------------------------
 *
 * 1. **stdout 只有一个 JSON**。下载器与 pptgen 的进度全走 stderr。
 *    mssw_downloader.run() 在 options.json 为真时会自己 console.log 整包 JSON，
 *    会污染 stdout —— 所以这里**必须**传 json: false。
 *
 * 2. **Excel 先落盘，PPT 失败不回滚**。顺序硬编码「先 Excel 后 PPT」。
 *    PPT 挂了就把 excel.ok=true / ppt.ok=false 如实写进 JSON，并以非零码退出。
 *    理由：Excel 本身就是可交付物（本仓库的 429 格口径还在起步阶段，
 *    但已经比 PPT 完整），删掉它等于把已经成功的那一半也扔掉。
 *
 * 3. **跨语言入参整包 B64**。见下方 pptgenArgs()。
 *
 * ---------------------------------------------------------------------------
 * 退出码
 * ---------------------------------------------------------------------------
 *
 *    0  成功
 *    1  未归类异常
 *    2  参数错
 *    3  LLM 不可用（禁用 / 不可达 / 鉴权失败，来自 pptgen）
 *    4  vendor 快照或适配层坏了（来自 pptgen）
 *    5  模板 / 页 / token 找不到（来自 pptgen）
 *    6  渲染失败（来自 pptgen）
 *    7  doctor 不通过（来自 pptgen）
 *    8  下载失败（有表没下到，未生成 Excel）
 *    9  pptgen 超时被 kill（产物可能不完整，但不删）
 *
 * 3~7 是 pptgen 自己的码，直接透传 —— 让 OpenClaw 能区分「重试」还是「改参数」。
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { parseArgs, splitList } = require('./args');
const { encodePath } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');
const progress = require('./progress');
const runlog = require('./runlog');
const downloader = require('./mssw_downloader');
// 失败分类（code / 退出码 / hint）与 mssw_downloader 的 main 共用这一份，
// 免得同一份报错在两个入口给出不同的码和提示。退出码 8（下载失败）/ 10（拿不到登录态）
// 的定义、以及 AUTH_ERROR_CODE / NOT_CONFIGURED_CODE 的判据都在那边。
const { classifyFailure } = require('./mssw_errors');

const REPO_ROOT = __dirname;
const PPTGEN_MODULE = 'pptgen';

const EXIT_OK = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_BAD_REQUEST = 2;
const EXIT_PPT_TIMEOUT = 9;

const DEFAULT_TEMPLATE = 'mss_classic_ops_2';

// 40 页要发多批请求。默认给足 30 分钟，只 kill 进程、不删产物。
const DEFAULT_PPT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * focus 的中文别名。**这是我们 CLI 的词汇，不是上游的。**
 *
 * 上游的权威别名表在 vendor/.../schemas/requests.py 的 FOCUS_OPTION_ALIASES，
 * 那是 HTTP 契约；它只认「漏洞优先 / 告警优先 / 业务保护」这三个**完整**标题。
 *
 * 旧 ai-ppt-pipeline 的用法是 `--focus 业务保护,漏洞,告警` —— 其中「漏洞」「告警」
 * 在上游会被 `raise ValueError("Unsupported focus option: 漏洞")` 直接拒掉。
 * 这里把它们补成别名，是为了让用户凭旧习惯敲的命令仍然可用。
 * 映射在 Node 侧做完再下传，所以 pptgen 只认三个 id，不需要知道中文。
 */
const FOCUS_ALIASES = {
  business_protection: 'business_protection',
  业务保护: 'business_protection',
  'business protection': 'business_protection',

  vulnerability: 'vulnerability',
  漏洞: 'vulnerability',
  脆弱性: 'vulnerability',
  漏洞优先: 'vulnerability',
  'vulnerability priority': 'vulnerability',

  alert: 'alert',
  告警: 'alert',
  告警优先: 'alert',
  'alert priority': 'alert'
};

// 默认三个全开。注意 pptgen 侧「一个都不传」的含义**不是**「三个全开」：
// 引擎 _resolve_selected_annotations(None) 直接返回 []，AI 提示词里的
// {preference} 会留空。要那个行为就用 --no-focus。
const DEFAULT_FOCUS = ['business_protection', 'vulnerability', 'alert'];

/**
 * 本次运行的目录：outputs/{YYYYMMDD_HHMMSS}，**保证是个新目录**。
 *
 * 这是 `pptgen/paths.py` 的 `new_run_dir()` 的镜像 —— 规则必须一致，两处都要有：
 * 这里要有是因为 **Excel 在 PPT 之前下载**，而 Excel 也要落进同一个 run 目录，
 * 所以目录必须在这一步就定下来，不能等 pptgen 自己去铸。
 * （ppTgen 那条无 --run-dir 的独立入口仍然会自己铸，给 `python -m pptgen generate` 用。）
 *
 * 同一秒内起第二次就顺延到下一秒：名字保持是纯时间戳，且永远不会踩掉上一次的产物。
 *
 * 优先级：`--run-dir` > （真会下载时的）`--output-dir` > 新铸的时间目录。
 * `--output-dir` 只在下载时算数：`--excel --no-download` 那条路它本来就无事可做，
 * 让它顺便改掉 PPT 落点只会让人意外。
 */
function newRunDir(options, willDownload) {
  if (options['run-dir']) return resolveRunPath(options['run-dir']);
  if (willDownload && options['output-dir']) return resolveRunPath(options['output-dir']);
  const base = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  for (let offset = 0; offset < 120; offset += 1) {
    const moment = new Date(base.getTime() + offset * 1000);
    const name = `${moment.getFullYear()}${pad(moment.getMonth() + 1)}${pad(moment.getDate())}`
      + `_${pad(moment.getHours())}${pad(moment.getMinutes())}${pad(moment.getSeconds())}`;
    const candidate = path.join(runsBase(), name);
    if (!fs.existsSync(candidate)) return candidate;
  }
  const error = new Error('outputs/ 下连续 120 秒的时间戳目录都被占用了，先清理 outputs/');
  error.code = 'bad_request';
  throw error;
}

/**
 * run 目录的父目录。
 *
 * 集群上 skill 根只读，必须落到 guard 注入的可写区（`<SKILL_OUTPUT_DIR>/outputs`）；
 * 没设 `SKILL_OUTPUT_DIR` 就是本地，保持 `<repo>/outputs` 逐字不变。
 * 这条口径已收进 `workdir.runsBase()` —— runlog.js 的日志目录用的是同一个，
 * 别再在这儿写第二份实现。
 */
function runsBase() {
  return workdir.runsBase();
}

/** 用户给的 run/output 目录：集群下相对路径相对可写根解析（cwd 可能就是只读的 skill 根）。 */
function resolveRunPath(value) {
  const raw = String(value);
  return workdir.hasSkillOutputDir() ? workdir.resolveWritable(raw) : path.resolve(raw);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

let quiet = false;

/**
 * 进度一律走 stderr —— stdout 只留给最后的汇总 JSON。
 *
 * `--quiet` 只压控制台，**不压日志文件**：那条通路绕过了 stderr（也就绕过了
 * runlog 的镜像），所以这里显式补一次。日志是事后排障的唯一凭据，不该被开关关掉。
 */
function logger(message) {
  if (quiet) {
    runlog.line(message);
    return;
  }
  process.stderr.write(`${message}\n`);
}

/**
 * 结果 JSON 走 stdout（机器读的那一份）。
 *
 * 同时往日志里记一份 —— 汇总（含 `error.code` / 实际用到的入口）本身就在 stderr 上看不到，
 * 不记的话日志会缺最关键的一段。
 */
function emit(payload) {
  // 日志路径一并回传：失败时 agent 得靠它把日志原文取回来。
  // stdout 是它唯一可靠的读取面（stderr 会被截断、转述时会丢东西）。
  const logPath = runlog.currentPath();
  if (logPath && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.log = { path: logPath };
  }
  const text = JSON.stringify(payload, null, 2);
  process.stdout.write(`${text}\n`);
  runlog.line(`\n===== 结果 JSON =====\n${text}`);
}

/** 失败也走 stdout（一个 JSON），人读的提示走 stderr。退出码在 main 里给。 */
function fail(code, message, extra) {
  const payload = { ok: false, command: currentCommand, error: Object.assign({ code, message }, extra || {}) };
  emit(payload);
  logger(`  ! ${message}`);
  if (extra && extra.hint) logger(`    hint: ${extra.hint}`);
  return payload;
}

let currentCommand = null;

// ---------------------------------------------------------------------------
// 取值与校验
// ---------------------------------------------------------------------------

function isTrue(value) {
  return value === true || value === 'true';
}

function requireOption(options, name) {
  if (!options[name]) {
    throw Object.assign(new Error(`缺少 --${name}`), { code: 'bad_request' });
  }
  return options[name];
}

/**
 * 列表参数的统一切分见 args.js（splitList）—— 那是唯一实现，本文件不再自带一份：
 * 「数据统计」的 D3/D4/D5 要按**分好的**核心系统名填，切法与 PPT 侧必须逐字一致。
 */
function resolveFocus(options) {
  if (isTrue(options['no-focus'])) return null;
  const raw = options.focus === undefined ? DEFAULT_FOCUS : splitList(options.focus);
  if (!raw.length) return null;

  const resolved = [];
  const unknown = [];
  for (const item of raw) {
    const canonical = FOCUS_ALIASES[item] || FOCUS_ALIASES[item.toLowerCase()];
    if (!canonical) {
      unknown.push(item);
      continue;
    }
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  if (unknown.length) {
    const error = new Error(
      `不认识的 --focus 值: ${unknown.join(', ')}。可用: 业务保护 / 漏洞 / 脆弱性 / 告警`
    );
    error.code = 'bad_request';
    throw error;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 调 python -m pptgen
// ---------------------------------------------------------------------------

/**
 * 把整包入参 B64 之后一次传过去。
 *
 * 为什么不像其它参数那样逐个 `--key value`：
 *   - 中文路径 / 中文 prompt 在 Windows 命令行上会被按控制台代码页转码，落进 Python 就是乱码
 *   - prompt 里可能有引号、空格、反斜杠，逐参转义迟早出错
 *   - args.js 把「下一个 token 以 -- 开头」当成布尔开关，所以一个以 `--` 开头的值没法传
 * 整包 JSON 再 base64 之后只剩 [A-Za-z0-9+/=]，上面三个问题一次全没。
 * 编解码口径与 pptgen/b64.py、scripts/_path_helper.py 一致（'B64:' 前缀 + utf8 的 base64）。
 */
function pptgenArgs(command, payload) {
  return ['-m', PPTGEN_MODULE, command, '--payload', encodePath(JSON.stringify(payload))];
}

/**
 * 用**指定**解释器跑一次 pptgen，返回 {exitCode, timedOut, json, stdout, stderr, spawnError}。
 *
 * 两个必须这么写的点：
 *   - **stdout 按 Buffer 累积、最后一次性 utf8 解码**。`chunk.toString('utf8')` 逐块解码
 *     会把跨块的多字节汉字切成半个，产出乱码 —— 而中文 prompt / 路径是常态。
 *   - **stderr 透传**（非 quiet 时）。引擎的 chart warning 之类都在那里，
 *     用户要能看到，但它们绝不能进 stdout。
 */
function spawnPptgenOnce(command, payload, options, python) {
  const timeoutMs = Number(options['ppt-timeout-ms'] || DEFAULT_PPT_TIMEOUT_MS);
  const args = pptgenArgs(command, payload);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, args, {
        cwd: REPO_ROOT,
        // 引擎 config.py 先读 MSS_ENV_PATH 再 load_dotenv(override=True)；
        // bootstrap.py 里有同样的兜底，这里显式给一份，好让「启动了什么」在 ps 里可见。
        // 路径由 workdir.resolveEnvFile 定（集群上 .env.ppt 不在只读的 skill 根里：
        // 先认已注入的 MSS_ENV_PATH，再找 SKILL_OUTPUT_DIR 下的，最后才是仓库根）。
        // TMPDIR/TEMP/TMP 与 PYTHONDONTWRITEBYTECODE 走 childEnv（集群上 skill 根只读）。
        env: workdir.childEnv({
          MSS_ENV_PATH: workdir.resolveEnvFile(REPO_ROOT),
          MSS_OUTPUTS_DIR: workdir.hasSkillOutputDir()
            ? workdir.engineStateDir()
            : path.join(REPO_ROOT, 'outputs', '_engine_state')
        }),
        windowsHide: true
      });
    } catch (error) {
      resolve({ spawnError: error, exitCode: null, timedOut: false, json: null, stdout: '', stderr: '' });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 只 kill 进程，不清产物：已经写下的 pptx / slidespec 仍然可用。
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (!quiet) process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ spawnError: error, exitCode: null, timedOut, json: null, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      resolve({
        exitCode: code,
        timedOut,
        json: lastJsonObject(stdout),
        stdout,
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}

/**
 * 跑一次 pptgen，返回 {exitCode, timedOut, json, python, ...}。
 *
 * 解释器按 python_cmd.candidates() 逐个试：本地是 `python`、集群镜像里是 `python3`，
 * 写死哪一个都会在另一边起不来。回退的判定见 python_cmd.isInterpreterMissing ——
 * 脚本自己挂了（stderr 有 traceback）不重试，免得白跑一遍还可能重复写产物。
 * `python` 字段带回去，是为了报错里能说清到底起的哪个解释器。
 */
async function runPptgen(command, payload, options) {
  const interpreters = pythonCmd.candidates(options.python);
  let result = null;
  let used = interpreters[0];

  for (let index = 0; index < interpreters.length; index += 1) {
    used = interpreters[index];
    result = await spawnPptgenOnce(command, payload, options, used);

    const interpreterMissing = result.spawnError
      ? pythonCmd.isInterpreterSpawnError(result.spawnError)
      : (result.exitCode !== null && pythonCmd.isInterpreterMissing(result.exitCode, result.stderr));
    if (!interpreterMissing || index + 1 >= interpreters.length) {
      break;
    }
    if (!quiet) {
      process.stderr.write(`[ppt] ${used} 不可用，改用 ${interpreters[index + 1]} 重试 ...\n`);
    }
  }

  result.python = used;
  return result;
}

/**
 * 从 stdout 里取出那一个 JSON 对象。
 *
 * cli.py 保证 stdout 只有一行 JSON，但 Python 在极早期崩溃（比如解释器级错误）
 * 时可能什么都没输出、或者第三方库往 stdout 打了别的东西。所以逐行找最后一个
 * 能 parse 的对象，而不是直接 JSON.parse 整个 stdout。
 */
function lastJsonObject(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      // 不是 JSON 就继续往前找
    }
  }
  return null;
}

/** pptgen 的退出码与错误码 → 我们自己的统一报错。 */
function pptFailure(command, result, timeoutMs) {
  if (result.spawnError) {
    return {
      code: 'python_not_found',
      message: `起不来 python（${result.python}）: ${result.spawnError.message}`,
      hint: '本机要有 python 3.10+ 且 pip install -r requirements.txt；'
        + '或用 --python <路径> / PYTHON 环境变量指定解释器'
        + '（本地一般是 python，集群镜像里是 python3）'
    };
  }
  if (result.timedOut) {
    return {
      code: 'ppt_timeout',
      message: `pptgen ${command} 超过 ${timeoutMs} ms 未结束，已 kill`,
      hint: '产物未删除，可能是半个 pptx。加 --ppt-timeout-ms 放宽，'
        + '或加 --llm-read-timeout 调单批读超时'
    };
  }
  if (pythonCmd.isInterpreterMissing(result.exitCode, result.stderr)) {
    // 候选都试过了还是这个形态：退出码像"命令找不到"、stderr 一句没有 —— 解释器缺，不是 pptgen 报错。
    return {
      code: 'python_not_found',
      message: `起不来 python（${result.python}，退出码 ${result.exitCode}，stderr 为空）`,
      hint: '本机要有 python 3.10+ 且 pip install -r requirements.txt；'
        + '或用 --python <路径> / PYTHON 环境变量指定解释器'
        + '（本地一般是 python，集群镜像里是 python3）'
    };
  }
  if (result.json && result.json.error) {
    return Object.assign({}, result.json.error, { exitCode: result.exitCode });
  }
  return {
    code: 'pptgen_no_output',
    message: `pptgen ${command} 退出码 ${result.exitCode}，但 stdout 里没有 JSON`,
    hint: '看 stderr（已透传）或 outputs/_logs/ 下最新的日志',
    detail: { stdout_tail: String(result.stdout || '').slice(-400) }
  };
}

// ---------------------------------------------------------------------------
// 各子命令
// ---------------------------------------------------------------------------

/** 下载并生成 Excel。返回 buildReport 的 {filePath, sheets, statistics, beautify}。 */
async function ensureExcel(options, runDir) {
  if (options.excel) {
    // 在这里查存在性，而不是留给 pptgen：否则我们会先打一行「Excel 就绪: ...」，
    // 再让 pptgen 报 excel_not_found —— 自己的日志自己打脸。
    const excelPath = path.resolve(options.excel);
    if (!fs.existsSync(excelPath)) {
      const error = new Error(`--excel 指向的文件不存在: ${excelPath}`);
      error.code = 'bad_request';
      throw error;
    }
    return {
      filePath: excelPath,
      sheets: null,
      statistics: null,
      beautify: null,
      preprocess: null,
      source: 'given'
    };
  }
  if (isTrue(options['no-download'])) {
    const error = new Error('--no-download 必须与 --excel 一起用（否则没有 Excel 可用）');
    error.code = 'bad_request';
    throw error;
  }

  logger(`===== 下载 =====`);
  const payload = await downloader.run({
    'cookie-path': options['cookie-path'],
    customer: options.customer,
    'customer-id': options['customer-id'],
    start: options.start,
    end: options.end,
    type: options.type,
    'mssw-base-url': options['mssw-base-url'],
    'mssw-host-header': options['mssw-host-header'],
    'mssw-referer-path': options['mssw-referer-path'],
    'report-template': options['report-template'],
    'beautify-theme': options['beautify-theme'],
    'no-beautify': options['no-beautify'],
    'keep-intermediates': options['keep-intermediates'],
    // 「数据统计」的 D3/D4/D5（系统名）与 D7/D8/D9（该系统风险总数）按这个参数取值，
    // 所以它不只是 PPT 封面的输入，Excel 侧也要。切分规则与 PPT 侧同一份（args.splitList）。
    'business-systems': options['business-systems'],
    // Excel 也落进本次运行的目录 —— 一次运行一个目录，Excel 与 PPT 不分家
    'output-dir': runDir,
    quiet: options.quiet,
    // 必须 false：run() 在它为真时会自己 console.log 整包 JSON，污染 stdout。
    json: false
  });
  return Object.assign({ source: 'downloaded' }, payload.report);
}

async function cmdGenerate(options) {
  const templateId = options.template || DEFAULT_TEMPLATE;
  const focus = resolveFocus(options);

  const summary = {
    ok: false,
    command: 'generate',
    customer: options.customer || null,
    customerId: options['customer-id'] || null,
    start: options.start || null,
    end: options.end || null,
    template_id: templateId,
    focus_options: focus,
    run_dir: null,
    excel: { ok: false },
    ppt: { ok: false },
    failures: [],
    timings: { total_ms: 0 }
  };
  const started = Date.now();

  // --- 1. Excel ---
  // run 目录在这里就定下来（而不是等 pptgen 自己铸）：Excel 要落进同一个目录。
  let runDir;
  try {
    runDir = newRunDir(options, !options.excel && !isTrue(options['no-download']));
  } catch (error) {
    summary.error = { code: error.code || 'bad_request', message: error.message };
    return { summary, exitCode: EXIT_BAD_REQUEST };
  }
  summary.run_dir = runDir;

  const excelStarted = Date.now();
  let report;
  try {
    report = await ensureExcel(options, runDir);
  } catch (error) {
    summary.timings.excel_ms = Date.now() - excelStarted;
    summary.failures = (error.failures || []).map((f) => ({ type: f.type, label: f.label, message: f.message }));
    // 分类（含「没登录」要跟「下载失败」分开、网关不认会话要跟两者都分开、三者的退出码与 hint）
    // 全在 mssw_errors.classifyFailure 一处定义，这里不重写一遍判据。
    const failure = classifyFailure(error, options);
    summary.error = { code: failure.code, message: error.message, hint: failure.hint };
    return { summary, exitCode: failure.exitCode };
  }
  summary.timings.excel_ms = Date.now() - excelStarted;
  summary.excel = {
    ok: true,
    path: report.filePath,
    sheets: report.sheets || null,
    preprocess: report.preprocess || null,
    statistics: report.statistics || null,
    beautify: report.beautify || null,
    source: report.source
  };
  logger(`Excel 就绪: ${report.filePath}`);

  // --- 2. PPT ---
  const pptStarted = Date.now();
  const payload = {
    excel: report.filePath,
    template: templateId,
    customer: options.customer,
    start: options.start,
    end: options.end,
    business_systems: splitList(options['business-systems']),
    mock: isTrue(options.mock),
    require_llm: isTrue(options['require-llm']),
    no_cover_override: isTrue(options['no-cover-override']),
    force: isTrue(options.force),
    run_dir: runDir,
    focus: focus === null ? [] : focus,
    no_focus: focus === null,
    verbose: isTrue(options.verbose),
    quiet: true, // pptgen 的人读汇总由我们自己打，避免两套格式
    llm_read_timeout: options['llm-read-timeout'],
    llm_connect_timeout: options['llm-connect-timeout'],
    llm_retry_attempts: options['llm-retry-attempts']
  };

  const timeoutMs = Number(options['ppt-timeout-ms'] || DEFAULT_PPT_TIMEOUT_MS);
  logger(`===== 生成 PPT（模板 ${templateId}）=====`);
  // 这一步是最慢的一段（默认超时 30 分钟），必须让用户先看到「在动」。
  progress.stage('ppt', '正在生成 PPT，请稍候…');
  const result = await runPptgen('generate', payload, options);
  summary.timings.ppt_ms = Date.now() - pptStarted;
  summary.timings.total_ms = Date.now() - started;

  if (result.exitCode !== EXIT_OK || !result.json || result.json.ok !== true) {
    summary.error = pptFailure('generate', result, timeoutMs);
    // Excel 不回滚：它是独立可交付物。这里把已有产物路径一并回传。
    summary.error.excel_path = report.filePath;
    progress.fail('ppt', `PPT 生成失败：${summary.error.message}`, summary.error.code, 'ppt_failed');
    return { summary, exitCode: result.timedOut ? EXIT_PPT_TIMEOUT : (result.exitCode || EXIT_UNEXPECTED) };
  }

  const ppt = result.json;
  summary.ok = true;
  summary.run_dir = ppt.run_dir;
  progress.done('ppt', `PPT 已生成：${ppt.pptx_name || ppt.pptx_path}`);
  summary.ppt = {
    ok: true,
    path: ppt.pptx_path,
    name: ppt.pptx_name,
    bytes: ppt.pptx_bytes,
    run_dir: ppt.run_dir,
    slidespec_path: ppt.slidespec_path,
    input_json_path: ppt.input_json_path,
    slides_total: ppt.slides_total,
    slides_with_placeholders: ppt.slides_with_placeholders,
    placeholders_total: ppt.placeholders_total,
    by_kind: ppt.by_kind,
    resolved_from_excel: ppt.resolved_from_excel,
    missing_sources_count: ppt.missing_sources_count,
    template_literal_count: ppt.template_literal_count,
    empty_values: ppt.empty_values,
    ai_generated_count: ppt.ai_generated_count,
    chart_unresolved: ppt.chart_unresolved,
    leftover_tokens: ppt.leftover_tokens,
    // 残留占位符的两种成因必须分开报：declared 是图表位数据缺失（有救），
    // undeclared 是模板自带、descriptor 里没有的 token（永远替换不了）
    leftover_declared_tokens: ppt.leftover_declared_tokens,
    leftover_undeclared_tokens: ppt.leftover_undeclared_tokens,
    cover_source: ppt.cover_source,
    cover_overlays: ppt.cover_overlays,
    llm: ppt.llm,
    warnings: ppt.warnings
  };
  logger(`成片: ${ppt.pptx_path}`);
  for (const warning of ppt.warnings || []) logger(`  ! ${warning}`);
  return { summary, exitCode: EXIT_OK };
}

/** rewrite / list-slides / doctor 都是纯 Python 侧动作，这里只做转发与整形。 */
async function cmdProxy(command, options) {
  const payload = {
    quiet: true,
    verbose: isTrue(options.verbose),
    template: options.template || DEFAULT_TEMPLATE,
    slide: options.slide,
    prompt: options.prompt,
    target_tokens: splitList(options['target-tokens']),
    run_dir: options['run-dir'],
    slidespec: options.slidespec,
    excel: options.excel,
    customer: options.customer,
    start: options.start,
    end: options.end,
    no_cover_override: isTrue(options['no-cover-override']),
    rewritable: isTrue(options.rewritable),
    verify_vendor: isTrue(options['verify-vendor']),
    probe_engine: !isTrue(options['no-probe-engine']),
    probe_llm: isTrue(options['probe-llm']) || isTrue(options.llm),
    fingerprint: isTrue(options.fingerprint),
    update_fingerprint: isTrue(options['update-fingerprint']),
    list_models: isTrue(options['list-models']),
    llm_read_timeout: options['llm-read-timeout'],
    llm_connect_timeout: options['llm-connect-timeout'],
    llm_retry_attempts: options['llm-retry-attempts']
  };
  // 只保留真正给了的键：ppTgen 侧对「没给」与「给了空值」的处理不同
  // （例如 focus 默认三个全开、而 focus: [] 表示不注入偏好）。
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }

  const timeoutMs = Number(options['ppt-timeout-ms'] || DEFAULT_PPT_TIMEOUT_MS);
  const result = await runPptgen(command, payload, options);

  if (result.exitCode !== EXIT_OK || !result.json) {
    const error = pptFailure(command, result, timeoutMs);
    return {
      summary: { ok: false, command, error },
      exitCode: result.timedOut ? EXIT_PPT_TIMEOUT : (result.exitCode || EXIT_UNEXPECTED)
    };
  }
  if (result.json.ok === false) {
    return { summary: result.json, exitCode: result.exitCode };
  }

  // 人读汇总（stdout 里已有完整 JSON，这里只是让人不用去 parse）
  const data = result.json;
  if (command === 'list-slides') {
    logger(`${data.template_id}: ${data.slides_total} 页，可重写 ${data.rewritable_total} 页`);
    for (const row of data.slides) {
      if (row.rewritable) {
        logger(`  P${row.slide_no} ${row.slide_key}  AI位=${row.ai_tokens.length}  ${(row.ai_cn_names || []).join(' / ')}`);
      } else {
        logger(`  P${row.slide_no} ${row.slide_key}  无 AI 位（source ${row.source_tokens_count} / chart ${row.chart_tokens_count}）`);
      }
    }
  } else if (command === 'rewrite') {
    logger(`重写 P${data.slide_no} ${data.slide_key}（目标 ${data.target_how}，改了 ${data.updated_count} 个 token）`);
    logger(`新文件: ${data.pptx_path}`);
    for (const warning of data.warnings || []) logger(`  ! ${warning}`);
  } else if (command === 'doctor') {
    for (const failure of data.failures || []) {
      logger(`  [FAIL] ${failure.check}: ${failure.problem}`);
      if (failure.hint) logger(`     hint: ${failure.hint}`);
    }
    logger(data.ok ? '  doctor 全绿' : `  doctor 未通过（${(data.failures || []).length} 项）`);
  }
  return { summary: data, exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const USAGE = `
用法: node pipeline.js <command> [options]

命令:
  generate     下载 → Excel → PPT（端到端）
  rewrite      按页重写已生成 PPT 的 AI 位，另存新文件
  list-slides  列页清单（不碰 LLM）
  doctor       自检：vendor / 引擎符号 / 依赖 / env / 模板 / 指纹 / LLM

generate 专有:
  --customer <名>            安全客户名（必需，除非用 --customer-id）
  --start <Y-M-D>            统计起始日（必需，除非 --no-download）
  --end <Y-M-D>              统计结束日
  --cookie-path <p>          MSSW cookie 文件；**传了即本地模式**，不传则走集群
                             （集群由 session-manager 代管登录态，默认如此）
  --mssw-base-url <origin>   MSSW 入口；裸域名默认补 https://，集群入口要写完整
                             origin（如 http://mssw-inner.sangfor.com.cn:30001）
  --mssw-host-header <h>     Host 头覆盖（本地默认=域名，集群默认=统一 Host 头）
  --mssw-referer-path <p>    Referer 路径，默认 /index.html
  --excel <p>                已有的 *_report.xlsx；给了就跳过下载
  --no-download              只出 PPT，不下载（必须与 --excel 一起用）
  --template <id>            模板，默认 ${DEFAULT_TEMPLATE}
  --focus <a,b>              业务保护 / 漏洞 / 脆弱性 / 告警；默认三个全开
  --no-focus                 不注入偏好文本（引擎此时不填 {preference}）
  --business-systems <a,b,c> 核心系统名，最多 3 个（逗号/顿号/分号均可，中英文不限）
  --mock                     用 mock 值填 AI 位；产物不是真实内容，别当成品发
  --require-llm              OPENAI_API_KEY 为空即失败
  --no-cover-override        不用 --customer/--start/--end 覆盖封面与周期
  --run-dir <d>              指定 run 目录（默认新铸一个 outputs/{YYYYMMDD_HHMMSS}）
  --force                    仅当 --run-dir 指向已有非空目录时才有意义：覆盖它
  --output-dir <p>           同上，作为 run 目录（Excel 与 PPT 都落进去）；仅下载时算数
  --llm-read-timeout <秒>    投影到 LLM_READ_TIMEOUT_SECONDS
  --llm-connect-timeout <秒>
  --llm-retry-attempts <n>
  --ppt-timeout-ms <ms>      pptgen 超时，默认 ${DEFAULT_PPT_TIMEOUT_MS}

产物布局（一次运行 = 一个目录，Excel 与 PPT 不分家）:
  outputs/{YYYYMMDD_HHMMSS}/
    {客户}_report.xlsx
    {客户}_report_{模板id}.pptx                    ← 与上游 report_service 落盘名同形
    {客户}_report_{模板id}_重写版_P{n}.pptx
    slidespec.json  slidespec.original.json  input.json  manifest.json
  outputs/_logs/{入口}.{时间戳}.log               ← 本次运行的完整日志（路径也在结果 JSON 的 log.path 里）

rewrite 专有:
  --slide <页码|slide_key>   必填
  --prompt "<中文要求>"       必填
  --target-tokens <a,b>      只改这些 token（精确 token 或精确中文名，不做模糊匹配）
  --run-dir <d>              默认读 outputs/latest.json 指向的那个 run 目录
  --slidespec <p>            直接指定 slidespec.json（优先于 --run-dir）
  --excel <p>                重抽 Excel；不给就复用 run 目录的 input.json

list-slides 专有:
  --template <id>  --rewritable

doctor 专有:
  --verify-vendor  --probe-llm  --no-probe-engine  --fingerprint
  --update-fingerprint  --list-models

通用:
  --json       无副作用（stdout 本来就只出 JSON）
  --quiet      不打进度（stderr）；**日志文件不受影响**，照常落盘
  --verbose    引擎日志降到 DEBUG
  --python <p> python 解释器；不给则取环境变量 PYTHON，再不然按平台取
               （Windows → python，其他 → python3，都带另一个做备选）

排障: 失败时先读结果 JSON 的 log.path（那份日志含全部 stderr、异常栈与退出码，
      比转述可靠；报错里的 [POST /…/接口名] 就是出错的接口）。
`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    currentCommand = null;
    fail('bad_request', error.message);
    return EXIT_BAD_REQUEST;
  }

  const { command, options } = parsed;
  currentCommand = command;
  quiet = isTrue(options.quiet);

  // `--python` 是进程级的：ppTgen 之外，下载段末尾的美化报告、删事件表/漏洞表的误报行也要用它。
  // 在这里写一次，python_cmd 的四个 spawn 点就都认（不必逐层往下传）。
  pythonCmd.setOverride(options.python);

  if (!command || isTrue(options.help) || isTrue(options.h)) {
    process.stderr.write(`${USAGE}\n`);
    return command ? EXIT_OK : EXIT_BAD_REQUEST;
  }

  // 日志文件在这里开：`--help` / 无命令就不必留文件；真正的活儿一律留痕。
  // attach() 之后 stderr 上的一切（含 Python 子进程透传、异常 stack）自动进文件。
  const logPath = runlog.open({ entry: 'pipeline' });
  runlog.attach();
  if (logPath) {
    logger(`[log] 本次运行日志: ${logPath}`);
  }

  try {
    if (command === 'generate') {
      const { summary, exitCode } = await cmdGenerate(options);
      emit(summary);
      return exitCode;
    }
    if (command === 'rewrite' || command === 'list-slides' || command === 'doctor') {
      const { summary, exitCode } = await cmdProxy(command, options);
      emit(summary);
      return exitCode;
    }
    fail('bad_request', `不认识的命令: ${command}`, { hint: '可用: generate / rewrite / list-slides / doctor' });
    return EXIT_BAD_REQUEST;
  } catch (error) {
    if (error && error.code === 'bad_request') {
      fail('bad_request', error.message);
      return EXIT_BAD_REQUEST;
    }
    fail('unexpected', `${error && error.name ? error.name : 'Error'}: ${error && error.message}`);
    if (!quiet && error && error.stack) process.stderr.write(`${error.stack}\n`);
    return EXIT_UNEXPECTED;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = EXIT_UNEXPECTED;
  });
