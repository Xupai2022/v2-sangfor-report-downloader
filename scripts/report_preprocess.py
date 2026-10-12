#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「表格预处理」阶段（独立阶段）—— 由 preprocess/ 的三个 JS 文件 1:1 移植而来。

**位置（用户口径 2026-10-12：取值层必须在预处理之后）**：本阶段跑在
**下载之后、解析之前** —— mssw_downloader.js 调本文件的 preprocess_event_file()
**原地改写下载件**，所以 parse* 读到的、ctx 行对象拿到的，都是预处理**之后**的表。
这也是「遏制时长」能被 G7 直接读到（而不是在 event.js 里再实现一遍）的原因。

为什么单独成阶段、而不是塞进取值层：
  它改的是**表格本身**（给事件表加列），不是「数据统计」的某一格。
  按 CELL_REGISTRY.md F2，「数据统计」sheet 的写入地址只由
  stats/write_statistics_sheet.js 决定；这个阶段一行都不碰它，
  所以两者可以各自独立演进、也能各自独立自测。

本阶段做三件事，顺序不能换（第 2 件要用第 1 件的结果，第 4 件要挨着第 2 件追加）：
  1. 资产表：精确读「IP地址」+「互联网暴露」两列，建 IP -> 内网/外网/未知 映射
  2. 事件表：逐行（表头除外）取「影响资产」的 IP，查映射，在行末尾追加
     「内网外网资产」这一列填进去；查不到填「不在资产表」
  4. 事件表：精确取五个时间列，两两做减法，在**第 2 步那列右边**再追加四个时长列
     「遏制时长」「识别时长」「处置时长」「响应时长」（分钟数，2 位小数；用户 2026-10-10 口径）

  ⚠️ 曾经的**第 3 步（告警表剥「主机IP」的括号后缀）已于 2026-10-12 删除**（用户决定）：
  它对取值毫无影响（取值层的 normalizeIp 自己会剥，见 stats/metrics/alarm.js），
  却让同一个「主机IP」在仓库里有两个形态（报告 sheet 一个、ctx 一个）。
  现在交付物里保留平台原样 `172.101.226.10(未归类组)`，剥只发生在比对的那一刻。
  所以下面这两个函数**不能**跟着删 —— 第 1/2 步查 IP 映射时正是靠它们，
  stats/metrics/rows.js 的 normalizeIp 还是它们的手工镜像：
  `strip_bracket_suffix()` / `normalize_ip()`。
  （编号保留 1/2/4 不重排：别处的文档与验收按这几个编号指代这几步。）

失败口径（与报告其它步骤一致：不静默）：
  - 有表头但**缺列** -> 抛错。平台改列名是契约变更，产出一份悄悄少一列的交付物更糟。
  - **空表** -> 不抛错（该时间段确实没数据是合法状态），记 status 并在日志里说明。
  - 映射为空（资产表没数据）-> 不抛错，但日志明确告警：事件表所有行都会标成「不在资产表」。
  - 第 4 步的**缺列不抛错**，理由见 append_duration_columns 头注：那五个时间列是平台近版
    才有的列，客户环境里可能一行都不带，为它把整份报告打掉不值当。
    ⚠️ 这一步不报错 ≠ 下游没事：G7「威胁平均遏制时间」读的就是这一步追加出来的
    「遏制时长」列（见 stats/metrics/event.js 的 averageContainedMinutes）——
    这一列没加上时，G7 会**不写值 + 记错误**，而不是被悄悄数成 0。

⚠️ 第 2 步与第 4 步都**不是幂等的**（新列一律追加在使用范围的右边界 +1），所以本文件
自带一道**幂等闸**：目标表头里已经有「内网外网资产」/ 那四个时长列名时直接跳过、
不重复追加。没有这道闸，同一份下载件被处理两次就会写出重名表头 —— 而
parse_table_rows.py 见到重名表头会抛错，错误现场离病根很远。

