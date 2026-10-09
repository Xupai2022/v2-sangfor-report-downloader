'use strict';

// 「参数错」的码。定义放这里（本模块无任何依赖），因为判据在 mssw_errors.classifyFailure
// —— 两个入口都靠它把参数错和「下载失败」「登录态拿不到」分开（退出码 2 / 8 / 10 不是一回事）。
const BAD_REQUEST_CODE = 'bad_request';

/**
 * 造一个「参数错」的 error。参数类问题一律走它，别裸 throw ——
 * 裸 throw 出来的 error 没有 code，落进 classifyFailure 会被归成「Excel 没生成」，
 * 指向完全相反的方向（2026-10-08 实测踩过）。
 */
function badRequest(message) {
  const error = new Error(message);
  error.code = BAD_REQUEST_CODE;
  return error;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : null;
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      i += 1;
    }
  }

  return { command, options };
}

function requireArgs(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length) {
    throw badRequest(`Missing required option(s): ${missing.map((name) => `--${name}`).join(', ')}`);
  }
}

/**
 * 列表参数的统一切分：半角逗号 / 全角逗号 / 顿号 / 中英文分号 / 换行。
 *
 * 收这么多分隔符是因为**用户的手感是中文标点**：`--business-systems "OA，财务"`
 * 用全角逗号是常态。只认半角逗号的话，这种输入不会报错，会静默变成一个名字
 * 「OA，财务」—— 错得无声无息，比报错糟得多。
 *
 * 这是 `pptgen/cli.py` 的 `_LIST_SEPARATORS` 的镜像 —— 规则必须一致。
 * 放在这里（而不是各自入口里）是因为有三个调用方：pipeline.js 自己、mssw_downloader.js
 * 自己（两个入口都能被直调），以及 pptgen 那条路。一份实现，就不会出现
 * 「pptgen 切出来的名字和取值层切出来的不是同一个」这种事。
 *
 * 本模块保持零依赖：这个方法只用正则，不需要 require 任何东西。
 */
const LIST_SEPARATORS = /[，、,；;\r\n]+/;

function splitList(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(LIST_SEPARATORS)
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  BAD_REQUEST_CODE,
  badRequest,
  parseArgs,
  requireArgs,
  splitList,
  LIST_SEPARATORS
};
