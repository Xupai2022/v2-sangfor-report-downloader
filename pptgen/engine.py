# -*- coding: utf-8 -*-
"""★ 全仓库唯一 import `mss_ai_ppt_sample_assets.*` 的文件。

这一层的存在就是「解耦面」本身。上游改了服务之后，本仓库要改的代码只可能在
这个文件里；`pptgen/` 其余模块只认这里暴露的函数，不认上游的类名。

上游 7 个符号 → 我们 11 个函数：

    ExcelDataExtractor.extract_data          → extract()
    TenantInput                              → build_input() / raw_of()
    TemplateRepository.get_descriptor_v2      → template_slides()
    TemplateRepository.list_v2_templates      → list_templates() / list_declared_templates()
                                                 / template_available()
    LLMOrchestratorV2.generate_slidespec_v2   → generate_spec()
    LLMOrchestratorV2.rewrite_single_slide_v2 → rewrite_slide()
    PPTGeneratorV2.render                    → render()
    SlideSpecV2.load_from_file / .save        → load_spec() / save_spec()
                                               （外加 set_placeholder_value / get_slide
                                                 的薄封装，避免上层直接碰引擎对象）

签名期望写在 ENGINE_SYMBOLS 里，由 doctor.py `--probe-engine` 用
`inspect.signature` 逐个断言。上游改了签名会立刻指出是哪一个，而不是等到
调用期在深栈里炸。

约定：本文件里出现 `SlideSpec` / `TenantInput` 这类引擎对象时，只在
函数签名上以**不透明句柄**的形式进出，上层不得调用它们的方法 —— 要读页、
要写占位符，用下面这些函数。
"""

from . import bootstrap  # noqa: F401  必须最先 import：它设 env 与 sys.path

import functools
import inspect
import sys
from pathlib import Path

from .errors import (
    BadRequest,
    EngineSymbolMissing,
    LlmUnreachable,
    OutputLocked,
    RenderFailed,
    SlideNotFound,
    TemplateNotFound,
)

# ---------------------------------------------------------------------------
# 上游 import —— 全仓库仅此一处
# ---------------------------------------------------------------------------

from mss_ai_ppt_sample_assets.backend.config import (  # noqa: E402
    DATA_DIR,
    OUTPUTS_DIR,
    TEMPLATES_DIR,
    settings,
)
from mss_ai_ppt_sample_assets.backend.exceptions import (  # noqa: E402
    DataValidationError,
    FileValidationError,
    LLMGenerationError,
    MSSAIException,
    PPTGenerationError,
    TemplateNotFoundError,
)
from mss_ai_ppt_sample_assets.backend.models.inputs import TenantInput  # noqa: E402
from mss_ai_ppt_sample_assets.backend.models.slidespec import SlideSpecV2  # noqa: E402
from mss_ai_ppt_sample_assets.backend.modules.excel_handler import ExcelDataExtractor  # noqa: E402
from mss_ai_ppt_sample_assets.backend.modules.llm_orchestrator import LLMOrchestratorV2  # noqa: E402
from mss_ai_ppt_sample_assets.backend.modules.ppt_generator import PPTGeneratorV2  # noqa: E402
from mss_ai_ppt_sample_assets.backend.modules.template_loader import TemplateRepository  # noqa: E402


# ---------------------------------------------------------------------------
# 签名期望（doctor --probe-engine 的判据）
# ---------------------------------------------------------------------------
#
# expect_params 列出「上游必须仍然接受」的参数名。只列我们真的会传的那些 ——
# 上游新增可选参数不该报警，但把某个我们依赖的参数改名/删掉必须报警。