⚠️ 提前跑意味着**下载件会被 openpyxl 整本重存一次**（原地改写，`preprocess_event_file`）。
重存的两处已知代价，都验过：
  · **公式格**：openpyxl 只写 `<f>` 不写缓存 `<v>`，公式的缓存值会丢。实测平台导出的事件表
    6050 行 × 28 列里**公式格数为 0**（平台给的是纯值），所以这条在真实数据上不发生；
    哪天真出现公式列，症状是取值层读到空值 —— 那是要报给平台的口径问题，不是这里该兜的。
  · **样式**：搬表（build_report.py 的 rebuild_sheet）本来就不照搬源文件样式、只搬值与数字格式，
    交付物的观感由美化那一步统一套（见 references/report-excel.md），所以重存不掉东西。
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__（与 build_report.py 同款，
# 放在下面的本地 import 之前）。
sys.dont_write_bytecode = True

# 报错文案里会有「」和中文列名；PYTHONIOENCODING 由 workdir.childEnv() 设好，
# 手工在 GBK 控制台执行时 stdout 可能是 GBK —— 只放宽错误处理、不改编码。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import load_workbook
from openpyxl.styles.numbers import is_date_format
from openpyxl.utils import get_column_letter
from openpyxl.utils.datetime import from_excel

from _path_helper import decode_argv

ASSET_SHEET_NAME = '资产表'
IP_HEADER = 'IP地址'
EXPOSURE_HEADER = '互联网暴露'

EVENT_SHEET_NAME = '事件表'
IMPACT_HEADER = '影响资产'
NEW_HEADER = '内网外网资产'

# --- 第 4 步：事件表四个时长列的列名（新列名 / 被减数 / 减数）-----------------
# 五个源列名与四个新列名都是**用户 2026-10-10 投喂的口径**，逐个精确取，不按子串匹配。
# 「遏制时长」这个新列名另有一处下游读者：G7「威胁平均遏制时间」
# （stats/metrics/event.js 的 averageContainedMinutes 直接读 ctx 里的这一列）——
# 本文件的常量是列名的唯一出处，那边写的是字面量，改名要两处一起改。
CREATED_HEADER = '事件创建时间'
CHECKOUT_HEADER = '组件检出时间'
CLOSED_LOOP_HEADER = '事件闭环时间'
CONTAINED_HEADER = '事件遏制时间'
EXPERT_HEADER = '专家研判时间'

# 顺序即追加到事件表末尾的列顺序（第 2 步的「内网外网资产」之后）。
# 同一对时间列可以被两个新列复用（「事件创建时间」既是识别时长的被减数、也是处置时长的减数；
# 「组件检出时间」是识别与响应的减数，「专家研判时间」是遏制与响应的减/被减数），
# 所以这里描述的是「对」而不是「列清单」。
DURATION_COLUMNS = (
    ('遏制时长', CONTAINED_HEADER, EXPERT_HEADER),      # 事件遏制时间 - 专家研判时间
    ('识别时长', CREATED_HEADER, CHECKOUT_HEADER),      # 事件创建时间 - 组件检出时间
    ('处置时长', CLOSED_LOOP_HEADER, CREATED_HEADER),   # 事件闭环时间 - 事件创建时间
    ('响应时长', EXPERT_HEADER, CHECKOUT_HEADER),       # 专家研判时间 - 组件检出时间
)

# 第 4 步用到的五个源列（去重后），缺任何一个都算「这一列算不出来」。
DURATION_SOURCE_HEADERS = tuple(
    dict.fromkeys(header for _, left, right in DURATION_COLUMNS for header in (left, right))
)

# 平台导出的时间戳形态：实测 `2026-07-22 10:09:39`（60xx 行 100% 是这个形态）。
# 秒缺失的 `2026-07-22 10:09` 也收 —— 拼第二个格式的代价只是多一次 try，
# 而写进表里的都是分钟的差值，两种形态算出来的是同一个量。
# **不猜别的写法**（`2026/07/22`、`07-22` 之类）：解析不出来就留空 + 记数报到日志，
# 按「猜一个日期」写进交付物比留空糟得多。
TIME_FORMATS = ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M')

