#!/usr/bin/env node
'use strict';

/**
 * 漏洞表**新接口**（2026-10-16 起的异步报表接口）下载链路的验证门：
 * `node scripts/verify_vuln_async.js`（退出码 0 = 通过）。
 *
 * 与 scripts/verify_exposed_surface.js 同一条思路：真接口没法按需造状态，所以起一个本地
 * http server **照着用户 2026-10-16 给的那条 curl 的形状**应答，对着 **mssw_client 真正的
 * exportMsswVulnList** 打 —— 验的是接线（打哪个端点、请求体长什么样、轮询到什么时候算完、
 * 文件从哪个地址下来），不是算法。
 *
 * 钉住的几件事，每一件都对应一处"写错了也不会报错、只会静默给错数据"的地方：
 *
 *   1. 建任务的请求体**逐字等于用户给的 curl**（公司 id 与报告期两个变量之外一个字都不差）：
 *      data_type 51、need_split false、export_scope combined、export_mode single_table、
 *      split{enabled:false,by:fix_priority}、fixed_status [0,1,2,6,3,4]、scan_type [1]、
 *      时间在 params.list_filters.found_time_range 里。少一个数就是另一批数据。
 *      ⚠️ 时间必须是**毫秒闭区间**、收尾 .999（与暴露面那份"没有时间"、与漏洞表**旧**接口
 *      那套截到 .000 的算法都不一样）。
 *   2. 端点与暴露面**逐字相同**（建任务 report、轮询 report_async_task）—— 平台就是这么挂的，
 *      别自己给它编一个 /vuln/... 出来。
 *   3. task_id 取自 `data.task_id`（字符串），轮询体是 `{task_id_list:[…]}`；
 *      **只看第一轮就返回**会拿到半成品（这里先回一轮 running，再回成功）。
 *   4. 文件从 attachment 给的 `/gateway/workflow/...` 地址下，且下载请求要去掉
 *      x-requested-with / content-type（否则被网关当 XHR 拦）。
 *   5. 缺报告期 / 缺 company_id 都**当场抛**：新接口的请求体里这两个是必带变量，
 *      替平台猜一个空档只会静默导错数据。
 */

// 报告期 -> epoch 毫秒是**按本地时区**算的（全仓同款），所以先把时区钉在上海，
// 才能拿用户那条 curl 里的字面数字（1782835200000 / 1785599999999）来断言。
process.env.TZ = 'Asia/Shanghai';

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  exportMsswVulnList,
  buildMsswVulnExportRequestBody,
  MSSW_VULN_ASYNC_DATA_TYPE,
  MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT,
  MSSW_EXPOSED_SURFACE_TASK_ENDPOINT
} = require('../mssw_client');

// ---- 用户 2026-10-16 那条 curl 里的字面值 ----
const TRIGGER_PATH = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report';
const TASK_PATH = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report_async_task';
const ATTACH_PATH = '/gateway/workflow/order/v1/attachments';
const COMPANY_ID = '19616826';
const TASK_ID = 'a1b2c3d4e5f60718293a4b5c';
const FILE_ID = 'a1b2c3d4e5f60718293a4b5d';
const ATTACH_URL = `${ATTACH_PATH}?_file=${FILE_ID}`;
// 报告期：--start 2026-07-01 / --end 2026-08-01（按本地时区 = 上海）
const START = '2026-07-01';
const END = '2026-08-01';
const CAPTURE_RANGE = [1782835200000, 1785599999999];
// 抓包请求体，逐字。断言直接拿它比 —— 改实现时这里不该跟着改。
const CAPTURE_BODY = {
  data_type: 51,
  need_split: false,
  params: {
    company_id: COMPANY_ID,
    export_scope: 'combined',
    fixed_status: [0, 1, 2, 6, 3, 4],
    scan_type: [1],
    export_mode: 'single_table',
    split: { enabled: false, by: 'fix_priority' },
    list_filters: { found_time_range: [1782835200000, 1785599999999] }
  }
};
// 实际该发出去的体 = 抓包 + 用户明确改过的那几处。目前**一处都没有**
// （这份抓包就是用户 2026-10-16 直接给的原文，不像暴露面那份被改过 need_split）。
// 有改动就在这显式写一条，而不是去改 CAPTURE_BODY —— 那样就分不清
// "平台改契约了" 和 "我们有意发得不一样"，会把抓包这个底稿弄丢。
const EXPECTED_BODY = CAPTURE_BODY;
// 假压缩包：只在头部放个 ZIP magic，够证明"字节被原样落盘"
const ZIP_BYTES = Buffer.from('504b0304-vuln-two-tables-bytes', 'utf8');
const DISPOSITION = 'attachment; filename=%E6%BC%8F%E6%B4%9E_20261016.zip';

const requests = [];
let scenario = {};

