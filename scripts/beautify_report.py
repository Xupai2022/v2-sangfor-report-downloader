#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给已生成的 report.xlsx 套用统一视觉规范（原地改写）。

移植自 health-checkup-report/excel-beautifier（作者：陈梅 35937），
适配点见下面「本仓库的适配」一节。样式规则本身全部来自 excel_beautifier 包，
本文件只负责：调用哪个 sheet、跳过哪个 sheet、以及一处数字格式保护。

用法:
    python beautify_report.py <report.xlsx> '<payload_json>'
    payload_json 形如 {"theme":"classic","exclude_sheets":["数据统计"],"watermark":null}
      theme           classic（默认，宋体浅蓝底）| modern（雅黑斑马纹）
      exclude_sheets  不美化的 sheet 名单，默认 ["数据统计"]
      watermark       水印文字，默认不加；传了需要 Pillow

输出:
    stdout: {"theme","styled":[...],"skipped":[...]}
    stderr: 每行一个 JSON 诊断对象

本仓库的适配:
    1. 跳过「数据统计」sheet —— MIGRATION.md R1 单元格冻结，不给它套任何样式/格式。
       excel-beautifier 原本是"处理所有 sheet"，这里改成白名单外一律跳过。
       ⚠️ 注意"跳过"只是不套样式，**不是不动这个文件**：openpyxl 是整本读进来再整本写出去，
       存盘时公式格只写公式、不写 <v> 缓存值。所以「数据统计」里的公式格
       （I1 = TODAY()，C7/C8/C9 = D3/D4/D5）跑完美化后，程序按值读会得到空/0。
       Excel 打开会自己重算，肉眼看不出来；这是**已知问题**，尚未修（见 MIGRATION.md §8）。
    2. 时间列不套数字格式（见 TIME_HEADER_KEYWORDS 处说明）。
    3. 结构识别不出来的 sheet（空表、非表格页）自动跳过，不算失败 ——
       暴露面 / 资产漏洞表目前就是空表。
