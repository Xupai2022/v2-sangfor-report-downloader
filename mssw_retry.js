'use strict';

/**
 * MSSW 请求的重试：判据 + 退避循环。
 *
 * **六张表共用这一份**（事件 / 告警 / 资产 / 漏洞 / 弱密码 / 暴露面）：重试只在 HTTP 层做一次，
 * 不在各自的 export* 里各抄一遍 —— 跟 mssw_errors.js 是同一条道理，一件事只能有一处定义。
 *
 * 只重试「再发一次可能就好」的失败：
 *   · 连接层 errno（ECONNRESET / ETIMEDOUT / EAI_AGAIN …）—— 请求根本没到业务逻辑
 *   · 5xx / 408 / 425 / 429 —— 服务端侧的瞬时故障
 *
 * 一律不重试（重试无用，还会把日志刷成一片红）：
 *   · 4xx —— 含 403 捎回来的网关码 9451（会话不认）/ 9002（真没权限），
 *     见 mssw_errors.gatewayReject；这两类要人去处理，不是再打一次能好的
 *   · 业务码 code != 0 —— 那不是 HTTP 失败，由调用点自己抛，压根不经这里
 *
 * 超时单独一类：超时意味着请求**可能已被服务端受理**。GET 幂等，重试安全；
 * 非幂等的 POST（建导出任务）重试会变成建两个任务，所以默认只有 GET 重试，
 * 幂等的查询（事件/告警轮询）由调用点显式 `onTimeout: true` 打开。
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERRNO = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'
]);

/**
 * 指数退避 + 抖动。
 *
 * 抖动是必须的：资产表分页导出是多线程并发（默认十几路），退避若完全同步，
 * 服务端抖一下之后所有线程会在同一毫秒一起冲回去，等于把故障放大一遍。
 */
function backoffMs(attempt, baseDelayMs) {
  const raw = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS);
  return raw + Math.floor(Math.random() * 250);
}

/**
 * @param {Error} error 抛出来的那个 error（只读，不改写）
 * @param {{onTimeout?: boolean}} [policy] 调用点的策略，只在「超时」这一类上有分歧
 * @returns {boolean}
 */
function isRetryableError(error, policy) {
  if (!error) return false;
  // 调用点可以用 error.retryable 显式判生 / 判死，优先级高于下面的自动判据。
  if (error.retryable === false) return false;
  if (error.retryable === true) return true;
  if (error.timedOut) return Boolean(policy && policy.onTimeout);
  if (error.statusCode) return RETRYABLE_STATUS.has(Number(error.statusCode));
  return RETRYABLE_ERRNO.has(error.code);
}

/**
 * 跑 fn，失败按策略重试。
 *
 * fn 收到 1 起的 attempt 序号（探针/日志要用才接）。重试日志只在**真的要重试**时打一行，
 * 打的是失败原因的前 200 字 —— 不然 9451 那种长 body 会把日志刷满。
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {{attempts?: number, baseDelayMs?: number, onTimeout?: boolean, logger?: Function, label?: string}} [policy]
 */
async function withRetry(fn, policy = {}) {
  const attempts = Math.max(1, Number(policy.attempts || DEFAULT_ATTEMPTS));
  const baseDelayMs = Number(policy.baseDelayMs || DEFAULT_BASE_DELAY_MS);
  const label = policy.label || 'MSSW 请求';
  // 没传 logger 也要看得见：调用点有几处（找客户 id / 取导出字段）上游本来就没有 logger，
  // 静默重试等于把「这次差点失败」这件事藏起来。直落 stderr，与 python_cmd 同一种做法 ——
  // stdout 是给 --response-only 的 JSON 用的，不能往里掺日志。
  const log = typeof policy.logger === 'function'
    ? policy.logger
    : (message) => process.stderr.write(`[retry] ${message}\n`);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error, policy)) {
        throw error;
      }
      const waitMs = backoffMs(attempt, baseDelayMs);
      log(`${label} 第 ${attempt} 次失败（${String(error.message).slice(0, 200)}），${waitMs}ms 后重试`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

module.exports = {
  withRetry,
  isRetryableError,
  DEFAULT_ATTEMPTS
};