const attachment = (overrides = {}) => Object.assign({
  status: 'success', progress: 100, url: ATTACH_URL, task_id: TASK_ID
}, overrides);
const poll = (rotationStatus, list) => ({
  success: true, code: 0, msg: 'success',
  data: { rotation_status: rotationStatus, attachment_list: list }
});
const RUNNING = poll(1, [attachment({ status: 'running', progress: 30, url: '' })]);
const DONE = poll(2, [attachment()]);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8')
    });

    const sendJson = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url === TRIGGER_PATH) {
      sendJson(scenario.trigger || { data: { task_id: TASK_ID }, code: 0, msg: '成功' });
      return;
    }

    if (req.url === TASK_PATH) {
      const list = scenario.polls || [DONE];
      // 最后一轮**反复回**（同一个响应回两次是常态：轮询问的是"到了没"）
      const payload = list.length > 1 ? list.shift() : list[0];
      sendJson(payload);
      return;
    }

    if (req.url.startsWith(ATTACH_PATH)) {
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': scenario.disposition || DISPOSITION
      });
      res.end(ZIP_BYTES);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
});

/** 每一段用的干净现场：新目录 + 一份 cookie 文件 + 空的请求录像。 */
function fresh(dirName) {
  requests.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v2-vuln-async-${dirName}-`));
  const cookiePath = path.join(dir, 'mssw_cookies.txt');
  fs.writeFileSync(cookiePath, 'soc-token=fake-token; csrf_token=fake-csrf\n');
  return { dir, cookiePath, downloadDir: path.join(dir, 'downloads') };
}

const CASES = [];
const check = (name, fn) => CASES.push({ name, fn });

/** 跑一次导出，把"扔了什么"也带回来（成功路径要看返回的对象）。 */
async function runExport(base, ctx, overrides = {}) {
  try {
    const value = await exportMsswVulnList(Object.assign({
      msswCookiePath: ctx.cookiePath,
      msswBaseUrl: base,
      customerId: COMPANY_ID,
      downloadDir: ctx.downloadDir,
      pollIntervalMs: 10,
      start: START,
      end: END
    }, overrides));
    return { value, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

const requestTo = (url) => requests.filter((item) => item.url === url || item.url.startsWith(`${url}?`));

// 端口要 listen 之后才知道，下面 IIFE 里赋值；用例只在它之后跑。
let baseUrl = '';

// 1 -------------------------------------------------------------------------
check('建任务请求体逐字等于 2026-10-16 那条 curl（公司 id 与报告期之外一个字都不差）', async () => {
  scenario = { polls: [DONE] };
  const ctx = fresh('body');
  await runExport(baseUrl, ctx);

  const hits = requests.filter((item) => item.url === TRIGGER_PATH);
  assert.ok(hits.length >= 1, '应当打过建任务接口');
  const sent = JSON.parse(hits[0].body);
  assert.deepStrictEqual(sent, EXPECTED_BODY, `请求体与抓包不一致: ${hits[0].body}`);
  assert.strictEqual(sent.data_type, MSSW_VULN_ASYNC_DATA_TYPE, 'data_type 必须取常量（51）');
  assert.strictEqual(typeof sent.params.company_id, 'string', 'company_id 必须是字符串（抓包如此）');
  // 报告期：毫秒闭区间、收尾 .999（抓包里就是 .999）
  assert.deepStrictEqual(sent.params.list_filters.found_time_range, CAPTURE_RANGE,
    `报告期与抓包不一致: ${JSON.stringify(sent.params.list_filters.found_time_range)}`);
  assert.strictEqual(sent.params.list_filters.found_time_range[1] % 1000, 999,
    '收尾必须落在 .999（与旧接口那套截到 .000 的算法刻意不同）');
});

// 2 -------------------------------------------------------------------------
check('端点与暴露面逐字相同：建任务 report、轮询 report_async_task', async () => {
  scenario = { polls: [RUNNING, DONE] };
  const ctx = fresh('poll');
  const { value, error } = await runExport(baseUrl, ctx);
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);

  assert.ok(requestTo(MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT).length >= 1,
    '建任务应当打暴露面那个端点（平台把漏洞表挂在同一处）');
  const polls = requestTo(MSSW_EXPOSED_SURFACE_TASK_ENDPOINT);
  assert.ok(polls.length >= 2, `应当轮询到成功为止（实际 ${polls.length} 次）`);
  assert.deepStrictEqual(JSON.parse(polls[0].body), { task_id_list: [TASK_ID] }, '轮询请求体不对');
  assert.strictEqual(value.taskId, TASK_ID, 'task_id 取自 data.task_id');
  assert.strictEqual(value.rotationStatus, 2, '应当把 rotation_status 带回来（成功那轮是 2）');
});

// 3 -------------------------------------------------------------------------
check('文件从 attachment 给的 workflow 地址下载，字节与文件名都落对（压缩包原样落盘）', async () => {
  scenario = { polls: [DONE] };
  const ctx = fresh('download');
  const { value, error } = await runExport(baseUrl, ctx);
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);

  const downloads = requestTo(ATTACH_PATH);
  assert.strictEqual(downloads.length, 1, `应当只下载一次（实际 ${downloads.length} 次）`);
  assert.strictEqual(downloads[0].method, 'GET', '下载必须是 GET');
  assert.strictEqual(downloads[0].url, ATTACH_URL, '应当下 attachment 给的那个地址');

  // 二进制下载必须去掉这两个头，否则网关把它当普通 XHR 拦掉（与另几份表同款）
  assert.strictEqual(downloads[0].headers['x-requested-with'], undefined, '下载不该带 x-requested-with');
  assert.strictEqual(downloads[0].headers['content-type'], undefined, '下载不该带 content-type');
  assert.strictEqual(downloads[0].headers['x-mssw-company-id'], COMPANY_ID, '下载要带租户头');
  assert.ok(String(downloads[0].headers.cookie || '').includes('soc-token'), '下载要带 cookie');

  assert.strictEqual(value.filename, '漏洞_20261016.zip',
    `content-disposition 里是百分号编码的中文，落盘名要解码（实际 ${value.filename}）`);
  const disk = fs.readFileSync(value.filePath);
  assert.ok(disk.equals(ZIP_BYTES), '落盘字节应当与响应一致（这一层不做解包、不改内容）');
});

// 4 -------------------------------------------------------------------------
check('附件 status=failed -> 当场抛，消息里带 status/progress，且不去下载', async () => {
  scenario = { polls: [poll(3, [attachment({ status: 'failed', progress: 40, url: '' })])] };
  const ctx = fresh('failed');
  const { error } = await runExport(baseUrl, ctx);
  assert.ok(error, '失败态应当抛错');
  assert.ok(/failed/.test(error.message) && /40/.test(error.message),
    `报错要能定位（status/progress），实际: ${error.message}`);
  assert.strictEqual(requestTo(ATTACH_PATH).length, 0, '失败态不该去下载');
});

// 5 -------------------------------------------------------------------------
check('一直 running -> 超时抛错，且消息里带最近一次的 rotation_status/附件状态', async () => {
  scenario = { polls: [RUNNING] };
  const ctx = fresh('timeout');
  const { error } = await runExport(baseUrl, ctx, { timeoutMs: 150, pollIntervalMs: 10 });
  assert.ok(error, '超时应当抛错');
  assert.ok(/超时/.test(error.message), `应当是超时错误，实际: ${error.message}`);
  assert.ok(/rotation_status=1/.test(error.message) && /running/.test(error.message),
    `超时消息要带最近的现场，实际: ${error.message}`);
});

// 6 -------------------------------------------------------------------------
check('缺报告期 -> 当场抛（不替平台猜一个"不带时间"的空档）', async () => {
  scenario = { polls: [DONE] };
  const ctx = fresh('no-range');
  const { error } = await runExport(baseUrl, ctx, { start: undefined, end: undefined });
  assert.ok(error, '没传 --start/--end 应当抛错');
  assert.ok(/--start/.test(error.message) && /--end/.test(error.message),
    `报错要点名缺什么，实际: ${error.message}`);
  assert.strictEqual(requests.length, 0, '不该发出任何请求');
});

// 7 -------------------------------------------------------------------------
check('建请求体：缺 company_id / 缺时间范围都直接抛', async () => {
  assert.throws(() => buildMsswVulnExportRequestBody('', [1, 2]), /company_id/);
  assert.throws(() => buildMsswVulnExportRequestBody(COMPANY_ID, []), /found_time_range/);
  assert.throws(() => buildMsswVulnExportRequestBody(COMPANY_ID, undefined), /found_time_range/);
});

// 8 -------------------------------------------------------------------------
check('请求体里那几处常量逐个钉住（少一个数就是另一批数据）', async () => {
  const body = buildMsswVulnExportRequestBody(COMPANY_ID, CAPTURE_RANGE);
  assert.strictEqual(body.need_split, false, 'need_split 必须是 false');
  assert.strictEqual(body.params.export_scope, 'combined');
  assert.strictEqual(body.params.export_mode, 'single_table');
  assert.deepStrictEqual(body.params.split, { enabled: false, by: 'fix_priority' });
  assert.deepStrictEqual(body.params.fixed_status, [0, 1, 2, 6, 3, 4]);
  assert.deepStrictEqual(body.params.scan_type, [1]);
  // 每次调用都给新数组，别让调用方改一处把常量本身改了
  body.params.fixed_status.push(99);
  assert.deepStrictEqual(buildMsswVulnExportRequestBody(COMPANY_ID, CAPTURE_RANGE).params.fixed_status,
    [0, 1, 2, 6, 3, 4], '常量被改到了（应当每次拷贝一份）');
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

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

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  const total = CASES.length;
  process.stdout.write(failed ? `\n${failed}/${total} 项失败\n` : `\n全部通过（${total} 项）\n`);
  process.exit(failed ? 1 : 0);
})();
