#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把各份总表的下载结果合并成一份 {客户}_report.xlsx —— 本仓库**唯一**的 Excel 写入口。

本文件是 report_writer.js + preprocess/ 的 openpyxl 重写版。改写动机是去掉仓库唯一的
npm 依赖（SheetJS 社区版），顺带修掉它解决不了/悄悄丢掉的三处东西，见「与 SheetJS 版的差异」。

各 sheet 的写入形态：

  资产表    ← 资产工作簿的第一个 worksheet，**原样搬入**（不重排版）
              保留平台导出的「第 1 行空 + 第 2 行表头」形态 ——
              下游消费方按第 2 行读表头，这里千万不能"顺手"把首行空行删掉。
  告警表    ← 第 1 行表头、第 2 行起数据，列宽按内容自适应（10~50 字符）
  事件表    ← 同告警表
  内网漏洞表 ← 同告警表（一个下载件搬出两张，见下表「内网漏洞表 / 互联网漏洞表」）
  互联网漏洞表 ← 同内网漏洞表
  弱密码表   ← 同告警表（平台导出的「弱密码」sheet 也是第 1 行表头）
  暴露面     ← 同告警表（2026-10-15 接入。⚠️ 平台导出的「暴露面」表**没有样本**，
              按第 1 行表头的假设走 rebuild；拿到样本后若发现它是"第 1 行空 + 第 2 行表头"
              那种形态，要改成 copy_sheet_verbatim 那条路 —— 否则表头会被当成数据行）

> 2026-10-16 起漏洞表是**一个下载件对应两张 sheet**：平台把漏洞表拆成内网/外网两份报表
> （下载产物是 zip，见 scripts/extract_vuln_report.py），那一步已经把两份合进**一个**
> 工作簿的两张 sheet，所以搬表这边只是「同一个 filePath、按 sheet 名搬两次」。
> 两张 sheet **保持各自原表头**（30 列 / 21 列），**不做并集对齐** —— 用户口径 2026-10-16
> 要的就是分开看。取值层那边按同一份三列白名单把两份的行拼成 ctx.vulnRows（全表 = 两份相加）。

告警表/事件表/内网漏洞表/互联网漏洞表/弱密码表/暴露面是「值搬过去 + 数字格式另还原」（见 collect_source_rows）：
平台导出里时间列是带日期格式的序列号，只搬值会让它在报告里显示成 46225.42。资产表不走这条
路径，值/格式/列宽/行高/合并单元格随 sheet 一起原样保留。
（漏洞表/弱密码表的时间列实测是**字符串**，本来就没有数字格式可还原。）

**唯一一种会被搬过去的填充**：标记色格（漏洞表的粉红 = 「最近扫描新增漏洞」，平台把这条
约定写在了表头里）。按**格**透传而不是按行，识别与涂色都在 scripts/marker_colors.py；
只认同一种显式约定、不搬其它字体/填充/边框 —— 其余观感仍由美化那一步统一决定。

各表落成 sheet 之后，落盘之前还有一步：

  数据统计取值（writes 段）           写「数据统计」sheet

> **2026-10-12 起本文件不再跑任何表格预处理。** 从前这里有一个「告警表『主机IP』剥括号后缀」
> 的步骤（`preprocess_workbook(steps=('alarm',))`），现已删除：那一步对取值毫无影响
> （取值层的 normalizeIp 自己会剥，见 stats/metrics/alarm.js），却让同一个「主机IP」
> 在仓库里有两个形态。删掉之后交付物里保留平台原样 `172.101.226.10(未归类组)`。
> 表格预处理现在只有一处 —— **下载之后、解析之前**（mssw_downloader.js 调
> mssw_preprocess.js -> report_preprocess.preprocess_event_file，**原地改写下载件**，
> 追加「内网外网资产」列与五个时长列）。用户口径 2026-10-12「取值层必须在预处理之后」
> 就是这条：那几列必须在 parse* 之前落到文件上，ctx 里的行对象才读得到。
> **不能改到这里来跑**：那几步是往行末盲追加，引擎里跑会写出重名表头
> （parse_table_rows.py 见到重名会抛错），而报告 sheet 已经是搬表搬进来的成品了。

