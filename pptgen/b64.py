# -*- coding: utf-8 -*-
"""跨语言参数传递的 B64 编解码。

线上格式与仓库既有的两个文件**必须完全一致**（`path_helper.js` 的 encodePath、
`scripts/_path_helper.py` 的 decode_arg）：

    'B64:' + base64(utf-8 原文)

为什么把**整个请求**编码，而不是只编码路径：pipeline.js 传给 python 的是一个
含中文客户名、中文 prompt、Windows 绝对路径的 JSON。走裸命令行会被三层撕咬 ——
cmd 的引号规则、GBK 控制台编码、args.js 里「值以 -- 开头就当成布尔」的边角。
整包 B64 一次免疫全部，代价只是 base64 后长一点。

这里刻意**不 import** `scripts/_path_helper.py`：那会给 pptgen 引入一个对
scripts/ 目录布局的依赖，而这个函数只有三行。前缀常量是两边唯一需要同步的东西，
所以在下面单独标出来。
"""

import base64
import json

B64_PREFIX = "B64:"


def decode_arg(value):
    """解一个 B64: 开头的参数；不是则原样返回。与 scripts/_path_helper.py 同语义。"""
    if isinstance(value, str) and value.startswith(B64_PREFIX):
        try:
            return base64.b64decode(value[len(B64_PREFIX):]).decode("utf-8")
        except Exception:
            return value
    return value


def decode_json_arg(value, what="payload"):
    """解 B64 参数并解析成 JSON 对象。

    解析失败时抛出带原文前 200 字的 ValueError —— 这一层的失败几乎都是
    「Node 侧 encodePath 忘了调用」，所以能看到原文比看到 "Expecting value" 有用。
    """
    if value is None:
        raise ValueError(f"缺少 {what} 参数")
    raw = decode_arg(value)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        preview = raw[:200] if isinstance(raw, str) else repr(raw)[:200]
        raise ValueError(f"{what} 不是合法 JSON（{exc}）；原文前 200 字：{preview}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{what} 解析结果应为对象，实际是 {type(parsed).__name__}")
    return parsed


def encode_arg(value):
    """反向：给需要在命令行里回传的场景用（主要是测试）。"""
    return B64_PREFIX + base64.b64encode(value.encode("utf-8")).decode("ascii")
