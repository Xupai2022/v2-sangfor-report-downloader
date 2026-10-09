# -*- coding: utf-8 -*-
"""命令行入口：`python -m pptgen <command> [options]`。

## 两条契约

1. **stdout 恰好一个 JSON 对象。** 成功是 `{"ok":true,"command":...}`，
   失败是 `{"ok":false,"error":{"code","message","hint","detail"}}`。
   诊断、进度、人读的汇总表一律走 stderr。pipeline.js 只 parse stdout。
2. **退出码由 `errors.EXIT_*` 决定**（2 参数错 / 3 LLM / 4 vendor / 5 not_found /
   6 渲染 / 7 doctor），让 OpenClaw 能区分「重试」还是「改参数」。

## 入参两个通道

- `--payload "B64:<base64(JSON)>"`：pipeline.js 的通道。整包编码，一次免疫中文
  路径、中文 prompt、引号、空格、反斜杠，也绕开 `args.js` 里「值以 `--` 开头会被
  当布尔」的边角。**payload 的值优先于同名命令行参数**（Node 是权威调用方）。
- 显式命令行参数：给人手工跑、排查用。两个通道共用同一套 `_pick` 取值，
  所以不存在「Node 能设、手工设不了」的参数。

## 为什么所有 import 都在函数里

vendor 的 `config.py` 在 **import 期**就 `load_dotenv(override=True)` 并实例化
模块级 `settings`。要按次覆盖超时/重试，环境变量必须在**任何**触及 engine 的
import 之前注入。所以顶层只 import 不碰 vendor 的模块（errors/logs/paths/b64），
engine / doctor / generate / rewrite / templates 全部在 dispatch 里延迟 import。
"""

import argparse
import json
import os
import re
import sys
import traceback

from . import b64, errors, logs, paths

DEFAULT_TEMPLATE = "mss_classic_ops_2"

# 本 CLI 的 focus 词汇**只有这三个 id**。中文/英文别名由 pipeline.js 负责映射
# （upstream 的权威别名表在 schemas/requests.py 的 FOCUS_OPTION_ALIASES，
# 那是 HTTP 契约，不是我们的 CLI 契约 —— 在这里复制一遍就会有两份真相）。
FOCUS_VOCABULARY = ("business_protection", "vulnerability", "alert")

# 默认三个全开，与旧编排层 `--focus 业务保护,漏洞,告警` 的默认口径一致。
# 注意引擎自己的默认**不是**「三个全开」：`focus_options` 为空时
# `_resolve_selected_annotations` 直接 return []，AI 提示词里的 {preference}
# 会留空。要那个行为就显式 `--no-focus`。
DEFAULT_FOCUS = FOCUS_VOCABULARY

# 可按次覆盖的调参。这些键**绝不能出现在 .env.ppt 里** —— config.py 用
# override=True 读文件，文件里出现就会被文件盖掉，命令行传值静默失效。
TUNING_ENV_KEYS = (
    ("llm_read_timeout", "LLM_READ_TIMEOUT_SECONDS"),
    ("llm_connect_timeout", "LLM_CONNECT_TIMEOUT_SECONDS"),
    ("llm_retry_attempts", "LLM_RETRY_ATTEMPTS"),
)


class _Parser(argparse.ArgumentParser):
    """把 argparse 的用法错误变成我们的 JSON，而不是一行裸 usage。

    argparse 默认走 `error()` → 打 usage 到 stderr 后 `sys.exit(2)`，
    stdout 上什么都没有。那违反契约 1，Node 侧只能看到「空输出 + 退出码 2」。
    """

    def error(self, message):
        raise errors.BadRequest(
            f"参数错误: {message}",
            hint=self.format_usage().strip(),
        )


# ---------------------------------------------------------------------------
# 取值：payload 与命令行共用一套
# ---------------------------------------------------------------------------

def _pick(args, payload, name, default=None):
    """payload 优先，其次命令行，最后默认值。

    `payload[name] is not None` 而不是 `if name in payload`：payload 里显式的
    `false` 必须能盖掉命令行上的 `--mock`（Node 是权威调用方）。
    """
    if name in payload and payload[name] is not None:
        return payload[name]
    value = getattr(args, name, None)
    return default if value is None else value


