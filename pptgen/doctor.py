# -*- coding: utf-8 -*-
"""自检。判据不是「感觉能跑」，而是这一条：

    node pipeline.js doctor --verify-vendor --probe-engine --fingerprint --probe-llm

全绿 = 当前 vendor 快照与 pptgen 适配层是匹配的。不绿 = 它直接指出哪一处需要改，
而需要改的代码只可能在 pptgen/engine.py 一个文件里（vendor 永远不手改）。

检查项（括号里是 checks 里的键）与「会静默出错的几种情况」的对应关系：

    vendor        有人手改了 vendor/ ── sha256 对不上 MANIFEST.json
    engine        engine.py 依赖的符号被上游改签名/删除 ── inspect.signature 逐个断言
    fingerprint   上游改了 excel_handler 的硬编码单元格地址，或 descriptor 的 source
                  ── 唯一会**静默**少渲染十几个格子而不报错的风险
    templates     模板 pptx 里有 token 但 descriptor 没声明 ── 会原样印在成稿上
    closure       有人把 backend.services 牵出来了 ── 那条链会要 qdrant
    env           注入的 env 变量名与上游 config.py 对不上 ── 上游改了变量名
                  （比对 .env.ppt 的值与 settings 的实际值，名字对不上就报错）
    llm           可达性。含两条实测踩过的坑：403「无该模型权限」不是权限问题而是
                  模型名过期；引擎 trust_env=False，进程里的 HTTP_PROXY 不生效
    list_models   --list-models 专用：网关有哪些模型、本 key 真能用哪些

fingerprint 会真跑一遍 extract → generate(mock) → render，落在
outputs/_engine_state/fingerprint/ 下（gitignore）。mock 是刻意的：
指纹要能离线复算，不能依赖 LLM 的随机输出。
"""

import importlib
import json
from pathlib import Path

from . import bootstrap, engine, logs, metrics, paths
from .errors import PptError

logger = logs.get_logger("pptgen.doctor")

# 引擎链路实际需要的第三方包。与 requirements.txt 的 PPT 段一一对应。
REQUIRED_MODULES = [
    ("pptx", "python-pptx", "PPT 渲染"),
    ("pydantic", "pydantic", "引擎的数据模型"),
    ("dotenv", "python-dotenv", "config.py 的 load_dotenv"),
    ("openai", "openai", "LLM 调用"),
    ("httpx", "httpx", "openai 的传输层；引擎显式传 http_client"),
    ("tenacity", "tenacity", "retry_policy"),
    ("lxml", "lxml", "python-pptx 的 XML 层"),
    ("openpyxl", "openpyxl", "Excel 抽取"),
]


# ---------------------------------------------------------------------------
# vendor sha256
# ---------------------------------------------------------------------------

def _sha256(path):
    import hashlib

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _vendor_excluder(manifest):
    """把 MANIFEST.json 的 exclude 规则编译成「这个相对路径算不算垃圾」。

    必须与 scripts/vendor_sync.js 的 buildExcluder 同义，否则两边会互相打脸：
    vendor_sync 认为某个文件不该在快照里，doctor 却把它算成「多余」。
    """
    import fnmatch

    rules = manifest.get("exclude") or {}
    globs = list(rules.get("globs") or [])

    def excluded(rel):
        return any(fnmatch.fnmatch(rel, pattern) for pattern in globs)

    return excluded


