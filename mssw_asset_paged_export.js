'use strict';

/**
 * MSSW 资产分页导出（兜底方案）。
 *
 * 当默认导出接口 /apps/asset/view/asset/export 因数据量过大超时时，
 * 退而求其次通过 count + list 分页接口拉取全部资产 id，分批调 export 接口，
 * 本地组装成 xlsx，然后交回 mssw_client.js 走加工流程。
 *
 * 本模块只负责调度 Python 脚本（scripts/mssw_asset_paged_export.py）并转发进度日志，
 * 不直接维护分页/HTTP 细节。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const { encodePath } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');

/**
 * 老调用方还在传裸 host 字符串时的兜底归一：补 https://（与历史逐字一致）。
 *
 * **不能再剥协议** —— 集群入口是 `http://mssw-inner.sangfor.com.cn:30001`，
 * 剥掉 scheme 和端口就必然连不上。现在优先收 platform 描述符（origin 已完整）。
 */
function originFromLegacy(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) {
    return '';
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * Python stderr 可能回显 HTTP 响应体（`RuntimeError(f'HTTP {code}: {body}')`），
 * 真有凭据泄漏时不该原样泼进日志。
 */
const SECRET_LINE_PATTERN = /csrf_token=|cookie:/i;

/** 截尾前先滤掉疑似带凭据的行 —— 错误信息会被上层拼进日志。 */
function sanitizeTail(text, max = 500) {
  return String(text || '')
    .split('\n')
    .filter((line) => !SECRET_LINE_PATTERN.test(line))
    .join('\n')
    .slice(-max);
}

/**
 * 通过 Python 脚本走分页接口拉取资产并生成 xlsx。
 *
 * @param {Object} options
 * @param {{resolvedPath: string, cookieString: string}} options.cookieInfo readMsswCookieInfo 的返回值
 * @param {{origin: string, hostHeader?: string, refererPath?: string}} options.platform
 *        平台描述符（mssw_client.resolvePlatform 的产物）；兼容老的 options.msswBaseUrl 字符串
 * @param {string|number} options.companyId
 * @param {string} [options.outputDir] 默认 <可写区>/tmp/exports
 * @param {number} [options.pageSize] 默认 1000
 * @param {'current'|'wait_approve'|'both'} [options.searchType] 默认 both
 * @param {(msg: string) => void} [options.logger] 进度日志回调
 * @returns {Promise<{currentFilePath: string, waitApproveFilePath: string}>}
 */
async function pagedExportMsswAssetList(options) {
  const cookieInfo = options.cookieInfo;
  if (!cookieInfo || !cookieInfo.resolvedPath) {
    throw new Error('pagedExportMsswAssetList: cookieInfo.resolvedPath 缺失');
  }

  const platform = options.platform && typeof options.platform === 'object'
    ? options.platform
    : {
      origin: originFromLegacy(options.msswBaseUrl),
      hostHeader: options.msswHostHeader,
      refererPath: options.msswRefererPath
    };
  const origin = String(platform.origin || '').trim().replace(/\/+$/, '');
  if (!origin) {
    throw new Error('pagedExportMsswAssetList: platform.origin 缺失');
  }
  const companyId = String(options.companyId || '');
  if (!companyId) {
    throw new Error('pagedExportMsswAssetList: companyId 缺失');
  }

  const outputDir = options.outputDir || workdir.tmpExportsDir();
  await fsp.mkdir(outputDir, { recursive: true });

  const scriptPath = path.join(__dirname, 'scripts', 'mssw_asset_paged_export.py');
  const args = [
    scriptPath,
    '--cookie-path', encodePath(cookieInfo.resolvedPath),
    '--base-url', origin,
    '--host-header', String(platform.hostHeader || ''),
    '--referer-path', String(platform.refererPath || '/index.html'),
    '--company-id', companyId,
    '--output-dir', encodePath(outputDir),
    '--batch-size', String(options.pageSize || 1000),
    '--search-type', options.searchType || 'both'
  ];

  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  logger(`[paged-export] 启动分页导出: origin=${origin} host=${platform.hostHeader || '（不发）'} company=${companyId} searchType=${options.searchType || 'both'}`);

  const stdout = await runPython(args, logger);

  // Python 脚本最后会打印 '###JSON###' + JSON 结果
  const marker = '###JSON###';
  const idx = stdout.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`分页导出脚本未返回 JSON 标记: ${sanitizeTail(stdout)}`);
  }
  const jsonText = stdout.slice(idx + marker.length).trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`分页导出脚本 JSON 解析失败: ${jsonText.slice(0, 500)}`);
  }

  const result = {
    currentFilePath: parsed.currentFilePath || '',
    waitApproveFilePath: parsed.waitApproveFilePath || ''
  };

  if (result.currentFilePath && !fs.existsSync(result.currentFilePath)) {
    throw new Error(`分页导出返回的 currentFilePath 不存在: ${result.currentFilePath}`);
  }
  if (result.waitApproveFilePath && !fs.existsSync(result.waitApproveFilePath)) {
    logger(`[paged-export] waitApproveFilePath 不存在（可能为空），忽略: ${result.waitApproveFilePath}`);
    result.waitApproveFilePath = '';
  }

  return result;
}

