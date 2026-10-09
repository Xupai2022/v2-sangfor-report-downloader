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
  资产漏洞表 ← 同告警表（平台导出的「漏洞」sheet 也是第 1 行表头）
  弱密码表   ← 同告警表（平台导出的「弱密码」sheet 也是第 1 行表头）

告警表/事件表/资产漏洞表/弱密码表是「值搬过去 + 数字格式另还原」（见 collect_source_rows）：
平台导出里时间列是带日期格式的序列号，只搬值会让它在报告里显示成 46225.42。资产表不走这条
路径，值/格式/列宽/行高/合并单元格随 sheet 一起原样保留。
（漏洞表/弱密码表的时间列实测是**字符串**，本来就没有数字格式可还原。）

各表落成 sheet 之后，落盘之前依次还有两步（顺序固定）：

  表格预处理（report_preprocess.py）  资产表建 IP -> 内网/外网 映射，事件表追加「内网外网资产」列
  数据统计取值（writes 段）           写「数据统计」sheet

「数据统计」sheet 的写入**地址与取值口径**由 stats/write_statistics_sheet.js 决定
（CELL_REGISTRY.md R14 / F2）；本文件只执行它给出的 writes 计划，不自己决定写哪一格。
不管有没有 writes，单元格地址集合都不变（R1 单元格冻结）。
**表格预处理不依赖 writes**，无条件跑 —— 它改的是事件表，不是「数据统计」。

合并写完后还有一步（在 JS 侧调 scripts/beautify_report.py）：给除「数据统计」外的 sheet
套统一视觉规范（宋体 + 深蓝表头 + 浅蓝底，主题见 excel_beautifier/themes）。

用法:
    python build_report.py '<payload_json>'      # 建议用 B64: 前缀过一遍中文路径，
                                                 # 见 path_helper.js / _path_helper.py
payload_json:
    {
      "template": "<模板 xlsx 绝对路径>",
      "output":   "<产物 xlsx 绝对路径>",
      "tables":   {"asset": {"filePath": "..."}, "alarm": {...}, "event": {...}, "vuln": {...}},
      "statistics": {"writes": [{"addr": "J1", "value": "...", "mode": "value"}]}
    }

输出:
    stdout: {"sheets", "statistics", "preprocess", "logs"} 这一次 build 的全部结果
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
from report_preprocess import preprocess_workbook

# 模板骨架（R3 + R3a）：缺任何一个都早失败，避免产出缺 sheet 的报告还看起来"成功"。
# 顺序照抄 data.xlsx 模板的真实顺序（R3：sheet 顺序由模板定，代码不重排）。
# 这份列表只用于「模板缺 sheet 就早失败」的存在性校验，顺序本身不参与决策。
TEMPLATE_SHEETS = ['数据统计', '暴露面', '资产漏洞表', '资产表', '告警表', '事件表', '弱密码表']

# 表类型 -> 报告里的 sheet 名。
TABLE_SHEET_NAMES = {
    'asset': '资产表',
    'alarm': '告警表',
    'event': '事件表',
    'vuln': '资产漏洞表',
    'weakpwd': '弱密码表',
}

# 「数据统计」sheet：写入地址由 stats/write_statistics_sheet.js 决定（F2）。
STATISTICS_SHEET = '数据统计'
PERCENT_FORMAT = '0.00%'

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


def load_first_worksheet(file_path):
    """读工作簿的第一个 worksheet（不认 sheet 名，与旧版一致）。"""
    if not file_path:
        raise ValueError('工作簿路径为空')
    path = Path(file_path)
    if not path.exists():
        raise ValueError(f'工作簿不存在: {file_path}')

    # data_only=True：平台导出里若有公式，要的是**缓存值**，这与 SheetJS 的 cell.v 一致。
    # 模板走 data_only=False（见 build_report），公式必须原样保住（R2 模板冻结）。
    workbook = load_workbook(path, data_only=True)
    if not workbook.sheetnames:
        raise ValueError(f'工作簿没有任何 sheet: {file_path}')
    sheet_name = workbook.sheetnames[0]
    return workbook, sheet_name, workbook[sheet_name]


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
            rows.append((values, formats))
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


def rebuild_sheet(target_sheet, source_sheet):
    """告警表 / 事件表：第 1 行表头 + 第 2 行起数据，列宽自适应，数字格式另还原。

    只给有值的格子盖格式：空格子套上日期格式，Excel 会把它当成 1900-01-00 显示。

    :returns: (data_rows, restored_formats)
    """
    rows = split_leading_blank_rows(collect_source_rows(source_sheet))
    if not rows:
        return 0, 0

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

    return len(values_rows) - 1, restored


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

    for table_type, sheet_name in TABLE_SHEET_NAMES.items():
        table = tables.get(table_type)
        if not table or not table.get('filePath'):
            raise ValueError(f'缺少 {sheet_name} 的下载结果，无法生成报告')

        source_path = table['filePath']
        _source_workbook, source_sheet_name, source_sheet = load_first_worksheet(source_path)
        source_base = Path(source_path).name
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

        data_rows, restored = rebuild_sheet(target_sheet, source_sheet)
        if data_rows <= 0:
            # 空表也是有效结果（该时间段确实没有数据），但要说清楚，不静默
            logs.append(f'[报告] {sheet_name} 源文件无数据行: {source_base}')
        logs.append(
            f'[报告] {sheet_name} <- {source_base} '
            f'(表头第 1 行 + {data_rows} 行数据'
            + (f'，还原 {restored} 个单元格格式' if restored else '')
            + ')'
        )
        sheets.append({
            'name': sheet_name,
            'rowCount': data_rows,
            'mode': 'rebuild',
            'source': source_base,
            'sourceSheet': source_sheet_name,
            'restoredFormats': restored,
        })

    # 「表格预处理」阶段：所有表都落成 sheet 之后、数据统计取值之前。
    # 改的是事件表本身，不碰「数据统计」（那是 stats/write_statistics_sheet.js 的
    # 专属写入区，CELL_REGISTRY.md F2），所以这一步不依赖 writes，无条件跑。
    # 表头缺列会在这里抛出（平台改列名属于契约变更，宁可失败，也不产出一份悄悄少一列的交付物）。
    preprocess = preprocess_workbook(workbook, logs)

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
        'preprocess': {k: v for k, v in preprocess.items() if k != 'logs'},
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
