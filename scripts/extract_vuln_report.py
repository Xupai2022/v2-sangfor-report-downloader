#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞表下载件（zip）-> 一个两-sheet 的工作簿（「内网漏洞表」/「互联网漏洞表」）。

**位置**：跑在「下载之后」、解析与搬表之前 —— mssw_downloader.js 的漏洞表分支拿到
exportMsswVulnList 的 zip 之后立刻调本脚本。跑完之后磁盘上那个两-sheet 的 xlsx 就是
这条链路上**唯一的漏洞表中间件**：scripts/parse_table_rows.py 按同一份三列白名单
逐张读它（取值层的「全表」= 两份相加），scripts/build_report.py 按 sheet 名把它搬进
报告的两张 sheet（表头各自原样保留，不并集对齐）。

为什么需要这一层（用户口径 2026-10-16 的直接后果）：
  · 平台把漏洞表拆成内网 / 外网**两份报表**，下载产物从 xlsx 变成 **zip**。zip 里
    是一堆 xlsx，装着一个四处找表、四处解析、还要处理编码的活儿 —— 那些都不该散到
    JS 侧（JS 连读 xlsx 都做不到，本仓的 Excel 全在 openpyxl 这一侧）。
  · 搬表复用 scripts/build_report.py 的 `rebuild_sheet`（第 1 行表头 + 数据 + 列宽 +
    数字格式还原），**不另写一套搬表逻辑** —— 报告里那两张 sheet 与取值层读到的
    必须是同一份行集合，两处各写一遍搬法迟早对不上。

⚠️ 取 sheet 名 `4-漏洞清单+跟踪记录` 是**平台侧的契约**（一份里四张 sheet，前两张是
概览与指引、第三张是「急需修复」的子集，只有最后那张是完整清单）。仓库里没有任何
常量兜着这个名 —— 所以两份文件里哪一份找不到这张 sheet 就**当场抛错**，绝不"退化到
第一个 sheet"：第三张与第四张的表头一模一样，静默取错只会少一批行，报告看起来完全正常。

⚠️ **预处理：删掉「处置状态 = 处置完成（误报）」的整行**（用户口径 2026-10-21）。
用户原话：「所有的漏洞操作都是等预处理后才做的，预处理包含删除处置完成误判的行」。
这一步就在本脚本里、在 `rebuild_sheet` 搬表**之前**做，所以它同时是下游两条路的输入：
取值层（parse_table_rows.py）与报告 sheet（build_report.py）看到的行集合都不含误报行。

2026-10-16 那一版的「不删」口径**已作废**：当时依赖下载接口请求体的
`fixed_status: [0, 1, 2, 6, 3, 4]` 先把误报那一档筛掉。现在不再把筛选押在接口上 ——
下载件里出现误报行就在本层删掉，接口筛不筛都一样。
⚠️ 删行判据与 scripts/remove_rows_by_status.py 共用同一套文字比对（整值相等，
再退一步只抹平括号全半角与空白）—— 两处各写一套判据迟早对不上。

输入（走 _path_helper 的 B64GZ: / B64: 前缀，与其余脚本同款）:
    {"zip": "<下载下来的 zip 绝对路径>", "output": "<要写出的 xlsx 绝对路径>"}

输出:
    stdout: {"ran", "filePath", "sheets": [{name, rows, columns, sourceSheet,
             sourceFile, restoredFormats, removedFalsePositives}],
             "alreadyPresent", "logs"}
    stderr: 失败时 {"diag":"error","message","logs"}（与其余脚本同一套协议）