/**
 * 跑 Python 脚本，stdout 按行实时转发到 logger，最终返回完整 stdout。
 *
 * 用 spawn 而非 execFile：分页导出可能跑很久（大数据量客户），需要实时进度日志，
 * 且超时后能 SIGTERM/SIGKILL 子进程，避免 execFile 超时后拿不到已生成文件的边界问题。
 *
 * 解释器按 python_cmd.candidates() 逐个试（本地 python、集群 python3）：
 * "这个失败是不是解释器不存在"的判定在 python_cmd.isInterpreterMissing —— 它要求
 * stderr 为空，脚本自身的失败（有 traceback）不会被误判成解释器缺失而重跑一遍。
 */
function runPython(args, logger) {
  return new Promise((resolve, reject) => {
    // 走 workdir.childEnv：TMPDIR/TEMP/TMP 指到可写区（Python 的 mkdtemp 落点）、
    // 关掉 __pycache__（集群上 skill 根只读）。
    const env = workdir.childEnv({
      PYTHONUNBUFFERED: '1',
      PYTHONLEGACYWINDOWSSTDIO: '0'
    });
    const interpreters = pythonCmd.candidates();
    // 分页导出可能涉及大数据量客户（20w+ 资产），给 2 小时
    const timeoutMs = 120 * 60 * 1000;
    let settled = false;
    let timeoutHandle = null;
    let childProc = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const tryRun = (index) => {
      const cmd = interpreters[index];
      const cmdLabel = cmd;
      // 回退时重置缓冲：上一次的输出不该混进这一次的结果（stdout 末尾是结果 JSON）
      stdoutBuffer = '';
      stderrBuffer = '';
      childProc = spawn(cmd, args, { env, windowsHide: true });

      // 标准输出：实时按行转发到 logger
      const rl = readline.createInterface({ input: childProc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        stdoutBuffer += line + '\n';
        if (line && !line.startsWith('###JSON###')) {
          logger(line);
        }
      });

      // 标准错误：实时按行转发到 logger（仅作日志，不阻断）。
      // 带凭据的行直接吞掉：Python 侧会把 HTTP 响应体截 500 字回显，真有泄漏不泼日志。
      const rlErr = readline.createInterface({ input: childProc.stderr, crlfDelay: Infinity });
      rlErr.on('line', (line) => {
        stderrBuffer += line + '\n';
        if (line && !SECRET_LINE_PATTERN.test(line)) {
          logger(`[paged-export-stderr] ${line}`);
        }
      });

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const onExit = (code, signal) => {
        if (settled) return;
        cleanup();
        if (code !== 0 && code !== null) {
          // 解释器不存在时换下一个候选（本地 python / 集群 python3）
          if (pythonCmd.isInterpreterMissing(code, stderrBuffer) && index + 1 < interpreters.length) {
            logger(`[paged-export] ${cmd} 不可用 (code=${code})，改用 ${interpreters[index + 1]} 重试 ...`);
            tryRun(index + 1);
            return;
          }
          settled = true;
          reject(new Error(`分页导出脚本执行失败 (${cmdLabel}): code=${code} signal=${signal} stderr=${sanitizeTail(stderrBuffer)}`));
          return;
        }
        settled = true;
        resolve(stdoutBuffer);
      };

      childProc.on('error', (err) => {
        if (settled) return;
        // 先清掉本次的超时定时器：它闭包的是共享的 childProc，留着会在 2 小时后
        // 把重试起的那个子进程杀掉。
        cleanup();
        if (pythonCmd.isInterpreterSpawnError(err) && index + 1 < interpreters.length) {
          logger(`[paged-export] ${cmd} 不存在 (ENOENT)，改用 ${interpreters[index + 1]} 重试 ...`);
          tryRun(index + 1);
          return;
        }
        settled = true;
        reject(new Error(`分页导出脚本启动失败 (${cmdLabel}): ${err.message}`));
      });

      childProc.on('exit', onExit);
      childProc.on('close', (code, signal) => {
        // close 在 exit 之后触发，exit 已处理过就不再处理
        if (!settled && code === null && signal) {
          onExit(code, signal);
        }
      });

      // 超时强制杀掉子进程
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        logger(`[paged-export] 超时 ${timeoutMs / 1000}s，强制终止子进程`);
        try { childProc.kill('SIGTERM'); } catch (_) { /* ignore */ }
        // 5 秒后若仍未退出，强杀
        setTimeout(() => {
          if (!settled) {
            try { childProc.kill('SIGKILL'); } catch (_) { /* ignore */ }
          }
        }, 5000).unref();
      }, timeoutMs);
      timeoutHandle.unref();
    };

    tryRun(0);
  });
}

module.exports = {
  pagedExportMsswAssetList
};