ENGINE_SYMBOLS = [
    {
        "name": "ExcelDataExtractor.extract_data",
        "expect_params": ["excel_path", "template_id"],
        "note": "Excel → 域分组 dict。要求 sheet「数据统计」存在。",
    },
    {
        "name": "TenantInput",
        "expect_params": ["raw"],
        "note": "keyword-only 构造。",
    },
    {
        "name": "TemplateRepository.__init__",
        "expect_params": ["base_dir"],
        "note": "base_dir 默认应为 vendor 里的 templates 目录。",
    },
    {
        "name": "TemplateRepository.get_descriptor_v2",
        "expect_params": ["template_id"],
        "note": "页清单与占位符定义的来源。",
    },
    {
        "name": "TemplateRepository.get_pptx_path",
        "expect_params": ["template_id"],
        "note": "模板 pptx 路径。",
    },
    {
        "name": "LLMOrchestratorV2.generate_slidespec_v2",
        "expect_params": ["tenant_input", "template_id", "use_mock", "focus_options", "ws_manager"],
        "note": "ws_manager=None 时进度回调整体短路，所以不需要 FastAPI。",
    },
    {
        "name": "LLMOrchestratorV2.rewrite_single_slide_v2",
        "expect_params": [
            "tenant_input", "template_id", "slide_key", "user_prompt",
            "current_slide_content", "target_tokens",
        ],
        "note": "返回 {slide_key, placeholders, warnings, missing_tokens, updated_tokens}。",
    },
    {
        "name": "PPTGeneratorV2.render",
        "expect_params": ["slidespec", "output_path"],
        "note": "从模板 pptx 全量重放：会先 unlink 目标再另存。",
    },
    {
        "name": "SlideSpecV2.load_from_file",
        "expect_params": ["path"],
        "note": "类方法。",
    },
    {
        "name": "SlideSpecV2.save",
        "expect_params": ["path"],
        "note": "覆盖写，可叠加。",
    },
    {
        "name": "SlideSpecV2.get_slide",
        "expect_params": ["slide_key"],
        "note": "找不到返回 None。",
    },
    {
        "name": "SlideSpecV2.set_placeholder_value",
        "expect_params": ["slide_key", "token", "value"],
        "note": "页不存在时静默 no-op —— 所以写回前必须先 get_slide 确认。",
    },
]


def _resolve_symbol(dotted):
    """'A.b.c' → 对象。用于探针，不用于业务调用。"""
    target = sys.modules[__name__]
    for part in dotted.split("."):
        target = getattr(target, part)
    return target


def probe_symbols():
    """逐个断言 ENGINE_SYMBOLS 存在且参数名齐备。

    返回 (report, ok)。report 是可直接塞进 doctor JSON 的列表。
    """
    report = []
    ok = True
    for spec in ENGINE_SYMBOLS:
        name = spec["name"]
        entry = {"name": name, "ok": True}
        try:
            target = _resolve_symbol(name)
        except AttributeError as exc:
            entry.update(ok=False, problem=f"符号不存在: {exc}")
            report.append(entry)
            ok = False
            continue

        try:
            signature = inspect.signature(target)
        except (TypeError, ValueError) as exc:
            entry.update(ok=False, problem=f"取不到签名: {exc}")
            report.append(entry)
            ok = False
            continue

        try:
            signature.bind_partial(**{p: None for p in spec["expect_params"]})
        except TypeError:
            actual = [p for p in signature.parameters if p not in ("self", "cls")]
            missing = [p for p in spec["expect_params"] if p not in signature.parameters]
            entry.update(
                ok=False,
                problem=f"参数不匹配，缺少 {missing}",
                expected_params=spec["expect_params"],
                actual_params=actual,
            )
            report.append(entry)
            ok = False
            continue

        entry["signature"] = str(signature)
        report.append(entry)

    return report, ok


# ---------------------------------------------------------------------------
# 上游对象工厂
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=1)
def repository():
    """TemplateRepository 单例。descriptor 有缓存，复用能省掉重复解析 108K JSON。"""
    return TemplateRepository()


@functools.lru_cache(maxsize=1)
def _orchestrator():
    return LLMOrchestratorV2(repository())


@functools.lru_cache(maxsize=1)
def _generator():
    return PPTGeneratorV2(repository())


