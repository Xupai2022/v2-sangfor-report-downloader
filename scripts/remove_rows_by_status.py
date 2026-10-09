#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按「处置状态」列的值删除整行（事件表 / 漏洞表 / 弱密码表共用一套实现）。

判据完全取自表自身的列，不依赖任何接口拉取的 ID 清单 —— 因此不受分页抖动、
跨系统 ID 对齐的影响。

用法: python remove_rows_by_status.py <table.xlsx> '<payload_json>'

payload_json:
    {
      "column":  "处置状态",             # 必填：按哪一列判
      "values":  ["处置完成（误报）"],     # 必填：命中即整行删除
      "aliases": ["处理状态", "处置情况"], # 可选：精确匹配不到时的子串退路
      "label":   "漏洞表"                 # 可选：只影响日志与返回文案
    }

匹配口径:
    列  表头 strip 后精确相等优先 → 再退到忽略大小写/空格/下划线 → 都不到才走 aliases 子串。
        任何一步命中不止一列就报错退出（不猜）—— 漏洞表里「处置状态」与「处置标签」
        并排出现，靠子串/近似匹配挑列迟早挑错。
    值  整值 strip 后相等即命中；再退一步，**只看括号全半角与空白的差异**
        （"处置完成（误报）" / "处置完成(误报)" / "处置完成（误报） " 算同一个值）——
        平台实测两种括号都可能给，卡死一种就会静默地一条都不删。
        走这一步命中的会在诊断里逐条列出来（matched_via=loose + matched_loose_values），
        别让它悄悄删。
        除此之外不做同义/模糊匹配：「处置完成」不会因为「处置完成（误报）」在里面而被删。

输出:
    stdout: {"removed": n, "total_before": n, "total_after": n, "message": "..."}
    stderr: 每行一个 JSON 诊断对象（列命中情况、状态值分布、命中方式、逐行命中明细）
