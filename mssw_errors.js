'use strict';

/**
 * 失败信封的分类：把一个 `error` 翻成「机器可读的 code + 进程退出码 + 给人看的 hint」。
 *
 * **两个入口共用这一份**（`pipeline.js` 的 generate 与 `mssw_downloader.js` 的 main）：
 * 同一份报错无论从哪个入口冒出来，都必须给同一个 code、同一句 hint、同一个退出码。
 * 抄成两份就会各修各的、迟早对不上 —— 跟 R5/R14 是同一条道理：一件事只能有一处定义。
 *
 * 退出码全表见 `SKILL.md`；本模块只用得到两个：
 *
 *    8  下载失败（有表没下到，未生成 Excel）—— 重试可能就好了
 *   10  登录态拿不到（下面三个子类）—— 重试无用，得有人去处理
 */

const { AUTH_ERROR_CODE, NOT_CONFIGURED_CODE } = require('./session');
// 「参数错」的码由 args.js 定义（本模块无依赖的那一侧），这里只做判据。
const { BAD_REQUEST_CODE } = require('./args');

const EXIT_BAD_REQUEST = 2;
const EXIT_DOWNLOAD_FAILED = 8;
const EXIT_AUTH = 10;

/**
 * 认出「网关不认这份会话」这一类失败。
 *
 * 形状来自 mssw_client 的报错（接口名也在里面，所以要一起带回去）：
 *   MSSW 请求失败 403 [POST /gateway/…/customer_statistic]: {"code":9451,"msg":"非法操作","data":[]}
 *   9451 = 会话不被该入口认可；9002 = 会话认了但没这个权限。两者都不是重试能解决的。
 *
 * ⚠️ 9451 也可能是**只砸在一个后端服务上**（其余服务同时照常 200，2026-10-08 实测）——
 * 判据是立刻拿另一个服务的接口对打一发。还通就别去重导 cookie，那个方向是错的。
 */
function gatewayReject(message) {
  const hit = String(message || '').match(/\[(POST|GET)\s+(\S+?)\][\s\S]*?"code"\s*:\s*(\d+)/);
  if (!hit || (hit[3] !== '9451' && hit[3] !== '9002')) {
    return null;
  }
  return { method: hit[1], endpoint: hit[2], code: hit[3] };
}

/**
 * 这一类的 hint。两种模式的成因完全不同，所以要分开说 ——
 * 本地几乎总是 cookie 文件过期/被顶掉（跟入口、请求头都无关），
 * 集群则几乎总是入口环境打错（同一份 cookie 换个入口就通）。
 */
function rejectHint(reject, options) {
  const where = `${reject.method} ${reject.endpoint}`;
  if (reject.code === '9002') {
    return `网关认了这份会话但说没权限（${where}）。这既不是重试能解决的、也不是换环境能解决的：`
      + '确认该账号在平台上对这个客户确实有权限。';
  }
  const local = typeof options['cookie-path'] === 'string' && options['cookie-path'].trim() !== '';
  if (local) {
    return `本地模式：这份 cookie 文件不是网关当前认的会话（${where}）。`
      + 'MSSW 一个账号只保留一个活会话 —— **在浏览器里重新登录会立刻顶掉之前导出的 cookie**，'
      + '症状就是 403/9451「非法操作」，且与入口、请求头无关。'
      + '请在登录状态下重新导出 cookie 后重跑；刚导出仍报此错，再查 --mssw-base-url 是不是该会话所在的环境。';
  }
  return `集群模式：这份登录态不被该入口认可（${where}）。`
    + '大概率是 config/api_config.json 里 platforms.mssw.origin 打错环境 —— 同一份 cookie 换个入口就通/不通。'
    + '先用 REPORT_DOWNLOADER_MSSW_BASE_URL 覆盖验证，再回填 config。';
}

/**
 * @param {Error} error 抛出来的那个 error（不会被改写，message 原样回传）
 * @param {object} options CLI options（`rejectHint` 要看有没有 --cookie-path 来分本地/集群）
 * @returns {{code: string, exitCode: number, hint: string}}
 */
function classifyFailure(error, options) {
  const message = String((error && error.message) || '');
  const opts = options || {};

  // 参数错：补齐参数就行，跟网络、登录态都无关。必须排在前面 ——
  // 它的 error.message 里不会有接口名，掉进后面的分支会被归成别的东西。
  if (error && error.code === BAD_REQUEST_CODE) {
    return { code: BAD_REQUEST_CODE, exitCode: EXIT_BAD_REQUEST, hint: '补齐参数后重跑即可（退出码 2 是参数错，重试无用）' };
  }

  // 「没登录」要单独一类：重试多少次都一样，得有人去把平台账号重新绑一下。
  // 跟「下载失败」混在一起的话，guard 会一直重试到超时。
  //
  // 这一类里还要再分：Console 没配平台凭据时**重新登录也没用**，该找的是管理员。
  // 两者共用 EXIT_AUTH（都不该重试），但 hint 与 code 必须分开，否则只会被转述成
  // 「请重新登录」，用户登十次也照样失败。
  if (error && error.code === NOT_CONFIGURED_CODE) {
    return { code: NOT_CONFIGURED_CODE, exitCode: EXIT_AUTH,
      hint: '重试与重新登录都无效（session-manager 回的是 retryable:false）。'
        + '让管理员在 Console 配置该平台凭据并为当前用户配好；'
        + '不要让用户手工粘 Cookie —— 粘了也进不了 session-manager。' };
  }
  if (error && error.code === AUTH_ERROR_CODE) {
    return { code: AUTH_ERROR_CODE, exitCode: EXIT_AUTH,
      hint: '集群模式由 session-manager 代管登录态：先在平台上确认账号已绑定并登录；'
        + '本地调试则传 --cookie-path 指到 cookie 文件' };
  }

  // 网关不认会话。要在下面「有表没下到」之前拦：查客户 id、读 cookie 这些步骤
  // 都在按表下载之前，那一步挂掉时 failures 还是空的，会被归成「生成 Excel 挂了」——
  // 完全指错方向（2026-09-24 实测误导过一次）。
  const rejected = gatewayReject(message);
  if (rejected) {
    return { code: 'session_rejected', exitCode: EXIT_AUTH, hint: rejectHint(rejected, opts) };
  }

  // 「有表没下到」和「表下到了但 Excel 没生成」是两回事，不能共用一句提示：
  // 前者重试可能就好了，后者重试多少次都一样（要改的是合并 / 表格预处理 / 美化里的那一处）。
  // 判据用 error.failures —— 那是 mssw_downloader 只在「有表没下到」时挂上去的字段。
  const failures = error && Array.isArray(error.failures) ? error.failures : [];
  if (failures.length) {
    return { code: 'download_failed', exitCode: EXIT_DOWNLOAD_FAILED,
      hint: '任何一份表没下到就不出报告（缺 sheet 的报告看起来像「这段时间没数据」，会被静默消费）' };
  }

  return { code: 'excel_not_generated', exitCode: EXIT_DOWNLOAD_FAILED,
    hint: '下载没报错，是生成 Excel 这一步挂了（合并 / 表格预处理 / 数据统计 / 美化）；'
      + '报错信息里点名了哪一步就去查那一步' };
}

module.exports = {
  EXIT_BAD_REQUEST,
  EXIT_DOWNLOAD_FAILED,
  EXIT_AUTH,
  gatewayReject,
  rejectHint,
  classifyFailure
};