def engine_dirs():
    return {
        "templates_dir": str(TEMPLATES_DIR),
        "data_dir": str(DATA_DIR),
        "outputs_dir": str(OUTPUTS_DIR),
    }


def settings_snapshot():
    """settings 里与本 pipeline 有关的事实。doctor 与汇总 JSON 都用它。"""
    return {
        "enable_llm": bool(getattr(settings, "enable_llm", False)),
        "openai_model": getattr(settings, "openai_model", None),
        "openai_base_url": getattr(settings, "openai_base_url", None),
        "api_key_set": bool(getattr(settings, "openai_api_key", None)),
        "llm_read_timeout_seconds": getattr(settings, "llm_read_timeout_seconds", None),
        "llm_connect_timeout_seconds": getattr(settings, "llm_connect_timeout_seconds", None),
        "llm_retry_attempts": getattr(settings, "llm_retry_attempts", None),
        "rag_enabled": bool(getattr(settings, "rag_enabled", False)),
    }


def upstream_modules_loaded():
    """已加载的上游模块名。doctor 用它证明闭包干净。"""
    return sorted(name for name in sys.modules if name.startswith(bootstrap.UPSTREAM_PACKAGE))


def leaked_services_modules():
    """有没有把 backend.services 牵出来（那条链会要 qdrant / sentence-transformers）。

    正常值恒为空列表。非空意味着有人在 engine.py 之外 import 了引擎的 services 层，
    或者上游把 services 挪进了我们的 import 闭包 —— 两种情况都要立刻知道。
    """
    prefix = f"{bootstrap.UPSTREAM_PACKAGE}.backend.services"
    return sorted(name for name in sys.modules if name == prefix or name.startswith(f"{prefix}."))


# ---------------------------------------------------------------------------
# 1. Excel → 数据
# ---------------------------------------------------------------------------

def extract(excel_path, template_id):
    """Excel → 域分组 dict（引擎的 raw 结构）。

    要求 workbook 里存在 sheet「数据统计」—— 本仓库产出的 Excel 模板同源，
    这一条天然满足。不满足时引擎抛 DataValidationError，这里翻成 2 bad_request
    并把 available_sheets 带上，便于一眼看出拿错文件了。
    """
    excel_path = Path(excel_path)
    if not excel_path.exists():
        raise BadRequest(
            f"Excel 不存在: {excel_path}",
            hint="检查 --excel 路径；路径含中文时由 pipeline.js 整包 B64 传递，直接调 CLI 需自行加 B64: 前缀",
        )
    try:
        return ExcelDataExtractor.extract_data(excel_path, template_id)
    except DataValidationError as exc:
        detail = {"template_id": template_id, "excel": str(excel_path)}
        for attr in ("field", "message", "available_sheets"):
            value = getattr(exc, attr, None)
            if value is not None:
                detail[attr] = value
        raise BadRequest(
            f"Excel 与模板 {template_id} 不匹配（{exc}）",
            hint="报告模板需含 sheet「数据统计」；确认 --excel 指向本仓库产出的 *_report.xlsx",
            detail=detail,
        ) from exc
    except FileValidationError as exc:
        raise BadRequest(
            f"Excel 文件格式非法: {excel_path.name}",
            hint="用 openpyxl 能打开的文件；平台导出的中间件不是报告模板",
            detail={"excel": str(excel_path)},
        ) from exc
    except MSSAIException as exc:
        raise BadRequest(f"Excel 解析失败: {exc}", detail={"template_id": template_id}) from exc


def build_input(raw):
    """dict → TenantInput（不透明句柄）。"""
    return TenantInput(raw=raw)


def raw_of(tenant_input):
    """从 TenantInput 取回 raw dict。用于 input.json 落盘与内存覆盖。"""
    return getattr(tenant_input, "raw", None)


# ---------------------------------------------------------------------------
# 2. 模板
# ---------------------------------------------------------------------------

def list_declared_templates():
    """catalog 声明的**全部**模板，含文件没被纳入 vendor 快照的。

    只有 doctor 该调它 —— 它要把「声明了却拿不到」的差异报出来。选模板一律
    走 list_templates()。
    """
    return repository().list_v2_templates()


