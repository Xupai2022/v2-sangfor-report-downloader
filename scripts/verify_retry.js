#!/usr/bin/env node
'use strict';

/**
 * 重试接线的验证门：`node scripts/verify_retry.js`（退出码 0 = 通过）。
 *
 * 网络重试没法用真接口验 —— 真接口不会按需抖。这里起一个本地 http server 造失败序列，
 * 对着 **mssw_client 真正的 requestJson / requestBuffer** 打，验的是接线而不只是算法：
 * 「403 不重试」「5xx 重试」「连接断了重试」「超时不重试（非幂等 POST）」
 * 「超时重试（幂等查询）」以及「网关码仍能被打捞出来」。
 *
 * 退避一律调成 10ms —— 这个门要在 CI 里几秒内跑完，不是来测退避曲线的。
 */

const http = require('http');
const assert = require('assert');

const { requestJson, requestBuffer } = require('../mssw_client');
const { isRetryableError } = require('../mssw_retry');
const { gatewayReject } = require('../mssw_errors');

const HITS = new Map();
const bump = (key) => {
  const next = (HITS.get(key) || 0) + 1;
  HITS.set(key, next);
  return next;
};
const resetHits = () => HITS.clear();

const server = http.createServer((req, res) => {
  const path = req.url;
  const n = bump(path);

  if (path === '/once-503') {
    if (n === 1) { res.writeHead(503); res.end('busy'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"code":0,"data":"ok"}'); return;
  }

  if (path === '/always-403') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"code":9451,"msg":"非法操作","data":[]}');
    return;
  }

  if (path === '/reset') {
    // 连接层失败：请求根本没到业务逻辑，重试安全
    if (n === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"code":0}'); return;
  }

  if (path === '/hang') {
    return; // 不响应，让客户端自己超时
  }

  if (path === '/download-once-500') {
    if (n === 1) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('xlsx-bytes'); return;
  }

  res.writeHead(404); res.end('not found');
});

/** 打一发并把「打了几次」和「抛了什么」都带回来。 */
async function probe(path, fn) {
  const before = HITS.get(path) || 0;
  let error = null;
  let value = null;
  try {
    value = await fn();
  } catch (err) {
    error = err;
  }
  return { hits: (HITS.get(path) || 0) - before, error, value };
}

const CASES = [];
function check(name, fn) {
  CASES.push({ name, fn });
}

// 1. 5xx 该重试，第 2 次成功
check('5xx 重试一次后成功', async (base) => {
  resetHits();
  const { hits, error, value } = await probe('/once-503', () => requestJson(`${base}/once-503`, {
    headers: {}, retry: { baseDelayMs: 10 }
  }));
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);
  assert.strictEqual(hits, 2, `应当只重试一次（实际 ${hits} 次）`);
  assert.strictEqual(value.code, 0);
});

// 2. 403（网关 9451 走的就是这条路）不许重试，且 message 原样可被打捞
check('403/9451 不重试，且 message 仍可被 gatewayReject 认出', async (base) => {
  resetHits();
  const { hits, error } = await probe('/always-403', () => requestJson(`${base}/always-403`, {
    headers: {}, retry: { baseDelayMs: 10 }
  }));
  assert.ok(error, '403 应当抛错');
  assert.strictEqual(hits, 1, `403 不该重试（实际 ${hits} 次）`);
  assert.strictEqual(error.statusCode, 403, 'error 上要挂 statusCode，重试判据靠它');
  const rejected = gatewayReject(error.message);
  assert.ok(rejected && rejected.code === '9451', 'gatewayReject 必须仍能认出 9451');
});

// 3. 连接层断连该重试
check('连接被重置后重试成功', async (base) => {
  resetHits();
  const { hits, error } = await probe('/reset', () => requestJson(`${base}/reset`, {
    headers: {}, retry: { baseDelayMs: 10, attempts: 3 }
  }));
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);
  assert.strictEqual(hits, 2, `应当重试（实际 ${hits} 次）`);
});

// 4. 超时：非幂等 POST 默认不重试（建导出任务不能变成建两个）
check('超时默认不重试（POST 建任务）', async (base) => {
  resetHits();
  const { hits, error } = await probe('/hang', () => requestJson(`${base}/hang`, {
    headers: {}, body: '{}', timeout: 200,
    retry: { baseDelayMs: 10, attempts: 2 }
  }));
  assert.ok(error, '超时应当抛错');
  assert.strictEqual(hits, 1, `超时的 POST 不该重试（实际 ${hits} 次）`);
});

// 5. 超时：幂等查询显式打开后要重试（事件/告警轮询就是这么用的）
check('超时 onTimeout:true 会重试（轮询查询）', async (base) => {
  resetHits();
  const { hits, error } = await probe('/hang', () => requestJson(`${base}/hang`, {
    headers: {}, body: '{"task_id":"t"}', timeout: 200,
    retry: { baseDelayMs: 10, attempts: 2, onTimeout: true }
  }));
  assert.ok(error, '超时应当抛错');
  assert.strictEqual(hits, 2, `onTimeout:true 应当重试（实际 ${hits} 次）`);
});

// 6. 下载（requestBuffer，GET 幂等）：5xx 重试后拿到二进制
check('下载 500 重试后拿到文件', async (base) => {
  resetHits();
  const { hits, error, value } = await probe('/download-once-500', () => requestBuffer(`${base}/download-once-500`, {
    headers: {}, retry: { baseDelayMs: 10 }
  }));
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);
  assert.strictEqual(hits, 2, `应当重试（实际 ${hits} 次）`);
  assert.strictEqual(value.buffer.toString('utf8'), 'xlsx-bytes');
});

// 7. 业务码 / 普通 error 不重试：code != 0 是调用点自己抛的，压根不该进重试判据
check('普通业务错误不重试', async () => {
  assert.strictEqual(isRetryableError(new Error('MSSW 事件导出创建任务失败: 参数不对'), {}), false);
  assert.strictEqual(isRetryableError(new Error('手工判死'), { }).valueOf(), false);
  assert.strictEqual(isRetryableError(Object.assign(new Error('x'), { retryable: false }), { onTimeout: true }), false);
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;

  for (const item of CASES) {
    try {
      await item.fn(base);
      process.stdout.write(`PASS  ${item.name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL  ${item.name}\n      ${error.message}\n`);
    }
  }

  // 挂着的请求要先掐断，否则 close 永远等不到回调
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  const total = CASES.length;
  process.stdout.write(failed ? `\n${failed}/${total} 项失败\n` : `\n全部通过（${total} 项）\n`);
  process.exit(failed ? 1 : 0);
})();