# 平台拿横杠当「无 / 不适用」的占位符（用户口径：这种代表空值，跳过）。
# 与 stats/metrics/ranking.js 的 PLACEHOLDER_RE 同一把尺子（半角 / 全角 / 长破折号），
# 免得同一个 `-` 在报告的一处算空、另一处算一种取值。
PLACEHOLDER_PATTERN = re.compile(r'^[-—－–]+$')

# 「主机IP」值尾部的括号说明。实测形态：`172.101.226.10(未归类组)` /
# `10.244.96.104(管理IP范围)`（真实导出 10 万行里 100% 带后缀）。
# 只认**行尾**那一处，全半角括号都收；中间带括号的 IP 不受影响。
BRACKET_SUFFIX_PATTERN = re.compile(r'[（(][^）)]*[）)]\s*$')

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


def strip_bracket_suffix(text):
    """剥掉 IP 值**行尾**的括号说明：`172.101.226.10(未归类组)` -> `172.101.226.10`。

    两条边界都紧（这个函数的结果会**写回单元格**，不是只用来比对）：
      - 没带括号后缀的**原样返回**，连首尾空白都不碰 —— 免得把平台的写法
        顺手洗成我们的写法（写回的差异会一路进交付物）；
      - 剥完为空（整格就是个括号说明，如 `(未归类组)`）**退回原值**，不做无中生有。

    与 normalize_ip 共用同一把尺子：写回表里的 IP 与拿去资产表查归属的 IP
    必须一致，否则同一个值一半查得到、一半查不到。
    """
    if not text:
        return text
    stripped = BRACKET_SUFFIX_PATTERN.sub('', text)
    if stripped == text:
        return text
    stripped = stripped.strip()
    return stripped or text


def normalize_ip(value):
    """平台有些 IP 列会带后缀（实测告警表的「主机IP」是 `33.33.35.57(未归类组)`），
    这里统一剥掉再比对，好让表格两侧的 IP 用同一把尺子。
    剥完为空（整格就是个括号说明）就退回原值，不做无中生有。
    """
    text = js_string(value if value is not None else '').strip()
    if not text:
        return ''
    return strip_bracket_suffix(text)


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

    header_row, columns, header_values = header

    # 幂等闸：这一列已经在表头里了（同一份下载件被预处理了第二次）。
    # 再追加一次会写出重名表头，而 parse_table_rows.py 见到重名表头会抛错 ——
    # 现场离病根很远，所以在这里直接跳过，宁可什么都不做。
    if NEW_HEADER in header_values:
        return dict(base, status='already_present', headerRow=header_row,
                    impactColumn=get_column_letter(columns[IMPACT_HEADER] + 1))

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
# 第 4 步：事件表追加「遏制时长 / 识别时长 / 处置时长 / 响应时长」四列
# ---------------------------------------------------------------------------

def parse_time_cell(cell):
    """时间格 -> (datetime, 'ok') / (None, 'blank') / (None, 'unparsed')。

    **三种形态都要收**，这是这一步最容易踩空的地方（实测三种都真出现过）：
      · 文本 `2026-07-22 10:09:39` —— 平台导出原样；
      · 真 datetime —— 从落盘的 xlsx **读回来**时，openpyxl 会把「带日期格式的序列号」
        还原成 datetime（实测 outputs/20261010_152149 的「事件创建时间」6050 行全是这样）；
      · **裸序列号（float + 日期格式）** —— 报告是**边构建边预处理**的：build_report.py 的
        rebuild_sheet 按 to_serial_number 的口径把时间列写成序列号（那是刻意保留的旧行为，
        见那个函数的说明），此刻格子里的值就是一个 float。只认前两种的话，真实流水线里
        这五列**全部**解析不出来，交付物上是三列空的时长 —— 而那条路上跑出来的表，
        读回来又是 datetime，肉眼核对时反倒看不出问题。
    序列号只在**该格自带日期格式**时才换算：一个 General 格式的数字待在时间列里
    说明它根本不是个时间，报「解析不出来」比猜一个日期诚实。

    三态分开是这一步的关键：**空值跳过是用户口径**（`-` 代表空），而解析不出来是
    「平台换了时间格式」—— 那是契约变更，跳过它的同时必须报到日志里，不能与
    「这行本来就没时间」混成一个数（两者成因不同，混了以后没法复盘）。
    """
    value = cell.value
    if isinstance(value, datetime):
        return value, 'ok'
    if isinstance(value, (int, float)) and not isinstance(value, bool) \
            and is_date_format(cell.number_format):
        return from_excel(value), 'ok'
    text = (js_string(value) if value is not None else '').strip()
    if not text or PLACEHOLDER_PATTERN.match(text):
        return None, 'blank'
    for fmt in TIME_FORMATS:
        try:
            return datetime.strptime(text, fmt), 'ok'
        except ValueError:
            continue
    return None, 'unparsed'