def list_templates():
    """catalog 声明、且模板文件确实在快照里的模板（可选集合）。

    vendor/ 是「上游 − MANIFEST.exclude」的筛子集，所以 catalog 里可能有条目
    指向没被纳入的模板 —— 上游已废弃的 mss_classic_ops 就是：它的 legacy/
    目录整块在 exclude 里。这类模板一旦被选中，会在读 descriptor 时抛
    FileNotFoundError，而它不是 TemplateNotFoundError，调用方按「模板不存在」
    写的 except 捕不到，会一路炸到顶层。所以在这里就判掉，让它根本进不了
    可选集合。
    """
    return [t for t in list_declared_templates() if template_available(t["template_id"])]


def template_available(template_id):
    """descriptor 与 pptx 都在盘上才算可用。

    只有「文件不在」判为不可用（TemplateNotFoundError / OSError，后者覆盖
    FileNotFoundError）。descriptor 在盘上但解析失败属于真故障，照旧往上抛，
    由 doctor 报出来 —— 别把它混进「没纳入快照」里一起静音。
    """
    try:
        repository().get_descriptor_v2(template_id)
        pptx_path = repository().get_pptx_path(template_id)
    except (TemplateNotFoundError, OSError):
        return False
    return pptx_path.is_file()


def template_slides(template_id):
    """页清单（纯 dict），含每页的占位符定义。

    转成 dict 是为了让上层不必 import 引擎的 pydantic 模型 —— 那样
    templates.py 就得 import 上游，本文件的「唯一适配面」就不成立了。
    """
    try:
        descriptor = repository().get_descriptor_v2(template_id)
    except TemplateNotFoundError as exc:
        raise TemplateNotFound(
            f"模板不存在: {template_id}",
            hint=f"可用模板见 `node pipeline.js list-slides`",
            detail={"template_id": template_id},
        ) from exc
    return [slide.model_dump() for slide in descriptor.slides]


def template_pptx_path(template_id):
    try:
        return repository().get_pptx_path(template_id)
    except TemplateNotFoundError as exc:
        raise TemplateNotFound(f"模板不存在: {template_id}") from exc


# ---------------------------------------------------------------------------
# 3. 生成
# ---------------------------------------------------------------------------

def generate_spec(tenant_input, template_id, mock=False, focus_options=None):
    """跑引擎生成 SlideSpec（不透明句柄）。

    ws_manager=None 是刻意的：引擎里所有进度回调都在 `if ws_manager` 下，
    传 None 会让它们整体短路，于是这条路不需要 FastAPI / WebSocket / job store。

    mock=True 时 AI 位填「[token: AI generated content]」这类占位文案 ——
    它是**验证渲染链路**用的，不是降级方案。所以调用方必须把 used_mock
    如实带进汇总 JSON，不能让 mock 产物被当成成品。
    """
    return _orchestrator().generate_slidespec_v2(
        tenant_input=tenant_input,
        template_id=template_id,
        use_mock=bool(mock),
        focus_options=focus_options or None,
        ws_manager=None,
    )


def rewrite_slide(tenant_input, template_id, slide_key, user_prompt,
                  current_slide_content=None, target_tokens=None):
    """单页重写。返回引擎的原始结果 dict。

    current_slide_content 要传**该页全部占位符的现值**（不是只传 AI 位）：
    引擎把它当上下文让模型知道这页已经有什么。

    注意：本函数没有 enable_llm 守卫 —— 引擎也没有。ENABLE_LLM=false 时
    引擎会抛 LLMGenerationError，而它会被上层当「模型输出格式错」重试 5 次，
    最终报错文案是 "check model output format"，极具误导性。
    所以调用方（cli/rewrite）必须**先**判 enable_llm。
    """
    try:
        return _orchestrator().rewrite_single_slide_v2(
            tenant_input=tenant_input,
            template_id=template_id,
            slide_key=slide_key,
            user_prompt=user_prompt,
            current_slide_content=dict(current_slide_content or {}),
            target_tokens=list(target_tokens) if target_tokens else None,
            rag_context=None,
            session_id=None,
        )
    except LLMGenerationError as exc:
        raise LlmUnreachable(
            f"LLM 调用失败: {exc}",
            hint="跑 node pipeline.js doctor --probe-llm 区分「不可达」与「鉴权失败」；"
                 "注意引擎的 _build_openai_client 用了 trust_env=False，HTTP_PROXY 不生效",
        ) from exc


