'use strict';

/**
 * 进度上报（`muad-progress`）—— **best-effort，永远不影响业务结果**。
 *
 * 本 skill 一条命令要跑几分钟到几十分钟（前台任务，不声明 `longTask`）。不报进度的话，
 * 用户在企微/Mattermost 里全程收不到任何消息，只能干等 —— 而 Runtime Guard 不自动补进度、
 * 不做心跳，节点必须由 skill 自己上报。
 *
 * 三条硬性约定（`references/progress-notify.md`）：
 *
 * 1. **不传收件人**：禁止传 `--channel` / `peerId` 或任何凭据。Runtime Guard 从当前
 *    可信会话决定投递目标，传了反而是绕过它。
 * 2. **失败一律吞掉**：`muad-progress` 不存在（本地开发）或非零退出时只当无事发生。
 *    进度上报失败绝不能把一次成功的业务报成失败。
 * 3. **不碰 stdout**：走 `stdio: 'ignore'` 完全隔离。本仓库的 stdout 契约是
 *    「恰好一个 JSON 对象」，第三方 CLI 往 stdout 写一个字都是污染。
 *
 * `done` 只写**节点结果摘要**，不要把完整报告塞进 `--text`；完整结果仍由 Agent 的
 * 原生最终回复（含 `MEDIA:` 行）恰好发送一次。
 */

const { spawn } = require('node:child_process');

// 疑似凭据的行一律不发（平台的进度文案会直接展示给用户）。
// 判据与 runlog.js 共用同一条正则：那边管落盘、这边管外发，两处必须一致。
const { SECRET_LINE_PATTERN } = require('./runlog');

const TEXT_LIMIT = 300;

/**
 * 洗一遍要发出去的文案：丢掉疑似凭据的行，截断到 ~300 字符。
 *
 * 报错信息会流到这里（比如下载失败时网关回显的响应体片段），所以不能直接透传。
 */
function sanitize(text) {
  const raw = String(text === undefined || text === null ? '' : text);
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => !SECRET_LINE_PATTERN.test(line))
    .join(' ')
    .trim();
  const collapsed = kept.replace(/\s+/g, ' ');
  return collapsed.length > TEXT_LIMIT ? `${collapsed.slice(0, TEXT_LIMIT - 1)}…` : collapsed;
}

/** 业务错误码的形状（`auth_required` / `download_failed` 这类）。 */
const BUSINESS_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 只放行**我们自己的**错误码。
 *
 * `error.code` 在 Node 里同时被两类东西占用：我们的业务码（`auth_required`）和
 * 系统错误码（`ENOENT` / `EACCES`，全大写）。直接透传的话，`--code ENOENT` 这种
 * 东西会当成业务码展示给用户。判据用形状：业务码一律小写开头。
 */
function businessCode(code, fallback) {
  const raw = String(code === undefined || code === null ? '' : code).trim();
  return BUSINESS_CODE_PATTERN.test(raw) ? raw : fallback;
}

/** 可执行文件名。`MUAD_PROGRESS_BIN` 是给本地自测用的（照抄 session.js 的注入手法）。 */
function progressBin() {
  const override = (process.env.MUAD_PROGRESS_BIN || '').trim();
  return override || 'muad-progress';
}

function emit(command, stage, text, code) {
  const message = sanitize(text);
  if (!stage || !message) {
    return;
  }
  const args = [command, '--stage', String(stage), '--text', message];
  // --code 只在 error 节点上有意义
  if (command === 'error') {
    args.push('--code', code);
  }

  try {
    const child = spawn(progressBin(), args, { stdio: 'ignore', windowsHide: true });
    // 本地没有 muad-progress 时是 ENOENT —— 静默，不刷屏、不改退出码。
    child.on('error', () => {});
  } catch (error) {
    // spawn 自身同步抛（参数非法等）也吞掉
  }
}

/** 节点开始。 */
function stage(node, text) {
  emit('stage', node, text);
}

/** 节点成功结束 —— 只写摘要。 */
function done(node, text) {
  emit('done', node, text);
}

/**
 * 节点失败。业务自身的失败信号仍是 stderr + 非零退出码，这里只是给用户看的文案。
 *
 * `fallback` 是调用方给的兜底码 —— 因为传进来的 `error.code` 常常是 `ENOENT` 这类
 * 系统码，被 `businessCode` 挡掉后就该落回调用方那个更有意义的码（如 `excel_failed`），
 * 而不是笼统的 `stage_failed`。
 */
function fail(node, text, code, fallback) {
  emit('error', node, text, businessCode(code, businessCode(fallback, 'stage_failed')));
}

module.exports = {
  stage,
  done,
  fail,
  // 导出给测试用
  sanitize,
  businessCode
};