def _missing_headers(ws, bounds, required):
    """在前 HEADER_SEARCH_ROWS 行里找**最像表头**的那一行，回报缺了哪几个列名。

    只给「缺列不抛错」那条路当诊断用（哪一列找不到得说清楚，否则用户不知道该等谁来改）。
    取「命中最多」的那一行而不是第一行：数据行里偶尔会有一格正好等于某个列名的文字，
    取命中最多的一行对这种噪声最稳。
    """
    min_row, min_col, max_row, max_col = bounds
    last_row = min(max_row, min_row + HEADER_SEARCH_ROWS - 1)
    best_row, best_hits = None, 0
    for row in range(min_row, last_row + 1):
        values = _row_texts(ws, row, max_col, min_col)
        hits = sum(1 for header in required if header in values)
        if hits > best_hits:
            best_row, best_hits = row, hits
    if best_row is None:
        return None, list(required)
    values = _row_texts(ws, best_row, max_col, min_col)
    return best_row, [header for header in required if header not in values]


def append_duration_columns(workbook):
    """给事件表追加「遏制时长」「识别时长」「处置时长」「响应时长」四列。

    逐个精确取这五个时间列，两两做减法，把**分钟数（2 位小数）**写进新列
    （用户口径；「响应时长」是 2026-10-10 追加的第四条）：

    ```text
      遏制时长 = 事件遏制时间 - 专家研判时间
      识别时长 = 事件创建时间 - 组件检出时间
      处置时长 = 事件闭环时间 - 事件创建时间
      响应时长 = 专家研判时间 - 组件检出时间
    ```

    五个必须这么写的地方：
    1. **必须排在第 2 步之后**。新列落在使用范围的右边界 +1，而第 2 步刚往同一张表
       末尾追加了「内网外网资产」—— 先跑这一步的话，四列时长会插到它的左边，
       交付物里的列序就与用户看到的说明对不上了。
    2. **按行独立跳过，不整列跳过**。某行只要有一个源格是空 / `-`（占位符），
       这一对就算不出来 —— 那一格留空，但**同一行的另外几对照算**（用户口径：
       有 `-` 的就不算，直接跳过）。留空是有意的：`0 分钟` 与「算不出来」在报告上
       必须是两个样子，填 0 就把「这段时间没数据」说成了「瞬间完成」。
    3. **空值只有两种**：空串 / 纯横杠（见 parse_time_cell）。解析不出来的值（平台换
       时间格式）同样留空，但**计数 + 记样例**报到日志里 —— 不报的话，一整列空
       看上去就像「平台这段时间真的没有遏制数据」。
       **算出来是负数的同样留空**（用户口径 2026-10-12）：时长不可能为负，负差值说明
       至少有一个源列不是要算的那个时间（取错列 / 两列对调 / 回填了脏数据）。
       它走第三条计数 `negative`，与「空值」「解析失败」分得开。
    4. **只加列，不动已有列**。原有列与第 2 步那列一个都不碰（PPT 引擎与人工核对都按
       原列位置读；事件表的列集本身是数据相关的，所以这里也不写死"原有多少列"）。
    5. **缺列不抛错，但要吼**（与第 3 步的告警表同一条口径，理由不同）：这五个时间列
       （尤其「事件遏制时间」「专家研判时间」是平台近版才有的列）在客户环境里可能一行都不带，
       为它把整份报告打掉不值当；但缺了必须让用户看见（日志明写「这次没算时长、缺哪几列」），
       不能悄悄少四列。
       ⚠️ **「不抛错」只是这一步的失败口径，不代表下游看不见**：G7「威胁平均遏制时间」
       （stats/metrics/event.js 的 averageContainedMinutes）读的就是这里追加出来的
       「遏制时长」列 —— 这一步没加出这一列时，G7 会不写值 + 记错误（不是悄悄数成 0）。
       从 2026-10-12 起本步骤跑在**解析之前**（下载件原地改写），所以这一列真的会进 ctx，
       取值层不再另写一份实现。

    :returns: summary: dict（不含任何 openpyxl 对象，要进 stdout 的 JSON）
    """
    ws = workbook[EVENT_SHEET_NAME] if EVENT_SHEET_NAME in workbook.sheetnames else None
    if ws is None:
        raise ValueError(
            f'工作簿里没有「{EVENT_SHEET_NAME}」sheet，无法追加时长列'
        )

    base = {
        'sheet': EVENT_SHEET_NAME,
        'headerRow': None,
        'sourceColumns': {},
        'addedColumns': [],
        'dataRows': 0,
        'filled': {},
        'blankSkipped': {},
        'unparsedSkipped': {},
        'negative': {},
        'unparsedSamples': [],
    }

    bounds = _used_bounds(ws)
    if bounds is None:
        return dict(base, status='empty_sheet')

    header = _find_header_row(ws, bounds, list(DURATION_SOURCE_HEADERS))
    if header is None:
        if not _has_any_value(ws, bounds):
            # 空表是合法状态（该时间段确实没事件），不抛错
            return dict(base, status='empty_sheet')
        # 有事件行但凑不齐这五列：不抛错（见头注第 5 条），把缺的列名报出去
        row, missing = _missing_headers(ws, bounds, DURATION_SOURCE_HEADERS)
        return dict(base, status='no_column', headerRow=row, missing=missing)

    header_row, columns, header_values = header

    # 幂等闸：四个时长列已经在表头里了（同一份下载件被预处理了第二次）。
    # 同第 2 步：再追加一次会写出重名表头，parse_table_rows.py 会抛错，直接跳过。
    if all(name in header_values for name, _, _ in DURATION_COLUMNS):
        return dict(base, status='already_present', headerRow=header_row,
                    sourceColumns={
                        name: get_column_letter(columns[name] + 1)
                        for name in DURATION_SOURCE_HEADERS
                    },
                    addedColumns=[
                        get_column_letter(header_values.index(name) + 1)
                        for name, _, _ in DURATION_COLUMNS
                    ])

    source_cols = {header: columns[header] for header in DURATION_SOURCE_HEADERS}

    # 第 2 步追加的列已经在用范围里，所以这里是「三列时长」的起点
    first_new_col = bounds[3] + 1
    added_cols = [first_new_col + index for index in range(len(DURATION_COLUMNS))]

    filled = {name: 0 for name, _, _ in DURATION_COLUMNS}
    blank_skipped = {name: 0 for name, _, _ in DURATION_COLUMNS}
    unparsed_skipped = {name: 0 for name, _, _ in DURATION_COLUMNS}
    negative = {name: 0 for name, _, _ in DURATION_COLUMNS}
    unparsed_samples = []
    # 同一个坏格会被多对用到（「组件检出时间」既是识别的减数、也是响应的减数），
    # 样例按「格子」去重，免得同一个格子在日志里报两遍
    seen_unparsed = set()

    for (name, _, _), col in zip(DURATION_COLUMNS, added_cols):
        ws.cell(row=header_row, column=col).value = name

    for row in range(header_row + 1, bounds[2] + 1):
        # 每个源列一行只读一次：同一行的四对里「事件创建时间」「组件检出时间」「专家研判时间」
        # 都会出现两次
        parsed = {
            header: parse_time_cell(ws.cell(row=row, column=col + 1))
            for header, col in source_cols.items()
        }

        for (name, left, right), col in zip(DURATION_COLUMNS, added_cols):
            left_value, left_kind = parsed[left]
            right_value, right_kind = parsed[right]

            if left_kind == 'blank' or right_kind == 'blank':
                # 用户口径：`-` 代表空值 -> 这一对不算，直接跳过（同一行别的对照算）
                blank_skipped[name] += 1
                continue
            if left_kind == 'unparsed' or right_kind == 'unparsed':
                unparsed_skipped[name] += 1
                for header, kind in ((left, left_kind), (right, right_kind)):
                    if kind != 'unparsed' or (row, header) in seen_unparsed:
                        continue
                    seen_unparsed.add((row, header))
                    if len(unparsed_samples) < MAX_DETAIL_ITEMS:
                        unparsed_samples.append({
                            'row': row,
                            'column': header,
                            'value': cell_text(ws.cell(row=row, column=source_cols[header] + 1)),
                        })
                continue

            # 分钟数、2 位小数（用户口径）。用 Python 的 round：`x.xx5` 这种正好卡在
            # 半格上的差值极少见（差值是秒级的整数秒 / 60），真卡上时按银行家舍入 ——
            # 与 vendor 那份 event_transformer.py 的 round(x, 2) 是同一条口径。
            minutes = round((left_value - right_value).total_seconds() / 60, 2)
            if minutes < 0:
                # 负差值**不合法 -> 该格留空**（用户口径 2026-10-12，从前是照写负号）。
                # 时长在业务上不可能为负：算出来是负的只说明这两个时间列里至少有一列
                # 不是我们要的那个时间（取错列 / 平台把两列的值对调了 / 回填了脏数据）——
                # 写一个负数进交付物，等于把"这行没数据"说成了"提前完成"。
                # 与空值 / 解析失败一样留空，但**单列一个计数**报到日志里：
                # 整列有一半是负数通常意味着取错了列，这个信号不能和别的混成一个数。
                negative[name] += 1
                continue
            ws.cell(row=row, column=col).value = minutes
            filled[name] += 1

    # 列宽：只补新追加的四列（原有列的列宽一个都不动，那几列最终由美化阶段按内容定）
    for (name, _, _), col in zip(DURATION_COLUMNS, added_cols):
        width = min(max(len(name) + 2, MIN_COL_WIDTH), MAX_COL_WIDTH)
        ws.column_dimensions[get_column_letter(col)].width = width

    return dict(base, **{
        'status': 'ok',
        'headerRow': header_row,                  # Excel 行号（1 基）
        'sourceColumns': {header: get_column_letter(col + 1) for header, col in source_cols.items()},
        'addedColumns': [get_column_letter(col) for col in added_cols],
        'dataRows': bounds[2] - header_row,
        'filled': filled,
        'blankSkipped': blank_skipped,
        'unparsedSkipped': unparsed_skipped,
        'negative': negative,
        'unparsedSamples': unparsed_samples,
    })