# ---------------------------------------------------------------------------
# 4. SlideSpec 句柄操作
# ---------------------------------------------------------------------------

def load_spec(path):
    return SlideSpecV2.load_from_file(Path(path))


def save_spec(spec, path):
    SlideSpecV2.save(spec, Path(path))


def spec_template_id(spec):
    return getattr(spec, "template_id", None)


def spec_slide_keys(spec):
    """[(slide_no, slide_key)]，按幻灯片顺序。"""
    return [(slide.slide_no, slide.slide_key) for slide in spec.slides]


def spec_get_slide(spec, slide_key):
    return spec.get_slide(slide_key)


def spec_placeholder_values(spec, slide_key):
    """该页 token → 值。页不存在返回 None（区别于空 dict）。"""
    slide = spec.get_slide(slide_key)
    if slide is None:
        return None
    return dict(slide.placeholders)


def spec_set_placeholder(spec, slide_key, token, value):
    if spec.get_slide(slide_key) is None:
        raise SlideNotFound(f"页不存在: {slide_key}", detail={"slide_key": slide_key})
    spec.set_placeholder_value(slide_key, token, value)


# ---------------------------------------------------------------------------
# 5. 渲染
# ---------------------------------------------------------------------------

def remove_stale_output(output_path):
    """删掉即将被重放的旧产物（render 是「先 unlink 再另存」）。

    单独抽出来是为了让「文件被 PowerPoint 占着」这条 Windows 上极常见的路径
    有统一的、能看懂的报错。裸的 `PermissionError: [WinError 32] 另一个程序
    正在使用此文件` 读起来像程序坏了，实际解法只是关掉 PowerPoint。

    三个调用点（generate / rewrite / doctor 的指纹探针）都走这里，
    免得各写一遍 try/except 再各自漂移。
    """
    output_path = Path(output_path)
    if not output_path.exists():
        return False
    try:
        output_path.unlink()
    except PermissionError as exc:
        raise OutputLocked(
            f"产物被占用，无法覆盖: {output_path}",
            hint="这个 pptx 正被别的程序打开（多半是 PowerPoint）—— 关掉它再重跑。"
                 "生成用的 render() 需要先删掉旧文件再另存，占用时删不掉",
            detail={"output_path": str(output_path)},
        ) from exc
    return True


def render(spec, output_path):
    """渲染 pptx。

    引擎行为（已逐行确认，上层必须知道）：
      - **从模板 pptx 全量重放**：先 unlink 目标再另存。所以在 PowerPoint 里
        手改过的排版会全部丢失 —— 这与线上服务行为一致，不是 bug。
      - 只读模板 + slidespec，**不改** slidespec。所以同一份 slidespec 重渲幂等。
      - 目标已存在时会被 unlink，因此重写版必须另存新文件，不能覆盖原稿。
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    remove_stale_output(output_path)
    try:
        return Path(_generator().render(spec, output_path))
    except PPTGenerationError as exc:
        raise RenderFailed(
            f"渲染失败: {exc}",
            hint="检查目标 pptx 是否被 PowerPoint 占用（占用时 unlink 会失败）",
            detail={"output_path": str(output_path)},
        ) from exc
    except PermissionError as exc:
        raise OutputLocked(
            f"写盘被拒: {output_path}",
            hint="这个 pptx 正被别的程序打开（多半是 PowerPoint）—— 关掉它再重跑",
            detail={"output_path": str(output_path)},
        ) from exc
