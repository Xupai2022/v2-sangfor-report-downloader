#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读暴露面表「文档说明」sheet 的暴露面汇总行 -> 行对象数组。

暴露面表的下载件不是一张规整的行列表：第一张 sheet「文档说明」上半部分是文档标题
与基本信息，真正的汇总表从第 15 行才开始（I..M 五列：服务内容 / 资产类型 / 子类型 /
总数 / 影子资产数），而且这份 sheet 同时是报告里「暴露面」sheet 的来源
（scripts/build_report.py 的 TABLE_SHEET_NAMES['exposed'] 取第一个 worksheet）。

所以这里**不复用** parse_table_rows.py 的「第一行就是表头」口径：那样会把标题行
（第 2 行的 F 列）当成表头。本脚本按投喂口径（用户口径 2026-10-19）做：

   在「文档说明」整张 sheet 里逐格找这些**子类型文字**（整格精确匹配、去首尾空白），
   取它**右侧一个单元格**的值作为「总数」，一个子类型一行。

行对象形态（与 parse_table_rows.py 的四条硬规矩一致，键是文字不是列下标）：

    {"子类型": "根域名资产", "总数": 41}

诊断字段：
  · missingLabels   请求了但整张 sheet 里没有这一格的子类型（平台改了表 / 少了那一行）
  · duplicateLabels 同一个子类型出现了不止一次（取哪一个都是猜，交给取值层报错）
  · invalidLabels   找到了文字，但右侧一格不是数字（平台把「总数」改成了文本 / 占位符）

**一个都没找到时当场抛错**：那说明这不是暴露面表的「文档说明」结构；静默返回空数组
会让 D128 算出 0，与"暴露面确实是 0"长得一模一样（R10 缺数不静默）。部分缺失不抛，
由取值层按 missingLabels 记进错误列表（与缺列同档）。

用法:
    python parse_exposed_summary.py '<payload>'    # 走 B64GZ:（gzip + base64）或 B64: 前缀（中文路径）
payload_json:
    {
      "path":   "<xlsx 绝对路径>",
      "sheet":  "文档说明",                         # 省略 = 第一个 worksheet
      "labels": ["根域名资产", "子域名资产", ...],   # 必填，按投喂顺序
      "match":  "exact"                            # 可选：exact（默认）/ contains
    }

`match` = `contains` 时，格子文字**包含**某一项文字就算命中（投喂口径「找包含『IP资产』
的单元格」），仍然只取**右侧一格**；一格同时命中两项清单文字视为清单有问题、当场抛错
（取哪一项都是猜）。
"""

import json
import math
import sys
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__。
# 放在下面这些本地 import 之前，否则它们自己就已经先把 pycache 写进去了。
sys.dont_write_bytecode = True

# 报错文案里会有「」和中文子类型；PYTHONIOENCODING 由调用方的 workdir.childEnv() 设好，
# 但手工在 GBK 控制台执行时 stdout 可能是 GBK，那样会在**已经读完表**之后抛
# UnicodeEncodeError。只放宽错误处理、不改编码，与 build_report.py 同款。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _path_helper import decode_argv
from build_report import load_source_workbook, pick_source_sheet


def normalize_labels(value):
    """payload 的 `labels` -> 去首尾空白后的字符串数组。

    空 / 非数组 / 混入非字符串都当场抛：本脚本靠这份清单决定读哪几行，
    清单错了要报出来，不能退回"读全部"（那会把「服务内容」「资产类型」也当成一项）。
    """
    if not isinstance(value, list) or not value:
        raise ValueError('labels 必须是非空的字符串数组')
    labels = []
    for label in value:
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f'labels 里有非法项: {label!r}')
        labels.append(label.strip())
    return labels


def is_number(value):
    """整体是数字（int / float，不含 bool），NaN / Inf 不算。"""
    return (isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value))


def normalize_match(value):
    """payload 的 `match` -> 'exact' / 'contains'（默认 exact）。

    拼错 / 其它值当场抛：静默退回 exact 会让「包含」口径变成一条都找不到。
    """
    if value is None:
        return 'exact'
    if value not in ('exact', 'contains'):
        raise ValueError(f"match 只能是 exact 或 contains，收到: {value!r}")
    return value


def parse_exposed_summary(payload):
    """暴露面表「文档说明」sheet -> 汇总行对象数组。返回体见模块头注。"""
    file_path = payload.get('path')
    labels = normalize_labels(payload.get('labels'))
    match = normalize_match(payload.get('match'))
    label_set = set(labels)

    workbook = load_source_workbook(file_path)
    actual_name, sheet = pick_source_sheet(workbook, file_path, payload.get('sheet'))

    # 子类型文字 -> [(文字所在的单元格地址, 右侧一格的地址, 右侧一格的值)]
    #
    # 逐格扫整张 sheet，而不是写死 K16:L28：用户口径是「找到这项文字，取它右边一格」，
    # 行号随平台版式变、列也可能挪动，按文字定位才对得上这条口径。
    hits = {}
    for row in sheet.iter_rows():
        for cell in row:
            if cell.value is None:
                continue
            text = str(cell.value).strip()
            if match == 'exact':
                matched = [text] if text in label_set else []
            else:
                matched = [label for label in labels if label in text]
                if len(matched) > 1:
                    raise ValueError(
                        f'单元格 {cell.coordinate} 同时包含多项清单文字'
                        f'（{"、".join(matched)}）：按「包含」取哪一项都是猜，请收紧清单'
                    )
            if not matched:
                continue
            label = matched[0]
            right = sheet.cell(row=cell.row, column=cell.column + 1)
            hits.setdefault(label, []).append(
                (cell.coordinate, right.coordinate, right.value)
            )

    if not hits:
        raise ValueError(
            f'暴露面表「{actual_name}」里一个子类型文字都没找到: '
            f'{"、".join(labels[:3])}…。平台可能改了表结构（R10 缺数不静默）。'
        )

    missing = []
    duplicate = []
    invalid = []
    rows = []

    for label in labels:
        found = hits.get(label, [])
        if not found:
            missing.append(label)
            continue
        if len(found) > 1:
            duplicate.append(label)
            continue
        _text_cell, value_cell, value = found[0]
        if not is_number(value):
            invalid.append({
                'label': label,
                'cell': value_cell,
                'value': '' if value is None else str(value),
            })
            continue
        # 整数保持整数（openpyxl 对整数值给的就是 int；这里不转 float，避免 41 -> 41.0）
        rows.append({'子类型': label, '总数': value})

    return {
        'sheet': actual_name,
        'header': ['子类型', '总数'],
        'rowCount': len(rows),
        'rows': rows,
        'missingLabels': missing,
        'duplicateLabels': duplicate,
        'invalidLabels': invalid,
    }


def main():
    decode_argv()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: parse_exposed_summary.py '<payload_json>'")

    try:
        payload = json.loads(sys.argv[1])
        if not isinstance(payload, dict):
            raise ValueError('payload 必须是一个 JSON 对象')
        result = parse_exposed_summary(payload)
    except Exception as error:  # noqa: BLE001 —— 统一转成可读 JSON 交给 JS 侧
        print(json.dumps({
            'diag': 'error',
            'message': str(error),
        }, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
