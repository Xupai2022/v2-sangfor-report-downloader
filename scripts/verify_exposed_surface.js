#!/usr/bin/env node
'use strict';

/**
 * 暴露面表下载链路的验证门：`node scripts/verify_exposed_surface.js`（退出码 0 = 通过）。
 *
 * 与 scripts/verify_retry.js 同一条思路：真接口没法按需造状态（更别说桌面/CI 里连不上
 * 集群入口），所以起一个本地 http server **照着 2026-10-15 那份浏览器抓包的形状**应答，
 * 对着 **mssw_client 真正的 exportMsswExposedSurfaceList** 打 ——
 * 验的是接线（哪个端点、请求体长什么样、轮询到什么时候算完、文件从哪个地址下来），
 * 不是算法。
 *
 * 钉住的几件事，每一件都对应一处"写错了也不会报错、只会静默给错数据"的地方：
 *
 *   1. 建任务的请求体等于抓包（唯一一处改动：need_split 发 false，用户口径 2026-10-16），
 *      且**一个时间参数都没有** —— 这份表不受 --start/--end 影响（用户口径 2026-10-15）。
 *      顺手塞个 found_time_range 进去，接口照样 code=0，只是导的是另一批数据。
 *   2. task_id 取自 `data.task_id`（字符串），不是事件表那种 `data.id`。
 *   3. 轮询问的是 report_async_task、体是 `{task_id_list:[…]}`；**只看第一轮就返回**会拿到
 *      半成品（这里先回一轮 running，再回成功）。
 *   4. attachment_list 里认**自己那个 task_id** 的那一项 —— 别家任务排在后面时
 *      取"最后一项"就取错了。
 *   5. 文件从 attachment 给的 `/gateway/workflow/...` 地址下（不是 easm-exposure 自己的
 *      下载接口），且下载请求要去掉 x-requested-with / content-type（否则被网关当 XHR 拦）。
 *   6. 失败/超时/契约破损三条路都**当场抛**，且消息里带得出定位信息
 *      （status、progress、rotation_status、缺哪个字段）。
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  exportMsswExposedSurfaceList,
  buildMsswExposedSurfaceExportRequestBody,
  buildMsswExposedSurfaceAttachmentUrl,
  MSSW_EXPOSED_SURFACE_DATA_TYPE
} = require('../mssw_client');

// ---- 抓包里的那些常量（2026-10-15，用户给的那份 curl）----
const TRIGGER_PATH = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report';
const TASK_PATH = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report_async_task';
const ATTACH_PATH = '/gateway/workflow/order/v1/attachments';
const COMPANY_ID = '67262236';
const TASK_ID = '6ad071106a24a3647da821b0';
const FILE_ID = '6ad07096988b1cf65b027d01';
const ATTACH_URL = `${ATTACH_PATH}?_file=${FILE_ID}`;
// 抓包请求体，逐字。断言直接拿它比 —— 改实现时这里不该跟着改。
const CAPTURE_BODY = {
  params: { company_id: COMPANY_ID, target_company_id: [], related_task: [] },
  need_split: true,
  data_type: 50
};
// 实际该发出去的体 = 抓包 + 用户明确改过的那几处。
// 目前只有一处：need_split true -> false（用户口径 2026-10-16）。
// 有改动就在这显式写一条，而不是把 CAPTURE_BODY 改掉 —— 那样就分不清
// "平台改契约了" 和 "我们有意发得不一样"，会把抓包这个底稿弄丢。
const EXPECTED_BODY = Object.assign({}, CAPTURE_BODY, { need_split: false });
// 假 xlsx：只在头部放个 ZIP magic，够证明"字节被原样落盘"
const XLSX_BYTES = Buffer.from('504b0304-exposed-surface-bytes', 'utf8');
// 落盘名走 percent-encoded 中文那条路（平台在别处就是这么给的）
const DISPOSITION = 'attachment; filename=%E6%9A%B4%E9%9C%B2%E9%9D%A2_20261015.xlsx';

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
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': scenario.disposition || DISPOSITION
      });
      res.end(XLSX_BYTES);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
});

/** 每一段用的干净现场：新目录 + 一份 cookie 文件 + 空的请求录像。 */
function fresh(dirName) {
  requests.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v2-exposed-${dirName}-`));
  const cookiePath = path.join(dir, 'mssw_cookies.txt');
  fs.writeFileSync(cookiePath, 'soc-token=fake-token; csrf_token=fake-csrf\n');
  return { dir, cookiePath, downloadDir: path.join(dir, 'downloads') };
}

const CASES = [];
const check = (name, fn) => CASES.push({ name, fn });

/** 跑一次导出，把"扔了什么"也带回来（成功路径要看返回的对象）。 */
async function runExport(base, ctx, overrides = {}) {
  try {
    const value = await exportMsswExposedSurfaceList(Object.assign({
      msswCookiePath: ctx.cookiePath,
      msswBaseUrl: base,
      customerId: COMPANY_ID,
      downloadDir: ctx.downloadDir,
      pollIntervalMs: 10
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
check('建任务请求体逐字等于抓包（need_split 除外，按用户口径发 false），且不带任何时间参数', async () => {
  scenario = { polls: [DONE] };
  const ctx = fresh('body');
  await runExport(baseUrl, ctx);

  const hits = requests.filter((item) => item.url === TRIGGER_PATH);
  assert.ok(hits.length >= 1, '应当打过建任务接口');
  const sent = JSON.parse(hits[0].body);
  assert.deepStrictEqual(sent, EXPECTED_BODY, `请求体与预期不一致: ${hits[0].body}`);
  assert.strictEqual(sent.need_split, false, 'need_split 必须是 false（用户口径 2026-10-16）');
  assert.strictEqual(sent.data_type, MSSW_EXPOSED_SURFACE_DATA_TYPE, 'data_type 必须取常量');
  assert.strictEqual(typeof sent.params.company_id, 'string', 'company_id 必须是字符串（抓包如此）');
  // 时间参数一个都不许有 —— 这是这份表与其他五份最容易被"顺手补齐"的地方
  assert.ok(!/time|range|begin|end|start/i.test(hits[0].body),
    `请求体里出现了时间相关的键: ${hits[0].body}`);
});

// 2 -------------------------------------------------------------------------
check('轮询问 report_async_task、体是 {task_id_list:[…]}；先 running 后 success 才算完', async () => {
  scenario = { polls: [RUNNING, DONE] };
  const ctx = fresh('poll');
  const { value, error } = await runExport(baseUrl, ctx);
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);

  const polls = requestTo(TASK_PATH);
  assert.ok(polls.length >= 2, `应当轮询到成功为止（实际 ${polls.length} 次）`);
  assert.deepStrictEqual(JSON.parse(polls[0].body), { task_id_list: [TASK_ID] }, '轮询请求体不对');
  assert.strictEqual(value.taskId, TASK_ID, 'task_id 取自 data.task_id');
  assert.strictEqual(value.rotationStatus, 2, '应当把 rotation_status 带回来（成功那轮是 2）');
});

// 3 -------------------------------------------------------------------------
check('文件从 attachment 给的 workflow 地址下载，字节与文件名都落对', async () => {
  scenario = { polls: [DONE] };
  const ctx = fresh('download');
  const { value, error } = await runExport(baseUrl, ctx);
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);

  const downloads = requestTo(ATTACH_PATH);
  assert.strictEqual(downloads.length, 1, `应当只下载一次（实际 ${downloads.length} 次）`);
  assert.strictEqual(downloads[0].method, 'GET', '下载必须是 GET');
  assert.strictEqual(downloads[0].url, ATTACH_URL, '应当下 attachment 给的那个地址');

  // 二进制下载必须去掉这两个头，否则网关把它当普通 XHR 拦掉（与另三份表同款）
  assert.strictEqual(downloads[0].headers['x-requested-with'], undefined, '下载不该带 x-requested-with');
  assert.strictEqual(downloads[0].headers['content-type'], undefined, '下载不该带 content-type');
  assert.strictEqual(downloads[0].headers['x-mssw-company-id'], COMPANY_ID, '下载要带租户头');
  assert.ok(String(downloads[0].headers.cookie || '').includes('soc-token'), '下载要带 cookie');

  assert.strictEqual(value.filename, '暴露面_20261015.xlsx',
    `content-disposition 里是百分号编码的中文，落盘名要解码（实际 ${value.filename}）`);
  const disk = fs.readFileSync(value.filePath);
  assert.ok(disk.equals(XLSX_BYTES), '落盘字节应当与响应一致');
});

// 4 -------------------------------------------------------------------------
check('attachment_list 里认自己那个 task_id（别家任务排在后面也不会取错）', async () => {
  scenario = {
    polls: [poll(2, [
      attachment(),
      { status: 'success', progress: 100, url: `${ATTACH_PATH}?_file=someone-else`, task_id: 'other-task' }
    ])]
  };
  const ctx = fresh('others');
  const { value, error } = await runExport(baseUrl, ctx);
  assert.strictEqual(error, null, `不该失败: ${error && error.message}`);
  assert.strictEqual(value.attachmentUrl, ATTACH_URL, '取错了附件（拿到别家任务那一项）');
  assert.strictEqual(requestTo(ATTACH_PATH)[0].url, ATTACH_URL, '下载的地址应当是自己的那一项');
});

// 5 -------------------------------------------------------------------------
check('附件 status=failed -> 当场抛，消息里带 status/progress', async () => {
  scenario = { polls: [poll(3, [attachment({ status: 'failed', progress: 40, url: '' })])] };
  const ctx = fresh('failed');
  const { error } = await runExport(baseUrl, ctx);
  assert.ok(error, '失败态应当抛错');
  assert.ok(/failed/.test(error.message) && /40/.test(error.message),
    `报错要能定位（status/progress），实际: ${error.message}`);
  assert.strictEqual(requestTo(ATTACH_PATH).length, 0, '失败态不该去下载');
});

// 6 -------------------------------------------------------------------------
check('顶层 success:false -> 当场抛（别当"还在跑"一直轮询）', async () => {
  scenario = { polls: [{ success: false, code: 0, msg: '任务不存在', data: {} }] };
  const ctx = fresh('not-success');
  const { error } = await runExport(baseUrl, ctx);
  assert.ok(error, 'success:false 应当抛错');
  assert.ok(/任务不存在/.test(error.message), `要把平台的 msg 带出来，实际: ${error.message}`);
  assert.strictEqual(requestTo(TASK_PATH).length, 1, '不该继续轮询');
});

// 7 -------------------------------------------------------------------------
check('一直 running -> 超时抛错，且消息里带最近一次的 rotation_status/附件状态', async () => {
  scenario = { polls: [RUNNING] };
  const ctx = fresh('timeout');
  const { error } = await runExport(baseUrl, ctx, { timeoutMs: 150, pollIntervalMs: 10 });
  assert.ok(error, '超时应当抛错');
  assert.ok(/超时/.test(error.message), `应当是超时错误，实际: ${error.message}`);
  assert.ok(/rotation_status=1/.test(error.message) && /running/.test(error.message),
    `超时消息要带最近的现场（否则只能猜是排队还是字段改了），实际: ${error.message}`);
});

// 8 -------------------------------------------------------------------------
check('建任务响应缺 task_id -> 当场抛（不乱猜 id 继续轮询）', async () => {
  scenario = { trigger: { data: { id: 'wrong-field' }, code: 0, msg: '成功' } };
  const ctx = fresh('no-task-id');
  const { error } = await runExport(baseUrl, ctx);
  assert.ok(error, '缺 task_id 应当抛错');
  assert.ok(/task_id/.test(error.message), `报错要点名字段，实际: ${error.message}`);
  assert.strictEqual(requestTo(TASK_PATH).length, 0, '拿不到 task_id 就不该去轮询');
});

// 9 -------------------------------------------------------------------------
check('附件地址是整条 URL 时照用（不拼 origin）；相对路径拼 origin；空值抛', async () => {
  const platform = { origin: 'https://sitmssw.soar.sangfor.com.cn' };
  assert.strictEqual(buildMsswExposedSurfaceAttachmentUrl(platform, 'https://cdn.example.com/a.xlsx'),
    'https://cdn.example.com/a.xlsx');
  assert.strictEqual(buildMsswExposedSurfaceAttachmentUrl(platform, ATTACH_URL),
    `https://sitmssw.soar.sangfor.com.cn${ATTACH_URL}`);
  assert.strictEqual(buildMsswExposedSurfaceAttachmentUrl(platform, 'gateway/x'),
    'https://sitmssw.soar.sangfor.com.cn/gateway/x');
  assert.throws(() => buildMsswExposedSurfaceAttachmentUrl(platform, ''), /没有给出附件地址/);
});

// 10 ------------------------------------------------------------------------
check('company_id 缺失时建请求体直接抛（不发一个租户为空的请求）', async () => {
  assert.throws(() => buildMsswExposedSurfaceExportRequestBody(''), /company_id/);
  assert.throws(() => buildMsswExposedSurfaceExportRequestBody(undefined), /company_id/);
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
