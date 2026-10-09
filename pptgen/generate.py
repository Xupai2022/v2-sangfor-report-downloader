# -*- coding: utf-8 -*-
"""generate 编排：Excel → slidespec → pptx。

顺序是固定的，每一步的产物都落盘，因为后一步（以及 rewrite）要复用它们：

    extract       Excel → raw dict
    build_input   raw + 封面/周期覆盖 → TenantInput          → input.json
    generate_spec TenantInput → SlideSpec                     → slidespec.json
                                                              → slidespec.original.json
    render        SlideSpec → pptx                            → {Excel词干}_{模板}.pptx

两条硬规则：

1. **LLM 未启用时不假装成功。** ENABLE_LLM=false 或 .env.ppt 缺失时，
   如果用户没显式给 --mock，这里直接报 llm_disabled / llm_env_missing 并退出 3。
   静默降级成 mock 会产出「AI 位写着 [token: AI generated content]」的 PPT ——
   它长得像成功，会被当成成品发出去。
2. **产物自检进汇总。** render 之后立刻扫一遍成片里还没被替换的 {{token}}。
   它是全链路唯一读真产物的检查，也是上游 descriptor 漏声明 token 时唯一的报警点
   （实测 plus.pptx 的 P40 就有这个情况）。
"""

import time
from pathlib import Path

from . import bootstrap, engine, errors, input as input_mod, logs, metrics, paths, templates

logger = logs.get_logger("pptgen.generate")

SLIDESPEC_NAME = "slidespec.json"
SLIDESPEC_ORIGINAL_NAME = "slidespec.original.json"
MANIFEST_NAME = "manifest.json"


def _guard_llm(mock, require_llm):
    """在真正调用引擎之前判清楚 LLM 状态。

    放在这里而不是等引擎抛，是因为引擎在这条路上的报错极具误导性：
    ENABLE_LLM=false 时 generate_slidespec_v2 会去建 client、抛 LLMGenerationError，
    而它会被 _call_and_parse_with_retry 当成「模型输出格式错」重试 5 次，
    最后抛出来的话术是 "check model output format"。
    """
    snapshot = engine.settings_snapshot()
    env_missing = bootstrap.env_missing

    if mock:
        return {"enabled": snapshot["enable_llm"], "used_mock": True,
                "model": snapshot["openai_model"], "env_missing": env_missing,
                "base_url": snapshot["openai_base_url"]}

    if env_missing:
        raise errors.LlmEnvMissing(
            ".env.ppt 不存在，无法做真实生成；而 mock 产物会被误当成成品",
            hint=f"{bootstrap.env_hint()}；只想验证渲染链路就显式加 --mock",
            detail={"env_path": str(paths.ENV_FILE)},
        )

    if not snapshot["enable_llm"]:
        raise errors.LlmDisabled(
            "ENABLE_LLM=false，无法生成 AI 位；而 mock 产物会被误当成成品",
            hint="把 .env.ppt 的 ENABLE_LLM 设为 true，或显式加 --mock 只验证渲染链路",
            detail={"env_path": str(paths.ENV_FILE)},
        )

    if require_llm and not snapshot["api_key_set"]:
        raise errors.LlmEnvMissing(
            "OPENAI_API_KEY 为空（--require-llm）",
            hint=bootstrap.env_hint(),
        )

    return {"enabled": True, "used_mock": False,
            "model": snapshot["openai_model"], "env_missing": False,
            "base_url": snapshot["openai_base_url"]}


def _holds_previous_run(target_dir):
    """目录里是否已经有一次 pptgen 运行的产物。

    判据只用**我们自己的产物**，不是「目录非空」—— 因为 Excel 也落在这个目录里：
    下载步骤先把 `{客户}_report.xlsx` 放进来，然后才轮到 pptgen。按「非空」判的话，
    每一次真实下载都会撞上 run_dir_conflict（实测踩过：`--excel` 冒烟能过，
    因为那条路 Excel 在目录外，把 bug 藏住了）。
    """
    return any((target_dir / name).exists() for name in (
        SLIDESPEC_NAME, SLIDESPEC_ORIGINAL_NAME, MANIFEST_NAME, input_mod.INPUT_JSON_NAME,
    ))


def _resolve_run_dir(run_dir, force):
    """定位 run 目录。

    `--run-dir` 是「就用这个目录」；不给就由 paths.new_run_dir() 新铸一个
    `outputs/{时间}`。所以**重复跑 generate 不再撞车** —— 每次都是新目录，
    上一次运行的产物原样留着（这才符合「名字就是时间」的语义）。

    撞车只可能发生在显式 `--run-dir` 指向一个**已有上次运行产物**的目录时
    （pipeline.js 传的是它刚铸好的新目录，所以那条路不会撞）。这时不覆盖的理由：
    slidespec.json 是后续 rewrite 的输入，静默覆盖会让「刚重写完的几页」在下次
    generate 时无声消失，而用户以为只是重新生成了一遍。
    """
    target = Path(run_dir) if run_dir else paths.new_run_dir()
    if run_dir and _holds_previous_run(target) and not force:
        raise errors.RunDirConflict(
            f"--run-dir 指向的目录里已有一次运行的产物（slidespec/input/manifest）: {target}",
            hint="加 --force 覆盖它，或换个新目录，或干脆不传 --run-dir（默认每次新铸一个时间目录）；"
                 "重写已生成的 PPT 请用 `rewrite` 子命令（它会保留原稿）",
            detail={"run_dir": str(target)},
        )
    target.mkdir(parents=True, exist_ok=True)
    return target