_LIST_SEPARATORS = re.compile(r"[，、,；;\r\n]+")


def _as_list(value):
    """逗号串 / 列表 / None → 去空去重的列表。

    分隔符是 `pipeline.js` 的 `LIST_SEPARATORS` 的镜像 —— 规则必须一致，两处都要有。
    收全角逗号、顿号、分号、换行是因为用户的手感是中文标点；只认半角逗号的话
    `--business-systems "OA，财务"` 会静默变成一个名字，错得无声无息。
    """
    if value is None:
        return []
    if isinstance(value, str):
        items = _LIST_SEPARATORS.split(value)
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        raise errors.BadRequest(f"期望逗号分隔的列表，收到 {type(value).__name__}: {value!r}")
    out = []
    for item in items:
        text = str(item).strip()
        if text and text not in out:
            out.append(text)
    return out


def _resolve_focus(args, payload):
    """→ focus_options 列表（None 表示不注入偏好文本）。"""
    if _pick(args, payload, "no_focus", False) and _pick(args, payload, "focus", None):
        raise errors.BadRequest("--focus 与 --no-focus 不能同时给")
    if _pick(args, payload, "no_focus", False):
        return None

    raw = _pick(args, payload, "focus", None)
    requested = _as_list(DEFAULT_FOCUS if raw is None else raw)
    if not requested:
        return None

    unknown = [item for item in requested if item not in FOCUS_VOCABULARY]
    if unknown:
        raise errors.BadRequest(
            "不认识的 focus: " + ", ".join(unknown),
            hint="本 CLI 只接受 " + " / ".join(FOCUS_VOCABULARY)
                 + "（中文别名由 pipeline.js 映射：业务保护→business_protection、"
                   "漏洞|脆弱性→vulnerability、告警→alert）",
            detail={"allowed": list(FOCUS_VOCABULARY), "unknown": unknown},
        )
    return requested


# ---------------------------------------------------------------------------
# 调参注入（必须早于任何 engine import）
# ---------------------------------------------------------------------------

def _keys_in_env_file():
    """`.env.ppt` 里出现过的键名。用于拦截「命令行传了但永远不会生效」的调参。"""
    if not paths.ENV_FILE.exists():
        return set()
    try:
        from dotenv import dotenv_values
    except ImportError:
        # 没有 python-dotenv 时退化成扫文本行。宁可能漏报，也不要在这里炸掉。
        keys = set()
        for line in paths.ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                keys.add(line.split("=", 1)[0].strip())
        return keys
    return set(dotenv_values(str(paths.ENV_FILE)).keys())


