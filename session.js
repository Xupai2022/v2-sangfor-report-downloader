'use strict';

/**
 * 运行模式 + 登录态 —— 本仓库唯一的「本地 / 集群」判定点。
 *
 * 判定规则：**有没有传 `--cookie-path`**
 *   - 传了   → local：直接读那个 txt / 目录（历史行为，逐字不变）
 *   - 没传   → cluster（默认）：调 `session-manager get-state` 取当前 agent 的登录态，
 *              把 cookie 串私有写到 `<SKILL_OUTPUT_DIR>/session/mssw_cookies.txt`，
 *              再把**这个文件路径**喂给下游。
 *
 * 关键点：两条路最后都返回「一个 cookie 文件路径」，所以
 *   - cookie_reader.js 零改动
 *   - Python 子进程继续收 `--cookie-path <file>`，契约不变
 * 变的只是这个路径的生产者。
 *
 * 参考实现：tmp/health-checkup-report/src/session.js（同为 Node + Python 混合）
 * 与 tmp/policy-check/shared/__init__.py:get_cookie。
 *
 * 凭据（cookie / csrf）绝不写 stdout、日志或错误信息。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const workdir = require('./workdir');
const apiConfig = require('./api_config');
const { resolvePlatform } = require('./mssw_client');
const { SKILL_NAME, PLATFORM } = require('./skill_meta');

/** 集群取态的超时（与参照实现一致）。 */
const SESSION_MANAGER_TIMEOUT_MS = 60000;

/** 认证类失败的错误码：让 pipeline.js 能把「未登录」和「下载失败」区分开。 */
const AUTH_ERROR_CODE = 'auth_required';

/**
 * Console 没给本平台配凭据。与「登录态过期」是**两回事**，虽然都属于"拿不到登录态"：
 *
 *   auth_required           会话过期/账号未绑定 → 用户自己重新登录就能好，可以劝他重试
 *   platform_not_configured Console 里没这个平台的凭据 → **重试无用、重新登录也无用**
 *                           （session-manager 自己回 retryable:false），得管理员去 Console 配
 *
 * 分开报的理由：两者都非零退出、都不能自动恢复，但**该找的人不同**。
 * 混成一个码的话，这条只会被转述成"请重新登录"，然后用户登十次也没用。
 */
const NOT_CONFIGURED_CODE = 'platform_not_configured';

function authError(message, code = AUTH_ERROR_CODE) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 两类"拿不到登录态" —— 都不该重试，调用方据此统一映射成 EXIT_AUTH。 */
function isAuthError(error) {
  return !!error && (error.code === AUTH_ERROR_CODE || error.code === NOT_CONFIGURED_CODE);
}

/**
 * 从 session-manager 的 stderr 里取错误码。
 *
 * 它的 stderr 是 `{"version":1,"error":{"code":"not_configured",...}}`。
 * **只认 `error.code` 这一个字段**，不拿 message 做字符串匹配 —— message 是给人看的，
 * 会随版本改措辞；code 才是契约。解析不出来就返回空串（走通用分支）。
 */
function sessionManagerErrorCode(stderr) {
  try {
    const parsed = JSON.parse(String(stderr || '').trim());
    const code = parsed && parsed.error && parsed.error.code;
    return typeof code === 'string' ? code : '';
  } catch (error) {
    return '';
  }
}

/**
 * session-manager 的调用命令。
 *
 * SESSION_MANAGER_CLI_JS / SESSION_MANAGER_NODE / SESSION_MANAGER_BIN 是**本地联调钩子**
 * （对齐 tmp/asset-discovery/scripts/_common.py:141）：没有它，Windows 上
 * spawnSync('session-manager') 解析不到 .js 文件，集群分支在本地根本没法测。
 */
function sessionManagerCommand(args) {
  const cliJs = process.env.SESSION_MANAGER_CLI_JS;
  if (cliJs) {
    return [process.env.SESSION_MANAGER_NODE || 'node', cliJs, ...args];
  }
  return [process.env.SESSION_MANAGER_BIN || 'session-manager', ...args];
}

/**
 * 调 session-manager 取 skill-scoped 登录态，返回解析后的 session 对象。
 *
 * fail loud：取不到一律抛错（非 0 退出），绝不静默回退到别的凭据。
 */