def check_vendor():
    """复算 vendor/ 全部文件的 sha256，比对 MANIFEST.json 的基线。

    读写规则与 scripts/vendor_sync.js --check 完全一致（都只认 MANIFEST.files），
    所以两边不会各自漂移。

    排除规则命中的文件单列进 `ignored` 而**不算失败**：它们本来就是快照不带的东西
    （`__pycache__` 之类）。把它们算成「多余」会让每次跑完 doctor 都变成一次
    vendor 漂移告警 —— 而真正的漂移就淹没在这个假警报里了。
    （bootstrap 另有一道 `sys.dont_write_bytecode`，正常情况下根本不会产生它们。）
    """
    manifest_path = paths.MANIFEST_PATH
    if not manifest_path.exists():
        return {"ok": False, "problem": f"缺少 {manifest_path.relative_to(paths.REPO_ROOT)}"}

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    vendor_dir = paths.REPO_ROOT / manifest["vendor_dir"]
    if not vendor_dir.exists():
        return {"ok": False, "problem": f"vendor 目录不存在: {manifest['vendor_dir']}",
                "hint": "node scripts/vendor_sync.js"}

    baseline = manifest.get("files") or {}
    if not baseline:
        return {"ok": False, "problem": "MANIFEST.json 的 files 段为空",
                "hint": "node scripts/vendor_sync.js"}

    excluded = _vendor_excluder(manifest)
    actual = {}
    ignored = []
    for path in vendor_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(vendor_dir).as_posix()
        if rel not in baseline and excluded(rel):
            ignored.append(rel)
            continue
        actual[rel] = _sha256(path)

    missing = [rel for rel in baseline if rel not in actual]
    modified = [rel for rel, digest in baseline.items() if rel in actual and actual[rel] != digest]
    added = [rel for rel in actual if rel not in baseline]

    ok = not (missing or modified or added)
    report = {
        "ok": ok,
        "vendor_dir": manifest["vendor_dir"],
        "baseline_count": len(baseline),
        "actual_count": len(actual),
        "ignored_count": len(ignored),
        "upstream_commit_short": manifest.get("upstream_commit_short"),
        "upstream_worktree_dirty": manifest.get("upstream_worktree_dirty"),
    }
    if ignored:
        report["ignored"] = sorted(ignored)[:20]
    if not ok:
        report["missing"] = missing[:20]
        report["modified"] = modified[:20]
        report["added"] = added[:20]
        report["problem"] = (
            f"vendor 快照有漂移：缺失 {len(missing)}、被改 {len(modified)}、多余 {len(added)}"
        )
        report["hint"] = "vendor/ 永远不手改。修法：node scripts/vendor_sync.js"
    return report


# ---------------------------------------------------------------------------
# 引擎符号
# ---------------------------------------------------------------------------

def check_engine():
    try:
        report, ok = engine.probe_symbols()
    except Exception as exc:  # import 期就可能炸（缺依赖、上游改了模块名）
        return {
            "ok": False,
            "problem": f"engine.py 导入失败: {type(exc).__name__}: {exc}",
            "hint": "上游可能把生成能力搬离了 modules/。见 vendor/VENDOR.md「不保证兼容」一节",
        }
    broken = [entry for entry in report if not entry["ok"]]
    result = {
        "ok": ok,
        "passed": len(report) - len(broken),
        "total": len(report),
        "symbols": report,
    }
    if not ok:
        result["problem"] = "以下符号不存在或签名变化: " + ", ".join(e["name"] for e in broken)
        result["hint"] = "只需改 pptgen/engine.py 一个文件，再重跑 doctor"
    return result


def check_dependencies():
    missing = []
    report = []
    for module, package, why in REQUIRED_MODULES:
        try:
            importlib.import_module(module)
            report.append({"module": module, "package": package, "why": why, "ok": True})
        except Exception as exc:
            report.append({"module": module, "package": package, "why": why, "ok": False,
                           "problem": f"{type(exc).__name__}: {exc}"})
            missing.append(package)
    result = {"ok": not missing, "modules": report}
    if missing:
        result["problem"] = "缺少依赖: " + ", ".join(sorted(set(missing)))
        result["hint"] = "pip install -r requirements.txt"
    return result


# ---------------------------------------------------------------------------
# env 与 settings
# ---------------------------------------------------------------------------