"""

import json
import sys
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__（与其余脚本同款，
# 放在下面的本地 import 之前）。
sys.dont_write_bytecode = True

# 报错文案与日志里会有「」和中文 sheet 名；PYTHONIOENCODING 由调用方的
# workdir.childEnv() 设好，但手工在 GBK 控制台执行时 stdout 可能是 GBK ——
# 只放宽错误处理、不改编码（与 build_report.py / report_preprocess.py 同款）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import Workbook, load_workbook

from _path_helper import decode_argv
# 搬表逻辑**只此一处**（H4）：本脚本不自己写「表头 + 数据 + 列宽 + 数字格式」那一套，
# 直接复用合并引擎刚写好的那个 —— 否则报告里的 sheet 与取值层读到的行集合会分家。
from build_report import rebuild_sheet
from marker_colors import marked_row_numbers
# 删行判据**只写一处**（H4）：整值相等 + 「只差括号全半角/空白」的退路都用
# remove_rows_by_status.py 里那一套，本脚本不另写一份文字比对。
from remove_rows_by_status import find_column, normalize, paren_canon, read_header

# ---------------------------------------------------------------------------
# 平台侧的契约（两份文件 / 那张 sheet）
# ---------------------------------------------------------------------------

# zip 里两份工作簿的文件名各自含这两个词（实测 `测试客户0907-内网漏洞报告-20261016.xlsx`
# / `…-外网漏洞报告-20261016.xlsx`）。**按内容判**、不按下标：zip 里条目的顺序是平台
# 打包时定的，按下标取等于把「哪份是内网」押在一个没写下来的顺序上。
INNER_KEYWORD = '内网'
OUTER_KEYWORD = '外网'

# 内网那份 -> 报告与工作簿里的 sheet 名；顺序即输出工作簿里的 sheet 顺序。
# ⚠️ 这三个名字与另外两处必须逐字一致（跨语言，靠这条注释与 mssw_downloader.js 的
# VULN_TABLE_SHEETS 对上）：scripts/build_report.py 的 TABLE_SHEET_NAMES['vuln']。
TARGET_SHEETS = ((INNER_KEYWORD, '内网漏洞表'), (OUTER_KEYWORD, '互联网漏洞表'))

# 两份里都存在的最后那张 sheet —— 唯一一张完整清单（见模块头注）。
SOURCE_SHEET_NAME = '4-漏洞清单+跟踪记录'

# 只认这两种后缀：zip 里除了两份 xlsx，平台可能塞别的东西（实测这份只有那两份，
# 但不押注）。非 xlsx 的条目一律不看，也不因为「多出来一个文件」就报错。
XLSX_SUFFIX = '.xlsx'

# ---------------------------------------------------------------------------
# 预处理：删「处置状态 = 处置完成（误报）」的行（用户口径 2026-10-21）
# ---------------------------------------------------------------------------

# 判据列与判据值。**列名是平台侧契约**：找不到这一列就抛错，不能当成「没有误报」跳过 ——
# 那等于把"没读到"说成"没有"（R10），下游每一格漏洞数都会多算误报行。
FALSE_POSITIVE_COLUMN = '处置状态'
FALSE_POSITIVE_VALUES = ('处置完成（误报）',)


def _locate_disposition_column(sheet, label):
    """在一张源 sheet 上按表头找到「处置状态」列，返回列下标。

    找不到 / 有多列同名时抛 ValueError（不猜）：删行是取值之前的必做步骤，
    列名对不上就得人工确认口径，不能静默跳过。
    """
    header = read_header(sheet)
    try:
        column_index, _matched_by = find_column(header, FALSE_POSITIVE_COLUMN, ())
    except SystemExit as error:  # find_column 的"多列同名不猜"走的是 SystemExit
        raise ValueError(f'{label}：{error}') from error
    if column_index is None:
        raise ValueError(
            f'{label} 里没有「{FALSE_POSITIVE_COLUMN}」列（现有表头: {header}）。'
            f'删「{FALSE_POSITIVE_VALUES[0]}」的行是漏洞取值之前的必做步骤'
            '（用户口径 2026-10-21），列名对不上就没法保证误报行被删掉 —— '
            '不能当作「没有误报」跳过。'
        )
    return column_index


def false_positive_row_numbers(sheet, label):
    """源 sheet 上「处置状态」= 处置完成（误报）的**物理行号**列表。

    判据：整值 strip 后相等；再退一步只抹平括号全半角与空白（与
    remove_rows_by_status.py 的 remove_by_values 同款）。退路命中的写法一并返回，
    好在日志里露出来 —— 别让它悄悄删。

    :returns: (行号列表, {平台实际写法: 行数})
    """
    column_index = _locate_disposition_column(sheet, label)
    values = set(FALSE_POSITIVE_VALUES)
    loose_targets = {paren_canon(value): value for value in FALSE_POSITIVE_VALUES}

    row_numbers = []
    loose_matched = {}
    # 从第 2 行起：第 1 行是表头。行号从 2 开始数，与 Excel 一致（delete_rows 要物理行号）。
    for row_index, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        value = normalize(row[column_index]) if column_index < len(row) else ''
        if value in values:
            row_numbers.append(row_index)
        elif value and paren_canon(value) in loose_targets:
            row_numbers.append(row_index)
            loose_matched[value] = loose_matched.get(value, 0) + 1
    return row_numbers, loose_matched


def drop_false_positive_rows(sheet, label, logs):
    """从源 sheet 上删掉误报行（倒序删，行号不会因为前面的行没了而错位）。返回删除行数。"""
    row_numbers, loose_matched = false_positive_row_numbers(sheet, label)
    for row_index in reversed(row_numbers):
        sheet.delete_rows(row_index, 1)

    if row_numbers:
        logs.append(
            f'[预处理] {label}：删掉「{FALSE_POSITIVE_COLUMN}」= '
            f'{" / ".join(FALSE_POSITIVE_VALUES)} 的 {len(row_numbers)} 行'
            + (
                f'（其中 {sum(loose_matched.values())} 行只差括号全半角/空白: '
                f'{"、".join(loose_matched)}）'
                if loose_matched else ''
            )
        )
    else:
        logs.append(
            f'[预处理] {label}：没有「{FALSE_POSITIVE_COLUMN}」= '
            f'{" / ".join(FALSE_POSITIVE_VALUES)} 的行（删 0 行）'
        )
    return len(row_numbers)


def _member_names(zip_file):
    """zip 里的条目名，目录条目（以 / 结尾）剔掉。"""
    return [name for name in zip_file.namelist() if not name.endswith('/')]


def locate_members(zip_file):
    """zip -> [内网条目名, 外网条目名]。

    每个关键词**必须恰好命中一个** xlsx：多了（平台多打了一份）少了（打包漏了）都抛错。
    不退回「第一个 xlsx」：万一命中的是内网那份，外网那批行会**整批消失**，
    而报告上「互联网漏洞表」还是正常的一张表 —— 少数据比报错难查得多。
    """
    names = _member_names(zip_file)
    xlsx_names = [name for name in names if name.lower().endswith(XLSX_SUFFIX)]
    if not xlsx_names:
        raise ValueError(
            f'压缩包里一个 xlsx 都没有（条目: {"、".join(names) or "（空包）"}）。'
            '漏洞表下载件应当是内网 / 外网两份报表的压缩包。'
        )

    located = []
    for keyword, target in TARGET_SHEETS:
        hits = [name for name in xlsx_names if keyword in Path(name).name]
        if len(hits) != 1:
            raise ValueError(
                f'压缩包里含「{keyword}」的 xlsx 有 {len(hits)} 个（要恰好 1 个）: '
                f'{"、".join(hits) or "（一个都没有）"}。'
                f'现有 xlsx: {"、".join(xlsx_names)}。'
                f'平台改了打包的文件名就属于契约变更，得先确认口径再改这里，'
                f'不要退回「随便取一个」—— 少一份就是少一批行，报告上还看不出来。'
            )
        located.append((hits[0], target))
    return located


def read_source_sheet(archive, member_name):
    """zip 里的一个 xlsx 条目 -> (它的目标 sheet 名, worksheet)。

    在**内存里**读（不落盘解包）：这条链路上没有任何东西需要那两份原始 xlsx 留在磁盘上，
    解包到临时目录只会多出一处要清理、并且多一个「解出来的路径可不可信」的问题。
    zip 条目名可以带 `..`，落盘解包要防穿越；这里压根不落盘，风险面小一层。
    """
    with archive.open(member_name) as handle:
        data = handle.read()

    try:
        workbook = load_workbook(BytesIO(data), data_only=True)
    except BadZipFile as error:
        raise ValueError(f'压缩包里的「{member_name}」不是 xlsx: {error}') from error

    if SOURCE_SHEET_NAME not in workbook.sheetnames:
        raise ValueError(
            f'「{Path(member_name).name}」里没有 sheet「{SOURCE_SHEET_NAME}」'
            f'（现有: {"、".join(workbook.sheetnames)}）。'
            '这张 sheet 是平台侧的契约（前几张是概览/指引/急需修复的子集），'
            '名字对不上时要人工确认，不能退而取第一张 —— 那会静默少一批行。'
        )
    return workbook[SOURCE_SHEET_NAME]


def extract_vuln_report(zip_path, output_path, logs=None):
    """zip -> 两-sheet 工作簿。返回体见模块头注。"""
    logs = logs if logs is not None else []

    if not zip_path:
        raise ValueError('漏洞表下载件（zip）路径为空')
    zip_file = Path(zip_path)
    if not zip_file.exists():
        raise ValueError(f'漏洞表下载件不存在: {zip_path}')
    if not output_path:
        raise ValueError('漏洞表中间件的输出路径为空')
    output = Path(output_path)

    logs.append('===== 漏洞表下载件解包（zip -> 内网 / 外网两张 sheet）=====')

    # 幂等闸：输出已经在、两张 sheet 齐、**而且里面一行误报都不剩** -> 直接跳过。
    # 与 report_preprocess.py 的幂等闸同一条理由：这个脚本要重跑一次也只是白费力气，
    # 但**半个输出**（只写出一张 sheet）比不跑糟得多 —— 所以形状不对时**抛错**，
    # 不"顺手把它补齐"：那会让「上次写到一半崩了」看起来像一次成功的运行。
    # ⚠️ 2026-10-21 起多查一条：旧的中间件是按「不删误报行」写出来的，里面可能还有误报行。
    # 「已存在」不等于「已按当前口径处理过」—— 还有误报行时按 zip 重建，不让旧口径的文件
    # 靠幂等闸活下来。
    if output.exists():
        expected = [target for _keyword, target in TARGET_SHEETS]
        existing = load_workbook(output, data_only=True)
        try:
            existing_names = list(existing.sheetnames)
            if not all(name in existing_names for name in expected):
                raise ValueError(
                    f'输出文件已存在但不是本脚本的形态: {output}'
                    f'（现有 sheet: {"、".join(existing_names)}，'
                    f'应当有 {"、".join(expected)}）。'
                    '这是一份写到一半 / 被别的步骤占用的中间件 —— 请先确认并删掉它，'
                    '本脚本不覆盖不认识的输出。'
                )
            stale_rows = sum(
                len(false_positive_row_numbers(existing[name], f'已有的「{name}」')[0])
                for name in expected
            )
        finally:
            existing.close()

        if stale_rows == 0:
            logs.append(f'[解包] 输出已存在、两张 sheet 齐、且没有误报行（{output}），这次跳过')
            return {
                'ran': False,
                'alreadyPresent': True,
                'filePath': str(output),
                'sheets': [],
                'logs': logs,
            }
        logs.append(
            f'[预处理] 已存在的中间件里还有 {stale_rows} 行「{FALSE_POSITIVE_COLUMN}」= '
            f'{" / ".join(FALSE_POSITIVE_VALUES)}（旧口径产物），这次按 zip 重建'
        )

    results = []
    with ZipFile(zip_file) as archive:
        # 目的工作簿在**源表都读进来之后**才开始写：源 xlsx 的每个条目都要在 `with`
        # 里读出来（archive 关掉之后 open 就没了），而写盘那步与 zip 无关。
        sources = [
            (member_name, target_name, read_source_sheet(archive, member_name))
            for member_name, target_name in locate_members(archive)
        ]

    workbook = Workbook()
    # Workbook() 自带一张空 sheet，把它当第一张用 —— openpyxl 的工作簿至少要留一张
    # sheet，先删后建之间会短暂没有 sheet（那条路上出错的话现场很难看）
    first = True
    for member_name, target_name, source_sheet in sources:
        target_sheet = workbook.active if first else workbook.create_sheet()
        first = False
        target_sheet.title = target_name

        # 预处理在搬表**之前**：删掉的行既不进取值层读的那份中间件，也不进报告 sheet。
        # 必须在 rebuild_sheet 之前 —— 之后删就得同时改中间件与已搬好的两张表。
        removed = drop_false_positive_rows(
            source_sheet, f'{target_name}（{Path(member_name).name}）', logs
        )

        rows, restored, _dropped, marked_cells = rebuild_sheet(target_sheet, source_sheet, ())
        marked_rows = marked_row_numbers(marked_cells)
        columns = target_sheet.max_column or 0

        logs.append(
            f'[解包] {target_name} <- {Path(member_name).name} '
            f'(sheet "{SOURCE_SHEET_NAME}", 表头第 1 行 + {rows} 行数据、{columns} 列'
            + (f'，还原 {restored} 个单元格格式' if restored else '')
            + (f'，透传标记色 {len(marked_cells)} 格（{len(marked_rows)} 行，最近扫描新增）'
               if marked_cells else '')
            + ')'
        )
        results.append({
            'name': target_name,
            'rows': rows,
            'columns': columns,
            'sourceSheet': SOURCE_SHEET_NAME,
            'sourceFile': Path(member_name).name,
            'restoredFormats': restored,
            'removedFalsePositives': removed,
            'markedRows': marked_rows,
            'markerCellCount': len(marked_cells),
        })

    if len(results) != len(TARGET_SHEETS):
        # locate_members 已经保证每个关键词恰命中一个，这里只是兜底：真发生说明上面
        # 那个循环被改坏了，宁可当场抛错也不要写出半份中间件
        raise ValueError(
            f'解包结果只有 {len(results)} 张 sheet（应当 {len(TARGET_SHEETS)} 张）'
        )

    # 口径（用户 2026-10-21）：**先预处理（删误报行）、再往下走**。上面每张 sheet 搬表前
    # 已经删过；这里只把口径写进日志，方便对着产物核对。
    logs.append(
        f'[解包] 两张 sheet 都已按预处理删掉「{FALSE_POSITIVE_COLUMN}」= '
        f'{" / ".join(FALSE_POSITIVE_VALUES)} 的行（用户口径 2026-10-21：'
        '所有漏洞取值都在预处理之后）；两份也不合并 —— 各自一张 sheet。'
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(output)

    total = sum(item['rows'] for item in results)
    logs.append(
        f'[解包] 已写出 {output}（两张 sheet，合计 {total} 行数据）'
    )

    return {
        'ran': True,
        'alreadyPresent': False,
        'filePath': str(output),
        'sheets': results,
        'logs': logs,
    }


def main():
    decode_argv()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: extract_vuln_report.py '<payload_json>'")

    logs = []
    try:
        payload = json.loads(sys.argv[1])
        if not isinstance(payload, dict):
            raise ValueError('payload 必须是一个 JSON 对象')
        result = extract_vuln_report(payload.get('zip'), payload.get('output'), logs)
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