"""
import json
import sys
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__。
# 放在下面这些本地 import 之前，否则它们自己就已经先把 pycache 写进去了。
sys.dont_write_bytecode = True

# stdout 只走结果 JSON。手工在 GBK 控制台跑时，sheet 名里若有 GBK 编不出的字符，
# print 会在**文件已经改完**之后抛 UnicodeEncodeError —— 最糟的一种失败：
# 活干完了却报错。只放宽错误处理、不改编码（正常路径由 PYTHONIOENCODING=utf-8 兜住）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import load_workbook

from _path_helper import decode_argv
from excel_beautifier.core import load_template
from excel_beautifier.detector import detect_structure, detect_column_types
from excel_beautifier.styles import apply_all

decode_argv()

# 默认不美化的 sheet。数据统计 sheet 是人工填写区，模板原样保留（MIGRATION.md R1）。
DEFAULT_EXCLUDE_SHEETS = ["数据统计"]

# 表头含这些词的列，保留平台给的原格式，不套主题的数字格式。
#
# 事件表的时间列是「序列号 + 日期格式」（如 yyyy/m/d h:mm，由 report_writer.js 从
# 平台导出还原）。美化工具只看值，会把 46225.42 当小数套 #,##0.00；就算识别成日期，
# 主题的 date 格式是 yyyy-mm-dd，会把时分秒截掉。两种都比现状差，所以这类列一律
# 不碰数字格式，只套字体/底色/边框/行高——观感照样统一，时间精度不丢。
TIME_HEADER_KEYWORDS = ["时间", "日期"]


def normalize(value):
    return "" if value is None else str(value).strip()


def has_time_component(number_format):
    """判断数字格式是否带时分秒（如 yyyy/m/d h:mm 带，yyyy-mm-dd 不带）。

    只看引号外、且没被反斜杠转义的部分，免得把 "时间:" 这类字面量当时间记号。
    """
    fmt = str(number_format or "")
    if not fmt or fmt == "General":
        return False

    visible = []
    in_literal = False
    escaped = False
    for ch in fmt:
        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_literal = not in_literal
            continue
        if not in_literal:
            visible.append(ch.lower())

    plain = "".join(visible)
    # h = 小时，s = 秒；冒号是时间分隔符，单独出现也说明是时间格式
    return "h" in plain or "s" in plain or ":" in plain


def parse_payload(raw):
    """解析第二个参数，返回 (theme, exclude_sheets, watermark)。"""
    if not raw:
        return "classic", list(DEFAULT_EXCLUDE_SHEETS), None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"无法解析美化参数 JSON: {e}")
    if not isinstance(payload, dict):
        raise SystemExit("美化参数必须是一个 JSON 对象")

    theme = normalize(payload.get("theme")) or "classic"
    excludes = payload.get("exclude_sheets")
    if excludes is None:
        excludes = list(DEFAULT_EXCLUDE_SHEETS)
    excludes = [normalize(v) for v in excludes if normalize(v)]
    watermark = normalize(payload.get("watermark")) or None
    return theme, excludes, watermark


def current_column_format(sheet, structure, col):
    """取该列第一个有值单元格的数字格式，作为「平台原格式」的代表。"""
    for row in range(structure["data_start"], structure["data_end"] + 1):
        cell = sheet.cell(row=row, column=col)
        if cell.value is not None:
            return normalize(cell.number_format)
    return ""


def protect_time_columns(sheet, structure, col_types):
    """把 时间/日期 列从列类型里摘掉，让它们保留平台给的原格式。

    唯一放行的情况：列被识别成日期，且原格式本来就不带时分秒（如 yyyy-mm-dd）——
    这时套主题的 yyyy-mm-dd 不丢信息，还能和别的日期列统一。

    返回被摘掉的列，供诊断输出。
    """
    header_row = structure["header_row"]
    protected = []
    for col, col_type in list(col_types.items()):
        header = normalize(sheet.cell(row=header_row, column=col).value)
        if not header or not any(kw in header for kw in TIME_HEADER_KEYWORDS):
            continue
        current = current_column_format(sheet, structure, col)
        if col_type == "date" and not has_time_component(current):
            continue
        del col_types[col]
        protected.append({
            "column": col,
            "header": header,
            "detected_type": col_type,
            "kept_format": current,
        })
    return protected


def beautify(path, theme, exclude_sheets, watermark_text=None):
    """对 report.xlsx 原地套用主题样式。

    返回 {"theme", "styled": [...], "skipped": [...]}。
    """
    template = load_template(theme=theme)
    if watermark_text:
        wm = template.setdefault("watermark", {})
        wm["text"] = watermark_text
        wm["enabled"] = True

    workbook = load_workbook(path)
    styled = []
    skipped = []
    watermarked = False

    for sheet_name in workbook.sheetnames:
        sheet = workbook[sheet_name]

        if sheet_name in exclude_sheets:
            skipped.append({"name": sheet_name, "reason": "在排除名单中（模板原样保留）"})
            continue

        # 空表（暴露面 / 资产漏洞表目前就没有内容）：没有可套的范围，跳过不算失败
        if sheet.max_row is None or sheet.max_row == 0:
            skipped.append({"name": sheet_name, "reason": "空表"})
            continue

        structure = detect_structure(sheet)
        if structure is None:
            skipped.append({"name": sheet_name, "reason": "未识别到表头（非表格 sheet）"})
            continue

        col_types = detect_column_types(
            sheet,
            structure["header_row"],
            structure["data_start"],
            structure["data_end"],
            structure["col_start"],
            structure["col_end"],
        )
        protected = protect_time_columns(sheet, structure, col_types)

        apply_all(sheet, template, structure, col_types)

        # 水印只加第一个真正套了样式的 sheet（数据统计被跳过了，
        # 照搬 excel-beautifier 的"只加第一张表"会把水印加到不动的表上）
        if not watermarked and template.get("watermark", {}).get("enabled"):
            from excel_beautifier.core import _apply_watermark

            _apply_watermark(sheet, template["watermark"], structure)
            watermarked = True

        styled.append({
            "name": sheet_name,
            "header_row": structure["header_row"],
            "title_row": structure["title_row"],
            "data_start": structure["data_start"],
            "data_end": structure["data_end"],
            "data_rows": max(structure["data_end"] - structure["data_start"] + 1, 0),
            "columns": structure["col_end"] - structure["col_start"] + 1,
            "time_columns_without_format": protected,
        })

        print(json.dumps({
            "diag": "sheet_beautified",
            "sheet": sheet_name,
            "header_row": structure["header_row"],
            "data_range": [structure["data_start"], structure["data_end"]],
            "column_range": [structure["col_start"], structure["col_end"]],
            "time_columns_without_format": protected,
        }, ensure_ascii=False), file=sys.stderr)

    workbook.save(path)
    return {"theme": theme, "styled": styled, "skipped": skipped}


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: beautify_report.py <report.xlsx> '<payload_json>'")

    excel_path = sys.argv[1]
    if not Path(excel_path).exists():
        raise SystemExit(f"报告文件不存在: {excel_path}")

    theme, exclude_sheets, watermark = parse_payload(sys.argv[2] if len(sys.argv) > 2 else None)

    result = beautify(excel_path, theme, exclude_sheets, watermark)

    print(json.dumps({
        "diag": "beautify_summary",
        "theme": theme,
        "exclude_sheets": exclude_sheets,
        "styled_sheets": [s["name"] for s in result["styled"]],
        "skipped_sheets": result["skipped"],
    }, ensure_ascii=False), file=sys.stderr)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