def check_env():
    """检查 .env.ppt 存在，以及它里面的键**确实被上游 settings 消费**。

    「被消费」这一条是防上游改 env 变量名：我们在 bootstrap 里注入 MSS_ENV_PATH，
    如果上游把 ENABLE_LLM 改名成别的，settings.enable_llm 会静默变成 False，
    AI 位退化成 mock 而 PPT 照样生成成功 —— 看起来像成功了。
    比对文件里的值与 settings 的实际值就能把这种情况变成响亮的失败。
    """
    report = {
        "env_path": str(paths.ENV_FILE),
        "exists": paths.ENV_FILE.exists(),
        "example_path": str(paths.ENV_EXAMPLE),
    }

    if not report["exists"]:
        report.update(
            ok=False,
            problem=".env.ppt 不存在：引擎会静默降级成 mock（AI 位变成「[token: AI generated content]」），看起来像成功了",
            hint=bootstrap.env_hint(),
        )
        return report

    from dotenv import dotenv_values

    file_values = {k: v for k, v in dotenv_values(str(paths.ENV_FILE)).items() if v is not None}
    snapshot = engine.settings_snapshot()
    report["settings"] = snapshot
    report["engine_dirs"] = engine.engine_dirs()

    mismatches = []

    # ENABLE_LLM：文件说 true，settings 就必须是 true
    file_enable = str(file_values.get("ENABLE_LLM", "")).strip().lower() == "true"
    if file_enable != snapshot["enable_llm"]:
        mismatches.append(
            f"ENABLE_LLM 文件={file_enable} 但 settings.enable_llm={snapshot['enable_llm']}"
        )

    # OPENAI_MODEL / OPENAI_BASE_URL：文件写了就必须原样被读到
    for key, attr in (("OPENAI_MODEL", "openai_model"), ("OPENAI_BASE_URL", "openai_base_url")):
        if key in file_values and file_values[key] != snapshot[attr]:
            mismatches.append(
                f"{key} 文件={file_values[key]!r} 但 settings.{attr}={snapshot[attr]!r}"
            )

    # 开关打开却没 key：上游 Settings() 会在 import 期抛 ValueError，
    # 能走到这里说明还没炸，但下次可能就炸了
    if snapshot["enable_llm"] and not snapshot["api_key_set"]:
        mismatches.append("ENABLE_LLM=true 但 OPENAI_API_KEY 为空")

    if mismatches:
        report.update(
            ok=False,
            problem="env 文件里的键没有被上游 settings 消费：" + "；".join(mismatches),
            hint="上游可能改了 config.py 的 env 变量名；改 .env.ppt 与 .env.ppt.example 的键名",
        )
        return report

    report["ok"] = True
    if not snapshot["enable_llm"]:
        report["warning"] = "ENABLE_LLM=false：AI 位会退化成 mock 文案，不是真实生成内容"
    return report


# ---------------------------------------------------------------------------
# 闭包干净
# ---------------------------------------------------------------------------

def check_closure():
    """断言没把 backend.services 牵出来。"""
    loaded = engine.upstream_modules_loaded()
    leaked = engine.leaked_services_modules()
    report = {
        "ok": not leaked,
        "upstream_modules_loaded": len(loaded),
        "services_leaked": leaked,
    }
    if leaked:
        report.update(
            problem="backend.services 被 import 了，会牵出 qdrant / sentence-transformers",
            hint="pptgen/engine.py 是唯一允许 import 上游的文件；检查是不是在别处 import 了上游模块",
        )
    return report


# ---------------------------------------------------------------------------
# 模板可达 + token 对齐
# ---------------------------------------------------------------------------