function readSessionState() {
  const command = sessionManagerCommand(['get-state', '--skill-name', SKILL_NAME]);
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    timeout: SESSION_MANAGER_TIMEOUT_MS
  });

  if (result.error) {
    throw authError(
      '未找到 session-manager：集群模式需要它提供 mssw 登录态' +
      '（本地调试请传 --cookie-path 指定 cookie 文件）' +
      `。底层错误: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    // 只用 stderr：session-manager 的 stdout 是登录态 JSON，
    // 拼进错误信息等于把凭据写进日志（参照实现里的 stderr || stdout 就是这么埋雷的）。
    const detail = String(result.stderr || '').trim().slice(0, 300);
    if (sessionManagerErrorCode(result.stderr) === 'not_configured') {
      throw authError(
        `Console 里没有本 skill 依赖的「${PLATFORM}」平台凭据（session-manager 报 not_configured）。` +
        `这是平台侧的配置缺失，重试和重新登录都没用：` +
        `请让管理员在 Console 配置「${PLATFORM}」平台并为当前用户配好凭据。` +
        `（skill 的 muad.skill.json 声明的是 platforms: ["${PLATFORM}"]，` +
        `若 Console 里该平台的名称不同，改这里。）` +
        (detail ? ` 原始错误: ${detail}` : ''),
        NOT_CONFIGURED_CODE
      );
    }
    throw authError(`获取登录态失败（session-manager 退出码 ${result.status}）${detail ? `: ${detail}` : ''}`);
  }

  let state;
  try {
    state = JSON.parse(result.stdout);
  } catch (error) {
    throw authError(`session-manager 输出解析失败: ${error.message}`);
  }

  const sessionFile = state && state.sessionStateFile;
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw authError(`未获取到登录态文件，请先确认 ${PLATFORM} 平台已绑定并登录`);
  }

  try {
    return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  } catch (error) {
    throw authError(`读取登录态文件失败: ${error.message}`);
  }
}

/** 从 session.platforms.<platform>.cookies 拼 `name=value; name2=value2`；取不到返回 null。 */
function cookieStringFor(session, platform = PLATFORM) {
  const section = (session && session.platforms && session.platforms[platform]) || null;
  const cookies = section && section.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return null;
  }
  const pairs = cookies
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join('; ') : null;
}

/**
 * 打印登录态的**非密指纹**：cookie 名清单 + 平台段里的环境元数据。
 *
 * 为什么值得单开一条：网关回 403/`code=9451 非法操作` 时，病因只有两个 ——
 * **环境打错**或 **cookie 名不全**（另一条 memory: mssp-gateway-error-codes）。
 * 而判环境唯一的依据是凭据的 domain（memory: sangfor-platform-envs「排障第一步是看 cookie 的 domain」）。
 *
 * 我们此前把 cookie 压成 `name=value` 串，**domain 和其余元数据就丢了** ——
 * 于是这类故障只能靠反推（2026-09-24 就是这么白跑了一轮，把 9451 误判成"缺 csrf_token"）。
 *
 * 只打**名**不打值：cookie 值、token 一律不外泄。
 */
function logSessionFingerprint(session, logger) {
  const section = (session && session.platforms && session.platforms[PLATFORM]) || {};
  const cookies = Array.isArray(section.cookies) ? section.cookies : [];
  const names = cookies.map((c) => (c && c.name) || '?').join(', ');
  logger(`[session] 登录态 cookie ${cookies.length} 个: ${names || '（无）'}`);

  // 环境元数据的字段名按各环境实现可能不同，见到就打 —— 这决定了请求该打到哪个入口。
  for (const key of ['domain', 'baseUrl', 'base_url', 'host', 'hostHeader', 'host_header', 'origin', 'env', 'environment']) {
    const value = section[key];
    if (typeof value === 'string' && value.trim()) {
      logger(`[session] 凭据环境(${key}): ${value.trim()}`);
    }
  }
}

/**
 * 取当前 agent 的 mssw 登录态，私有写到可写区，返回该文件路径。
 *
 * 文件权限 0o600（Windows 上无效，Linux 有效）。整轮运行期间必须存活：
 * 三个 exportMssw*List 与 Python 子进程都会按路径重读它。
 */
async function materializeMsswCookie(logger = () => {}) {
  const session = readSessionState();
  const cookieString = cookieStringFor(session, PLATFORM);
  if (!cookieString) {
    throw authError(`登录态缺少 ${PLATFORM} 平台 cookie（请先确认 ${PLATFORM} 平台已绑定并登录）`);
  }

  logSessionFingerprint(session, logger);

  const filePath = workdir.cookieFilePath(PLATFORM);
  await fsp.writeFile(filePath, cookieString, { encoding: 'utf8', mode: 0o600 });
  logger('[session] 登录态来源: session-manager（已写入私有 cookie 文件）');
  return filePath;
}

/**
 * 本地模式的平台描述符：**完全不读集群 config**。
 *
 * host 头等于域名（除非显式传 msswHostHeader），origin 走 https://<域名>。
 * 让本地也吃集群的统一 Host 头会把请求打挂。
 */
function resolveLocalPlatform(options = {}) {
  return resolvePlatform({
    msswBaseUrl: options.msswBaseUrl,
    msswHostHeader: options.msswHostHeader,
    msswRefererPath: options.msswRefererPath
  });
}

/**
 * 集群模式的平台描述符：origin / Host 头 / referer 均来自 config/api_config.json
 * （各自支持 env 覆盖），显式 CLI 参数优先（便于集群上排障）。
 */
function resolveClusterPlatform(options = {}) {
  return resolvePlatform({
    msswBaseUrl: options.msswBaseUrl || apiConfig.getOrigin(PLATFORM),
    msswHostHeader: options.msswHostHeader !== undefined
      ? options.msswHostHeader
      : apiConfig.getHostHeader(PLATFORM),
    msswRefererPath: options.msswRefererPath || apiConfig.getRefererPath(PLATFORM)
  });
}

/**
 * 判定模式并备好登录态与平台描述符。
 *
 * @param {{cookiePath?: string, msswBaseUrl?: string, msswHostHeader?: string, msswRefererPath?: string}} input
 * @param {(msg: string) => void} [logger]
 * @returns {Promise<{mode: 'local'|'cluster', cookiePath: string, platform: {origin: string, hostHeader: string, refererPath: string}, source: string}>}
 */
async function resolveAuth(input = {}, logger = () => {}) {
  const cookiePath = input.cookiePath;

  // args.js 会把裸写的 --cookie-path 解析成 true。那看起来像"选了本地模式"，
  // 却会在 fsp.stat(true) 里炸出一句看不懂的错，所以这里先拦下来。
  if (cookiePath === true) {
    throw new Error('--cookie-path 需要一个路径值，例如 --cookie-path "C:\\Users\\<you>\\Downloads\\mssw_cookies.txt"');
  }

  const hasLocalCookie = typeof cookiePath === 'string' && cookiePath.trim() !== '';

  if (hasLocalCookie) {
    const platform = resolveLocalPlatform(input);
    logger(`[mode] 本地（--cookie-path）：登录态取自 ${cookiePath.trim()}`);
    logger(`[platform] ${platform.origin}（host 头 ${platform.hostHeader || '（不发）'}）`);
    return { mode: 'local', cookiePath: cookiePath.trim(), platform, source: 'cli' };
  }

  const platform = resolveClusterPlatform(input);
  logger('[mode] 集群（session-manager 代管登录态）');
  logger(`[platform] ${platform.origin}（host 头 ${platform.hostHeader || '（不发）'}）`);
  const privateCookiePath = await materializeMsswCookie(logger);
  return { mode: 'cluster', cookiePath: privateCookiePath, platform, source: 'session-manager' };
}

module.exports = {
  AUTH_ERROR_CODE,
  NOT_CONFIGURED_CODE,
  isAuthError,
  sessionManagerErrorCode,
  SESSION_MANAGER_TIMEOUT_MS,
  SKILL_NAME,
  PLATFORM,
  sessionManagerCommand,
  readSessionState,
  cookieStringFor,
  materializeMsswCookie,
  resolveLocalPlatform,
  resolveClusterPlatform,
  resolveAuth,
  // 供 pipeline.js 等入口复用可写目录
  outputDir: workdir.outputDir
};
