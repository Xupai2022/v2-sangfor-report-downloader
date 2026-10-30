#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""源表「标记色行」的识别与透传（用户口径 2026-10-30）。

背景
----
平台导出的漏洞报告用**整行粉红**标出「最近扫描新增漏洞」，表头自己就写着这条约定
（`4-漏洞清单+跟踪记录` 的 R1「发现时间」格，第二行小字：
「填充此单元格为粉红色代表最近扫描新增漏洞」）。它不是条件格式 —— 那张 sheet 里
条件格式规则数是 0，是实打实的静态填充，所以只能逐格看 fill。

问题在于本仓的两道工序都会把填充清掉：`build_report.rebuild_sheet` 只搬「值 + 数字
格式 + 列宽」，`excel_beautifier.styles.reset_cell_styles` 再把整张表的底色清零。
这条粉色因此进不了报告。本模块就是那道「透传」：搬表时认出来、涂到新表上；美化时
在统一底色之后，再把它涂回去。

两个坑（都在 `cell_fill_hex` 里处理掉）
------------------------------------
1. 平台把颜色存成**调色板索引**（`<fgColor indexed="61"/>`），不是 RGB 字面量。
   openpyxl 对这种格子读 `.rgb` 会**直接抛** `Values must be of type <class 'str'>`，
   所以必须先看 `fgColor.type == 'indexed'`。
2. openpyxl 自带的 `COLOR_INDEX[61]` 是 `00993366`（紫）—— 它只认默认调色板。
   这份导出自带 64 色 `<indexedColors>`，61 在里面是 `F2DCDB`。所以调色板必须从
   **工作簿自己的** `wb._colors` 取（openpyxl 解析 `<indexedColors>` 后存在这儿）。
"""
import sys

from openpyxl.styles import PatternFill
from openpyxl.styles.colors import COLOR_INDEX

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__。
sys.dont_write_bytecode = True

# 视为「标记色」的底色 -> 它的业务含义（只用于日志/诊断，不参与判定）。
# 要加新约定就往这里加一行（例如别的客户用另一种颜色标「本次新增」）。
MARKER_COLORS = {
    "F2DCDB": "最近扫描新增漏洞",
}


def _workbook_palette(cell):
    """取这个引用所属工作簿的调色板（64 项 '00RRGGBB'）。

    工作簿里没有自定义 `<indexedColors>` 时退回归 openpyxl 的默认调色板。
    """
    worksheet = getattr(cell, 'parent', None)
    workbook = getattr(worksheet, 'parent', None)
    palette = getattr(workbook, '_colors', None)
    if palette:
        return palette
    return COLOR_INDEX


def cell_fill_hex(cell):
    """一格的实际底色 -> 'RRGGBB'（大写 6 位）；不是纯色填充时返回 None。

    只认 `fill_type == 'solid'`：主题色/渐变/无填充一律当没有底色（不去猜）。
    """
    fill = getattr(cell, 'fill', None)
    if fill is None or fill.fill_type != 'solid':
        return None

    color = fill.fgColor
    color_type = getattr(color, 'type', None)

    if color_type == 'rgb':
        rgb = color.rgb
        if isinstance(rgb, str) and len(rgb) >= 6:
            return rgb[-6:].upper()
        return None

    if color_type == 'indexed':
        index = color.indexed
        palette = _workbook_palette(cell)
        if isinstance(index, int) and 0 <= index < len(palette):
            value = palette[index]
            if isinstance(value, str) and len(value) >= 6:
                return value[-6:].upper()
        return None

    return None


def row_marker_color(sheet, row, col_start=1, col_end=None):
    """该行第一个命中标记色的底色（'RRGGBB'），没有则 None。

    约定是「整行同色」，但这里不要求整行 —— 只要这一行里有一格是标记色就认这一行：
    平台表头那句写的是「填充此单元格为粉红色」，真的只填一格时也不该丢。
    """
    if col_end is None:
        col_end = sheet.max_column or 0
    for col in range(col_start, col_end + 1):
        color = cell_fill_hex(sheet.cell(row=row, column=col))
        if color in MARKER_COLORS:
            return color
    return None


def marked_rows(sheet, first_row, last_row, col_start=1, col_end=None):
    """[first_row, last_row] 区间内所有标记行 -> {行号: 'RRGGBB'}。"""
    found = {}
    for row in range(first_row, last_row + 1):
        color = row_marker_color(sheet, row, col_start, col_end)
        if color:
            found[row] = color
    return found


def marker_fill(color):
    """'RRGGBB' -> solid PatternFill（6 位补 FF 不透明前缀）。"""
    return PatternFill(start_color=f'FF{color}', end_color=f'FF{color}', fill_type='solid')


def apply_marker_fill(sheet, row, col_start, col_end, color):
    """把 [col_start, col_end] 整段涂成标记色（只动 fill，不动字体/边框/值）。"""
    fill = marker_fill(color)
    for col in range(col_start, col_end + 1):
        sheet.cell(row=row, column=col).fill = fill


def marker_label(color):
    """标记色 -> 业务含义（日志用；没登记的颜色原样返回色值）。"""
    return MARKER_COLORS.get(color, color)