def check_templates():
    try:
        declared = engine.list_declared_templates()
    except Exception as exc:
        return {"ok": False, "problem": f"列模板失败: {type(exc).__name__}: {exc}"}

    report = {"ok": True, "templates": []}
    for entry in declared:
        template_id = entry["template_id"]
        row = {
            "template_id": template_id,
            "name": entry.get("name"),
            "deprecated": bool(entry.get("deprecated")),
        }
        if not engine.template_available(template_id):
            # catalog 声明了、但模板文件没被纳入 vendor 快照 —— 上游废弃的
            # mss_classic_ops 就是这种：legacy/ 整块在 MANIFEST.exclude 里。
            # 这**不算失败**：vendor 本就是「上游 − exclude」的筛子集。但必须
            # 报出来，否则有人照 catalog 去选一个根本选不中的模板，会撞上
            # FileNotFoundError（不是 TemplateNotFound，捕不到）。
            row.update(
                available=False,
                note="模板文件未纳入 vendor 快照（见 MANIFEST.exclude），不可选",
            )
            report["templates"].append(row)
            continue
        try:
            slides = engine.template_slides(template_id)
            pptx_path = engine.template_pptx_path(template_id)
            row["slides"] = len(slides)
            row["pptx_exists"] = Path(pptx_path).exists()

            descriptor_tokens = {}
            for slide in slides:
                descriptor_tokens[slide["slide_no"]] = {
                    placeholder["token"] for placeholder in slide["placeholders"]
                }

            template_tokens = {
                no: set(tokens) for no, tokens in metrics.tokens_in_pptx(Path(pptx_path)).items()
            }
            # 模板里有、descriptor 没声明 → 渲染后会原样印在成稿上。
            # 例外：descriptor 会用 ai_generate 展开出额外的 token（如 duty_summary
            # 展开成 7 个节日 key），所以这里只作**提示**，权威判据是 fingerprint
            # 里从渲染产物读出来的 leftover_tokens。
            undeclared = {
                no: sorted(tokens - descriptor_tokens.get(no, set()))
                for no, tokens in template_tokens.items()
                if tokens - descriptor_tokens.get(no, set())
            }
            row["tokens_in_template_not_in_descriptor"] = undeclared
            row["undeclared_count"] = sum(len(v) for v in undeclared.values())
            if row["undeclared_count"]:
                row["warning"] = (
                    "模板里有 descriptor 未声明的 token（可能原样印在成稿上）；"
                    "以 --fingerprint 的 leftover_tokens 为准"
                )
        except PptError as exc:
            row.update(ok=False, problem=f"{exc.code}: {exc.message}")
            report["ok"] = False
        report["templates"].append(row)

    # 只数真正可用的模板。没纳入快照的那条不能算进来 —— 否则「现有: [...]」
    # 会把一个根本选不中的 id 也报成可用。
    available = [
        t["template_id"] for t in report["templates"] if t.get("available", True)
    ]
    if not any(tid in available for tid in ("mss_classic_ops_2", "mss_classic_ops_3")):
        report.update(ok=False, problem=f"缺少可用模板，现有: {available}")
    return report




# ---------------------------------------------------------------------------
# 数据指纹
# ---------------------------------------------------------------------------

def measure_fingerprint(excel_path, template_id):
    """对一份固定 Excel 跑一遍 extract → generate(mock) → render，记录可比较的计数。

    为什么值得真跑一遍而不是只看 descriptor：上游改了 excel_handler 里的
    **硬编码单元格地址**时，descriptor 一个字都没变、代码也不报错，只是取出
    的字段少了十几个，PPT 相应位置印「失败」。那种失败在本机看起来和
    「本来就没数据」一模一样。把 counts 冻成基线就能把它变成一条明确的告警。

    mock=True 是刻意的：指纹要能离线复算，不能因为 LLM 输出不同而抖动。

    分类走 metrics.summarize_spec —— 与 generate 的汇总用同一份实现，
    否则「指纹变了」到底是上游变了还是我们数变了就分不清。
    """
    out_dir = paths.ENGINE_STATE_DIR / "fingerprint"
    out_dir.mkdir(parents=True, exist_ok=True)
    pptx_path = out_dir / f"{template_id}.pptx"

    raw = engine.extract(excel_path, template_id)
    tenant_input = engine.build_input(raw)
    spec = engine.generate_spec(tenant_input, template_id, mock=True)
    engine.render(spec, pptx_path)

    summary = metrics.summarize_spec(spec, template_id, engine.template_slides(template_id))
    leftover = metrics.tokens_in_pptx(pptx_path)

    return {
        "template_id": template_id,
        "slides_total": summary["slides_total"],
        "slides_with_placeholders": summary["slides_with_placeholders"],
        "placeholders_total": summary["placeholders_total"],
        "print_fail": summary["print_fail"],
        "template_literals": summary["template_literals"],
        "empty_values": summary["empty_values"],
        "ai_generated": summary["ai_generated"],
        "extracted_leaves": metrics.count_leaves(raw),
        "leftover_tokens": {str(no): tokens for no, tokens in sorted(leftover.items())},
        "leftover_count": sum(len(tokens) for tokens in leftover.values()),
        "measured_at": paths.now_iso(),
    }


# 参与比较的计数键。extracted_leaves 与 placeholders_total 是主力：
# 前者抓「上游改了单元格地址」，后者抓「上游改了 descriptor 的 source」。
_FINGERPRINT_KEYS = [
    "slides_total",
    "placeholders_total",
    "print_fail",
    "template_literals",
    "empty_values",
    "extracted_leaves",
    "leftover_count",
]