# ---------------------------------------------------------------------------
# 各步的日志（preprocess_event_file 专用；每一步一份，文案就是控制台上那几句）
# ---------------------------------------------------------------------------

def _log_asset_summary(logs, asset):
    """第 1 步的日志。"""
    if asset['status'] == 'no_asset_file':
        logs.append(
            f"[预处理] 这次没有资产表下载结果：不建 IP -> 内网/外网 映射，"
            f"事件表所有有 IP 的行都会标成「{NOT_IN_ASSET}」"
        )
        return
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


def _log_event_summary(logs, event):
    """第 2 步的日志。"""
    if event['status'] == 'already_present':
        logs.append(
            f"[预处理] {event['sheet']} 里已经有「{NEW_HEADER}」列（表头第 {event['headerRow']} 行），"
            '这次不再追加（幂等闸：重复追加会写出重名表头）'
        )
        return
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


def _log_duration_summary(logs, duration):
    """第 4 步的日志。"""
    if duration['status'] == 'already_present':
        logs.append(
            f"[预处理] {duration['sheet']} 里已经有时长列（表头第 {duration['headerRow']} 行），"
            '这次不再追加（幂等闸：重复追加会写出重名表头）'
        )
        return
    if duration['status'] == 'empty_sheet':
        logs.append(
            f"[预处理] {duration['sheet']} sheet 是空的（该时间段无事件），未追加时长列"
        )
    elif duration['status'] == 'no_column':
        # 不抛错（见那一步的头注第 5 条），但必须吼：不吼的话「这次没算时长」与
        # 「这次算了但每行都缺时间」在日志里长得一模一样
        logs.append(
            f"[预处理] ⚠️ {duration['sheet']} 里凑不齐时长列要用的时间列（缺 "
            + '、'.join(f'「{name}」' for name in duration['missing'])
            + f"；表头第 {duration['headerRow']} 行）：这次**没算**"
            + '、'.join(name for name, _, _ in DURATION_COLUMNS)
            + f"，取值层读不到这几列（报告里也没有）。"
            + f"其中「{DURATION_COLUMNS[0][0]}」是 G7「威胁平均遏制时间」要读的列 —— "
            '这一列没算出来时 G7 会不写值 + 记错误，不会被悄悄数成 0。'
            '为它把整份报告打掉不值当 —— 但若本该有列名，那就是平台改了列名，请人工确认。'
        )
    else:
        pairs_text = ' / '.join(
            f"{name} = {left} - {right}" for name, left, right in DURATION_COLUMNS
        )
        logs.append(
            f"[预处理] {duration['sheet']}: 表头第 {duration['headerRow']} 行，"
            f"{duration['dataRows']} 行数据 -> 末尾新增 "
            + '、'.join(f"{col} 列「{name}」" for (name, _, _), col
                        in zip(DURATION_COLUMNS, duration['addedColumns']))
            + f"（分钟数，2 位小数）：{pairs_text}"
        )
        for (name, _, _), col in zip(DURATION_COLUMNS, duration['addedColumns']):
            logs.append(
                f"[预处理] {duration['sheet']} {col} 列「{name}」: "
                f"算得 {duration['filled'][name]} 行"
                + (f"（两个时间有一格为空 / 占位符「-」跳过 {duration['blankSkipped'][name]} 行）"
                   if duration['blankSkipped'][name] else '')
                + (f"（⚠️ 时间解析不出来跳过 {duration['unparsedSkipped'][name]} 行）"
                   if duration['unparsedSkipped'][name] else '')
                + (f"（⚠️ 负差值 {duration['negative'][name]} 行 —— 时长不可能为负，"
                   f"那几格按不合法留空；整列一半是负数多半是取错了列）"
                   if duration['negative'][name] else '')
            )
        if duration['unparsedSamples']:
            logs.append(
                f"[预处理] ⚠️ {duration['sheet']} 有时间格解析不出来（按空处理、留空），样例: "
                + _format_list(
                    duration['unparsedSamples'],
                    lambda s: f"第{s['row']}行「{s['column']}」={s['value']!r}"
                )
            )


