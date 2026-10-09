'use strict';

/**
 * Python 解释器解析 —— 全仓库唯一的"取解释器"口子。
 *
 * 为什么需要它：本地（Windows）通常只有 `python`，集群镜像里通常只有 `python3`，
 * 同一份代码两边都要跑。之前四个拉起 Python 的地方各写各的：分页导出先试 python3
 * 再回退 python，其余三处把 'python' 写死 —— 集群上后三处直接 ENOENT，
 * 而且都发生在流水线末段（美化报告、删事件表/漏洞表的误报行），前面全跑完才炸。
 *
 * 优先级：
 *   1. 显式 `--python <路径>`（CLI 入口解析后调 setOverride 写进来）
 *   2. 环境变量 `PYTHON`
 *   3. 平台默认：win32 → `python`，其他 → `python3`
 * 前两条给了就**只用它**（用户指定了就别自作主张换解释器），
 * 第三条才带一个备选，配合 isInterpreterMissing 做一次回退。
 *
 * 为什么平台默认不是"一律先试 python3"：Windows 上的 `python3` 常是 Microsoft
 * Store 的应用执行别名 —— 它不是"不在 PATH"，而是返回怪退出码/弹商店，判定比
 * ENOENT 脏得多。反过来集群镜像里 `python` 通常干脆不存在（Debian/Ubuntu
 * 只装 python3）。所以按平台取默认，比一律 python3 先试更省事。
 */

const { execFile } = require('node:child_process');

/**
 * "解释器不存在"的退出码。
 *
 * 注意 9009：Windows cmd 找不到命令时返回 9009（不是 POSIX 的 127），
 * 实测这台机器上 python3 就是这样退出的，且 stderr 为空。只判断
 * 127/1/ENOENT 的话，在 Windows 上回退不到 python，会直接抛"脚本执行失败"。
 * 1 也在集合里：Store 别名那条路同样返回 1 且 stderr 为空。
 */
const PYTHON_NOT_FOUND_CODES = new Set([1, 126, 127, 9009]);

/** CLI 入口解析到的 `--python`；空串 = 没给。 */
let override = '';

/** 记下 `--python` 的值。进程级生效，四个 spawn 点都认它。 */
function setOverride(cmd) {
  override = typeof cmd === 'string' && cmd.trim() ? cmd.trim() : '';
}

/** 平台默认解释器名。 */
function platformDefault() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * 解释器候选列表，按尝试顺序。
 *
 * 显式指定（`--python` / `PYTHON` 环境变量）时只返回那一个 —— 用户说用哪个就用哪个，
 * 换掉只会把问题藏起来。没指定时返回 [平台默认, 另一个]。
 */
function candidates(explicit) {
  const configured = [explicit, override, process.env.PYTHON]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  if (configured) {
    return [configured];
  }
  const first = platformDefault();
  return [first, first === 'python' ? 'python3' : 'python'];
}

/** 首选解释器名（日志/报错文案用）。 */
function resolve(explicit) {
  return candidates(explicit)[0];
}

/**
 * 这个失败是"解释器不存在"，还是脚本自己挂了？
 *
 * 要求 stderr 为空：脚本自身的报错会往 stderr 写 traceback，那种失败换解释器重跑
 * 也只是再挂一次（还可能重复产生副作用）。退出码在 PYTHON_NOT_FOUND_CODES 里
 * 且 stderr 一句没有，才认成解释器的问题。
 */
function isInterpreterMissing(code, stderr) {
  return PYTHON_NOT_FOUND_CODES.has(code) && !String(stderr || '').trim();
}

/** 进程压根起不来：ENOENT（含 Windows 的 errno -4058）。 */
function isInterpreterSpawnError(error) {
  return Boolean(error) && (error.code === 'ENOENT' || error.errno === -4058);
}

/**
 * 跑一个 Python 脚本，按候选逐个试，返回第一个跑通的结果。
 *
 * 给"一次性拿完整 stdout"的调用方用（美化报告、删事件行）；需要实时转发日志的
 * 调用方（分页导出、pptgen）自己拿 candidates() + isInterpreterMissing() 写循环。
 *
 * @param {string} scriptPath 脚本绝对路径
 * @param {string[]} args 脚本参数
 * @param {Object} [options] execFile 的选项（encoding / maxBuffer / timeout / env /
 *   windowsHide），外加一个 `python` 用来显式指定解释器（不会传给 execFile）
 * @returns {Promise<{stdout: string, stderr: string, python: string}>}
 *   python 是真正跑通的那个解释器 —— 回退了的话，日志里要能看出来。
 */
function execFilePython(scriptPath, args, options = {}) {
  const list = candidates(options.python);
  const execOptions = Object.assign({}, options);
  delete execOptions.python;

  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = (index) => {
      const cmd = list[index];
      execFile(cmd, [scriptPath, ...args], execOptions, (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ stdout: String(stdout || ''), stderr: String(stderr || ''), python: cmd });
          return;
        }

        const missing = isInterpreterSpawnError(error) || isInterpreterMissing(error.code, stderr);
        if (missing && index + 1 < list.length) {
          // 走 stderr 是因为本仓库的 stdout 只留给结果 JSON（runlog.attach() 会把
          // stderr 镜像进日志文件，所以这行也进得了事后排障的那份日志）。
          process.stderr.write(`[python] ${cmd} 不可用（${error.code}），改用 ${list[index + 1]} 重试 ...\n`);
          attempt(index + 1);
          return;
        }

        // 候选用尽，或压根不是解释器的锅：原样抛，报错文案由调用方拼。
        const failure = new Error(String(stderr || '').trim() || error.message);
        failure.code = error.code;
        failure.python = cmd;
        failure.tried = list.slice(0, index + 1);
        rejectPromise(failure);
      });
    };
    attempt(0);
  });
}

module.exports = {
  PYTHON_NOT_FOUND_CODES,
  setOverride,
  candidates,
  resolve,
  isInterpreterMissing,
  isInterpreterSpawnError,
  execFilePython
};
