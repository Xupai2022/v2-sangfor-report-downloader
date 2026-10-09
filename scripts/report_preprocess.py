#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「表格预处理」阶段（独立阶段）—— 由 preprocess/ 的三个 JS 文件 1:1 移植而来。

位置：**所有表都落成 sheet 之后、数据统计 sheet 取值之前**（build_report.py 的
build_report() 里跑，两个阶段之间只隔几行）。

为什么单独成阶段、而不是塞进取值层：
  它改的是**表格本身**（给事件表加列），不是「数据统计」的某一格。
  按 CELL_REGISTRY.md F2，「数据统计」sheet 的写入地址只由
  stats/write_statistics_sheet.js 决定；这个阶段一行都不碰它，
  所以两者可以各自独立演进、也能各自独立自测。

本阶段做两件事，顺序不能换（第 2 件要用第 1 件的结果）：
  1. 资产表：精确读「IP地址」+「互联网暴露」两列，建 IP -> 内网/外网/未知 映射
  2. 事件表：逐行（表头除外）取「影响资产」的 IP，查映射，在行末尾追加
     「内网外网资产」这一列填进去；查不到填「不在资产表」

失败口径（与报告其它步骤一致：不静默）：
  - 有表头但**缺列** -> 抛错。平台改列名是契约变更，产出一份悄悄少一列的交付物更糟。
  - **空表** -> 不抛错（该时间段确实没数据是合法状态），记 status 并在日志里说明。
  - 映射为空（资产表没数据）-> 不抛错，但日志明确告警：事件表所有行都会标成「不在资产表」。