def _apply_tuning_env(args, payload):
    """把 --llm-read-timeout 之类注入进程 env，并报告被 .env.ppt 遮蔽的键。

    遮蔽是**硬失败**：config.py 的 override=True 意味着文件里的键会盖掉进程 env，
    于是「我明明传了 600 秒」和「实际还是 240 秒」之间的差异完全不可见。
    这类静默失效正是本仓库最该拦掉的失败模式。
    """
    file_keys = _keys_in_env_file()
    applied = {}
    shadowed = []

    for arg_name, env_name in TUNING_ENV_KEYS:
        value = _pick(args, payload, arg_name, None)
        if value in (None, ""):
            continue
        if env_name in file_keys:
            shadowed.append(env_name)
            continue
        os.environ[env_name] = str(value)
        applied[env_name] = value

    if shadowed:
        raise errors.BadRequest(
            "以下调参被 .env.ppt 遮蔽，传了也不会生效: " + ", ".join(shadowed),
            hint=f"config.py 用 load_dotenv(override=True) 读 {paths.ENV_FILE.name}，"
                 "文件里出现的键会盖掉进程 env。要从命令行调这几个值，"
                 f"先把它们从 {paths.ENV_FILE.name} 里删掉（文件只放密钥与功能开关）",
            detail={"shadowed": shadowed, "env_path": str(paths.ENV_FILE)},
        )
    return applied


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def _emit(payload):
    """stdout 的**唯一**写入点。一行一个 JSON 对象。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _say(message, quiet=False):
    if not quiet:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()


def _attach_file_log(command, verbose):
    """把 root logger 的日志同时落盘到 outputs/_logs/。

    docstring 里承诺了 `_logs/<run-id>.log`，这里把它做实。失败不致命 ——
    落不下日志不该让一次已经成功的生成变成失败。
    """
    try:
        import logging
        paths.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        path = paths.LOGS_DIR / f"{command}.{paths.timestamp()}.log"
        handler = logging.FileHandler(str(path), encoding="utf-8")
        handler.setFormatter(logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
        handler.setLevel(logging.DEBUG if verbose else logging.WARNING)
        logging.getLogger().addHandler(handler)
        return path
    except OSError:
        return None


# ---------------------------------------------------------------------------
# 各子命令
# ---------------------------------------------------------------------------

def _cmd_doctor(args, payload, quiet, log_path):
    from . import doctor

    report = doctor.run(
        verify_vendor=_pick(args, payload, "verify_vendor", False),
        probe_engine=_pick(args, payload, "probe_engine", True),
        probe_llm=_pick(args, payload, "probe_llm", False),
        fingerprint=_pick(args, payload, "fingerprint", False),
        update_fingerprint=_pick(args, payload, "update_fingerprint", False),
        list_models_flag=_pick(args, payload, "list_models", False),
    )

    if not quiet:
        models = report["checks"].get("list_models")
        if models:
            _say(f"  网关共 {models.get('gateway_total')} 个模型，实测了前 {models.get('probed')} 个", quiet)
            _say("  可用:", quiet)
            for model_id in models.get("usable") or []:
                _say(f"    {model_id}", quiet)
            refused = models.get("refused") or {}
            if refused:
                _say("  不可用:", quiet)
                for model_id, reason in refused.items():
                    _say(f"    {model_id:<34} {reason}", quiet)
        for name in report["checked"]:
            if name == "list_models":
                continue
            entry = report["checks"][name]
            _say(f"  [{'OK  ' if entry.get('ok') else 'FAIL'}] {name}", quiet)
        for failure in report["failures"]:
            _say(f"  -> {failure['check']}: {failure['problem']}", quiet)
            if failure.get("hint"):
                _say(f"     hint: {failure['hint']}", quiet)

    # report 自带 ok/checked/checks/failures，直接展开；只补 command 与 log_path。
    report["command"] = "doctor"
    report["log_path"] = _str(log_path)
    return report, (errors.EXIT_OK if report["ok"] else errors.EXIT_DOCTOR_FAILED)


def _cmd_list_slides(args, payload, quiet, log_path):
    from . import templates

    template_id = _pick(args, payload, "template", DEFAULT_TEMPLATE)
    templates.ensure_template(template_id)
    rows = templates.list_slides(template_id)
    rewritable = [row for row in rows if row["rewritable"]]
    only_rewritable = _pick(args, payload, "rewritable", False)

    if not quiet:
        _say(f"{template_id}: {len(rows)} 页，可重写 {len(rewritable)} 页", quiet)
        for row in (rewritable if only_rewritable else rows):
            if row["rewritable"]:
                names = " / ".join(row["ai_cn_names"]) or "-"
                _say(f"  P{row['slide_no']:<3} {row['slide_key']:<28} AI位={len(row['ai_tokens'])}  {names}", quiet)
            else:
                _say(f"  P{row['slide_no']:<3} {row['slide_key']:<28} 无 AI 位"
                     f"（source {row['source_tokens_count']} / chart {row['chart_tokens_count']}）", quiet)
        if only_rewritable:
            _say("  （只列可重写页；去掉 --rewritable 看全部）", quiet)

    return {
        "ok": True,
        "command": "list-slides",
        "template_id": template_id,
        "available_templates": templates.template_ids(),
        "slides_total": len(rows),
        "rewritable_total": len(rewritable),
        "slides": rewritable if only_rewritable else rows,
        "log_path": _str(log_path),
    }, errors.EXIT_OK


def _cmd_generate(args, payload, quiet, log_path):
    from . import generate

    excel = _pick(args, payload, "excel", None)
    if not excel:
        raise errors.BadRequest(
            "缺少 --excel",
            hint="先跑 `node pipeline.js generate --customer ... --cookie-path ...` 下载生成 Excel，"
                 "或把已有的 *_report.xlsx 路径传给 --excel",
        )

    result = generate.run(
        excel_path=excel,
        template_id=_pick(args, payload, "template", DEFAULT_TEMPLATE),
        customer=_pick(args, payload, "customer", None),
        start=_pick(args, payload, "start", None),
        end=_pick(args, payload, "end", None),
        business_systems=_as_list(_pick(args, payload, "business_systems", None)),
        mock=_pick(args, payload, "mock", False),
        cover_override=not _pick(args, payload, "no_cover_override", False),
        force=_pick(args, payload, "force", False),
        run_dir=_pick(args, payload, "run_dir", None),
        require_llm=_pick(args, payload, "require_llm", False),
        focus_options=_resolve_focus(args, payload),
        verbose=_pick(args, payload, "verbose", False),
    )
    result["log_path"] = _str(log_path)

    if not quiet:
        _say(f"  成片: {result['pptx_path']}  ({result['pptx_bytes'] / 1048576:.1f} MB)", quiet)
        _say(f"  页数 {result['slides_total']}（有占位符 {result['slides_with_placeholders']}）"
             f" / 占位符 {result['placeholders_total']}", quiet)
        _say(f"  取到 Excel 值 {result['resolved_from_excel']}"
             f"（其中 {result.get('template_literal_count', 0)} 个是模板原文）"
             f" / 印「失败」{result['missing_sources_count']}"
             f" / 空 {result['empty_values']}"
             f" / AI 位 {result['ai_generated_count']}", quiet)
        for warning in result["warnings"]:
            _say(f"  ! {warning}", quiet)
    return result, errors.EXIT_OK


def _cmd_rewrite(args, payload, quiet, log_path):
    from . import rewrite

    slide = _pick(args, payload, "slide", None)
    prompt = _pick(args, payload, "prompt", None)
    if not slide:
        raise errors.BadRequest("缺少 --slide", hint="用 `node pipeline.js list-slides` 看可重写页")
    if not prompt:
        raise errors.BadRequest(
            "缺少 --prompt",
            hint="给一句中文要求，例如 --prompt \"更强调威胁运营的改进闭环，控制在 300 字内\"",
        )

    result = rewrite.run(
        slide_ref=slide,
        prompt=prompt,
        template_id=_pick(args, payload, "template", DEFAULT_TEMPLATE),
        target_tokens=_as_list(_pick(args, payload, "target_tokens", None)) or None,
        run_dir=_pick(args, payload, "run_dir", None),
        slidespec=_pick(args, payload, "slidespec", None),
        excel_path=_pick(args, payload, "excel", None),
        customer=_pick(args, payload, "customer", None),
        start=_pick(args, payload, "start", None),
        end=_pick(args, payload, "end", None),
        cover_override=not _pick(args, payload, "no_cover_override", False),
        verbose=_pick(args, payload, "verbose", False),
    )
    result["log_path"] = _str(log_path)

    if not quiet:
        _say(f"  重写 P{result['slide_no']} {result['slide_key']}"
             f"（目标 {result['target_how']}，改了 {result['updated_count']} 个 token）", quiet)
        _say(f"  新文件: {result['pptx_path']}", quiet)
        for warning in result["warnings"]:
            _say(f"  ! {warning}", quiet)
    return result, errors.EXIT_OK


COMMANDS = {
    "doctor": _cmd_doctor,
    "list-slides": _cmd_list_slides,
    "generate": _cmd_generate,
    "rewrite": _cmd_rewrite,
}


# ---------------------------------------------------------------------------
# 参数表
# ---------------------------------------------------------------------------

def _str(value):
    return None if value is None else str(value)


def _force_utf8():
    """stdout/stderr 强制 utf-8。必须在 parse_args 之前跑。

    否则「参数错误」这类**在 logs.setup() 之前**发出的 JSON，会用 Windows 控制台
    默认的 GBK 写出中文 message，Node 侧按 utf-8 读就是乱码。
    logs.setup() 里还有一份同样的处理（它也可能被单独调用），两边都是幂等的。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def _add_common(parser):
    parser.add_argument("--payload", help="B64:<base64(JSON)>，pipeline.js 的整包入参通道")
    parser.add_argument("--json", action="store_true",
                        help="无副作用（stdout 本来就只出 JSON）；为了与 node 侧命令对称而保留")
    parser.add_argument("--quiet", action="store_true", help="不打人读汇总（stderr）")
    parser.add_argument("--verbose", action="store_true", help="stderr 与日志文件降到 DEBUG")


