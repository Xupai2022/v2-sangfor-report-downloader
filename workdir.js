'use strict';

/**
 * 统一可写工作区。
 *
 * 集群上 skill 根是**只读**挂载（Runtime Guard 不允许写），所以所有可写产物
 * （cookie 私有文件、中间导出 xlsx、报告、PPT run 目录、Python 的临时目录）
 * 都必须落在 guard 注入的 `SKILL_OUTPUT_DIR` 下。
 * 只读的代码 / 模板 / 配置仍然从仓库根读（`__dirname`）。
 *
 * 目录契约：
 *   SKILL_OUTPUT_DIR/
 *     session/<platform>_cookies.txt   登录态（0o600，整轮运行期间必须存活）
 *     tmp/downloads/                   原始导出 xlsx（中间件，合并后删除）
 *     tmp/exports/                     资产表加工产物（原 <repo>/tmp/exports）
 *     tmp/paged/                       → TMPDIR，Python mkdtemp 的落点
 *     outputs/                         = 原 <repo>/outputs
 *       {YYYYMMDD_HHMMSS}/             run 目录
 *       _engine_state/  _logs/         PPT 引擎 state / 日志
 *
 * 缺失 `SKILL_OUTPUT_DIR` 时回退系统临时目录，**仅供本地调试**：
 * 集群上缺失意味着 guard 没注入，产物会随 Pod 重启丢失，所以这里打 WARNING。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SKILL_NAME } = require('./skill_meta');

let warnedMissingOutputDir = false;

/**
 * 是否真的处在集群（guard 注入了 SKILL_OUTPUT_DIR）。
 *
 * 用途是给那些**本地没有任何写不进去的问题**的地方用：例如 pipeline 的 run 目录
 * 在本地一直是 `<repo>/outputs`，换到 tmpdir 只会平白改变本地行为。
 * 这些地方要的不是"兜底路径"，而是"是不是集群"这个事实。
 */
function hasSkillOutputDir() {
  return Boolean(process.env.SKILL_OUTPUT_DIR && String(process.env.SKILL_OUTPUT_DIR).trim());
}

