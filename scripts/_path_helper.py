#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
路径编解码工具，解决 Windows 命令行中文字符乱码问题。

用法：
    from _path_helper import decode_argv
    decode_argv()  # 在 main() 开头调用，自动解码所有 sys.argv

两个前缀（与 path_helper.js / pptgen/b64.py 逐字一致）：
    B64:    base64(utf-8 原文)              —— 单个路径 / 短字符串
    B64GZ:  base64(gzip(utf-8 原文))        —— JSON payload

为什么 payload 要多一层 gzip：Windows 命令行上限 32767 字符，超了 Node 的 execFile
会同步抛 ``spawn ENAMETOOLONG``（stderr 为空，日志里只有一句裸消息）。2026-10-29 实测
「数据统计」写入计划 base64 后正好压在 32K 线上，报告期一变就随机挂掉。压缩后大约
只剩 1/5 ~ 1/8，离上限远得很。
"""
import base64
import gzip
import sys

B64_PREFIX = 'B64:'
B64GZ_PREFIX = 'B64GZ:'


def decode_arg(arg):
    if arg.startswith(B64GZ_PREFIX):
        try:
            return gzip.decompress(
                base64.b64decode(arg[len(B64GZ_PREFIX):])).decode('utf-8')
        except Exception:
            return arg
    if arg.startswith(B64_PREFIX):
        try:
            return base64.b64decode(arg[len(B64_PREFIX):]).decode('utf-8')
        except Exception:
            return arg
    return arg


def decode_argv():
    """原地解码 sys.argv 中的所有条目。"""
    for i in range(1, len(sys.argv)):
        sys.argv[i] = decode_arg(sys.argv[i])


def reset_read_only_dimensions(sheet):
    """Ignore an incorrect XLSX ``dimension`` value in openpyxl read-only mode.

    Some MSSW exports declare ``<dimension ref="A1"/>`` even though their
    worksheet XML contains the complete table.  openpyxl otherwise truncates
    iteration to A1 when reading these files in streaming mode.
    """
    reset = getattr(sheet, 'reset_dimensions', None)
    if callable(reset):
        reset()
    return sheet
