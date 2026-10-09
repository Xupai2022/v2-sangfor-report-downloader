# -*- coding: utf-8 -*-
"""页清单、token 中文名、重写目标解析。

全部数据来自 `engine.template_slides()`（它返回纯 dict），所以本模块不 import 上游。

重写目标解析的顺序沿用旧编排层的习惯，并做了两处收紧：

    1. 显式 --target-tokens：只接受**精确 token 或精确中文名**，不做模糊匹配
    2. prompt 里出现中文名（includes 判断）
    3. 整页重写关键词（整页/全部/所有）
    4. 都失败 → 抛 SlideNotRewritable，detail 里带可重写页清单供上层展示给用户选

第 1 步不做模糊匹配是刻意的：模糊匹配会在用户打错一个字时**静默改错页面**，
而用户要到打开 PPT 才发现。宁可让他从候选清单里挑。
"""

from . import engine
from .errors import SlideNotFound, SlideNotRewritable, TemplateNotFound, TokenNotFound

# 「整页都改」的触发词。用户说「整页重写」时不必逐个点 token。
WHOLE_SLIDE_KEYWORDS = ("整页", "全部", "所有", "整份", "全文")

# 可重写 = 该页至少有一个 ai_generate 占位符。
# 引擎的 rewrite_single_slide_v2 只回填 ai_generate 的 token（duty_summary 还会
# 额外展开 7 个节日 key），所以没有 AI 位的页重写会得到空结果 —— 提前拦掉。


def template_ids():
    return [entry["template_id"] for entry in engine.list_templates()]


def ensure_template(template_id):
    available = template_ids()
    if template_id not in available:
        raise TemplateNotFound(
            f"模板不存在: {template_id}",
            hint="可用模板: " + ", ".join(available),
            detail={"available": available, "requested": template_id},
        )
    return template_id


def _slides(template_id):
    ensure_template(template_id)
    return engine.template_slides(template_id)


def list_slides(template_id):
    """页清单。每页带占位符构成，供 list-slides 展示与重写目标解析。"""
    rows = []
    for slide in _slides(template_id):
        placeholders = slide["placeholders"]
        ai_tokens = [p["token"] for p in placeholders if p.get("ai_generate")]
        source_tokens = [p["token"] for p in placeholders if p.get("source")]
        chart_tokens = [
            p["token"] for p in placeholders
            if p.get("chart_config") or (p.get("type") or "").startswith("P")
        ]
        rows.append({
            "slide_no": slide["slide_no"],
            "slide_key": slide["slide_key"],
            "title": slide.get("title"),
            "placeholders_total": len(placeholders),
            "ai_tokens": ai_tokens,
            "source_tokens_count": len(source_tokens),
            "chart_tokens_count": len(chart_tokens),
            "rewritable": bool(ai_tokens),
            "ai_cn_names": [
                p.get("cn_name") or p["token"] for p in placeholders if p.get("ai_generate")
            ],
        })
    return rows


def rewritable_slides(template_id):
    return [row for row in list_slides(template_id) if row["rewritable"]]


def find_slide(template_id, slide_ref):
    """按页码（int/数字串）或 slide_key 定位一页。找不到抛 SlideNotFound。"""
    slides = _slides(template_id)
    ref = str(slide_ref).strip()

    if ref.isdigit():
        wanted = int(ref)
        for slide in slides:
            if slide["slide_no"] == wanted:
                return slide
        raise SlideNotFound(
            f"模板 {template_id} 没有第 {ref} 页",
            hint=f"该模板共 {len(slides)} 页",
            detail={"template_id": template_id, "slide_no": wanted, "slides_total": len(slides)},
        )

    for slide in slides:
        if slide["slide_key"] == ref:
            return slide
    raise SlideNotFound(
        f"模板 {template_id} 没有 slide_key={ref} 的页",
        hint="用 `node pipeline.js list-slides --template " + template_id + "` 看页清单",
        detail={"template_id": template_id, "slide_key": ref},
    )


def ai_tokens_of(slide):
    return [p["token"] for p in slide["placeholders"] if p.get("ai_generate")]


def token_alias_map(slide):
    """token → {token, cn_name}，供 --target-tokens 解析用。"""
    out = {}
    for placeholder in slide["placeholders"]:
        token = placeholder["token"]
        out[token] = placeholder.get("cn_name") or token
    return out


def resolve_target_tokens(slide, target_tokens, prompt):
    """决定这次重写要改哪些 token。

    返回 (tokens, how)，how ∈ {explicit, prompt_match, whole_slide, all_ai}。
    - tokens=None 表示「该页全部 AI 位」（引擎自己决定）
    """
    available = ai_tokens_of(slide)
    aliases = token_alias_map(slide)

    if target_tokens:
        resolved = []
        unknown = []
        for raw in target_tokens:
            wanted = str(raw).strip()
            if not wanted:
                continue
            if wanted in aliases:                       # 精确 token
                if wanted in available and wanted not in resolved:
                    resolved.append(wanted)
                continue
            matched = [tok for tok, cn in aliases.items() if cn == wanted and tok in available]
            if matched:
                for tok in matched:
                    if tok not in resolved:
                        resolved.append(tok)
            else:
                unknown.append(wanted)
        if unknown:
            raise TokenNotFound(
                "以下 --target-tokens 在本页找不到对应占位符: " + ", ".join(unknown),
                hint="只接受精确 token 或精确中文名（不做模糊匹配）。本页可用的: "
                     + "; ".join(f"{tok}={aliases[tok]}" for tok in available),
                detail={"unknown": unknown, "available": {tok: aliases[tok] for tok in available}},
            )
        if not resolved:
            raise TokenNotFound(
                "--target-tokens 没有命中本页的 AI 位",
                detail={"available": {tok: aliases[tok] for tok in available}},
            )
        return resolved, "explicit"

    text = str(prompt or "")
    if text:
        hits = []
        for token in available:
            cn = aliases[token]
            if cn and cn in text:
                hits.append(token)
        if hits:
            return hits, "prompt_match"
        if any(keyword in text for keyword in WHOLE_SLIDE_KEYWORDS):
            return available, "whole_slide"

    return available, "all_ai"


def resolve_rewrite_target(template_id, slide_ref, prompt, target_tokens=None):
    """完整解析一次 rewrite 请求。

    返回 {slide_no, slide_key, title, tokens, how, ai_cn_names}。
    该页没有 AI 位时抛 SlideNotRewritable，detail 带候选清单。
    """
    slide = find_slide(template_id, slide_ref)
    available = ai_tokens_of(slide)

    if not available:
        candidates = [
            {"slide_no": row["slide_no"], "slide_key": row["slide_key"],
             "ai_cn_names": row["ai_cn_names"]}
            for row in rewritable_slides(template_id)
        ]
        raise SlideNotRewritable(
            f"第 {slide['slide_no']} 页（{slide['slide_key']}）没有 AI 位，无法重写",
            hint="从 detail.rewritable_slides 里挑一页，用 --slide 指定",
            detail={
                "template_id": template_id,
                "slide_no": slide["slide_no"],
                "slide_key": slide["slide_key"],
                "title": slide.get("title"),
                "rewritable_slides": candidates,
            },
        )

    tokens, how = resolve_target_tokens(slide, target_tokens, prompt)
    return {
        "slide_no": slide["slide_no"],
        "slide_key": slide["slide_key"],
        "title": slide.get("title"),
        "tokens": tokens,
        "how": how,
        "ai_cn_names": [token_alias_map(slide)[token] for token in tokens],
    }