/** 可写根：SKILL_OUTPUT_DIR；缺失时回退系统临时目录（仅本地调试）。 */
function outputDir() {
  const raw = process.env.SKILL_OUTPUT_DIR;
  if (raw && String(raw).trim()) {
    const dir = path.resolve(String(raw).trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const fallback = path.join(os.tmpdir(), SKILL_NAME);
  if (!warnedMissingOutputDir) {
    warnedMissingOutputDir = true;
    console.error(
      `[workdir] 警告：未设置 SKILL_OUTPUT_DIR，产物将落在 ${fallback}（仅适用于本地调试；` +
      '集群上该变量必须由 Runtime Guard 注入）'
    );
  }
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 登录态私有目录。 */
function sessionDir() {
  return ensureDir(path.join(outputDir(), 'session'));
}

/** 某平台的私有 cookie 文件路径（同时也是 Python 侧 --cookie-path 传的值）。 */
function cookieFilePath(platform) {
  return path.join(sessionDir(), `${platform}_cookies.txt`);
}

function tmpRoot() {
  return ensureDir(path.join(outputDir(), 'tmp'));
}

/** 原始导出 xlsx 落盘目录（替代"cookie 文件所在目录"这个旧默认）。 */
function tmpDownloadsDir() {
  return ensureDir(path.join(tmpRoot(), 'downloads'));
}

/** 资产表加工产物目录（原 <repo>/tmp/exports）。 */
function tmpExportsDir() {
  return ensureDir(path.join(tmpRoot(), 'exports'));
}

/** 给 Python 当 TMPDIR 用：避免 tempfile.mkdtemp 落到只读区或 Pod 外。 */
function pagedTmpDir() {
  return ensureDir(path.join(tmpRoot(), 'paged'));
}

/** 可写区里的 run 目录父目录（集群口径）。 */
function runsDir() {
  return ensureDir(path.join(outputDir(), 'outputs'));
}

/**
 * run 目录的父目录 —— **本地与集群的统一口径**。
 *
 *   集群 = `<SKILL_OUTPUT_DIR>/outputs`；本地 = `<仓库根>/outputs`（逐字不变）。
 *
 * 与 `runsDir()` 的差别只在本地：`outputDir()` 在本地会回退到系统临时目录（那是给它
 * 自己那套「可写区」语义用的），而 run 目录在本地一直是 `<repo>/outputs`。
 * 集群上没有这个分歧，因为 `SKILL_OUTPUT_DIR` 一定被注入。
 */
function runsBase() {
  return hasSkillOutputDir() ? runsDir() : ensureDir(path.join(__dirname, 'outputs'));
}

/** PPT 引擎 state 目录（传给 MSS_OUTPUTS_DIR）。 */
function engineStateDir() {
  return ensureDir(path.join(runsDir(), '_engine_state'));
}

/**
 * 日志目录：pptgen 的引擎日志与 runlog.js 的整轮运行日志都落这儿。
 *
 * 用 `runsBase()` 而不是 `runsDir()` —— 本地那半边不能落到系统临时目录去，
 * 否则「跑完在仓库里找日志」这件事在本地就不成立。
 */
function logsDir() {
  return ensureDir(path.join(runsBase(), '_logs'));
}

/**
 * 把用户给的路径绝对化：相对路径一律相对可写根解析。
 *
 * 集群上 cwd 很可能就是只读的 skill 根，相对路径直接落在那儿会写失败。
 * 空值返回 null，让调用方保留自己的默认值。
 */
function resolveWritable(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    return null;
  }
  const raw = inputPath.trim();
  return path.isAbsolute(raw) ? raw : path.join(outputDir(), raw);
}

/**
 * 引擎 env 文件（`MSS_ENV_PATH` 的值）该指向哪。
 *
 * `<repo>/.env.ppt` 里放的是 `OPENAI_API_KEY`，所以它被 .gitignore 排除 —— 不会进
 * 上传包；而集群上 skill 根是**只读**的，到那儿也新建不出来。若还写死
 * `<repo>/.env.ppt`，集群里 key 就无路可走，LLM 位会静默退化成 mock 文案。
 *
 * 三级回落（与 `pptgen/bootstrap.py`、`pptgen/paths.py` 的那份镜像逐条一致）：
 *
 *   1. 已经在 env 里显式注入的 `MSS_ENV_PATH` —— 集群镜像 / runtime 烘的路径优先，
 *      不能再被我们覆盖掉（这不是理论情形：pipeline 曾经就是无条件覆盖它）
 *   2. `<SKILL_OUTPUT_DIR>/.env.ppt` —— 可写区，key 放这儿就能被读到
 *   3. `<repo>/.env.ppt` —— 本地开发的**原路径，逐字不变**
 */
function resolveEnvFile(repoRoot) {
  const injected = (process.env.MSS_ENV_PATH || '').trim();
  if (injected) {
    return injected;
  }
  if (hasSkillOutputDir()) {
    const candidate = path.join(path.resolve(process.env.SKILL_OUTPUT_DIR.trim()), '.env.ppt');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(repoRoot, '.env.ppt');
}

/**
 * 子进程（Python）环境。
 *
 * 两种模式都设 `PYTHONIOENCODING=utf-8`（四个 spawn 点本来就各自设了）。
 *
 * **额外的两下只在集群下做**（`SKILL_OUTPUT_DIR` 已注入）：
 *   1. PYTHONDONTWRITEBYTECODE=1 —— 别往只读的 skill 根写 __pycache__
 *   2. TMPDIR/TEMP/TMP 指到可写区 —— tempfile.mkdtemp 别落到 Pod 外的 /tmp
 *
 * 本地（没注入）不加这两下：那时 skill 根可写、/tmp 也是本机的，
 * 没有要防的问题，改了只会平白多出一层目录和一句 WARNING。
 */
function childEnv(extra = {}) {
  const base = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }, extra);
  if (!hasSkillOutputDir()) {
    return base;
  }
  const tmp = pagedTmpDir();
  return Object.assign(base, {
    PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp
  });
}

module.exports = {
  outputDir,
  hasSkillOutputDir,
  sessionDir,
  cookieFilePath,
  tmpRoot,
  tmpDownloadsDir,
  tmpExportsDir,
  pagedTmpDir,
  runsDir,
  runsBase,
  engineStateDir,
  logsDir,
  resolveWritable,
  resolveEnvFile,
  childEnv
};
