'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * 解析 cookie 路径：传文件直接用；传目录则取目录里最新的 txt/json/cookie 文件。
 * @param {string} cookiePath
 * @returns {Promise<string>} 实际读取的文件路径
 */
async function resolveCookiePath(cookiePath) {
  const stat = await fsp.stat(cookiePath);
  if (stat.isFile()) {
    return cookiePath;
  }

  const candidates = await fsp.readdir(cookiePath, { withFileTypes: true });
  const files = candidates
    .filter((entry) => entry.isFile() && /\.(txt|json|cookie|cookies)$/i.test(entry.name))
    .map((entry) => path.join(cookiePath, entry.name));

  if (!files.length) {
    throw new Error(`Cookie 目录中没有找到 txt/json/cookie 文件: ${cookiePath}`);
  }

  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

/**
 * 读取 mssw cookie 文件，返回 cookie 字符串。
 *
 * cookie 全程以**原串**透传（请求头 `cookie` 直接用），不再切键值对 ——
 * 唯一需要按键取值的 csrf_token 已确认不是鉴权项，2026-09-24 起全面移除。
 *
 * 注意：返回的 resolvedPath 同时决定导出文件的落盘目录
 * （见 mssw_client.js 的 exportMsswIncidentList），因此必须是文件路径而非目录。
 *
 * @param {string} cookiePath
 * @returns {Promise<{resolvedPath: string, cookieString: string}>}
 */
async function readMsswCookieInfo(cookiePath) {
  if (!cookiePath) {
    throw new Error('MSSW 取数需要 --cookie-path');
  }

  const resolvedPath = await resolveCookiePath(cookiePath);
  const rawContent = await fsp.readFile(resolvedPath, 'utf8');
  const cookieString = String(rawContent || '').trim();

  if (!cookieString) {
    throw new Error(`MSSW Cookie 文件内容为空: ${resolvedPath}`);
  }

  return {
    resolvedPath,
    cookieString
  };
}

module.exports = {
  resolveCookiePath,
  readMsswCookieInfo
};