def _add_llm_tuning(parser):
    group = parser.add_argument_group(
        "LLM 调参（走进程 env，不写 .env.ppt）",
        "config.py 用 override=True 读 .env.ppt，所以这些键一旦出现在文件里，"
        "命令行传值就会静默失效 —— 本 CLI 会直接报错而不是假装生效。",
    )
    group.add_argument("--llm-read-timeout", type=float,
                       help="LLM_READ_TIMEOUT_SECONDS（引擎默认 240）")
    group.add_argument("--llm-connect-timeout", type=float,
                       help="LLM_CONNECT_TIMEOUT_SECONDS（引擎默认 5）")
    group.add_argument("--llm-retry-attempts", type=int,
                       help="LLM_RETRY_ATTEMPTS（引擎默认 2）")


def _build_parser():
    parser = _Parser(
        prog="python -m pptgen",
        description="进程内驱动 vendored PPT 引擎：Excel → slidespec → pptx，以及按页重写。",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="<command>", required=True)

    doctor = subparsers.add_parser("doctor", help="自检：vendor / 引擎符号 / 依赖 / env / 模板 / 指纹 / LLM")
    doctor.add_argument("--verify-vendor", action="store_true",
                        help="复算 vendor/ 的 sha256 与 MANIFEST.json 比对（慢，但能查出人手改过 vendor）")
    doctor.add_argument("--probe-engine", dest="probe_engine", action="store_true", default=True,
                        help="引擎符号签名探针（默认开；这个开关是为了让命令行把默认值写显式）")
    doctor.add_argument("--no-probe-engine", dest="probe_engine", action="store_false",
                        help="跳过引擎符号签名探针")
    doctor.add_argument("--probe-llm", action="store_true", help="发一次最小 chat 请求验证可达性")
    doctor.add_argument("--list-models", action="store_true",
                        help="向网关要模型清单并逐个探测本 key 能用哪些（发 40 次 max_tokens=1，"
                             "独立动作：给了它就只做这件事）")
    doctor.add_argument("--fingerprint", action="store_true", help="比对数据指纹基线")
    doctor.add_argument("--update-fingerprint", action="store_true",
                        help="把当前数据指纹写进 vendor/MANIFEST.json（上游升级后的人工确认动作）")
    _add_common(doctor)
    _add_llm_tuning(doctor)

    listing = subparsers.add_parser("list-slides", help="列页清单（不碰 LLM）")
    listing.add_argument("--template", default=None, help=f"模板 id（默认 {DEFAULT_TEMPLATE}）")
    listing.add_argument("--rewritable", action="store_true", help="只列有 AI 位、可重写的页")
    _add_common(listing)

    generate = subparsers.add_parser("generate", help="Excel → PPT")
    generate.add_argument("--excel", help="*_report.xlsx 路径（必填）")
    generate.add_argument("--template", default=None, help=f"模板 id（默认 {DEFAULT_TEMPLATE}）")
    generate.add_argument("--customer", help="安全客户名，用于封面与 AI 提示词（不再进文件名）")
    generate.add_argument("--start", help="统计起始日 Y-M-D")
    generate.add_argument("--end", help="统计结束日 Y-M-D")
    generate.add_argument("--business-systems",
                          help="核心系统名，最多 3 个；分隔符中英文逗号、顿号、分号均可")
    generate.add_argument("--focus", help="偏好，" + ",".join(FOCUS_VOCABULARY) + "（默认三个全开）")
    generate.add_argument("--no-focus", action="store_true",
                          help="不注入偏好文本（引擎在 focus_options 为空时不填 {preference}）")
    generate.add_argument("--mock", action="store_true",
                          help="用 mock 值填 AI 位。产物不是真实生成内容，别当成品发")
    generate.add_argument("--require-llm", action="store_true", help="OPENAI_API_KEY 为空即失败")
    generate.add_argument("--no-cover-override", action="store_true",
                          help="不用 CLI 的 --customer/--start/--end 覆盖封面与周期")
    generate.add_argument("--force", action="store_true",
                          help="--run-dir 指向的目录已存在且非空时覆盖它（不传 --run-dir 则每次都是新目录）")
    generate.add_argument("--run-dir", help="指定 run 目录（默认新铸一个 outputs/{YYYYMMDD_HHMMSS}）")
    _add_common(generate)
    _add_llm_tuning(generate)

    rewrite = subparsers.add_parser("rewrite", help="按页重写 AI 位，另存一份 pptx")
    rewrite.add_argument("--slide", help="页码或 slide_key（必填）")
    rewrite.add_argument("--prompt", help="中文重写要求（必填）")
    rewrite.add_argument("--template", default=None, help=f"模板 id（默认 {DEFAULT_TEMPLATE}）")
    rewrite.add_argument("--target-tokens",
                         help="只改这些 token，逗号分隔。只接受精确 token 或精确中文名，不做模糊匹配")
    rewrite.add_argument("--run-dir", help="run 目录（默认读 outputs/latest.json 指向的那个）")
    rewrite.add_argument("--slidespec", help="直接指定 slidespec.json（优先于 --run-dir）")
    rewrite.add_argument("--excel", help="重新抽一次 Excel；不给就复用 run 目录的 input.json")
    rewrite.add_argument("--customer")
    rewrite.add_argument("--start")
    rewrite.add_argument("--end")
    rewrite.add_argument("--no-cover-override", action="store_true")
    _add_common(rewrite)
    _add_llm_tuning(rewrite)

    return parser


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def _decode_payload(args):
    raw = getattr(args, "payload", None)
    if not raw:
        return {}
    payload = b64.decode_json_arg(raw, what=f"{args.command} payload")
    if not isinstance(payload, dict):
        raise errors.BadRequest(
            f"payload 顶层必须是对象，收到 {type(payload).__name__}",
            hint="pipeline.js 用 b64.encodeArg(JSON.stringify({...})) 生成它",
        )
    return payload


