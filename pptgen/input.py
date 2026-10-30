# -*- coding: utf-8 -*-
"""Excel → 引擎入参，以及封面/周期的**内存覆盖**。

## 为什么需要覆盖

引擎的封面客户名与统计周期来自 Excel 的 `J1/L1/M1`（`excel_handler.py` 读的是
`数据统计` 的 L1/M1）。走下载路径时，写入层已经把这三格按 CLI 入参写好了
（`stats/write_statistics_sheet.js`，日期格式 `YYYY/MM/DD`）。

但 `--excel` 可以指向**任意一份工作簿**（比如人工填过的模板、或更早版本产出的报告），
那里这三格可能是模板原文：客户名 `xx公司`、周期 `2025-08-01 ~ 2026-03-17`。
引擎照着读，封面就印 `xx公司`；更麻烦的是这个周期会进 AI 提示词 ——
模型会按错误的报告期写总结。

所以 generate 在**内存里**用 CLI 传入的权威值覆盖 `tenant_input.raw` 的对应字段。
Excel 里的值已经对时这一步仍会执行，且**不是**无操作：`period.start` / `period.end`
从 Excel 的 `2026/05/12`（斜杠，见 `stats/periods.js`）被归一成 CLI 的 `2026-05-12`，
封面上因此始终是短横格式 —— 与写入层还没有值可写时的成片形态一致。

## 为什么是内存覆盖，不是写回 Excel

写回 Excel 会违反 `CELL_REGISTRY.md` F2：`数据统计` sheet 的唯一写入点是
`stats/write_statistics_sheet.js`。一个绕过写入层的例外一旦开口，
「429 格口径有唯一登记」这件事就守不住了。

## 与「不过滤哨兵值」的关系

覆盖的是**封面与周期这四个字段**（用权威输入修正已知错值），不是清洗
`失败`/`手写` 那类字面量。后者按用户决定如实暴露、一个都不动。
要连覆盖也不要，`--no-cover-override` 即可 —— 此时封面周期直接取 Excel 的值：
走下载路径时是写入层写的斜杠格式 `2026/05/12`（引擎 `_to_text` 对字符串原样透传），
而 `--excel` 指向模板原文时则是模板自带的周期。
"""

from pathlib import Path

from . import engine, paths
from .errors import BadRequest

# 覆盖点在 raw 里的位置。写成表是为了让 overlays 报告能逐条列出「改了哪一格」，
# 而不是笼统说一句「已覆盖」—— 用户要能核对。
COVER_PATHS = ("cover.company",)
PERIOD_PATHS = ("period.start", "period.start_month", "cover.period_start")
PERIOD_END_PATHS = ("period.end", "period.end_month", "cover.period_end")


def _set_path(raw, dotted, value):
    current = raw
    parts = dotted.split(".")
    for part in parts[:-1]:
        nxt = current.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            current[part] = nxt
        current = nxt
    previous = current.get(parts[-1])
    current[parts[-1]] = value
    return previous


def _month_of(date_text):
    """'2026-05-12' → '2026-05'。raw 里 start_month 就是这个格式。"""
    digits = str(date_text or "").strip()
    return digits[:7] if len(digits) >= 7 else digits


def build_tenant_input(excel_path, template_id, customer=None, start=None, end=None,
                       business_systems=None, cover_override=True):
    """返回 (tenant_input, info)。

    info 里有 cover_source（cli / excel）与 overlays（逐条记录改了什么），
    两者都会进汇总 JSON —— 用户在打开 PPT 之前就能知道封面到底来自哪。
    """
    excel_path = Path(excel_path)
    raw = engine.extract(excel_path, template_id)

    overlays = []
    period_overridden = False

    if cover_override:
        if customer:
            for dotted in COVER_PATHS:
                before = _set_path(raw, dotted, customer)
                overlays.append({"path": dotted, "from": before, "to": customer})

        if start:
            for dotted in PERIOD_PATHS:
                value = _month_of(start) if dotted.endswith("start_month") else start
                before = _set_path(raw, dotted, value)
                overlays.append({"path": dotted, "from": before, "to": value})
            period_overridden = True

        if end:
            for dotted in PERIOD_END_PATHS:
                value = _month_of(end) if dotted.endswith("end_month") else end
                before = _set_path(raw, dotted, value)
                overlays.append({"path": dotted, "from": before, "to": value})
            period_overridden = True

        if business_systems:
            names = [str(name).strip() for name in business_systems if str(name).strip()]
            if len(names) > 3:
                raise BadRequest(
                    f"--business-systems 最多 3 个，收到 {len(names)} 个",
                    hint="模板里只有核心系统1/2/3 三个槽位",
                )
            for index, name in enumerate(names, start=1):
                dotted = f"success_metric.core_system_{index}"
                before = _set_path(raw, dotted, name)
                overlays.append({"path": dotted, "from": before, "to": name})

    info = {
        "cover_source": "cli" if overlays else "excel",
        "cover_overridden": bool(overlays),
        "period_overridden": period_overridden,
        "overlays": overlays,
    }
    return engine.build_input(raw), raw, info


# ---------- input.json 的落盘与回读 ----------

INPUT_JSON_NAME = "input.json"


def save_input_json(run_dir, raw, template_id, info, naming=None):
    """落 input.json。`naming` 是这次运行的命名依据（源 Excel、成片名）。

    记它是因为 rewrite 需要知道「我该给重写版起什么名字」—— 而重写版以原成片的词干
    为基，原成片的词干只能从源 Excel 的词干推出来。与其让 rewrite 去回读客户名和起止
    日期再拼一遍（拼错了就是改错页、认不出原稿），不如 generate 当时就把答案记下来。
    """
    payload = {
        "template_id": template_id,
        "saved_at": paths.now_iso(),
        "cover_override": info,
        "naming": naming or {},
        "raw": raw,
    }
    path = Path(run_dir) / INPUT_JSON_NAME
    paths.write_json_atomic(path, payload)
    return path


def load_input_json(run_dir):
    """rewrite 复用 generate 的入参。文件缺失返回 None（调用方决定怎么办）。"""
    path = Path(run_dir) / INPUT_JSON_NAME
    if not path.exists():
        return None
    payload = paths.read_json(path)
    if not isinstance(payload, dict) or "raw" not in payload:
        return None
    return payload


def pptx_stem_from_input_json(run_dir):
    """从 input.json 回读原成片的词干（重写版文件名的基）。

    正常情况直接命中 `naming.pptx_stem`。回读不到（例如 run 目录是旧布局留下的）
    才退回「源 Excel 的词干 + 模板」重算一遍 —— 那时可能算不出来，返回 None，
    由调用方决定退到什么。
    """
    payload = load_input_json(run_dir)
    if not payload:
        return None
    naming = payload.get("naming") or {}
    if naming.get("pptx_stem"):
        return naming["pptx_stem"]
    excel_path = naming.get("excel_path")
    template_id = payload.get("template_id")
    if excel_path and template_id:
        return f"{Path(excel_path).stem}_{template_id}"
    return None