"""
import json
import sys

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__（须在本地 import 之前）
sys.dont_write_bytecode = True

from openpyxl import load_workbook

from _path_helper import decode_argv
decode_argv()

DEFAULT_COLUMN = "处置状态"
# 逐行命中明细给日志用：命中几千行时没必要把几千条 JSON 塞进 stderr，条数本身在 removed 里
MATCHED_DETAILS_LIMIT = 100


def normalize(value):
    return "" if value is None else str(value).strip()


def canon(text):
    """列名的宽松形态：丢大小写、空格、下划线、连字符。只用于挑列的第二步。"""
    return normalize(text).lower().replace(" ", "").replace("_", "").replace("-", "")


def paren_canon(text):
    """值的"写法无关"形态：全角括号并成半角 + 去掉所有空白（含全角空格）。

    只抹平括号与空白的差异，不做别的归一化 —— 这一步的结果**只用来认值**，
    不做同义/模糊匹配（「处置完成」与「处置完成（误报）」在这里仍不相等）。
    """
    return (
        normalize(text)
        .replace("（", "(")
        .replace("）", ")")
        .replace("　", "")
        .replace(" ", "")
    )


def read_header(sheet):
    return [normalize(cell) for cell in next(sheet.iter_rows(min_row=1, max_row=1, values_only=True))]


def find_column(header, column, aliases):
    """挑列。返回 (列下标, 命中方式)；找不到返回 (None, None)。

    两列同名/同宽松形态时直接退出：宁可让人来定，也不替平台猜哪一列是判据。
    """
    target = normalize(column)

    exact = [i for i, name in enumerate(header) if name and name == target]
    if len(exact) > 1:
        raise SystemExit(f"表头里有 {len(exact)} 列都叫「{column}」(下标 {exact})，不猜，先改口径")
    if len(exact) == 1:
        return exact[0], "exact"

    target_canon = canon(target)
    loose = [i for i, name in enumerate(header) if name and canon(name) == target_canon]
    if len(loose) > 1:
        raise SystemExit(f"表头里有 {len(loose)} 列与「{column}」只差大小写/空格 (下标 {loose})，不猜")
    if len(loose) == 1:
        return loose[0], "canonical"

    alias_canons = [canon(alias) for alias in aliases if canon(alias)]
    hits = []
    for index, name in enumerate(header):
        if not name:
            continue
        name_canon = canon(name)
        if any(alias_canon in name_canon for alias_canon in alias_canons):
            hits.append(index)
    if len(hits) > 1:
        raise SystemExit(f"别名匹配到 {len(hits)} 列 (下标 {hits})，不猜")
    if len(hits) == 1:
        return hits[0], "alias"

    return None, None


def parse_payload(raw):
    """解析第二个参数，返回 (column, values, aliases, label)。"""
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"无法解析删除参数 JSON: {e}")
    if not isinstance(payload, dict):
        raise SystemExit("删除参数必须是一个 JSON 对象")

    column = normalize(payload.get("column")) or DEFAULT_COLUMN

    values = payload.get("values")
    if values is None:
        values = payload.get("status_values")  # 兼容旧调用方的键名
    values = [normalize(v) for v in (values or []) if normalize(v)]
    if not values:
        raise SystemExit("删除参数缺少 values（待删除的处置状态文字）")

    aliases = [normalize(a) for a in (payload.get("aliases") or []) if normalize(a)]
    label = normalize(payload.get("label")) or "表"
    return column, values, aliases, label


def remove_by_values(sheet, column_index, values):
    """按列值删除行。

    返回 (rows_to_keep, removed_count, total_before, matched_details, value_counter, loose_matched)
    """
    value_set = set(values)
    # 括号/空白无关形态 -> 判据原文：命中这一步的记下平台实际写法，别让它悄悄删
    loose_targets = {}
    for value in values:
        loose_targets.setdefault(paren_canon(value), value)

    rows_to_keep = []
    removed_count = 0
    total_before = 0
    matched_details = []
    value_counter = {}
    loose_matched = {}

    for row_index, row in enumerate(sheet.iter_rows(min_row=1, values_only=True)):
        if row_index == 0:
            rows_to_keep.append(row)
            continue
        if not any(normalize(cell) for cell in row):
            continue
        total_before += 1
        value = normalize(row[column_index]) if column_index < len(row) else ""
        value_counter[value] = value_counter.get(value, 0) + 1

        matched_via = None
        if value in value_set:
            matched_via = "exact"
        elif value and paren_canon(value) in loose_targets:
            matched_via = "loose"
            loose_matched[value] = loose_matched.get(value, 0) + 1

        if matched_via:
            removed_count += 1
            if len(matched_details) < MATCHED_DETAILS_LIMIT:
                matched_details.append({
                    "row": row_index + 1,
                    "status_action": value,
                    "matched_via": matched_via,
                })
        else:
            rows_to_keep.append(row)

    return rows_to_keep, removed_count, total_before, matched_details, value_counter, loose_matched


def main():
    if len(sys.argv) < 3:
        raise SystemExit("Usage: remove_rows_by_status.py <table.xlsx> '<payload_json>'")

    excel_path = sys.argv[1]
    column, values, aliases, label = parse_payload(sys.argv[2])

    workbook = load_workbook(excel_path)
    sheet = workbook.active
    header = read_header(sheet)

    column_index, matched_by = find_column(header, column, aliases)
    print(json.dumps({
        "diag": "column_detection",
        "table": label,
        "target_column": column,
        "column_index": column_index,
        "column_header": header[column_index] if column_index is not None and column_index < len(header) else None,
        "matched_by": matched_by,
        "aliases": aliases,
        "target_values": values,
        "header": header
    }, ensure_ascii=False), file=sys.stderr)

    if column_index is None:
        raise SystemExit(f"无法在{label}中找到「{column}」列 (表头: {header})")

    rows_to_keep, removed_count, total_before, matched_details, value_counter, loose_matched = remove_by_values(
        sheet, column_index, values
    )

    if total_before == 0:
        print(json.dumps({
            "removed": 0,
            "total_before": 0,
            "total_after": 0,
            "message": f"{label}为空，无需删除"
        }, ensure_ascii=False))
        return

    # 清除原工作表并写入保留的行（保持原脚本"原地整表重写"的做法：
    # 下游 build_report 的值/数字格式都从这份表现读，重写后仍是它对接口的那份）
    sheet.delete_rows(1, sheet.max_row)
    for row_data in rows_to_keep:
        sheet.append(row_data)
    workbook.save(excel_path)

    # 诊断：逐行命中的状态值 + 全量分布 + 括号/空白差异命中的实际写法，便于核对删除判据
    diagnostic = {
        "diag": "post_remove_value_check",
        "table": label,
        "target_column": header[column_index],
        "target_values": values,
        "removed_count": removed_count,
        "total_before": total_before,
        "total_after": total_before - removed_count,
        "value_distribution": value_counter,
        "matched_details": matched_details,
        "matched_details_truncated": removed_count > len(matched_details)
    }
    if loose_matched:
        diagnostic["matched_loose_values"] = loose_matched
        diagnostic["loose_note"] = "这些值并非判据原文，只靠括号全半角/空白差异命中后删除，平台改写法时留意"
    print(json.dumps(diagnostic, ensure_ascii=False), file=sys.stderr)

    print(json.dumps({
        "removed": removed_count,
        "total_before": total_before,
        "total_after": total_before - removed_count,
        "message": f"已从{label}中删除「{header[column_index]}」= {' / '.join(values)} 的 {removed_count} 行"
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