"""

from openpyxl.utils import get_column_letter

ASSET_SHEET_NAME = '资产表'
IP_HEADER = 'IP地址'
EXPOSURE_HEADER = '互联网暴露'

EVENT_SHEET_NAME = '事件表'
IMPACT_HEADER = '影响资产'
NEW_HEADER = '内网外网资产'

# 表头只可能在前几行；给足余量，但不扫全表（几千行数据没必要碰）。
HEADER_SEARCH_ROWS = 20

# 互联网暴露 -> 「内网外网资产」列要填的值。
# 对照关系由报告口径给定（用户口径），不在这里自由发挥：
# 暴露 = 外网可达，未暴露 = 仅内网。
# 三种之外的值（含空）落到「未知」，并计入 unrecognized 报到日志里，不静默吞掉。
EXPOSURE_TO_SIDE = {'暴露': '外网', '未暴露': '内网', '未知': '未知'}
UNKNOWN_SIDE = '未知'

# 事件表里「影响资产 IP 在资产表查不到」填这个值（用户口径）。
# 与资产表里本来就写着「未知」的行区分开 —— 两种成因不同，混成一个值以后没法复盘。
NOT_IN_ASSET = '不在资产表'

# 新列列宽的上下限，与 build_report.py 的 compute_column_widths 口径一致。
MIN_COL_WIDTH = 10
MAX_COL_WIDTH = 50

# 日志里最多列几个冲突/未识别取值，避免几百行刷屏。
MAX_DETAIL_ITEMS = 5


# ---------------------------------------------------------------------------
# 取值小工具
#
# ⚠️ 这些函数的判空/转字符串口径必须与移植前的 SheetJS 版本逐字一致，
# 否则「表头在哪一行」「哪些行算空行」会整体错位，格式/新列套到别的行上。
# ---------------------------------------------------------------------------

def cell_text(cell):
    """单元格 -> trim 过的字符串。空 / 缺都归一成空串。"""
    if cell is None or cell.value is None:
        return ''
    return js_string(cell.value).strip()


def js_string(value):
    """镜像 JS 的 `String(v)`。

    差别只在数字：JS 里 `String(10)` 是 "10"，Python 的 `str(10.0)` 会给出 "10.0"。
    平台导出的 IP / 暴露值都是文本，走不到这条分支；但列宽计算是按字符串长度算的，
    那里会大量经过数字，所以这里必须对齐，否则列宽会整体偏宽一格。
    """
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def normalize_ip(value):
    """平台有些 IP 列会带后缀（实测告警表的「主机IP」是 `33.33.35.57(未归类组)`），
    这里统一剥掉再比对，好让表格两侧的 IP 用同一把尺子。
    剥完为空（整格就是个括号说明）就退回原值，不做无中生有。
    """
    text = js_string(value if value is not None else '').strip()
    if not text:
        return ''
    import re
    stripped = re.sub(r'[（(][^）)]*[）)]\s*$', '', text).strip()
    return stripped or text


def _used_bounds(ws):
    """sheet 的实际使用范围 (min_row, min_col, max_row, max_col)，1 基；空表返回 None。

    刻意**不用** ws.calculate_dimension()：openpyxl 在普通模式下按实际解析出的
    `<c>` 元素算范围（已实测），但走迭代器拿到的更直接。空表（一个值都没有）
    返回 None，让调用方走「空表是合法状态」那条分支。
    """
    if ws.max_row is None or ws.max_row < 1 or ws.max_column is None or ws.max_column < 1:
        return None
    if ws.max_row == 1 and ws.max_column == 1 and ws['A1'].value is None:
        return None
    return 1, 1, ws.max_row, ws.max_column


def _has_any_value(ws, bounds):
    min_row, min_col, max_row, max_col = bounds
    for row in ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
        for cell in row:
            if cell_text(cell):
                return True
    return False


def _row_texts(ws, row, max_col, min_col=1):
    """取一行的文本值；下标就是列号（0 基），空列补空串，好让列号直接对上。"""
    return [cell_text(ws.cell(row=row, column=col)) for col in range(min_col, max_col + 1)]


def _find_header_row(ws, bounds, required):
    """在前 HEADER_SEARCH_ROWS 行里找同时含所有 required 列名的那一行。

    返回 (row, {列名: 0 基列号}, values)，找不到返回 None。
    列号是 **0 基**（与移植前 `values.indexOf(header)` 的口径一致），报给用户时再转。
    """
    min_row, min_col, max_row, max_col = bounds
    last_row = min(max_row, min_row + HEADER_SEARCH_ROWS - 1)
    for row in range(min_row, last_row + 1):
        values = _row_texts(ws, row, max_col, min_col)
        if all(header in values for header in required):
            return row, {header: values.index(header) for header in required}, values
    return None


def _header_hint(values):
    """表头行的前几列，给报错信息当线索用。"""
    shown = [v for v in values if v][:8]
    return ' / '.join(shown) if shown else '（前几行整行都是空的）'


def _format_list(items, render):
    shown = '、'.join(render(i) for i in items[:MAX_DETAIL_ITEMS])
    return f'{shown} …（共 {len(items)} 个）' if len(items) > MAX_DETAIL_ITEMS else shown


# ---------------------------------------------------------------------------
# 第 1 步：资产表 -> IP 归属映射
# ---------------------------------------------------------------------------

def build_asset_exposure_map(workbook):
    """精确读「资产表」sheet 的「IP地址」与「互联网暴露」两列，建 IP -> 内网/外网 映射。

    三个必须这么写的地方：
    1. **表头不是固定的第 1 行**。平台导出的资产表是「第 1 行空 + 第 2 行表头」形态，
       build_report.py 原样搬入时刻意不删那行空行（下游按第 2 行读表头），
       所以这里按**内容**找表头，不认行号。
    2. **有表头、缺列 = 契约破了，直接抛**。平台把列改名了是需要人工介入的事；
       这时候产出一份悄悄少一列的交付物，比报错糟得多。反过来，**整张表没内容**
       是既有合法状态（该时间段确实没数据），只记状态不抛错。
    3. **同 IP 出现多个暴露值时取首次出现的**，并把冲突原样记进返回值里 ——
       实测样本里就有（10.223.2.62 同时是「未暴露」和「未知」），不静默挑一个。

    :returns: (map: dict[str, str], summary: dict) —— summary 里**不含 map**
    """
    ws = workbook[ASSET_SHEET_NAME] if ASSET_SHEET_NAME in workbook.sheetnames else None
    if ws is None:
        raise ValueError(f'工作簿里没有「{ASSET_SHEET_NAME}」sheet，无法建立 IP -> 内网/外网 映射')

    base = {
        'sheet': ASSET_SHEET_NAME,
        'headerRow': None,
        'ipColumn': None,
        'exposureColumn': None,
        'dataRows': 0,
        'mapped': 0,
        'blankIpRows': 0,
        'conflicts': [],
        'unrecognized': [],
    }

    bounds = _used_bounds(ws)
    if bounds is None:
        return {}, dict(base, status='empty_sheet')

    header = _find_header_row(ws, bounds, [IP_HEADER, EXPOSURE_HEADER])
    if header is None:
        if not _has_any_value(ws, bounds):
            # 空表是合法状态（该时间段确实没资产），不抛错，但调用方要看到 status
            return {}, dict(base, status='empty_sheet')
        first_row_values = _row_texts(ws, bounds[0], bounds[3], bounds[1])
        raise ValueError(
            f'「{ASSET_SHEET_NAME}」sheet 找不到表头列「{IP_HEADER}」+「{EXPOSURE_HEADER}」'
            f'（前 {HEADER_SEARCH_ROWS} 行内都找不到）。'
            f'表里实际的前几列是: {_header_hint(first_row_values)}。'
            '平台把列改名了就属于契约变更，得先确认口径再改这里，不要静默跳过。'
        )

    header_row, columns, _ = header
    ip_col = columns[IP_HEADER]      # 0 基
    exposure_col = columns[EXPOSURE_HEADER]

    mapping = {}
    conflicts = []
    unrecognized = {}
    blank_ip_rows = 0

    for row in range(header_row + 1, bounds[2] + 1):
        ip = normalize_ip(ws.cell(row=row, column=ip_col + 1).value)
        if not ip:
            blank_ip_rows += 1
            continue

        raw = cell_text(ws.cell(row=row, column=exposure_col + 1))
        side = EXPOSURE_TO_SIDE.get(raw)
        if not side:
            # 三种之外（含空）：归到「未知」，但把原始取值记下来报到日志里
            unrecognized[raw] = unrecognized.get(raw, 0) + 1
            side = UNKNOWN_SIDE

        if ip in mapping:
            if mapping[ip] != side:
                conflicts.append({'ip': ip, 'kept': mapping[ip], 'ignored': side})
            continue
        mapping[ip] = side

    summary = dict(base, **{
        'status': 'ok',
        'headerRow': header_row,                      # Excel 行号（1 基）
        'ipColumn': get_column_letter(ip_col + 1),
        'exposureColumn': get_column_letter(exposure_col + 1),
        'dataRows': bounds[2] - header_row,
        'mapped': len(mapping),
        'blankIpRows': blank_ip_rows,
        'conflicts': conflicts,
        'unrecognized': [{'value': v, 'count': c} for v, c in unrecognized.items()],
    })
    return mapping, summary


# ---------------------------------------------------------------------------
# 第 2 步：事件表逐行补「内网外网资产」列
# ---------------------------------------------------------------------------

def append_external_side_column(workbook, mapping):
    """给事件表加「内网外网资产」列。

    对事件表每一行数据（表头行除外）取「影响资产」列的 IP，拿第 1 步建的映射换成
    内网/外网/未知，在**该行末尾**新增一列填进去。

    三个必须这么写的地方：
    1. **只加列，不动已有列**。新列固定落在使用范围的右边界 +1，事件表原有 25 列
       一个都不碰（PPT 引擎与人工核对都按原列位置读）。
    2. **列名要跟表头行对齐**。表头行是按内容找出来的（不认行号），新列的表头
       必须写在**那一行**，否则整列错行。
    3. **查不到就写「不在资产表」**（用户口径），与资产表里本来就写着「未知」的行
       区分开 —— 两种成因不同，混成一个值以后没法复盘。

    影响资产为空的行不写值（连 IP 都没有，写「不在资产表」是无中生有），
    只记数报到日志里。

    :returns: summary: dict
    """
    ws = workbook[EVENT_SHEET_NAME] if EVENT_SHEET_NAME in workbook.sheetnames else None
    if ws is None:
        raise ValueError(
            f'工作簿里没有「{EVENT_SHEET_NAME}」sheet，无法追加「{NEW_HEADER}」列'
        )

    base = {
        'sheet': EVENT_SHEET_NAME,
        'headerRow': None,
        'impactColumn': None,
        'addedColumn': None,
        'header': NEW_HEADER,
        'dataRows': 0,
        'tallies': {},
        'blankImpactRows': 0,
        'normalizedIps': 0,
    }

    bounds = _used_bounds(ws)
    if bounds is None:
        return dict(base, status='empty_sheet')

    header = _find_header_row(ws, bounds, [IMPACT_HEADER])
    if header is None:
        if not _has_any_value(ws, bounds):
            # 空表是合法状态（该时间段确实没事件），不抛错
            return dict(base, status='empty_sheet')
        raise ValueError(
            f'「{EVENT_SHEET_NAME}」sheet 找不到「{IMPACT_HEADER}」列'
            f'（前 {HEADER_SEARCH_ROWS} 行内都找不到）。'
            '平台把列改名了就属于契约变更，得先确认口径再改这里，不要静默跳过。'
        )

    header_row, columns, _ = header
    impact_col = columns[IMPACT_HEADER]      # 0 基
    new_col = bounds[3] + 1                  # 该行末尾：现有列宽的右边再一列（1 基）

    tallies = {}
    blank_impact_rows = 0
    normalized_ips = 0

    # 新列是全新的格，没有既有样式要保，直接整格写字符串即可。
    ws.cell(row=header_row, column=new_col).value = NEW_HEADER

    for row in range(header_row + 1, bounds[2] + 1):
        raw = cell_text(ws.cell(row=row, column=impact_col + 1))
        ip = normalize_ip(raw)
        if ip and ip != raw:
            normalized_ips += 1

        if not ip:
            # 连 IP 都没有，写「不在资产表」是无中生有；留空并记数
            blank_impact_rows += 1
            continue

        value = mapping.get(ip, NOT_IN_ASSET)
        tallies[value] = tallies.get(value, 0) + 1
        ws.cell(row=row, column=new_col).value = value

    # 列宽：补到新列（中间若有缺位给最小宽度，保证下标就是列号），再按内容定宽。
    # 起点是**已有列宽** —— 直接按最小值铺的话，会把 build_report.py 刚按内容算好的
    # 前几列列宽全部重置成 10。
    widths = []
    for index in range(1, new_col):
        dim = ws.column_dimensions.get(get_column_letter(index))
        widths.append(dim.width if dim is not None and dim.width is not None else MIN_COL_WIDTH)
    max_length = len(NEW_HEADER)
    for value in tallies:
        if len(value) > max_length:
            max_length = len(value)
    widths.append(min(max(max_length, MIN_COL_WIDTH), MAX_COL_WIDTH))
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width

    return dict(base, **{
        'status': 'ok',
        'headerRow': header_row,                      # Excel 行号（1 基）
        'impactColumn': get_column_letter(impact_col + 1),
        'addedColumn': get_column_letter(new_col),
        'dataRows': bounds[2] - header_row,
        'tallies': tallies,
        'blankImpactRows': blank_impact_rows,
        'normalizedIps': normalized_ips,
    })


# ---------------------------------------------------------------------------
# 阶段入口
# ---------------------------------------------------------------------------

def preprocess_workbook(workbook, logs=None):
    """跑一遍表格预处理。

    :param workbook: 工作簿（各表已落 sheet；数据统计 sheet 尚未取值）
    :param logs: 可选的列表，日志行会被追加进去（由 build_report.py 回传给 JS 侧打印，
                 保证控制台文案与移植前逐字一致）
    :returns: 阶段汇总（**不含 Map**，要进 stdout 的 JSON）
    """
    logs = logs if logs is not None else []

    logs.append('===== 表格预处理 =====')
    logs.append(
        '[预处理] 进入表格预处理阶段（在所有表落成 sheet 之后、数据统计取值之前）：'
        f'资产表建 IP -> 内网/外网 映射，事件表逐行追加「{NEW_HEADER}」列'
    )

    # --- 第 1 步：资产表 -> 映射 ---
    mapping, asset = build_asset_exposure_map(workbook)
    if asset['status'] == 'empty_sheet':
        logs.append(f"[预处理] {asset['sheet']} sheet 是空的（该时间段无资产数据），没建出任何映射")
    else:
        logs.append(
            f"[预处理] {asset['sheet']}: 表头第 {asset['headerRow']} 行，"
            f"「{IP_HEADER}」={asset['ipColumn']} 列、「{EXPOSURE_HEADER}」={asset['exposureColumn']} 列；"
            f"{asset['dataRows']} 行数据 -> 映射 {asset['mapped']} 个 IP"
            + (f"（IP 为空跳过 {asset['blankIpRows']} 行）" if asset['blankIpRows'] else '')
        )
        if asset['conflicts']:
            # 同一个 IP 在资产表里出现多次且暴露值不一致：取首次出现的，但必须说出来
            logs.append(
                f"[预处理] ⚠️ {asset['sheet']} 有 {len(asset['conflicts'])} 个 IP 暴露值冲突（取首次出现的）: "
                + _format_list(asset['conflicts'], lambda c: f"{c['ip']}（留 {c['kept']}，弃 {c['ignored']}）")
            )
        if asset['unrecognized']:
            # 三种之外（含空）的取值一律按「未知」处理，但原始值要报出来
            logs.append(
                f"[预处理] ⚠️ {asset['sheet']} 的「{EXPOSURE_HEADER}」列有 {len(asset['unrecognized'])} 种取值"
                '不在 暴露/未暴露/未知 之内，按「未知」处理: '
                + _format_list(asset['unrecognized'], lambda u: f"{u['value']!r}×{u['count']}")
            )
    # 映射为空必须单独喊一声：上面的明细在「有表头但一行数据都没有」时也长得像正常，
    # 不喊的话下一步那整列「不在资产表」看上去就像业务结论，而不是缺数据
    if not asset['mapped']:
        logs.append(f"[预处理] ⚠️ 映射为空（0 个 IP）：事件表所有有 IP 的行都会标成「{NOT_IN_ASSET}」")

    # --- 第 2 步：事件表追加列 ---
    event = append_external_side_column(workbook, mapping)
    if event['status'] == 'empty_sheet':
        logs.append(f"[预处理] {event['sheet']} sheet 是空的（该时间段无事件），未追加「{NEW_HEADER}」列")
    else:
        tally_text = ' / '.join(f'{k} {v}' for k, v in event['tallies'].items()) or '（无）'
        logs.append(
            f"[预处理] {event['sheet']}: 表头第 {event['headerRow']} 行，"
            f"「{IMPACT_HEADER}」={event['impactColumn']} 列；{event['dataRows']} 行数据 -> "
            f"末尾新增 {event['addedColumn']} 列「{NEW_HEADER}」"
        )
        logs.append(
            f"[预处理] {event['sheet']} 取值分布: {tally_text}"
            + (f"（影响资产为空留空 {event['blankImpactRows']} 行）" if event['blankImpactRows'] else '')
            + (f"（{event['normalizedIps']} 行的 IP 带后缀，已剥掉后匹配）" if event['normalizedIps'] else '')
        )

    return {'ran': True, 'asset': asset, 'event': event, 'logs': logs}
