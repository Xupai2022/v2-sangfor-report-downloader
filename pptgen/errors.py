# -*- coding: utf-8 -*-
"""错误类型与退出码。

约定：
  - 每个错误都带 code（机器可读）、message（人读）、hint（怎么办）、detail（诊断现场）
  - exit code 由 code 决定，映射在 EXIT_CODES。cli.py 是唯一的出口，
    它保证 stdout 只出现一个 JSON 对象、诊断一律走 stderr。

为什么 hint 是必填语义：这个 pipeline 的大部分失败都有明确的下一条命令
（".env.ppt 不存在 → cp .env.ppt.example .env.ppt"）。把 hint 丢掉，
用户看到的就是一个裸英文栈。
"""

# 退出码。0/1 之外的分档是为了让 OpenClaw / shell 能区分「哪种失败」，
# 便于决定重试还是改参数。
EXIT_OK = 0
EXIT_UNEXPECTED = 1        # 未归类的异常，附栈
EXIT_BAD_REQUEST = 2       # 参数错、文件不存在、run 目录冲突
EXIT_LLM = 3               # LLM 被禁用 / 不可达 / 鉴权失败
EXIT_VENDOR_BROKEN = 4     # vendor 漂移、引擎符号缺失或签名变化、依赖缺失
EXIT_NOT_FOUND = 5         # 模板 / 页 / token 找不到
EXIT_RENDER_FAILED = 6     # 渲染或写盘失败
EXIT_DOCTOR_FAILED = 7     # doctor 自检不通过


class PptError(Exception):
    """本 pipeline 的基类错误。所有可预期的失败都应该用它或它的子类抛出。"""

    code = "unexpected"
    exit_code = EXIT_UNEXPECTED

    def __init__(self, message, hint=None, detail=None):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.detail = detail or {}

    def to_dict(self):
        payload = {"code": self.code, "message": self.message}
        if self.hint:
            payload["hint"] = self.hint
        if self.detail:
            payload["detail"] = self.detail
        return payload


# ---------- 2 bad_request ----------

class BadRequest(PptError):
    code = "bad_request"
    exit_code = EXIT_BAD_REQUEST


class ExcelNotFound(BadRequest):
    code = "excel_not_found"


class RunDirConflict(BadRequest):
    """run 目录已存在且没给 --force。

    不覆盖的理由：generate 的产物里 slidespec.json 是后续 rewrite 的输入，
    静默覆盖会让「刚重写完的三个页面」在下次 generate 时无声消失。
    """

    code = "run_dir_conflict"


# ---------- 3 llm ----------

class LlmDisabled(PptError):
    """ENABLE_LLM=false。

    必须前置拦截：rewrite_single_slide_v2 自身没有 enable_llm 守卫，
    它会靠 _call_openai_with_retry 抛 LLMGenerationError，再被
    _call_and_parse_with_retry 当成「模型输出格式错」重试 5 次才抛出来，
    最终文案是 "check model output format" —— 完全误导。
    """

    code = "llm_disabled"
    exit_code = EXIT_LLM


class LlmUnreachable(PptError):
    code = "llm_unreachable"
    exit_code = EXIT_LLM


class LlmEnvMissing(PptError):
    """.env.ppt 不存在。此时引擎会静默降级成 mock，AI 位变成
    「[token: AI generated content]」—— 看起来像成功，所以必须响亮地报。
    """

    code = "llm_env_missing"
    exit_code = EXIT_LLM


# ---------- 4 vendor_broken ----------

class VendorBroken(PptError):
    code = "vendor_broken"
    exit_code = EXIT_VENDOR_BROKEN


class VendorDrift(VendorBroken):
    """vendor/ 内容与 MANIFEST.json 的 sha256 基线不一致。

    改了 vendor 里的文件就会这样。vendor 是 1:1 快照，任何差异都该是事故。
    """

    code = "vendor_drift"


class EngineSymbolMissing(VendorBroken):
    """engine.py 依赖的某个符号在上游不存在了。

    最可能的原因：上游把生成能力搬离了 modules/（架构级变化），
    这时拷文件解决不了，需要按 vendor/VENDOR.md 的「不保证兼容」一节重做适配。
    """

    code = "engine_symbol_missing"


class DependencyMissing(VendorBroken):
    code = "dependency_missing"


# ---------- 5 not_found ----------

class TemplateNotFound(PptError):
    code = "template_not_found"
    exit_code = EXIT_NOT_FOUND


class SlideNotFound(PptError):
    code = "slide_not_found"
    exit_code = EXIT_NOT_FOUND


class SlideNotRewritable(PptError):
    """该页没有 AI 位，重写无从下手。

    detail 里带 detail.rewritable_slides 候选清单，供上层展示给用户选。
    """

    code = "slide_not_rewritable"
    exit_code = EXIT_NOT_FOUND


class TokenNotFound(PptError):
    code = "token_not_found"
    exit_code = EXIT_NOT_FOUND


# ---------- 6 render_failed ----------

class RenderFailed(PptError):
    code = "render_failed"
    exit_code = EXIT_RENDER_FAILED


class OutputLocked(RenderFailed):
    """产物文件被别的程序占着（Windows 上最常见的是 PowerPoint 正打开着它）。

    单独一个 code 的理由：引擎的 render() 是「先 unlink 目标再另存」，所以在
    Windows 上占用的表现是 unlink 抛 `PermissionError: [WinError 32]`，
    裸报出来是一句「另一个程序正在使用此文件」+ 一长串引擎内部栈，
    完全看不出「关掉 PowerPoint 再跑一次」才是解法。
    """

    code = "output_locked"


# ---------- 7 doctor ----------

class DoctorFailed(PptError):
    code = "doctor_failed"
    exit_code = EXIT_DOCTOR_FAILED