搬表读的是**磁盘上那个 xlsx**（`load_source_workbook` / `pick_source_sheet`），而下载件在解析之前就被改写过，
所以报告 sheet 会自动带上预处理追加的那几列 —— 不存在"两处拼接"。
**搬表就是搬表**：报告里那些 sheet 与平台导出逐格相同，本文件不改任何一格表内容，
谁要在合并阶段加一道"顺手清洗"，先想清楚人工核对时报告与取值层对不上会怎么样
（scripts/verify_write_layer.py 的【3.6】正是钉这条的）。

「数据统计」sheet 的写入**地址与取值口径**由 stats/write_statistics_sheet.js 决定
（CELL_REGISTRY.md R14 / F2）；本文件只执行它给出的 writes 计划，不自己决定写哪一格。
不管有没有 writes，单元格地址集合都不变（R1 单元格冻结）。

合并写完后还有一步（在 JS 侧调 scripts/beautify_report.py）：给除「数据统计」外的 sheet
套统一视觉规范（宋体 + 深蓝表头 + 浅蓝底，主题见 excel_beautifier/themes）。

用法:
    python build_report.py '<payload>'           # 整包走 B64GZ:（gzip + base64），
                                                 # 见 path_helper.js / _path_helper.py；
                                                 # 纯 B64: 也认，但写入计划一长就会撞
                                                 # Windows 32767 字符的命令行上限
payload_json:
    {
      "template": "<模板 xlsx 绝对路径>",
      "output":   "<产物 xlsx 绝对路径>",
      "tables":   {"asset": {"filePath": "..."}, "alarm": {...}, "event": {...}, "vuln": {...}},
      "statistics": {"writes": [{"addr": "J1", "value": "...", "mode": "value"}]}
    }

输出:
    stdout: {"sheets", "statistics", "logs"} 这一次 build 的全部结果
    stderr: 失败时 {"diag":"error","message","logs"}（logs 是失败前已产生的日志行，
            好让调用方把用户已经"看过"的部分照常打出来）

与 SheetJS 版的差异（均为**有意的**，逐条说明）:
    1. 「数据统计」sheet 会带上模板原有的单元格样式。SheetJS 社区版能读样式但不能写样式，
       所以旧版交付物里这一 sheet 是默认 Calibri 裸样式 —— 那其实违反了 MIGRATION.md R2
       「不改表头、公式、合并单元格、格式」。openpyxl 整个工作簿读写，模板格式自然保住。
       （实测：逐格对拍时这一 sheet 有 1797 格的样式与旧版不同、121 个空格子的数字格式
       被恢复，值一格没动。）
    2. 资产表的列宽/行高/合并单元格/数字格式会被保住。旧版读源表时没开 cellNF，
       这些**全被静默丢掉**（实测：源表列宽 A:D 与 yyyy/m/d h:mm 格式，进报告后都没了）。
    3. --no-beautify 时资产表的 <dimension> 是 A2:D7 而不是 A1:D7。首行空行**物理上还在**
       （表头照样在第 2 行），只是 openpyxl 按实际单元格推导声明范围、不认源文件里那个
       A1:D7。走美化（生产默认）时这一步会被 beautify 重存覆盖回 A1:D7，无差别。
    4. 公式格的**缓存值**会丢（I1=TODAY()、C7/C8/C9）。这是 openpyxl 整本重存的固有行为，
       旧版本来也只发生在美化那一步；现在 build 这一步就丢了，于是 --no-beautify 也丢。
       引擎只读 L1/M1（L1/M1 是字符串），不读这几格；Excel 打开会自己重算，肉眼无差别。
    5. 列宽相差半格的**只有 --no-beautify 这条路**，且是 SheetJS 自己的口径：
       它把 wch 写成 XLSX 的 width 时加了 0.5 的补白（10→10.5、14→14.5、18→18.5），
       openpyxl 按 <col width> 的字面值写。**交付走的是美化那条路**，宽度由 beautify
       统一重设，逐列与旧版一致 —— 只有资产表 D 列 22→23，是第 2 条保住源表
       yyyy/m/d h:mm 格式带来的（多一格显示宽度），属于"修好的那件事"的连带效果。
       注意列宽是**按将要写进单元格的值**量的（见 compute_column_widths）：时间列量的是
       序列号而不是 datetime，否则每列会再宽一格。
