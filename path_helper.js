'use strict';

/**
 * 路径编解码工具，解决 Windows 命令行中文字符乱码问题。
 * 配合 scripts/_path_helper.py 使用，在传递包含中文的路径时进行 base64 编码。
 *
 * 两个前缀，别混：
 *   B64:    —— 单个路径 / 短字符串（encodePath）
 *   B64GZ:  —— JSON payload（encodePayload）
 *
 * 为什么 payload 要多一层 gzip：**Windows 命令行上限 32767 字符**，超过时 Node 的
 * execFile 会同步抛 `spawn ENAMETOOLONG`（stderr 为空，日志里只剩这一句裸消息，
 * 完全看不出是哪一步）。2026-10-29 实测：UTF8 base64 之后，一整份「数据统计」写入
 * 计划 + 7 张表元数据正好压在 32K 线上 —— 报告期一变、多解析出十几格，就随机翻车。
 * 纯 ASCII 的 JSON 压一遍通常只剩 1/5 ~ 1/8，离上限远得很。
 */

const zlib = require('node:zlib');

function encodePath(p) {
  if (typeof p !== 'string') return p;
  return 'B64:' + Buffer.from(p, 'utf8').toString('base64');
}

/**
 * JSON payload 的编码（'B64GZ:' + base64(gzip(utf8))）。
 *
 * 口径与 scripts/_path_helper.py、pptgen/b64.py 的 decode_arg 逐字一致 ——
 * 三个文件里这个前缀字符串必须同步改，别只改一边。
 *
 * @param {*} payload 对象或字符串
 */
function encodePayload(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return 'B64GZ:' + zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

module.exports = { encodePath, encodePayload };
