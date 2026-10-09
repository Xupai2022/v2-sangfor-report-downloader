# -*- coding: utf-8 -*-
"""rewrite 编排：按页重写 AI 位，另存一份 pptx。

    load_spec      读 run 目录的 slidespec.json（当前状态，可叠加）
    rewrite_slide  调引擎重写该页的 AI 位
    写回           只覆盖引擎返回的 token（它只回 ai_generate 的那些）
    审记快照       slidespec.P{n}.{ts}.json
    render         另存新文件 {原成片词干}_重写版_P{n}.pptx

三条必须知道的行为（都不是 bug，是引擎的既定行为）：

1. `render()` 是**从模板 pptx 全量重放**：先 unlink 目标再另存。所以
   - 重写版必须另存新文件，否则会把原稿覆盖掉
   - 用户在 PowerPoint 里手改过的排版会全部丢失（与线上服务行为一致）
2. `render()` 只读模板 + slidespec、不改 slidespec，所以同一份 slidespec 重渲幂等。
3. 重写**不重跑 Excel 抽取**（除非显式给 --excel）：tenant_input 从 run 目录的
   input.json 读回来。这样「改一页文案」不必重新下载、重新解析 Excel。

入参解析顺序（`templates.resolve_rewrite_target`）与旧编排层一致，但收紧了：
--target-tokens 只接受精确 token 或精确中文名，不做模糊匹配 —— 模糊匹配会在
用户打错一个字时**静默改错页面**。
"""

import time
from pathlib import Path

from . import bootstrap, engine, errors, generate, input as input_mod, logs, metrics, paths, templates

logger = logs.get_logger("pptgen.rewrite")


def _resolve_run_dir(run_dir, slidespec):
    """三级定位：--slidespec（文件） → --run-dir（目录） → outputs/latest.json。"""
    if slidespec:
        path = Path(slidespec)
        if not path.exists():
            raise errors.BadRequest(f"--slidespec 指向的文件不存在: {path}")
        return path.parent, path

    if run_dir:
        directory = Path(run_dir)
        path = directory / "slidespec.json"
        if not path.exists():
            raise errors.BadRequest(
                f"--run-dir 里没有 slidespec.json: {directory}",
                hint="该目录不是 generate 的产物目录",
            )
        return directory, path

    latest = paths.read_latest()
    if not latest:
        raise errors.BadRequest(
            "找不到「最近一次生成」",
            hint="先跑 `node pipeline.js generate ...`，或用 --run-dir / --slidespec 指定",
            detail={"latest_pointer": str(paths.LATEST_POINTER)},
        )
    directory = Path(latest["run_dir"])
    path = directory / "slidespec.json"
    if not path.exists():
        raise errors.BadRequest(
            f"latest.json 指向的目录里没有 slidespec.json: {directory}",
            hint="该目录可能被清理了；重新跑 generate",
            detail={"latest": latest},
        )
    return directory, path


def _load_tenant_input(run_dir, excel_path, template_id, customer, start, end, cover_override):
    """构造 TenantInput。

    优先复用 generate 落下的 input.json —— 重写一页文案不该重跑 Excel 解析，
    更不该因为 Excel 变了就让同一份 slidespec 的上下文漂移。
    """
    if excel_path:
        tenant_input, raw, info = input_mod.build_tenant_input(
            Path(excel_path), template_id,
            customer=customer, start=start, end=end, cover_override=cover_override,
        )
        return tenant_input, {"source": "excel", "excel_path": str(excel_path),
                              "cover_source": info["cover_source"]}

    payload = input_mod.load_input_json(run_dir)
    if not payload:
        raise errors.BadRequest(
            f"run 目录里没有 {input_mod.INPUT_JSON_NAME}，无法构造引擎入参",
            hint="用 --excel 指定一份 *_report.xlsx，或重新跑 generate",
            detail={"run_dir": str(run_dir)},
        )
    if payload.get("template_id") != template_id:
        raise errors.BadRequest(
            f"input.json 的模板是 {payload.get('template_id')}，与请求的 {template_id} 不一致",
            hint="别混用不同模板的中间产物",
            detail={"run_dir": str(run_dir)},
        )
    return engine.build_input(payload["raw"]), {
        "source": "input_json",
        "input_json": str(Path(run_dir) / input_mod.INPUT_JSON_NAME),
        "cover_source": (payload.get("cover_override") or {}).get("cover_source", "excel"),
    }


def _pptx_stem(run_dir):
    """重写版文件名的基 = 原成片的词干。三级：input.json 记的 → 源 Excel 重算 → "report"。

    generate 当时把 `naming.pptx_stem` 记进了 input.json，这就是正常路径；
    只有 run 目录是旧布局留下的（那时还没有这条路）才会落到第二、三级。
    第三级宁可给一个通用的 "report" 也不拿目录名当客户名 —— 目录名现在是纯时间戳，
    当文件名用只会得到一串看起来像乱码的东西。
    """
    stem = input_mod.pptx_stem_from_input_json(run_dir)
    if stem:
        return stem, "input_json"
    return "report", "fallback"