"""

import datetime
import json
import re
import sys
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__。
# 放在下面这些本地 import 之前，否则它们自己就已经先把 pycache 写进去了。
sys.dont_write_bytecode = True

# 日志里有 ⚠ 这类 GBK 编不出来的字符（平台把列改名、IP 暴露值冲突时会打）。
# 正常路径不会碰到：report_writer.js 走 workdir.childEnv()，那里设了
# PYTHONIOENCODING=utf-8。但手工执行时 stdout 可能是 GBK 控制台/管道，
# 那样会在**文件已经写完**之后抛 UnicodeEncodeError —— 最糟的一种失败。
# 只放宽错误处理、不改编码：手工在 GBK 控制台跑时中文照常可读，只有生僻字符退化成 '?'。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.utils.datetime import to_excel

from _path_helper import decode_argv
from marker_colors import (MARKER_COLORS, apply_marker_fill, cell_fill_hex,
                           marked_row_numbers)

# 模板骨架（R3 + R3a）：缺任何一个都早失败，避免产出缺 sheet 的报告还看起来"成功"。
# 顺序照抄 data.xlsx 模板的真实顺序（R3：sheet 顺序由模板定，代码不重排）。
# 这份列表只用于「模板缺 sheet 就早失败」的存在性校验，顺序本身不参与决策。
# 「资产漏洞表」2026-10-16 拆成「内网漏洞表」「互联网漏洞表」两个 sheet（位置仍在第 3、4）。
# 「弱密码表」2026-10-19 拆成「内网弱密码表」「互联网弱密码表」（追加在末尾）。
TEMPLATE_SHEETS = [
    '数据统计', '暴露面', '内网漏洞表', '互联网漏洞表', '资产表', '告警表', '事件表',
    '内网弱密码表', '互联网弱密码表',
]

# 表类型 -> [(源 sheet 名, 目标 sheet 名), ...]。
#
# 源 sheet 名为 None 表示「下载件的第一个 worksheet」（资产表那条老路径，不认名字）。
# 一个下载件搬出**多张**报告 sheet 的只有漏洞表：2026-10-16 起平台把它拆成内网/外网两份
# 报表，scripts/extract_vuln_report.py 把两份合进一个工作簿的两张同名 sheet，这里按名字搬两次。
# 目标 sheet 名必须同时出现在 TEMPLATE_SHEETS 里（上面），否则数据.xlsx 会被这层写坏。
TABLE_SHEET_NAMES = {
    'asset': [(None, '资产表')],
    'alarm': [(None, '告警表')],
    'event': [(None, '事件表')],
    'vuln': [('内网漏洞表', '内网漏洞表'), ('互联网漏洞表', '互联网漏洞表')],
    'weakpwd': [(None, '内网弱密码表')],
    # 2026-10-19：互联网弱密码表是**第二个下载件**（另一套端点与请求体），各搬一张。
    'weakpwd_internet': [(None, '互联网弱密码表')],
    # 六份总表的最后一份（2026-10-15 接入）。sheet 名照模板（R3 输出冻结），
    # 与总表的中文名「暴露面表」差一个字。
    'exposed': [(None, '暴露面')],
}

# 「数据统计」sheet：写入地址由 stats/write_statistics_sheet.js 决定（F2）。
STATISTICS_SHEET = '数据统计'
PERCENT_FORMAT = '0.00%'

# 事件表搬进报告时要**剔掉**的中间列（用户口径 2026-10-14）。
#
# 这一列是 scripts/report_preprocess.py 的 `append_month_column` 追加给 C58:N59 分桶用的
# 桶键（`2026-07` 形态），取值层要读它、报告上不要。列名在那边是常量
# `CREATE_MONTH_COLUMN`，这里写的是**字面量** —— 与 stats/metrics/event.js 里
# 「遏制时长」等几个列名同一套做法（跨语言、跨进程的两个脚本之间不同步引用，
# 靠这条注释对上；改名要两处一起改）。
DROP_EVENT_COLUMNS = ('事件创建月份',)

# 列宽最小 10、最大 50，表头参与计算。
MIN_COL_WIDTH = 10
MAX_COL_WIDTH = 50


# ---------------------------------------------------------------------------
# 取值小工具
# ---------------------------------------------------------------------------

def js_string(value):
    """镜像 JS 的 `String(v)`：整数浮点不带 ".0"。

    列宽是按字符串长度算的，数字大量经过这条路径，差一格就会让列宽整体偏一档。
    """
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def is_blank(value):
    """与 SheetJS 版的 isBlank 同口径：None / 空白串都算空。"""
    return value is None or js_string(value).strip() == ''


def to_serial_number(value):
    """datetime/date/time -> Excel 序列号，其余原样返回。

    ⚠️ 这是一处**刻意保留的旧行为**：平台导出的时间列在 xlsx 里就是「序列号 + 日期格式」，
    SheetJS 版读的是裸序列号（raw:true、没开 cellDates），报告里也按序列号写、靠
    number_format 显示成时间。openpyxl 会把带日期格式的格子直接还原成 datetime，
    如果照它写，报告里这一列的类型就从 float 变成 datetime 了 —— 显示一样，但
    凡是对这几列做算术/字符串化的下游都会看到不同的东西。这属于"口径变更"，
    不该混在一次引擎替换里，所以这里显式转回序列号，与旧版逐格对齐。

    如果哪天想改成写真正的 datetime（更自然、也更抗"格式丢了"），
    把本函数改成 `return value` 即可，但要走一次口径确认。
    注意 datetime -> 序列号是纯算术，不经过时区（旧版注释里担心的 UTC 偏移是
    SheetJS 的 cellDates 特有的，openpyxl 这条路径没有这个问题）。
    """
    if isinstance(value, datetime.datetime):
        return to_excel(value)
    if isinstance(value, datetime.date):
        return to_excel(datetime.datetime(value.year, value.month, value.day))
    if isinstance(value, datetime.time):
        return to_excel(value)
    return value


def load_source_workbook(file_path):
    """读一份平台导出的工作簿 -> workbook。

    只做「打开」，不决定取哪张 sheet（那是 pick_source_sheet 的事）：漏洞表那个下载件
    要一次打开、搬两张 sheet，分开两个函数才不必把同一个工作簿读两遍。

    data_only=True：平台导出里若有公式，要的是**缓存值**，这与 SheetJS 的 cell.v 一致。
    模板走 data_only=False（见 build_report），公式必须原样保住（R2 模板冻结）。
    **普通模式，不是 read_only**：平台有 `<dimension ref="A1"/>` 声明不准的导出，
    read_only 会只读到 A1（见 _path_helper.reset_read_only_dimensions 的说明）。
    """
    if not file_path:
        raise ValueError('工作簿路径为空')
    path = Path(file_path)
    if not path.exists():
        raise ValueError(f'工作簿不存在: {file_path}')

    workbook = load_workbook(path, data_only=True)
    if not workbook.sheetnames:
        raise ValueError(f'工作簿没有任何 sheet: {file_path}')
    return workbook


# 平台导出里「空表」的 sheet 名后缀（全角括号 + 行数），见 pick_source_sheet。
EXPORT_EMPTY_SHEET_SUFFIX = re.compile(r'（\d+）$')


def pick_source_sheet(workbook, file_path, sheet_name=None):
    """总表 workbook -> (实际 sheet 名, worksheet)。

    sheet_name 为空时取第一个 worksheet（**不认 sheet 名**，与旧版行为一致：
    资产表那份下载件就是这么取的）。给了名字就按名字取，名字找不到时**当场抛错、
    并把现有 sheet 名列出来**。

    为什么这里不能「名字对不上就退回第一个」：漏洞表 2026-10-16 起按名字取
    「内网漏洞表」「互联网漏洞表」，而那个工作簿里两张 sheet 的列集本来就不同
    （30 列 / 21 列）—— 静默退化会把外网表当内网表搬进报告，报告看起来完全正常。
    """
    if not sheet_name:
        sheet_name = workbook.sheetnames[0]
        return sheet_name, workbook[sheet_name]

    if sheet_name in workbook.sheetnames:
        return sheet_name, workbook[sheet_name]

    # 平台导出里**空表**的 sheet 名会带一个「（0）」后缀（2026-10-20 实测：一致性验收客户
    # 暴露面 13 张全空 ->「高危端口&服务（0）」；华能集团有数 ->「高危端口&服务」）。
    # 去掉后缀后**唯一命中**才认；命中多张说明名字本身有歧义，照样报错。
    suffixed = [
        name for name in workbook.sheetnames
        if EXPORT_EMPTY_SHEET_SUFFIX.sub('', name) == sheet_name
    ]
    if len(suffixed) == 1:
        return suffixed[0], workbook[suffixed[0]]

    raise ValueError(
        f'总表里没有 sheet 「{sheet_name}」: {file_path}'
        f'（现有: {"、".join(workbook.sheetnames)}）'
    )


def load_source_worksheet(file_path, sheet_name=None):
    """读一份总表里的某个 worksheet -> (workbook, 实际 sheet 名, worksheet)。

    单张 sheet 的调用方用这个（两件事一起做完）；要一个工作簿搬多张 sheet 的
    调用方（build_report）自己走 load_source_workbook + pick_source_sheet。
    """
    workbook = load_source_workbook(file_path)
    sheet_name, sheet = pick_source_sheet(workbook, file_path, sheet_name)
    return workbook, sheet_name, sheet


def compute_column_widths(rows):
    """列宽：按每列最长内容的字符数，钳在 10~50。表头参与计算。"""
    if not rows:
        return []
    column_count = max((len(row) for row in rows), default=0)
    widths = []
    for column in range(column_count):
        max_length = 0
        for row in rows:
            if column >= len(row):
                continue
            value = row[column]
            if value is None:
                continue
            # 量的是**将要写进单元格的那个值**的长度，不是读进来的原始对象。
            # 时间列读进来是 datetime，写进去却是序列号（见 to_serial_number）；
            # 拿 datetime 量会得到 len("2026-05-12 10:09:39")=19，而旧版量的是序列号
            # （SheetJS raw:true 读出来就是 46154.423368055554，18）—— 列宽会差一格。
            max_length = max(max_length, len(js_string(to_serial_number(value))))
        widths.append(min(max(max_length, MIN_COL_WIDTH), MAX_COL_WIDTH))
    return widths


# ---------------------------------------------------------------------------
# 读源表 / 重建 sheet
# ---------------------------------------------------------------------------

def collect_source_rows(source_sheet):
    """源 sheet -> [(值列表, 格式列表)]，行序保持，丢掉"整行没有值"的行。

    值的判空口径必须与旧版逐字一致：SheetJS 的 `blankrows:false` 只把「整行没有任何
    单元格值」当空行 —— 空串 "" 和空格 " " 都算有内容。旧版为此专门写过一段
    「判空口径对不上就整表丢格式」的保险（见 report_writer.js 的 collectSourceFormats），
    这里两边同源、结构上不可能错位，所以不需要那个保险。

    格式表与值表同一轮产出、同一批行，键就是「输出行,列」。
    """
    return [
        (values, formats)
        for _row_number, values, formats in collect_source_rows_with_numbers(source_sheet)
    ]


def collect_source_rows_with_numbers(source_sheet):
    """同 `collect_source_rows`，但每一行多带一个**源表物理行号**。

    标记色行（见 marker_colors.py）要按源表行号对回输出行号，而 `collect_source_rows`
    会把"整行没值"的行丢掉，输出行号与源行号不再相等 —— 所以行号必须与值同轮产出，
    不能在别处再判一遍「哪些行算有值」（两处判空口径迟早对不上）。
    """
    grid = {}
    for row in source_sheet.iter_rows():
        for cell in row:
            if cell.value is not None:
                grid[(cell.row, cell.column)] = (cell.value, cell.number_format)

    if not grid:
        return []

    max_row = max(r for r, _ in grid)
    max_column = max(c for _, c in grid)

    rows = []
    for r in range(1, max_row + 1):
        values = []
        formats = []
        for c in range(1, max_column + 1):
            value, number_format = grid.get((r, c), (None, 'General'))
            values.append(value)
            formats.append(number_format)
        if any(v is not None for v in values):
            rows.append((r, values, formats))
    return rows


def split_leading_blank_rows(rows):
    """丢掉开头的空行，让表头稳定落在第 1 行。

    平台导出的告警/事件表本身就是第 1 行表头，但这里不假设，多一层保险；
    资产表不走这条路径，不受影响。

    判空用 is_blank（空串/空格也算空），比"整行没值"更严 —— 与旧版 aoa 的那轮筛选一致。
    """
    start = 0
    while start < len(rows) and all(is_blank(v) for v in rows[start][0]):
        start += 1
    return rows[start:]


def reset_sheet(sheet):
    """把模板里这张 sheet 清成空表。

    模板的 资产表/告警表/事件表 实测本来就是空表（各只有一个 A1 空壳），
    这里清一遍是为了不依赖「模板恰好是空的」这个前提。
    """
    if any(cell.value is not None for row in sheet.iter_rows() for cell in row):
        sheet.delete_rows(1, sheet.max_row)
    for key in list(sheet.column_dimensions):
        del sheet.column_dimensions[key]
    for key in list(sheet.row_dimensions):
        del sheet.row_dimensions[key]
    for merged in list(sheet.merged_cells.ranges):
        sheet.unmerge_cells(str(merged))


def copy_sheet_verbatim(target_sheet, source_sheet):
    """资产表：原样搬入。

    保留源表的**绝对坐标**（第 1 行空 + 第 2 行表头），以及数字格式、列宽、行高、
    合并单元格。刻意**不搬源表的字体/填充/边框**：那是平台导出的样式，报告观感由
    美化那一步统一决定（scripts/beautify_report.py），搬过来只会多一层随后被覆盖的东西。

    :returns: (header_row, data_rows) —— header_row 是表头所在行（真实导出是第 2 行），
              data_rows 是**数据行数**（不含表头行）
    """
    grid = {}
    for row in source_sheet.iter_rows():
        for cell in row:
            if cell.value is not None:
                grid[(cell.row, cell.column)] = cell

    for (r, c), source_cell in grid.items():
        target_cell = target_sheet.cell(row=r, column=c)
        target_cell.value = source_cell.value
        if source_cell.number_format and source_cell.number_format != 'General':
            target_cell.number_format = source_cell.number_format

    for key, dim in source_sheet.column_dimensions.items():
        if dim.width is not None:
            target_sheet.column_dimensions[key].width = dim.width
    for key, dim in source_sheet.row_dimensions.items():
        if dim.height is not None:
            target_sheet.row_dimensions[key].height = dim.height

    for merged in source_sheet.merged_cells.ranges:
        target_sheet.merge_cells(str(merged))

    # 按**内容**算行数，不认行号：真实导出是「第 1 行空 + 第 2 行表头」，
    # 但源表没有首行空行时也得算对。旧版写死 last_row - 1（含表头行数），
    # 只在"一定有首行空行"时才对；这里按内容首行（=表头行）推，两种情况都对。
    rows = [r for r, _ in grid]
    first_row = min(rows, default=0)
    last_row = max(rows, default=0)
    data_rows = max(last_row - first_row, 0) if last_row else 0
    return first_row, data_rows


def rebuild_sheet(target_sheet, source_sheet, drop_headers=()):
    """告警表 / 事件表：第 1 行表头 + 第 2 行起数据，列宽自适应，数字格式另还原。

    只给有值的格子盖格式：空格子套上日期格式，Excel 会把它当成 1900-01-00 显示。

    :param drop_headers 表头里要**剔掉**的列名（精确相等，先 strip 再比）。
      给的是那种「取值层要用、报告上不要」的中间列 —— 眼下只有一个：
      「事件创建月份」（C58:N59 分桶用的桶键，见 report_preprocess.py 的
      `append_month_column`）。默认空 = 一列不剔。
      ⚠️ 与「没算出来的那一列根本不建」是同一条思路的两面：报告上不该出现的列，
      要么别写进下载件、要么在搬的这一处剔掉 —— 别指望下游看见它却假装没看见。
      列宽是按**剔完**的列算的，不是按剔之前。

    :returns: (data_rows, restored_formats, dropped_headers, marked_cells) —— 第三项是
      **真剔掉的**列名（表里本来就没有那一列时是空列表，那不是异常：这一步没算出月份列
      时就是这样）；第四项是搬完之后带标记色的格子 `{(输出行, 输出列): 'RRGGBB'}`
      （平台用粉红标「最近扫描新增漏洞」，见 marker_colors.py；按格不按行），
      没有标记格时是空 dict。
    """
    numbered = collect_source_rows_with_numbers(source_sheet)
    rows = split_leading_blank_rows([(values, formats) for _r, values, formats in numbered])
    if not rows:
        return 0, 0, [], []

    # 与 rows 同源同序：split_leading_blank_rows 只砍开头若干行，按长度差把行号对齐
    numbered = numbered[len(numbered) - len(rows):]

    dropped = []
    drop = set()
    source_column_count = max((len(values) for values, _formats in rows), default=0)
    if drop_headers:
        wanted = {str(name).strip() for name in drop_headers}
        header = [
            str(value).strip() if value is not None else ''
            for value in rows[0][0]
        ]
        indexes = [index for index, name in enumerate(header) if name in wanted]
        if indexes:
            dropped = [header[index] for index in indexes]
            drop = set(indexes)
            rows = [
                ([value for index, value in enumerate(values) if index not in drop],
                 [fmt for index, fmt in enumerate(formats) if index not in drop])
                for values, formats in rows
            ]
            numbered = [
                (row_number,
                 [value for index, value in enumerate(values) if index not in drop],
                 [fmt for index, fmt in enumerate(formats) if index not in drop])
                for row_number, values, formats in numbered
            ]

    values_rows = [values for values, _ in rows]
    formats_rows = [formats for _, formats in rows]

    widths = compute_column_widths(values_rows)
    for index, width in enumerate(widths, start=1):
        target_sheet.column_dimensions[get_column_letter(index)].width = width

    restored = 0
    for r, values in enumerate(values_rows, start=1):
        for c, value in enumerate(values, start=1):
            if value is None:
                continue
            cell = target_sheet.cell(row=r, column=c)
            # 序列号口径见 to_serial_number 的说明
            cell.value = to_serial_number(value)
            number_format = formats_rows[r - 1][c - 1] if c - 1 < len(formats_rows[r - 1]) else 'General'
            # General 是默认格式，写不写显示都一样；显式带上只会让每个格子都多背一条
            # 样式记录（事件表几千行 × 几十列），文件白胖一圈
            if number_format and number_format != 'General':
                cell.number_format = number_format
                restored += 1

    # 标记格透传（用户口径 2026-10-30）：平台把那几格涂粉标「最近扫描新增漏洞」，
    # 那是平台写在表头里的显式约定，不是样式噪声 —— 搬表时丢了，报告上就再也看不出来。
    # 按**格**透传、不按行：平台标整行，报告上就是整行；哪天它只标「发现时间」那一格，
    # 报告上也只该那一格是粉的（见 marker_colors.py）。
    # 表头行不参与判定；输出行号 = 该行在 numbered 里的位置（表头固定是第 1 行）。
    # 源列号 -> 目标列号按剔完列的位移算：kept_source_indexes 的第 n 项落在第 n+1 列。
    kept_source_indexes = [index for index in range(source_column_count) if index not in drop]
    marked_cells = {}
    for output_row, (source_row, _values, _formats) in enumerate(numbered[1:], start=2):
        for target_col, source_index in enumerate(kept_source_indexes, start=1):
            color = cell_fill_hex(source_sheet.cell(row=source_row, column=source_index + 1))
            if color in MARKER_COLORS:
                apply_marker_fill(target_sheet, output_row, target_col, color)
                marked_cells[(output_row, target_col)] = color

    return len(values_rows) - 1, restored, dropped, marked_cells


# ---------------------------------------------------------------------------
# 「数据统计」sheet：只执行 writes 计划，不决定写什么
# ---------------------------------------------------------------------------

def apply_statistics_writes(workbook, writes):
    """按 stats/write_statistics_sheet.js 给出的计划写「数据统计」sheet。

    mode 的语义（CELL_REGISTRY.md §4）:
      value    普通值
      percent  值 + 0.00% 数字格式
      blank    清成空串（清掉模板原值），**不动**模板原有的数字格式
                —— 与旧版一致：旧版只改 t/v，不碰 z

    :returns: 实际写入的地址列表（供 JS 侧与自己的账对拍）
    """
    sheet = workbook[STATISTICS_SHEET]
    applied = []
    for write in writes:
        address = write['addr']
        mode = write.get('mode') or 'value'
        cell = sheet[address]

        if mode == 'blank':
            cell.value = ''
        elif mode == 'percent':
            cell.value = write.get('value')
            cell.number_format = PERCENT_FORMAT
        else:
            cell.value = write.get('value')
        applied.append(address)
    return applied


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_report(payload, logs=None):
    logs = logs if logs is not None else []

    template_path = payload['template']
    output_path = payload['output']
    tables = payload.get('tables') or {}
    writes = (payload.get('statistics') or {}).get('writes') or []

    if not Path(template_path).exists():
        raise ValueError(f'报告模板不存在: {template_path}')

    # data_only=False：模板里的公式（I1 = TODAY() 等）必须原样保住（R2 模板冻结）
    workbook = load_workbook(template_path, data_only=False)

    # 模板骨架不合规就早失败，避免产出缺 sheet 的报告还看起来"成功"
    for sheet_name in TEMPLATE_SHEETS:
        if sheet_name not in workbook.sheetnames:
            raise ValueError(f'模板缺少 Sheet: {sheet_name}（模板: {template_path}）')

    sheets = []

    for table_type, sheet_pairs in TABLE_SHEET_NAMES.items():
        table = tables.get(table_type)
        if not table or not table.get('filePath'):
            targets = '、'.join(target for _source, target in sheet_pairs)
            raise ValueError(f'缺少 {targets} 的下载结果，无法生成报告')

        source_path = table['filePath']
        source_base = Path(source_path).name
        # 一个下载件搬出的第 N 张 sheet 都要重新在**同一个工作簿**里取（漏洞表那两份就
        # 落在同一个工作簿的两张 sheet 上）—— 所以工作簿在循环外只打开一次。
        source_workbook = load_source_workbook(source_path)

        for source_name, sheet_name in sheet_pairs:
            source_sheet_name, source_sheet = pick_source_sheet(
                source_workbook, source_path, source_name
            )
            target_sheet = workbook[sheet_name]
            reset_sheet(target_sheet)

            if table_type == 'asset':
                # 原样搬入：连首行空行与平台导出格式一起保留
                header_row, data_rows = copy_sheet_verbatim(target_sheet, source_sheet)
                logs.append(
                    f'[报告] {sheet_name} <- {source_base} '
                    f'(sheet "{source_sheet_name}", 原样搬入, {data_rows} 行数据'
                    + (f'，含第 {header_row} 行起的表头' if data_rows else '')
                    + ')'
                )
                sheets.append({
                    'name': sheet_name,
                    'rowCount': data_rows,
                    'mode': 'verbatim',
                    'source': source_base,
                    'sourceSheet': source_sheet_name,
                })
                continue

            # 「事件创建月份」只在事件表上剔：它是 C58:N59 分桶用的桶键，取值层要读它，
            # 交付物的「事件表」sheet 上不要（用户口径 2026-10-14）。五个时长列照旧保留 ——
            # 它们是既有交付物形态的一部分。
            dropped_headers = DROP_EVENT_COLUMNS if table_type == 'event' else ()
            data_rows, restored, dropped, marked_cells = rebuild_sheet(
                target_sheet, source_sheet, dropped_headers
            )
            marked_rows = marked_row_numbers(marked_cells)
            if data_rows <= 0:
                # 空表也是有效结果（该时间段确实没有数据），但要说清楚，不静默
                logs.append(f'[报告] {sheet_name} 源文件无数据行: {source_base}')
            logs.append(
                f'[报告] {sheet_name} <- {source_base} '
                f'(sheet "{source_sheet_name}", 表头第 1 行 + {data_rows} 行数据'
                + (f'，还原 {restored} 个单元格格式' if restored else '')
                + (f'，剔掉中间列 {"、".join(f"「{name}」" for name in dropped)}' if dropped else '')
                + (f'，透传标记色 {len(marked_cells)} 格'
                   f'（{len(marked_rows)} 行）' if marked_cells else '')
                + ')'
            )
            sheets.append({
                'name': sheet_name,
                'rowCount': data_rows,
                'mode': 'rebuild',
                'source': source_base,
                'sourceSheet': source_sheet_name,
                'restoredFormats': restored,
                'droppedColumns': dropped,
                'markedRows': marked_rows,
                'markerCellCount': len(marked_cells),
            })

    # 「数据统计」sheet 的取值层。writes 缺席时不写任何格子（M1 行为，模板原样）——
    # 这是刻意的默认值，让「没接 ctx」和「口径未定」两种情况都表现为「模板保持原样」。
    #
    # 这里**刻意不打日志**：[数据统计] 那几行由 report_writer.js 打印。
    # 「写哪一格、写什么」是 stats/write_statistics_sheet.js 的决定（F2），
    # 它的文案就该跟它的决策走；本文件只负责落笔和回报落了几格（statistics.applied）。
    applied = apply_statistics_writes(workbook, writes) if writes else []

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)

    return {
        'sheets': sheets,
        'statistics': {'applied': applied, 'count': len(applied)},
        'logs': logs,
    }


def main():
    decode_argv()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: build_report.py '<payload_json>'")

    logs = []
    try:
        payload = json.loads(sys.argv[1])
        if not isinstance(payload, dict):
            raise ValueError('payload 必须是一个 JSON 对象')
        result = build_report(payload, logs)
    except Exception as error:  # noqa: BLE001 —— 统一转成可读 JSON 交给 JS 侧
        # 失败时把已经产生的日志一起交出去：用户"看过"的那部分照常打出来，
        # 缺的只是后面几步，不至于让人以为整轮什么都没跑
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