def main(argv=None):
    _force_utf8()
    parser = _build_parser()

    try:
        args = parser.parse_args(argv)
    except errors.BadRequest as exc:
        _emit({"ok": False, "command": None, "error": exc.to_dict()})
        return exc.exit_code

    quiet = False
    log_path = None
    try:
        payload = _decode_payload(args)
        quiet = bool(_pick(args, payload, "quiet", False))
        verbose = bool(_pick(args, payload, "verbose", False))

        # 顺序硬约束：setup → 注入调参 → 才能 import engine。
        logs.setup(verbose)
        tuning = _apply_tuning_env(args, payload)
        log_path = _attach_file_log(args.command, verbose)

        # ensure_dirs 放在这里：doctor / list-slides 只读，但 logs/ 与
        # _engine_state/ 是引擎无论如何都要的（config.py 的 OUTPUTS_DIR）。
        paths.ensure_dirs()

        result, exit_code = COMMANDS[args.command](args, payload, quiet, log_path)
        if tuning and "llm" in result and isinstance(result["llm"], dict):
            result["llm"]["tuning_env"] = tuning
        _emit(result)
        return exit_code

    except errors.PptError as exc:
        _emit({"ok": False, "command": args.command, "error": exc.to_dict()})
        _say(f"  ! {exc.code}: {exc.message}", quiet)
        if exc.hint:
            _say(f"    hint: {exc.hint}", quiet)
        return exc.exit_code

    except KeyboardInterrupt:
        exc = errors.PptError("被中断", hint="产物可能不完整，重跑一次 generate 或 rewrite")
        _emit({"ok": False, "command": args.command, "error": exc.to_dict()})
        return exc.exit_code

    except Exception as exc:  # noqa: BLE001 - 顶层兜底，必须转成 JSON
        trace = traceback.format_exc()
        sys.stderr.write(trace + "\n")
        _emit({
            "ok": False,
            "command": args.command,
            "error": {
                "code": "unexpected",
                "message": f"{type(exc).__name__}: {exc}",
                "hint": "这是未归类的异常，栈已打到 stderr；"
                        "先跑 `node pipeline.js doctor --probe-engine` 排除适配面问题",
                "detail": {"traceback_tail": trace.strip().splitlines()[-6:]},
            },
        })
        return errors.EXIT_UNEXPECTED