def run(slide_ref, prompt, template_id, target_tokens=None, run_dir=None, slidespec=None,
        excel_path=None, customer=None, start=None, end=None, cover_override=True,
        verbose=False):
    logs.setup(verbose)
    started = time.time()
    timings = {}

    # LLM 前置检查。引擎的 rewrite_single_slide_v2 **没有** enable_llm 守卫，
    # 禁用时会走到 _call_openai_with_retry 抛错、再被当格式错重试 5 次，
    # 最终文案是 "check model output format" —— 完全误导。所以在这里拦掉。
    snapshot = engine.settings_snapshot()
    if not snapshot["enable_llm"]:
        raise errors.LlmDisabled(
            "ENABLE_LLM=false，无法重写（重写必须走 LLM，没有 mock 路径）",
            hint="把 .env.ppt 的 ENABLE_LLM 设为 true；"
                 f"若缺 .env.ppt：{bootstrap.env_hint()}",
            detail={"env_path": str(paths.ENV_FILE), "api_key_set": snapshot["api_key_set"]},
        )
    if not snapshot["api_key_set"]:
        raise errors.LlmEnvMissing(
            "ENABLE_LLM=true 但 OPENAI_API_KEY 为空", hint=bootstrap.env_hint()
        )

    templates.ensure_template(template_id)
    resolved_dir, slidespec_path = _resolve_run_dir(run_dir, slidespec)

    # 目标解析（含「该页没有 AI 位」的候选清单）
    target = templates.resolve_rewrite_target(template_id, slide_ref, prompt, target_tokens)
    logger.info("重写目标: P%s %s，token=%s（%s）",
                target["slide_no"], target["slide_key"], target["tokens"], target["how"])

    spec = engine.load_spec(slidespec_path)
    if engine.spec_template_id(spec) != template_id:
        raise errors.BadRequest(
            f"slidespec 的模板是 {engine.spec_template_id(spec)}，与请求的 {template_id} 不一致",
            detail={"slidespec": str(slidespec_path), "template_id": template_id},
        )

    current = engine.spec_placeholder_values(spec, target["slide_key"])
    if current is None:
        raise errors.SlideNotFound(
            f"slidespec 里没有 page={target['slide_key']}",
            hint="slidespec 与模板可能不同版本；重新跑 generate",
            detail={"slidespec": str(slidespec_path)},
        )

    tenant_input, input_info = _load_tenant_input(
        resolved_dir, excel_path, template_id, customer, start, end, cover_override
    )

    # --- 调用引擎 ---
    marker = time.time()
    result = engine.rewrite_slide(
        tenant_input=tenant_input,
        template_id=template_id,
        slide_key=target["slide_key"],
        user_prompt=prompt,
        current_slide_content=current,
        target_tokens=target["tokens"],
    )
    timings["llm_ms"] = int((time.time() - marker) * 1000)

    rewritten = result.get("placeholders") or {}
    # 引擎只返回该页 ai_generate 的 token（duty_summary 会额外展开节日 key），
    # 所以这一步不可能误改 Excel 数据位。
    applied = {}
    for token, value in rewritten.items():
        engine.spec_set_placeholder(spec, target["slide_key"], token, value)
        applied[token] = value

    # --- 落盘：当前状态可叠加，另存审记快照 ---
    engine.save_spec(spec, slidespec_path)
    stamp = paths.timestamp()
    snapshot_path = slidespec_path.with_name(f"slidespec.P{target['slide_no']}.{stamp}.json")
    engine.save_spec(spec, snapshot_path)

    # --- 渲染：必须另存新文件 ---
    marker = time.time()
    pptx_stem, stem_source = _pptx_stem(resolved_dir)
    out_name = paths.rewrite_pptx_name(pptx_stem, target["slide_no"])
    pptx_path = resolved_dir / out_name
    # 旧文件的 unlink 由 engine.render 内部统一处理（占用时给 output_locked 而不是 WinError 32）
    engine.render(spec, pptx_path)
    timings["render_ms"] = int((time.time() - marker) * 1000)

    leftover = metrics.tokens_in_pptx(pptx_path)
    warnings = list(result.get("warnings") or [])
    if result.get("missing_tokens"):
        warnings.append(f"引擎报告未生成的 token: {result['missing_tokens']}")
    if leftover:
        flat = ", ".join(f"P{no}:{','.join(tokens)}" for no, tokens in sorted(leftover.items()))
        warnings.append(f"成片上有未替换的占位符: {flat}")

    timings["total_ms"] = int((time.time() - started) * 1000)

    summary = {
        "ok": True,
        "command": "rewrite",
        "template_id": template_id,
        "slide_no": target["slide_no"],
        "slide_key": target["slide_key"],
        "slide_title": target["title"],
        "target_how": target["how"],
        "requested_tokens": target["tokens"],
        "requested_cn_names": target["ai_cn_names"],
        "updated_tokens": sorted(applied.keys()),
        "updated_count": len(applied),
        "values_preview": {
            token: (str(value)[:120]) for token, value in list(applied.items())[:8]
        },
        "run_dir": str(resolved_dir),
        "slidespec_path": str(slidespec_path),
        "slidespec_snapshot_path": str(snapshot_path),
        "pptx_path": str(pptx_path),
        "pptx_bytes": pptx_path.stat().st_size,
        "output_name_source": stem_source,
        "leftover_tokens": {str(no): tokens for no, tokens in sorted(leftover.items())},
        "input_source": input_info,
        "llm": {
            "enabled": True,
            "model": snapshot["openai_model"],
            "base_url": snapshot["openai_base_url"],
        },
        "warnings": warnings,
        "timings": timings,
    }

    paths.update_latest_rewrites({
        "at": paths.now_iso(),
        "slide_no": target["slide_no"],
        "slide_key": target["slide_key"],
        "updated_tokens": summary["updated_tokens"],
        "pptx_path": str(pptx_path),
    })

    generate.append_manifest(resolved_dir, {
        "action": "rewrite",
        "at": paths.now_iso(),
        "slide_no": target["slide_no"],
        "slide_key": target["slide_key"],
        "prompt": prompt,
        "requested_tokens": target["tokens"],
        "target_how": target["how"],
        "updated_tokens": summary["updated_tokens"],
        "pptx_path": str(pptx_path),
        "slidespec_snapshot": str(snapshot_path),
        "timings": timings,
    })

    return summary

