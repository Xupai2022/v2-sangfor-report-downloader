#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读一份平台导出的总表（xlsx）-> 内存行对象数组。

**这是 MIGRATION.md R9 的 `parse*` 那一半。** R9 要求每份总表对应一对函数：一个
`fetch*` 把表下到磁盘（在 mssw_client.js），一个 `parse*` 把它读成内存行对象。
本仓库的 Excel 读写全是 openpyxl，JS 侧读不了 xlsx，所以 `parse*` 只能落在 Python
这边，由 mssw_parser.js 拉起。

本文件是**通用**的读表器，不是告警表专用：将来事件表/漏洞表要用，换个 `columns`
白名单就够了，不要再写第二个读表器（那正是 R9 想避免的事）。

行对象的形态（stats/metrics/*.js 消费的就是这个）：

    { "告警定性": "未知威胁" }

四条硬规矩，违反哪一条都会让取值层静默算错：

  1. **键是表头文字，绝不按列下标。** 平台导出的列集是数据相关的：同一个接口同一组
     参数，116 条数据出 77 列、0 条数据只出 68 列，整列无值的列直接不出现
     （见 mssw_client.js 里 MSSW_ALERT_TABLE_FIELDS 的注记）。按列下标写死的代码，
     换一份数据就会静默数到别的列上。
  2. **每一行都携带请求的每一列的键**（该列在表头里存在时），空值写空串 ''。
     取值层用 `hasOwnProperty` 判「这一列在不在」；漏键会把「列存在但整列为空」
     误判成「列不存在」，于是本该记「空表」的那格变成报「列名被改了」。
  3. **请求的列在表头里不存在时，一行都不带这个键**（不补空串）—— 这正是规矩 2 里
     那条防线要的信号：`hasOwnProperty` 为假 => 列名对不上 => 取值层抛错（R10）。
  4. **表头重名直接抛错。** 行对象以表头文字为键，重名列会互相覆盖，静默丢掉一列
     比报错糟得多；这里不做「取第几个」的猜测。

单元格值的形态见 `format_cell_value`（时间列给的是 **epoch 秒**，R11）。

用法:
    python parse_table_rows.py '<payload>'    # 走 B64GZ:（gzip + base64）或 B64: 前缀（中文路径）
payload_json:
    {
      "path":    "<xlsx 绝对路径>",
      "sheet":   null,              # null / 省略 = 第一个 worksheet；也可以是名字，或名字数组
      "columns": ["告警定性"]        # 省略 = 全部具名列（小心：大表会撞 maxBuffer）
    }

`sheet` 传**数组**时，多张 worksheet 会被逐张读、行**顺序拼接**成同一个行数组
（漏洞表 2026-10-16 起的用法：下载件里内网/外网各一张 sheet，而取值层的口径是
「全表 = 两份相加」，见 stats/metrics/vuln.js 头注）。此时：

  · header       回报**第一张** sheet 的表头（诊断用，两张的列集本来就不同）
  · rowCount/rows 两张的数据行拼接后的总数
  · missingColumns 各张的并集（某张缺一列就会报出来 —— 那正是「列名被改了」的信号）
  · unnamedColumns 各张之和

输出:
    stdout: {"sheet", "header", "rowCount", "rows", "missingColumns", "unnamedColumns"}
        header          该表的**全部**表头（诊断用；rowCount/rows 只带 columns 要的列）
        rowCount        数据行数（不含表头行）
        rows            行对象数组，见上面四条规矩
        missingColumns  请求了但表头里没有的列
        unnamedColumns  表头为空的列数（这些列无法按名字寻址，不进行对象）
    stderr: 失败时 {"diag":"error","message"}（与 build_report.py 同一套协议）
"""

import datetime
import json
import sys
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__。
# 放在下面这些本地 import 之前，否则它们自己就已经先把 pycache 写进去了。
sys.dont_write_bytecode = True

# 报错文案里会有「」和中文列名；PYTHONIOENCODING 由调用方的 workdir.childEnv() 设好，
# 但手工在 GBK 控制台执行时 stdout 可能是 GBK，那样会在**已经读完表**之后抛
# UnicodeEncodeError。只放宽错误处理、不改编码，与 build_report.py 同款。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _path_helper import decode_argv
# 行集合的口径必须与合并引擎同源，否则取值层数出的行数与交付物里看到的对不上
from build_report import (
    collect_source_rows,
    is_blank,
    js_string,
    load_source_workbook,
    pick_source_sheet,
    split_leading_blank_rows,
)


def format_cell_value(value):
    """单元格值 -> 交给 JS 的形态。

    · None  -> ''（空串，不是 null：取值层按「空串 = 有这一列但没值」处理）
    · 时间  -> **epoch 秒**（R11：全仓时间戳单位统一用秒）

    时间那一条是**刻意与交付物不同**的：报告 sheet 里时间列写的是 Excel 序列号 +
    日期格式（见 build_report.to_serial_number，那是为了与旧版逐格对齐）。读到这里
    已经是 openpyxl 还原出的 datetime，把它换成秒，取值层就只有一个时间单位可用，
    不必每次去猜拿到的是天还是秒。

    无时区的 datetime 按 **UTC** 解释：Excel 里存的是墙上时间、本来就没有时区信息，
    而本地（Windows）与集群（Linux）的本地时区可能不同 —— 选 UTC 是为了同一份表
    在两处读出同一个数。time 类型（纯时刻，没有日期）给的是**当日零点起的秒数**，
    它不是一个时间戳，套 epoch 只会得到一个荒唐的 1900 年的数。
    """
    if value is None:
        return ''
    if isinstance(value, bool):
        return value
    if isinstance(value, datetime.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=datetime.timezone.utc)
        return int(value.timestamp())
    if isinstance(value, datetime.date):
        return int(datetime.datetime(
            value.year, value.month, value.day, tzinfo=datetime.timezone.utc
        ).timestamp())
    if isinstance(value, datetime.time):
        return value.hour * 3600 + value.minute * 60 + value.second
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (int, float)):
        return value
    return str(value)


def read_header_and_rows(sheet):
    """sheet -> (header, 数据行值列表)。

    行集合与报告里这张 sheet **完全同源**：同一个 collect_source_rows（整行没值才丢，
    空串算有内容）+ 同一个 split_leading_blank_rows（丢掉开头的空行）。两处同源，
    取值层数出来的行数才等于交付物里肉眼看到的行数。
    """
    rows = split_leading_blank_rows(collect_source_rows(sheet))
    if not rows:
        return [], []

    # 表头文字原样用，**不去首尾空白**：键就是要与平台导出的列名逐字对上，
    # 名字里真带了空格的话，宁可让 hasOwnProperty 那条防线抛错（错误信息里带着
    # 完整表头，一眼看得出来），也不要自作主张替用户决定「空白算不算」
    header = ['' if is_blank(value) else js_string(value) for value in rows[0][0]]
    return header, [values for values, _formats in rows[1:]]


def normalize_sheet_names(value):
    """payload 的 `sheet` -> sheet 名列表。

    空列表 = 「取第一个 worksheet」（老路径，不认名字）。字符串 = 单个名字，
    字符串数组 = 逐个读、行顺序拼接。其余形态直接抛错 —— `sheet` 传错会静默读到
    另一张 sheet 上（漏洞表那两份的列集本来就不同），不值得为它做容错。
    """
    if value is None or value == '':
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(name, str) for name in value):
        names = [name for name in value if name]
        if names:
            return names
    raise ValueError('sheet 必须是 sheet 名字符串、名字数组（或省略表示第一个 worksheet）')


def build_sheet_records(actual_name, header, value_rows, requested):
    """一张 sheet -> 它的行对象数组与诊断信息。

    四条硬规矩（见模块头注）**逐张 sheet 各判一遍**：两张 sheet 的表头本就不同，
    「列名对不上」「表头重名」都要落到具体是哪一张上，报错文案里因此带着 sheet 名。

    列白名单里的某一列若只在其中一张里有（另张没有），那张的行对象就不带这个键
    （规矩 3）—— 所以**同一批行里不同 sheet 来的行，键集可能不同**。这正是
    `missingColumns` 要取并集的原因：某张缺一列就得报出来，那是「列名被改了」的信号。
    注意是**并集、不是交集** —— 只要有一张读不出这一列就报（不是「两张都缺才算缺」）。
    反过来也成立：两张都有的列（漏洞表那三列白名单内外网都有）一个都不会误报，
    哪怕两份的列数差着 11 列。
    """
    named = [name for name in header if name]

    duplicated = sorted({name for name in named if named.count(name) > 1})
    if duplicated:
        raise ValueError(
            f'总表 {actual_name} 的表头有重名列: {"、".join(duplicated)}。'
            '行对象以表头文字为键，重名列会互相覆盖 —— 这里不做「取第几个」的猜测，'
            '先让平台把列名定下来。'
        )

    # 列名 -> 列序（0 基）。named 已保证无不重名，取到的就是唯一那一列。
    index_of = {}
    for index, name in enumerate(header):
        if name and name not in index_of:
            index_of[name] = index

    wanted = named if requested is None else requested
    # 表头里没有的列不进行对象（规矩 3），只回报给调用方
    missing = [column for column in wanted if column not in index_of]
    keys = [column for column in wanted if column in index_of]

    data = []
    for values in value_rows:
        record = {}
        for key in keys:
            index = index_of[key]
            record[key] = format_cell_value(values[index] if index < len(values) else None)
        data.append(record)

    return {
        'rows': data,
        'missingColumns': missing,
        'unnamedColumns': len(header) - len(named),
    }


def parse_table_rows(payload):
    """R9 的 parse*：总表 -> 行对象数组。返回体见模块头注。

    `sheet` 是数组时（漏洞表：内网/外网两张 sheet），逐张按**同一份列白名单**读、
    行顺序拼接 —— 拼接顺序就是数组顺序，本函数不排序、不去重、不合并同 IP 的行。
    """
    file_path = payload.get('path')
    sheet_names = normalize_sheet_names(payload.get('sheet'))

    requested = payload.get('columns')
    if requested is not None:
        if not isinstance(requested, list) or not all(isinstance(c, str) for c in requested):
            raise ValueError('columns 必须是字符串数组（或省略表示要全部具名列）')
        requested = [column for column in requested if column]

    # 一个文件里的多张 sheet 共用同一个 workbook（不必按 sheet 各打开一遍）
    workbook = load_source_workbook(file_path)

    actual_names = []
    header = []
    rows = []
    missing = []
    unnamed = 0

    for sheet_name in (sheet_names or [None]):
        actual_name, sheet = pick_source_sheet(workbook, file_path, sheet_name)
        sheet_header, value_rows = read_header_and_rows(sheet)
        records = build_sheet_records(actual_name, sheet_header, value_rows, requested)

        # header 只回报**第一张** sheet 的表头（诊断用）：两张的列集不同，
        # 拼成一份「表头」只会得到一份哪张都对不上的东西。
        if not actual_names:
            header = sheet_header
        actual_names.append(actual_name)
        rows.extend(records['rows'])
        missing.extend(name for name in records['missingColumns'] if name not in missing)
        unnamed += records['unnamedColumns']

    return {
        # 多张时用 `+` 连接（诊断字段；实际是哪几张看行列数对不对得上）
        'sheet': '+'.join(actual_names),
        'header': header,
        'rowCount': len(rows),
        'rows': rows,
        'missingColumns': missing,
        'unnamedColumns': unnamed,
    }


def main():
    decode_argv()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: parse_table_rows.py '<payload_json>'")

    try:
        payload = json.loads(sys.argv[1])
        if not isinstance(payload, dict):
            raise ValueError('payload 必须是一个 JSON 对象')
        result = parse_table_rows(payload)
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