def append_manifest(run_dir, entry):
    manifest_path = run_dir / MANIFEST_NAME
    if manifest_path.exists():
        try:
            payload = paths.read_json(manifest_path)
            history = payload.get("history") or []
        except (ValueError, OSError):
            history = []
    else:
        history = []
    history.append(entry)
    paths.write_json_atomic(manifest_path, {"history": history, "updated_at": paths.now_iso()})
    return manifest_path


def run(excel_path, template_id, customer=None, start=None, end=None,
        business_systems=None, mock=False, cover_override=True, force=False,
        run_dir=None, require_llm=False, focus_options=None, verbose=False):
    logs.setup(verbose)
    started = time.time()
    timings = {}

    templates.ensure_template(template_id)
    excel_path = Path(excel_path)
    if not excel_path.exists():
        raise errors.ExcelNotFound(
            f"Excel 不存在: {excel_path}",
            hint="先跑 `node pipeline.js generate --customer ... --cookie-path ...` 下载生成，"
                 "或把已有的 *_report.xlsx 路径传给 --excel",
            detail={"excel": str(excel_path)},
        )

    llm_info = _guard_llm(mock, require_llm)
    target_dir = _resolve_run_dir(run_dir, force)

    # 成片名 = 源 Excel 的词干 + 模板（上游 report_service 的 {input_id}_{template_id}）。
    # 先算出来是因为它要记进 input.json —— rewrite 靠它给重写版起名。
    pptx_name = paths.report_pptx_name(excel_path.stem, template_id)
    naming = {
        "excel_path": str(excel_path),
        "excel_stem": excel_path.stem,
        "pptx_name": pptx_name,
        "pptx_stem": Path(pptx_name).stem,
    }

    if bootstrap.env_missing:
        logger.warning(
            ".env.ppt 不存在（%s）。当前用 mock 值填充 AI 位，产物不是真实生成内容。",
            paths.ENV_FILE,
        )

    # --- 1. Excel → 入参 ---
    marker = time.time()
    tenant_input, raw, cover_info = input_mod.build_tenant_input(
        excel_path, template_id,
        customer=customer, start=start, end=end,
        business_systems=business_systems, cover_override=cover_override,
    )
    timings["extract_ms"] = int((time.time() - marker) * 1000)
    input_json_path = input_mod.save_input_json(
        target_dir, raw, template_id, cover_info, naming=naming
    )
    logger.info("入参已落盘: %s", input_json_path)

    # --- 2. 生成 slidespec ---
    marker = time.time()
    spec = engine.generate_spec(tenant_input, template_id, mock=mock, focus_options=focus_options)
    timings["llm_ms"] = int((time.time() - marker) * 1000)

    slidespec_path = target_dir / SLIDESPEC_NAME
    engine.save_spec(spec, slidespec_path)
    original_path = target_dir / SLIDESPEC_ORIGINAL_NAME
    engine.save_spec(spec, original_path)

    # --- 3. 渲染 ---
    marker = time.time()
    pptx_path = target_dir / pptx_name
    # 旧的 unlink 交给 engine.render 内部的 remove_stale_output ——
    # 这里再删一遍就绕过了它对「被 PowerPoint 占用」的翻译（实测踩过）。
    engine.render(spec, pptx_path)
    timings["render_ms"] = int((time.time() - marker) * 1000)

    # --- 4. 产物自检 + 计数 ---
    definitions = engine.template_slides(template_id)
    summary = metrics.summarize_spec(spec, template_id, definitions)
    leftover = metrics.tokens_in_pptx(pptx_path)

    # 成片上残留的 {{token}} 有两种成因，报成一句会误导人（实测踩过）：
    #   declared  —— descriptor 声明了它（图表位），但图表数据取不到，
    #                渲染时 no-op，模板里的占位符文本原样留下
    #   undeclared—— descriptor 根本没有这个 token（模板自带的残留，永远替换不了）
    declared_kind = {
        (slide["slide_no"], definition["token"]): metrics.placeholder_kind(definition)
        for slide in definitions
        for definition in slide["placeholders"]
    }
    leftover_declared, leftover_undeclared = {}, {}
    for slide_no, tokens in leftover.items():
        for token in tokens:
            bucket = leftover_declared if (slide_no, token) in declared_kind else leftover_undeclared
            bucket.setdefault(slide_no, []).append(token)

    warnings = []
    if leftover_undeclared:
        flat = ", ".join(f"P{no}:{','.join(tk)}" for no, tk in sorted(leftover_undeclared.items()))
        warnings.append(
            f"成片上有 descriptor **未声明**的模板 token，引擎永远不会替换它们: {flat}"
        )
    if leftover_declared:
        flat = ", ".join(f"P{no}:{','.join(tk)}" for no, tk in sorted(leftover_declared.items()))
        kinds = sorted({declared_kind[(no, token)]
                        for no, tokens in leftover_declared.items() for token in tokens})
        warnings.append(
            f"{sum(len(v) for v in leftover_declared.values())} 个已声明的占位符没渲染出来"
            f"（类别 {','.join(kinds)}）—— 数据取不到时渲染器整段 no-op，"
            f"成片保留模板自带示例图并留下占位符文本: {flat}"
        )
    if cover_info["cover_overridden"]:
        warnings.append(
            "封面/周期已用 CLI 入参在内存中覆盖（未写回 Excel）: "
            + ", ".join(f"{o['path']}={o['to']}" for o in cover_info["overlays"])
        )
    if not cover_info["cover_overridden"]:
        warnings.append(
            "封面客户名与统计周期取自 Excel 原文（未传 --customer/--start/--end）："
            "下载路径下写入层已按 CLI 写好 J1/L1/M1，但 --excel 指向的工作簿可能是模板原文，"
            "成片封面会显示「xx公司」与模板周期。加 --customer/--start/--end 可覆盖"
        )
    if summary["missing_sources_count"]:
        warnings.append(
            f"{summary['missing_sources_count']} 个 source 位取不到值，成片会印「失败」"
            "（引擎 _format_value 对 None 的回落值），按约定不做清洗"
        )
    if summary["resolved_but_literal"]:
        warnings.append(
            f"{summary['resolved_but_literal']} 个格子取到的是模板原文"
            "（手写 / 分布N / xx公司），不是业务数据"
        )
    if summary["chart_unresolved"]:
        warnings.append(
            f"{summary['chart_unresolved']} 个图表位取不到数据，成片保留模板自带示例图"
        )

    timings["total_ms"] = int((time.time() - started) * 1000)

    result = {
        "ok": True,
        "command": "generate",
        "template_id": template_id,
        "run_dir": str(target_dir),
        "excel_path": str(excel_path),
        "input_json_path": str(input_json_path),
        "slidespec_path": str(slidespec_path),
        "slidespec_original_path": str(original_path),
        "pptx_path": str(pptx_path),
        "pptx_name": pptx_name,
        "pptx_bytes": pptx_path.stat().st_size,
        "slides_total": summary["slides_total"],
        "slides_with_placeholders": summary["slides_with_placeholders"],
        "placeholders_total": summary["placeholders_total"],
        "by_kind": summary["by_kind"],
        "resolved_from_excel": summary["resolved_from_excel"],
        "missing_sources_count": summary["missing_sources_count"],
        "template_literal_count": summary["template_literals"],
        "empty_values": summary["empty_values"],
        "ai_generated_count": summary["ai_generated"],
        "chart_unresolved": summary["chart_unresolved"],
        "leftover_tokens": {str(no): tokens for no, tokens in sorted(leftover.items())},
        "leftover_declared_tokens": {str(no): tk for no, tk in sorted(leftover_declared.items())},
        "leftover_undeclared_tokens": {str(no): tk for no, tk in sorted(leftover_undeclared.items())},
        "cover_source": cover_info["cover_source"],
        "cover_overlays": cover_info["overlays"],
        "focus_options": list(focus_options or []),
        "llm": llm_info,
        "warnings": warnings,
        "timings": timings,
    }

    # latest.json 无条件写：它是「最近一次生成」的指针，而一次不带起止日期的
    # generate（--excel 验收用）同样是一次生成。以前按 start/end 门控，导致
    # 那条路径跑完之后 裸 `rewrite --slide N` 找不到产物，报的却是「先跑 generate」。
    latest = {
        "run_dir": str(target_dir),
        "customer": customer,
        "start": start,
        "end": end,
        "template_id": template_id,
        "excel_path": str(excel_path),
        "pptx_name": pptx_name,
        "pptx_path": str(pptx_path),
        "slidespec_path": str(slidespec_path),
        "generated_at": paths.now_iso(),
        "rewrites": [],
    }
    paths.write_latest(latest)
    result["latest_pointer"] = str(paths.LATEST_POINTER)

    append_manifest(target_dir, {
        "action": "generate",
        "at": paths.now_iso(),
        "template_id": template_id,
        "excel_path": str(excel_path),
        "mock": bool(mock),
        "cover_overlays": cover_info["overlays"],
        "pptx_path": str(pptx_path),
        "pptx_name": pptx_name,
        "counts": {
            key: summary[key] for key in (
                "slides_total", "placeholders_total", "print_fail",
                "template_literals", "empty_values", "ai_generated",
            )
        },
        "leftover_tokens": result["leftover_tokens"],
        "leftover_declared_tokens": result["leftover_declared_tokens"],
        "leftover_undeclared_tokens": result["leftover_undeclared_tokens"],
        "timings": timings,
    })

    return result