# ---------------------------------------------------------------------------
# 下载件级入口：事件表那三步提前到解析之前跑
# ---------------------------------------------------------------------------

def _set_first_sheet_title(workbook, title):
    """把工作簿第一个 worksheet 改名为 title（返回原标题）。

    这几步函数一律按 sheet 名（「资产表」/「事件表」）找表，而下载件里那张表带的是
    平台自己的名字（实测事件表导出叫 `Sheet`），所以先改名再调、用完改回去。
    交付物里那张 sheet 叫什么由模板决定，与这里无关。
    """
    ws = workbook.worksheets[0]
    original = ws.title
    if original != title:
        if title in workbook.sheetnames:
            raise ValueError(
                f'工作簿里已经有一张叫「{title}」的 sheet（{original} 之外）: '
                + '、'.join(workbook.sheetnames)
            )
        ws.title = title
    return original


def preprocess_event_file(asset_path, event_path, logs=None):
    """事件表那三步（建映射 / 加「内网外网资产」/ 加四个时长列）跑在解析之前，**原地改写下载件**。

    用户口径 2026-10-12：取值层必须在预处理之后 —— ctx 里的事件表行对象要能直接读到
    「遏制时长」。这一列是追加出来的，所以只能在解析前落到文件上
    （与 scripts/remove_rows_by_status.py 同款：openpyxl 读进来、改完 save 回原路径）。

    资产表只读、不改（只拿它建 IP -> 内网/外网 映射）。asset_path 为空按「没有资产表」
    处理（不建映射、所有行标「不在资产表」），与资产表是空表同一条路。

    :param asset_path: 资产表下载件（scripts/process_asset_table.py 加工过的那个）
    :param event_path: 事件表下载件 —— **会被原地改写**
    :param logs: 可选的日志列表
    :returns: 阶段汇总 {ran, asset, event, duration, logs}
    """
    logs = logs if logs is not None else []

    if not event_path:
        raise ValueError('缺少事件表下载结果，无法跑事件表预处理')

    logs.append('===== 表格预处理（下载之后、解析之前）=====')
    logs.append(
        '[预处理] 进入表格预处理阶段（下载之后、解析之前）：'
        f'资产表建 IP -> 内网/外网 映射，事件表逐行追加「{NEW_HEADER}」列与四个时长列'
        f'（{"、".join(name for name, _, _ in DURATION_COLUMNS)}）。'
    )

    if asset_path:
        asset_workbook = load_workbook(asset_path, data_only=True)
        _set_first_sheet_title(asset_workbook, ASSET_SHEET_NAME)
        mapping, asset = build_asset_exposure_map(asset_workbook)
    else:
        mapping = {}
        asset = {
            'sheet': ASSET_SHEET_NAME,
            'status': 'no_asset_file',
            'headerRow': None,
            'ipColumn': None,
            'exposureColumn': None,
            'dataRows': 0,
            'mapped': 0,
            'blankIpRows': 0,
            'conflicts': [],
            'unrecognized': [],
        }
    _log_asset_summary(logs, asset)

    event_workbook = load_workbook(event_path)
    if len(event_workbook.worksheets) > 1:
        # 只改第一张：build_report.py 的搬表与 parse_table_rows.py 读的都是第一张
        logs.append(
            f'[预处理] ⚠️ 事件表下载件里有 {len(event_workbook.worksheets)} 张 sheet，'
            f'只处理第一张「{event_workbook.worksheets[0].title}」'
        )
    original_title = _set_first_sheet_title(event_workbook, EVENT_SHEET_NAME)

    event = append_external_side_column(event_workbook, mapping)
    _log_event_summary(logs, event)
    duration = append_duration_columns(event_workbook)
    _log_duration_summary(logs, duration)

    _set_first_sheet_title(event_workbook, original_title)
    event_workbook.save(event_path)
    logs.append(f'[预处理] 事件表下载件已原地改写: {event_path}')

    return {
        'ran': True,
        'asset': asset,
        'event': event,
        'duration': duration,
        'logs': logs,
    }


def main():
    decode_argv()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: report_preprocess.py '<payload_json>'")

    logs = []
    try:
        payload = json.loads(sys.argv[1])
        if not isinstance(payload, dict):
            raise ValueError('payload 必须是一个 JSON 对象')
        result = preprocess_event_file(payload.get('asset'), payload.get('event'), logs)
    except Exception as error:  # noqa: BLE001 —— 统一转成可读 JSON 交给 JS 侧
        print(json.dumps({
            'diag': 'error',
            'message': str(error),
            'logs': logs,
        }, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
