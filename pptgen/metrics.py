# -*- coding: utf-8 -*-
"""占位符取值分类与产物自检。

存在的理由：**这套分类只能有一份**。doctor 的数据指纹与 generate 的汇总 JSON
如果各自数一遍，两者迟早会因为一处改了而给出互相矛盾的数 —— 那时候
「指纹变了」到底是上游变了、还是我们自己数变了，就分不清了。

三种「看起来有值、其实不是业务数据」的情况必须分开报，不能合成一个
「已填充」：

    印「失败」    source 取不到值 → 引擎 _format_value(None) 回落到 default="失败"
    模板字面量    值来自 Excel 单元格，但单元格里是模板原文（手写 / 分布N / xx公司）
    空            P37 那类 group 槽位，取不到就留空串，渲染时删框

把它们合成一个数，读者会以为「大部分格子有数据」。分开报才不会。
"""

import re
import zipfile
from pathlib import Path

# 引擎 _format_value 对 None 的回落值（descriptor 里 165 处 default 都是它）。
# 这是「取不到值」的判据 —— 不是我们加的哨兵，是引擎自己的行为。
FAIL_SENTINEL = "失败"

# 模板原文被当作值读回来的情况。`手写` 是模板里人手填字的位置；
# `分布N` 是没接上的分布图标签；`xx公司` 是封面客户名。
LITERAL_EXACT = ("手写", "xx公司")
LITERAL_PREFIX = ("分布",)

# 引擎里表示「AI 生成」的占位符 / 图表占位符的判据（与 descriptor 字段一致）。
CHART_TYPE_PREFIX = "P"


def classify(value):
    """→ 'fail' | 'literal' | 'empty' | 'value'"""
    if value is None:
        return "empty"
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return "empty"
        if stripped == FAIL_SENTINEL:
            return "fail"
        if stripped in LITERAL_EXACT or stripped.startswith(LITERAL_PREFIX):
            return "literal"
    return "value"


def placeholder_kind(definition):
    """descriptor 里一个占位符定义 → 它的类别。

    顺序有讲究：group 与 chart 的判据比 ai/source 更具体，先判它们；
    引擎 660 行的解析也是这样分叉的（chart → table → group → default → source）。
    """
    if definition.get("group_index") is not None:
        return "group"
    if definition.get("chart_config") or str(definition.get("type") or "").startswith(CHART_TYPE_PREFIX):
        return "chart"
    if definition.get("ai_generate"):
        return "ai"
    if definition.get("source"):
        return "source"
    return "other"


def summarize_spec(spec, template_id, definitions=None):
    """把一份 SlideSpec 数成可比较、可展示的计数。

    definitions 传 engine.template_slides(template_id) 的页定义时，会额外给出
    「这页本来该有几个 AI 位 / source 位」。不传就只按取值分类数。
    """
    kind_of_token = {}
    if definitions:
        for slide in definitions:
            for definition in slide["placeholders"]:
                kind_of_token[(slide["slide_no"], definition["token"])] = placeholder_kind(definition)

    counts = {
        "slides_total": len(spec.slides),
        "slides_with_placeholders": 0,
        "placeholders_total": 0,
        "print_fail": 0,
        "template_literals": 0,
        "empty_values": 0,
        "other_values": 0,
        "ai_generated": 0,
        "by_kind": {"source": 0, "ai": 0, "chart": 0, "group": 0, "other": 0},
    }
    # 只有 source 位才能谈「有没有从 Excel 取到值」
    resolved_from_excel = 0
    missing_sources = 0
    chart_unresolved = 0

    for slide in spec.slides:
        if slide.placeholders:
            counts["slides_with_placeholders"] += 1
        for token, value in slide.placeholders.items():
            counts["placeholders_total"] += 1
            kind = kind_of_token.get((slide.slide_no, token))
            if kind is None:
                kind = "ai" if isinstance(value, str) and value.startswith("[") else "other"
            counts["by_kind"][kind] = counts["by_kind"].get(kind, 0) + 1

            bucket = classify(value)
            if bucket == "fail":
                counts["print_fail"] += 1
                if kind == "source":
                    missing_sources += 1
                if kind == "chart":
                    chart_unresolved += 1
                continue
            if bucket == "literal":
                counts["template_literals"] += 1
                if kind == "source":
                    resolved_from_excel += 1
                continue
            if bucket == "empty":
                counts["empty_values"] += 1
                continue

            counts["other_values"] += 1
            if kind == "ai":
                counts["ai_generated"] += 1
            elif kind == "source":
                resolved_from_excel += 1

    counts["source_placeholders"] = counts["by_kind"].get("source", 0)
    counts["resolved_from_excel"] = resolved_from_excel
    counts["missing_sources_count"] = missing_sources
    counts["chart_unresolved"] = chart_unresolved
    # resolved_from_excel 里有多少其实是模板原文。两个数一起看才不会被误导。
    counts["resolved_but_literal"] = min(counts["template_literals"], resolved_from_excel)
    return counts


def count_leaves(node):
    """raw dict 的叶子数。上游改了 excel_handler 的单元格映射时这个数会变。"""
    if isinstance(node, dict):
        return sum(count_leaves(value) for value in node.values())
    if isinstance(node, list):
        return sum(count_leaves(value) for value in node)
    return 1


def tokens_in_pptx(pptx_path):
    """{slide_no: [token]} —— 渲染产物里**没被替换掉**的 {{...}}。

    只取 <a:t> 里的文本再匹配。不能对裸 XML 跑正则：PowerPoint 会把一个
    {{token}} 拆进多个 <a:r> run，裸正则于是跨标签匹配到一堆 XML 属性，
    得出满屏假 token（实测过）。

    这是全链路唯一的「成品自检」：它读的是真产物，不是中间状态。
    非空就说明 descriptor 漏声明了 token —— 那些 {{...}} 会原样印在成片上。
    """
    found = {}
    pptx_path = Path(pptx_path)
    if not pptx_path.exists():
        return found
    with zipfile.ZipFile(pptx_path) as archive:
        for name in archive.namelist():
            match = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name)
            if not match:
                continue
            xml = archive.read(name).decode("utf-8", errors="replace")
            text = "".join(re.findall(r"<a:t>(.*?)</a:t>", xml, re.S))
            tokens = sorted(set(re.findall(r"\{\{([^{}]+)\}\}", text)))
            if tokens:
                found[int(match.group(1))] = tokens
    return found