def check_fingerprint(update=False):
    manifest = json.loads(paths.MANIFEST_PATH.read_text(encoding="utf-8"))
    section = manifest.setdefault("fingerprints", {})
    fixture_name = section.get("excel_fixture", "一致性验收客户_report.xlsx")
    fixture = paths.REPO_ROOT / fixture_name

    if not fixture.exists():
        return {
            "ok": False,
            "skipped": True,
            "problem": f"指纹样本不存在: {fixture_name}（该文件被 .gitignore 忽略，是本机文件）",
            "hint": "把一份本仓库产出的 *_report.xlsx 放到仓库根，或改 MANIFEST.json 的 fingerprints.excel_fixture",
        }

    baseline = section.get("templates") or {}
    measured = {}
    for entry in engine.list_templates():
        template_id = entry["template_id"]
        try:
            measured[template_id] = measure_fingerprint(fixture, template_id)
        except Exception as exc:
            measured[template_id] = {
                "template_id": template_id,
                "error": f"{type(exc).__name__}: {exc}",
            }

    if update:
        section["excel_fixture"] = fixture_name
        section["templates"] = measured
        paths.write_json_atomic(paths.MANIFEST_PATH, manifest)
        return {"ok": True, "updated": True, "fixture": fixture_name, "measured": measured}

    if not baseline:
        return {
            "ok": False,
            "problem": "MANIFEST.json 里还没有指纹基线",
            "hint": "node pipeline.js doctor --fingerprint --update-fingerprint",
            "measured": measured,
        }

    diffs = []
    rows = {}
    for template_id, current in measured.items():
        if "error" in current:
            diffs.append(f"{template_id}: 跑不出指纹（{current['error']}）")
            rows[template_id] = {"ok": False, "problem": current["error"], "current": current}
            continue
        expected = baseline.get(template_id)
        if not expected:
            rows[template_id] = {"ok": False, "problem": "基线里没有这个模板", "current": current}
            diffs.append(f"{template_id}: 基线里没有（新增模板？）")
            continue
        changed = {
            key: {"baseline": expected.get(key), "current": current.get(key)}
            for key in _FINGERPRINT_KEYS
            if expected.get(key) != current.get(key)
        }
        if changed:
            diffs.append(f"{template_id}: " + ", ".join(
                f"{key} {v['baseline']}→{v['current']}" for key, v in changed.items()
            ))
            rows[template_id] = {"ok": False, "changed": changed, "current": current,
                                 "api_diff": _compare_token_maps(expected, current)}
        else:
            rows[template_id] = {"ok": True, "current": current}

    report = {
        "ok": not diffs,
        "fixture": fixture_name,
        "templates": rows,
    }
    if diffs:
        report["problem"] = "数据指纹发生变化：" + "；".join(diffs)
        report["hint"] = (
            "上游动了 excel_handler 的硬编码单元格地址，或 descriptor 的 source。"
            "人工确认影响面后再用 --update-fingerprint 重设基线"
        )
    return report


def _compare_token_maps(expected, current):
    """指纹变化时给出最可能的原因：占位符数量变了还是取值分布变了。"""
    out = {}
    if expected.get("placeholders_total") != current.get("placeholders_total"):
        out["placeholders_total"] = "descriptor 的占位符集合变了"
    if expected.get("extracted_leaves") != current.get("extracted_leaves"):
        out["extracted_leaves"] = "Excel 抽取出的字段数变了 → excel_handler 的单元格映射动了"
    if expected.get("print_fail") != current.get("print_fail"):
        out["print_fail"] = "印「失败」的格子数变了 → 单元格映射或 source 路径动了"
    if expected.get("leftover_tokens") != current.get("leftover_tokens"):
        out["leftover_tokens"] = "成稿上残留的 {{token}} 变了"
    return out


# ---------------------------------------------------------------------------
# LLM 可达性
# ---------------------------------------------------------------------------

