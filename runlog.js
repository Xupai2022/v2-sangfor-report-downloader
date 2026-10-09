'use strict';

/**
 * 本次运行的日志文件 —— 把 stderr 全量落一份到 `outputs/_logs/`。
 *
 * 为什么要它：诊断「403 / code=9451」这类故障时，唯一的观测面是跑完之后的 stderr，
 * 而 agent 转述时会丢信息（2026-09-24 实测就丢了「403 是哪个接口」这一条，
 * 导致下一轮排障还得再猜）。落一份文件之后，失败时可以把**原文**带回来，也能事后翻。
 *
 * 覆盖范围 = **整条 stderr**。做法是替换 `process.stderr.write` 这一个收口，于是
 * `console.error`、直接 `process.stderr.write`、透传进来的 Python 子进程 stderr、
 * 未捕获异常的 stack，全都自动进文件 —— 不需要在每个调用点接线。
 * （`console.error` 内部就走 `process.stderr.write`，所以只包这一层，不会重复写。）
 *
 * 三条硬性约束：
 *   1. **凭据不外泄**：疑似凭据的行整行丢弃（判据与 progress.js 共用同一个正则）。
 *   2. **best-effort**：落盘失败绝不改变业务结果，所有写入都吞异常。
 *   3. **不碰 stdout**：只读 stderr。stdout 的契约是「恰好一个 JSON 对象」，
 *      这里一个字节都不往那儿写。
 *
 * 落点与命名：`outputs/_logs/<入口>.<YYYYMMDD_HHMMSS>.log` —— 与 pptgen 自己那份
 * （`<command>.<时间戳>.log`）同目录、同命名法，出问题时能一眼对上。
 * 目录口径走 `workdir.logsDir()`：集群在 `<SKILL_OUTPUT_DIR>/outputs/_logs`，
 * 本地在 `<仓库根>/outputs/_logs`（两边都落）。
 *
 * 用法（入口脚本里，各一次）：
 *
 *     runlog.open({ entry: 'pipeline' });
 *     runlog.attach();
 *
 * 之后什么都不用做：stderr 上出现什么，文件里就有什么。
 */

const fs = require('node:fs');
const path = require('node:path');

const workdir = require('./workdir');

/**
 * 疑似凭据的行一律不落盘。
 *
 * 网关的报错响应体会被原样带进错误信息（`MSSW 请求失败 403: {...}`），
 * 里面可能回显 cookie。progress.js 要往外发文案时用的是同一条判据 ——
 * 两处必须一致，所以定义在这里、那边 import。
 *
 * 三种形状都要盖住（漏一种就等于没盖）：
 *   1. 凭据**字段名**出现 —— 带不带引号、跟 `:` 还是 `=` 都算（`csrf_token=` / `"csrfToken":`）
 *   2. JSON / 字典里的 cookie 字段 —— `"cookie": "..."`（引号夹在中间，第一种盖不住）
 *   3. 头式的 cookie 串 —— `cookie: a=b; c=d`
 *
 * 第 3 条刻意要求**有 `=`**：我们自己的 `MSSW Cookie: <cookie 文件路径>` 那行是有用的
 * （它说明用的是哪个凭据文件，且只有路径没有值），不能被误伤 —— 路径里没有 `=`。
 */
const SECRET_LINE_PATTERN = new RegExp([
  /(csrf_?token|soc-?token|pre_soc_token|sessionid|authorization|api[_-]?key|access[_-]?token|secret)["']?\s*[:=]/i.source,
  /["']cookie["']\s*[:=]/i.source,
  /cookie:\s*\S+=\S+/i.source
].join('|'), 'i');

/** 只保留一条日志的行数上限，防止异常刷屏把磁盘写满。 */
const MAX_LINES = 20000;

let logPath = null;
let opened = false;
let attached = false;
let linesWritten = 0;
let truncatedNoticed = false;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** 与 run 目录同款的时间戳（`YYYYMMDD_HHMMSS`），便于和产物目录对上。 */
function timestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeChunk(text) {
  if (!logPath) {
    return;
  }
  try {
    if (linesWritten >= MAX_LINES) {
      if (!truncatedNoticed) {
        truncatedNoticed = true;
        fs.appendFileSync(logPath, `\n# 已达 ${MAX_LINES} 行上限，后续日志不再写入\n`, 'utf8');
      }
      return;
    }
    const kept = String(text)
      .split(/\r?\n/)
      .filter((line) => line.trim() && !SECRET_LINE_PATTERN.test(line));
    if (!kept.length) {
      return;
    }
    linesWritten += kept.length;
    fs.appendFileSync(logPath, `${kept.join('\n')}\n`, 'utf8');
  } catch (error) {
    // best-effort：日志落不下去不是业务失败的理由。
  }
}

/**
 * 显式往日志里写一行。
 *
 * 用途只有一处：`--quiet` 时控制台不输出，那条通路绕过了 stderr，
 * 于是日志也会跟着空白 —— 用 `runlog.line()` 补上，让**日志文件不受 --quiet 影响**。
 */
function line(message) {
  writeChunk(`${message}\n`);
}

/**
 * 开日志文件。幂等：重复调用返回同一个路径（pipeline 会 require mssw_downloader，
 * 两者同进程，不能各开一份）。
 *
 * @param {{entry?: string, dir?: string}} [options]
 * @returns {string|null} 日志文件绝对路径；开不出来（磁盘只读等）返回 null
 */
function open(options = {}) {
  if (opened) {
    return logPath;
  }
  opened = true;
  try {
    const dir = options.dir || workdir.logsDir();
    // 显式传 dir 时也要建 —— `workdir.logsDir()` 自己会 ensureDir，但显式路径不会，
    // 而"目录不存在"会被下面的 catch 静默吞掉，等于日志凭空消失。
    fs.mkdirSync(dir, { recursive: true });
    const entry = String(options.entry || 'run').replace(/[^A-Za-z0-9_-]/g, '') || 'run';
    logPath = path.join(dir, `${entry}.${timestamp()}.log`);
    fs.writeFileSync(logPath, '', 'utf8');
    line(`# ${entry} 运行日志`);
    line(`# 开始时间: ${new Date().toISOString()}`);
    line(`# 进程 PID: ${process.pid}`);
    line(`# cwd: ${process.cwd()}`);
    // argv 里只可能是路径、客户名、日期这类参数 —— 凭据永远不该出现在命令行上
    // （SKILL.md 的硬约束），所以这里可以照抄；仍然过一遍上面的凭据过滤。
    line(`# argv: ${process.argv.slice(2).join(' ')}`);
    line('');
    process.once('exit', (code) => {
      try {
        fs.appendFileSync(logPath, `\n# 进程退出码: ${code}\n`, 'utf8');
      } catch (error) {
        // best-effort
      }
    });
  } catch (error) {
    logPath = null;
  }
  return logPath;
}

/**
 * 开始把 stderr 镜像进日志文件。
 *
 * 必须在业务开始**之前**调用 —— 之后 stderr 上出现什么就记什么。
 * 没有开成日志文件时是 no-op（照常 stderr 输出，只是没有文件）。
 */
function attach() {
  if (attached || !logPath) {
    return logPath;
  }
  attached = true;
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function patchedStderrWrite(chunk, encoding, callback) {
    try {
      writeChunk(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    } catch (error) {
      // best-effort
    }
    return originalWrite(chunk, encoding, callback);
  };
  return logPath;
}

/** 当前日志文件路径（未开则为 null）。 */
function currentPath() {
  return logPath;
}

module.exports = {
  SECRET_LINE_PATTERN,
  timestamp,
  open,
  attach,
  line,
  currentPath
};
