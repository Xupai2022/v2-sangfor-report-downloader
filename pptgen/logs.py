# -*- coding: utf-8 -*-
"""日志。

一条硬规则：**stdout 只留给最终的 JSON**，诊断信息一律走 stderr。

理由：pipeline.js 要靠 stdout 的一个 JSON 对象判断成败并回传 pptx 路径。
引擎内部有大量 logger.warning（图表取不到数据之类），如果它们漏进 stdout，
Node 侧 JSON.parse 会直接炸，而那时候产物其实已经生成好了 —— 最坏的失败方式。
所以这里把 root logger 绑到 stderr，并把 level 收紧到 WARNING，
让「引擎跑了什么」在需要时能看见，平时不淹没输出。
"""

import logging
import os
import sys

_CONFIGURED = False


def setup(verbose=False):
    """把 root logger 绑到 stderr。重复调用无副作用。"""
    global _CONFIGURED
    if _CONFIGURED:
        return

    level = logging.DEBUG if verbose else logging.WARNING
    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))

    root = logging.getLogger()
    # 清掉可能已由第三方库（或引擎的 logging_config）装上的 handler，
    # 否则同一行日志会出现两次。
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    # 引擎里逐请求刷屏的库，静音到 WARNING 以上。
    for noisy in ("httpx", "httpcore", "openai", "urllib3", "PIL", "matplotlib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Windows 控制台默认 GBK，中文日志会 UnicodeEncodeError。
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass

    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    _CONFIGURED = True


def get_logger(name):
    return logging.getLogger(name)