def check_llm():
    """一次最小 chat 请求。

    刻意用 trust_env=False 构造 http client —— 与引擎 _build_openai_client 一致。
    这样「本机走代理能连、引擎连不上」的差异会在 doctor 阶段就暴露，
    而不是等到 generate 跑到一半超时、被误判成「LLM 慢」。
    """
    snapshot = engine.settings_snapshot()
    if not snapshot["enable_llm"]:
        return {"ok": False, "skipped": True, "problem": "ENABLE_LLM=false，无法探测",
                "hint": "先把 .env.ppt 的 ENABLE_LLM 设为 true"}
    if not snapshot["api_key_set"]:
        return {"ok": False, "skipped": True, "problem": "OPENAI_API_KEY 为空"}

    import httpx
    import openai

    report = {"base_url": snapshot["openai_base_url"], "model": snapshot["openai_model"]}
    try:
        client = openai.OpenAI(
            api_key=engine.settings.openai_api_key,
            base_url=snapshot["openai_base_url"],
            http_client=httpx.Client(trust_env=False, timeout=httpx.Timeout(20.0, connect=5.0)),
            max_retries=0,
        )
        response = client.chat.completions.create(
            model=snapshot["openai_model"],
            messages=[{"role": "user", "content": "ping"}],
            # 16 而不是 4：推理型模型会先把 max_tokens 花在 reasoning 上，
            # 留 4 个 token 的话 content 是空串 —— 看起来像「模型没回话」。
            max_tokens=16,
        )
        report["ok"] = True
        report["reply_preview"] = (response.choices[0].message.content or "")[:40] or "(空回复)"
    except openai.AuthenticationError as exc:
        report.update(ok=False, problem=f"鉴权失败: {exc}",
                      hint="OPENAI_API_KEY 过期或不匹配该 BASE_URL")
    except (openai.APITimeoutError, openai.APIConnectionError) as exc:
        report.update(
            ok=False,
            problem=f"不可达: {type(exc).__name__}: {exc}",
            hint="引擎的 _build_openai_client 用了 trust_env=False，进程里的 HTTP_PROXY/HTTPS_PROXY 一律不生效。"
                 "若本机只能走代理出网，需要直连该 BASE_URL，或换一个可达的 OPENAI_BASE_URL",
        )
    except openai.APIStatusError as exc:
        body = ""
        try:
            body = str(exc.body if getattr(exc, "body", None) else exc)
        except Exception:  # noqa: BLE001 - 诊断信息取不到也不该让报告消失
            body = ""
        if exc.status_code == 403 and "no access to model" in body:
            # 这一条实测踩过：上游 .env 写的 OPENAI_MODEL=glm-4.7 在那个网关上
            # 已经退掉，报的是 403 而不是 404 —— 看起来像权限问题，实际是模型名过期。
            report.update(
                ok=False, problem=f"该 key 没有模型 {snapshot['openai_model']} 的权限: {body[:200]}",
                hint=f"把 .env.ppt 的 OPENAI_MODEL 换成实测可用的名字："
                     f"python -m pptgen doctor --list-models（当前写的是 {snapshot['openai_model']}）",
            )
        elif exc.status_code == 503:
            report.update(
                ok=False, problem=f"网关有该模型名但没有可用通道: {body[:200]}",
                hint="这是网关侧容量/路由问题，换一个模型名：python -m pptgen doctor --list-models",
            )
        elif exc.status_code == 404:
            report.update(
                ok=False, problem=f"模型不存在: {body[:200]}",
                hint="BASE_URL 路径是否正确（通常要以 /v1 结尾）、模型名是否拼错",
            )
        else:
            report.update(ok=False, problem=f"HTTP {exc.status_code}: {exc}",
                          hint="BASE_URL 路径是否正确（通常要以 /v1 结尾）、模型名是否存在")
    except Exception as exc:
        report.update(ok=False, problem=f"{type(exc).__name__}: {exc}")
    return report


def list_models():
    """向网关要一次模型清单，并逐个探哪些**这个 key 真的能用**。

    `GET /models` 是不过滤权限的 —— 实测它列出了 101 个模型，包括很多
    403/503 的。所以清单本身不是答案，答案在逐个 chat 探测里。
    探测用 max_tokens=1，成本可忽略；上限 40 个，避免在大网关上刷屏。
    """
    snapshot = engine.settings_snapshot()
    report = {"base_url": snapshot["openai_base_url"],
              "configured_model": snapshot["openai_model"]}
    if not snapshot["api_key_set"]:
        return {"ok": False, "problem": "OPENAI_API_KEY 为空", **report}

    import httpx

    base = snapshot["openai_base_url"].rstrip("/")
    headers = {"Authorization": f"Bearer {engine.settings.openai_api_key}"}
    timeout = httpx.Timeout(30.0, connect=8.0)
    try:
        with httpx.Client(trust_env=False, timeout=timeout) as client:
            response = client.get(base + "/models", headers=headers)
            if response.status_code != 200:
                return {"ok": False, "problem": f"GET /models → HTTP {response.status_code}",
                        "hint": "BASE_URL 是否正确（通常要以 /v1 结尾）", **report}
            all_ids = sorted(entry.get("id", "") for entry in response.json().get("data") or [])

            usable, refused = [], {}
            for model_id in all_ids[:40]:
                try:
                    probe = client.post(
                        base + "/chat/completions", headers=headers,
                        json={"model": model_id, "max_tokens": 1,
                              "messages": [{"role": "user", "content": "1"}]},
                    )
                except httpx.HTTPError as exc:
                    refused[model_id] = f"{type(exc).__name__}"
                    continue
                if probe.status_code == 200:
                    usable.append(model_id)
                else:
                    try:
                        refused[model_id] = f"{probe.status_code} {probe.json()['error']['message'][:60]}"
                    except Exception:  # noqa: BLE001
                        refused[model_id] = f"{probe.status_code} {probe.text[:60]}"
    except httpx.HTTPError as exc:
        return {"ok": False, "problem": f"{type(exc).__name__}: {exc}",
                "hint": "trust_env=False，进程里的 HTTP_PROXY 不生效", **report}

    report.update(
        ok=True,
        probed=min(len(all_ids), 40),
        gateway_total=len(all_ids),
        usable=usable,
        refused=refused,
    )
    if snapshot["openai_model"] not in usable:
        report["ok"] = False
        report["problem"] = f"当前 .env.ppt 的 OPENAI_MODEL={snapshot['openai_model']} 不在可用集合里"
        report["hint"] = "从 usable 里挑一个改到 .env.ppt，再跑 doctor --probe-llm"
    return report


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

def run(verify_vendor=False, probe_engine=True, probe_llm=False,
        fingerprint=False, update_fingerprint=False, list_models_flag=False):
    """跑一遍自检。probe_engine 默认开 —— 它最便宜且最能定位问题。"""
    logs.setup()

    # --list-models 是独立动作：它要发 40 次请求，不该混进常规自检。
    if list_models_flag:
        entry = _guard(list_models)
        return {
            "ok": bool(entry.get("ok")),
            "checked": ["list_models"],
            "checks": {"list_models": entry},
            "failures": [] if entry.get("ok") else [{
                "check": "list_models",
                "problem": entry.get("problem", "未通过"),
                "hint": entry.get("hint"),
            }],
        }

    checks = {}
    checks["templates"] = _guard(check_templates)
    checks["closure"] = _guard(check_closure)

    if probe_engine:
        checks["engine"] = _guard(check_engine)
    checks["dependencies"] = _guard(check_dependencies)
    checks["env"] = _guard(check_env)
    if verify_vendor:
        checks["vendor"] = _guard(check_vendor)
    if fingerprint or update_fingerprint:
        checks["fingerprint"] = _guard(lambda: check_fingerprint(update=update_fingerprint))
    if probe_llm:
        checks["llm"] = _guard(check_llm)

    failures = []
    for name, entry in checks.items():
        if not entry.get("ok"):
            failures.append({
                "check": name,
                "problem": entry.get("problem", "未通过"),
                "hint": entry.get("hint"),
            })

    return {
        "ok": not failures,
        "checked": sorted(checks.keys()),
        "checks": checks,
        "failures": failures,
    }


def _guard(fn):
    """把自检函数包成「永不抛」：一个检查项自己炸掉不该让整份报告消失。"""
    try:
        return fn()
    except Exception as exc:
        return {
            "ok": False,
            "problem": f"检查本身失败: {type(exc).__name__}: {exc}",
        }
