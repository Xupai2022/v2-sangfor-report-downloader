#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
漏洞表解包层验收 —— Python 侧主体（入口是 scripts/verify_vuln_extract.js）。

为什么这一段由 Python 收尾：造 zip fixture、以及**把产物读回来逐格看**都要 openpyxl
（JS 侧连读 xlsx 都做不到，见 scripts/verify_write_layer.js 的头注）。而"调真的
extractVulnReport"必须由 JS 做 —— 那是生产里 mssw_downloader.js 真正调的那一层。
所以两边各管一半：

    本文件                                   verify_vuln_extract.js 'extract' 子命令
    造 zip fixture（两份假报表）      ──▶    真的 mssw_vuln_extract.extractVulnReport
    读回产物逐格断言                  ◀──    结果 / 错误原样交回

钉住的事，每一件都对应一处"写错了也不报错、只会静默给错数据"的地方：
  1. **取的是第 4 张 sheet**（`4-漏洞清单+跟踪记录`）而不是第 3 张 —— 两张表头一模一样，
     取错只会少一批行，报告上完全看不出来。fixture 因此让第 3 张带一行独有的 IP。
  2. **预处理删行**（用户口径 2026-10-21）：源里「处置状态」=「处置完成（误报）」的整行
     必须在产物里**不存在**（内外两张各钉一行；外网那行故意写成**半角括号**，钉「只差
     全半角/空白」的退路）。删行发生在搬表之前，所以行数与逐格比对都按**删后**的源算。
  3. **两份不合并、也不并集对齐**：两张 sheet 各自的表头逐字等于各自源表头（30 / 21 列），
     内网那份的内容不能跑到外网那张上。
  4. **幂等**：同一份 zip 重跑一次不重写文件（字节不变），报 ran=false。
  5. 输出已存在但不是本脚本的形态 -> **抛**，不"顺手补齐"（那是「上次写到一半」
     最容易伪装成成功的样子）。
  6. 打包契约变了（缺一份 / 缺那张 sheet / 成员不是 xlsx）-> 当场抛，退回到"随便取一个"
     等于静默少一批行。
"""

import base64
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__（与其余脚本同款）
sys.dont_write_bytecode = True

# 报错文案与日志里全是中文 sheet 名；手工在 GBK 控制台跑时 stdout 可能是 GBK ——
# 只放宽错误处理、不改编码（与 build_report.py / extract_vuln_report.py 同款）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(errors='replace')

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill

# 命令行参数过 _path_helper 的 B64 编码（里面有中文路径）——与其余脚本同款
from _path_helper import decode_argv
# 平台侧的契约**不在这里写第二遍**：名字改了、常量挪了，这道门就该跟着红
from extract_vuln_report import SOURCE_SHEET_NAME, TARGET_SHEETS
# 标记色解析（调色板索引 -> RGB）只有一处实现，验收也走它
from marker_colors import cell_fill_hex

INNER_SHEET = TARGET_SHEETS[0][1]
OUTER_SHEET = TARGET_SHEETS[1][1]

INNER_FILE = '测试客户A-内网漏洞报告-20261016.xlsx'
OUTER_FILE = '测试客户A-外网漏洞报告-20261016.xlsx'

# 真实的第 3 张 sheet 名（「急需修复」的子集，表头与第 4 张一模一样）
DECOY_SHEET = '3-急需修复的漏洞'

# 漏洞表的「发现时间」列（平台 2026-10-29 起由「首次发现时间」改名，含换行；口径见 stats/metrics/vuln.js）
VULN_TIME_HEADER = '发现时间\n（填充此单元格为粉红色代表最近扫描新增漏洞）'

# 两份的列集刻意不同（生产实测 30 / 21 列）：解包层不许做并集对齐，
# 也不许把某一份的表头套到另一份上。
INNER_HEADER = [
    '漏洞名称', '修复优先级', '风险等级', '漏洞类型', '修复建议', '风险描述',
    '风险资产', '资产IP', '威胁标签', '处置状态', VULN_TIME_HEADER, '最近发现时间',
    'CVE编号', 'CNVD编号', 'CNNVD编号', '漏洞端口', '协议', '服务',
    '利用难度', '影响版本', '厂商', '产品', '攻击路径', 'POC状态',
    '是否可远程利用', '修复期限', '责任人', '处置说明', '处置时间', '所属业务',
]
OUTER_HEADER = [
    '漏洞名称', '修复优先级', '风险等级', '漏洞类型', '修复建议', '风险描述',
    '风险资产', '资产IP', '威胁标签', '处置状态', '风险端口数', '域名',
    'URL', '互联网暴露', VULN_TIME_HEADER, '最近发现时间', '处置说明', '处置时间',
    '责任人', '所属业务', '资产重要级别',
]
assert len(INNER_HEADER) == 30 and len(OUTER_HEADER) == 21, 'fixture 的列数就是要在源的 30/21 上'

FIRST_SEEN = datetime.datetime(2026, 9, 1, 8, 30, 0)

# 内网那份：三行，其中一行是**必须被预处理删掉的误报行**（口径 2 的钉子）
INNER_ROWS = [
    ['内-漏洞甲', '高', '高危', '远程命令执行', '升级', '描述', '10.1.0.1', '10.1.0.1',
     '高可利用', '待处置', FIRST_SEEN, FIRST_SEEN, 'CVE-2026-0001', '', '', 8443, 'https',
     'nginx', '低', '1.0', '厂商A', '产品A', '/a', '已公开', '是', '2026-10-20', '张三',
     '', '', 'OA'],
    ['内-漏洞乙', '中', '中危', '弱口令', '改密码', '描述', '10.1.0.2', '10.1.0.2',
     '热点漏洞、勒索利用', '处置完成（已修复）', FIRST_SEEN, FIRST_SEEN, '', 'CNVD-2026-1',
     '', 22, 'ssh', 'openssh', '中', '2.0', '厂商B', '产品B', '/b', '未公开', '否',
     '2026-10-25', '李四', '已打补丁', FIRST_SEEN, '财务'],
    ['内-漏洞丙', '低', '低危', '信息泄露', '关端口', '描述', '10.1.0.3', '10.1.0.3',
     '病毒利用', '处置完成（误报）', FIRST_SEEN, FIRST_SEEN, '', '', '', 9200, 'http',
     'es', '高', '7.0', '厂商C', '产品C', '/c', '未公开', '否', '2026-11-01', '王五',
     '业务误报', FIRST_SEEN, '运维'],
]

# 外网那份：三行，列少 9 列（这正是"不并集对齐"那条的现场）。
# 第三行是**半角括号**的误报（`处置完成(误报)`）—— 钉住「只差括号全半角/空白」那条退路；
# 两张 sheet 各有一行误报，证明删行对两份都生效、不是只处理了内网。
OUTER_ROWS = [
    ['外-漏洞甲', '高', '高危', '反序列化', '升级', '描述', '外网主机1', '1.2.3.4',
     '高可利用', '处置中', 3, 'a.example.com', 'https://a.example.com/x', '是',
     FIRST_SEEN, FIRST_SEEN, '', '', '赵六', '官网', '一级'],
    ['外-漏洞乙', '中', '中危', '越权', '修复', '描述', '外网主机2', '5.6.7.8',
     '热点漏洞', '处置完成（已接受风险）', 1, 'b.example.com', 'https://b.example.com/y', '是',
     FIRST_SEEN, FIRST_SEEN, '', '', '赵六', '官网', '二级'],
    ['外-漏洞丙', '低', '低危', '信息泄露', '关端口', '描述', '外网主机3', '9.9.9.9',
     '病毒利用', '处置完成(误报)', 2, 'c.example.com', 'https://c.example.com/z', '是',
     FIRST_SEEN, FIRST_SEEN, '', '', '赵六', '官网', '三级'],
]

# 预处理之后**应当留下**的行（产物与逐格比对都按这两份算）
INNER_KEPT_ROWS = [row for row in INNER_ROWS if '误报' not in str(row[9])]
OUTER_KEPT_ROWS = [row for row in OUTER_ROWS if '误报' not in str(row[9])]
assert len(INNER_KEPT_ROWS) == 2 and len(OUTER_KEPT_ROWS) == 2, '每份各删掉一行误报'

# 平台用**粉色**标「最近扫描新增漏洞」（表头那格的小字自己写着这条约定）。两种形态都钉住
# （用户口径 2026-10-30「按格透传」）：
#   · 内网第 1 行数据 —— **整行**粉红（平台现在的做法）
#   · 外网第 1 行数据 —— **只有「资产IP」那一格**粉红（平台若改成只标关键列，也只该那格粉）
# 两种都得原样透传：多涂（把一格涂成整行）或少涂都算错。
MARKED_INNER_ROW = 0
MARKED_OUTER_ROW = 0
MARKED_SINGLE_COLUMN = '资产IP'
MARKED_COLOR = 'F2DCDB'

# 第 3 张 sheet（诱饵）：表头与第 4 张逐字相同，行是它的**子集** + 一行独有行。
# 独有行那台的 IP 只出现在这里 —— 产物里要是看见它，就说明取错 sheet 了。
DECOY_EXTRA_IP = '10.9.9.9'
DECOY_ROWS = [INNER_ROWS[0], INNER_ROWS[2], [
    '内-只在该修复清单里', '高', '高危', '远程命令执行', '升级', '描述',
    DECOY_EXTRA_IP, DECOY_EXTRA_IP, '高可利用', '待处置', FIRST_SEEN, FIRST_SEEN,
    '', '', '', 443, 'https', 'nginx', '低', '1.0', '厂商A', '产品A', '/d', '已公开',
    '是', '2026-10-18', '张三', '', '', 'OA',
]]


def build_source_workbook(path, header, rows, include_decoy=True):
    """一份假报表：四张 sheet，**最后那张**才是完整清单（见 extract_vuln_report.py 头注）。"""
    workbook = Workbook()
    first = True
    sheets = [('1-漏洞概况', [['项目', '值'], ['统计时间', '2026-10-16']]),
              ('2-修复指引', [['优先级', '建议'], ['高', '24 小时内']])]
    if include_decoy:
        sheets.append((DECOY_SHEET, [header] + DECOY_ROWS))
    sheets.append((SOURCE_SHEET_NAME, [header] + rows))

    for name, aoa in sheets:
        sheet = workbook.active if first else workbook.create_sheet()
        first = False
        sheet.title = name
        for row in aoa:
            sheet.append(row)

        # 两张源表各涂一种标记形态（RGB 写法；生产导出走的是调色板索引 61，
        # 两种写法都由 marker_colors 解析）：内网整行涂、外网只涂「资产IP」那一格
        if name == SOURCE_SHEET_NAME and rows is INNER_ROWS:
            fill = PatternFill(start_color=f'FF{MARKED_COLOR}', end_color=f'FF{MARKED_COLOR}',
                               fill_type='solid')
            marked_row = MARKED_INNER_ROW + 2  # 表头占第 1 行
            for col in range(1, len(header) + 1):
                sheet.cell(row=marked_row, column=col).fill = fill
        if name == SOURCE_SHEET_NAME and rows is OUTER_ROWS:
            fill = PatternFill(start_color=f'FF{MARKED_COLOR}', end_color=f'FF{MARKED_COLOR}',
                               fill_type='solid')
            single_col = header.index(MARKED_SINGLE_COLUMN) + 1
            sheet.cell(row=MARKED_OUTER_ROW + 2, column=single_col).fill = fill

    workbook.save(path)
    return str(path)


def build_zip(zip_path, members):
    """{zip 内条目名: 磁盘上的文件} -> 一个 zip。目录条目之外还塞一个非 xlsx 成员，
    钉「多余条目一律不看、也不因为多一个文件就报错」。"""
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, source in members.items():
            archive.write(source, name)
    return str(zip_path)


class Checker:
    """攒断言，最后统一报几条没过（与 verify_write_layer.py 同款，第一条就中断看不到后面）。"""

    def __init__(self):
        self.failures = []

    def check(self, ok, label, actual, expected=None):
        mark = '✓' if ok else '✗'
        suffix = '' if expected is None else f'  (期望 {expected})'
        print(f'  {mark} {label}: {actual}{suffix}')
        if not ok:
            self.failures.append(label)

    def section(self, title):
        print(f'\n【{title}】')


def call_bridge(bridge, request):
    """跑一次 JS 侧的 extract 子命令，返回 {ok, result|message, logs}。"""
    payload = base64.b64encode(json.dumps(request, ensure_ascii=False).encode('utf-8')).decode()
    proc = subprocess.run(
        ['node', str(bridge), 'extract', f'B64:{payload}'],
        capture_output=True, text=True, encoding='utf-8',
    )
    text = (proc.stdout or '').strip()
    if not text:
        raise RuntimeError(f'node extract 没有输出（退出码 {proc.returncode}）: {(proc.stderr or "").strip()}')
    return json.loads(text)


def extract(bridge, zip_path, output_path=None):
    """走真 extractVulnReport 跑一次，返回 (result, error_message)。"""
    request = {'zipPath': zip_path}
    if output_path is not None:
        request['outputPath'] = output_path
    answer = call_bridge(bridge, request)
    if answer.get('ok'):
        return answer['result'], None
    return None, answer.get('message') or '（没有报错文案）'


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sheet_values(sheet):
    """一张 sheet -> [[...], ...]（含空串占位，直接可比）。"""
    return [[cell.value if cell.value is not None else '' for cell in row]
            for row in sheet.iter_rows()]


def check_product(checker, result, inner_file, outer_file):
    """产物本身（JS 侧交回来的那张清单）+ 读回来逐格看。"""
    checker.section('1】zip -> 两张 sheet（各自一张，行数与列数都按各自那份）')
    checker.check(result['ran'] is True and result['alreadyPresent'] is False,
                  '第一次跑 ran=true / alreadyPresent=false',
                  json.dumps({'ran': result['ran'], 'alreadyPresent': result['alreadyPresent']}))
    names = [item['name'] for item in result['sheets']]
    checker.check(names == [INNER_SHEET, OUTER_SHEET],
                  '两张 sheet 的名字与**顺序**（内网在前 —— 与模板里那两张的位置一致）',
                  json.dumps(names, ensure_ascii=False),
                  json.dumps([INNER_SHEET, OUTER_SHEET], ensure_ascii=False))

    rows = [item['rows'] for item in result['sheets']]
    columns = [item['columns'] for item in result['sheets']]
    checker.check(rows == [len(INNER_KEPT_ROWS), len(OUTER_KEPT_ROWS)],
                  '行数 = 源里第 4 张 sheet 的数据行数**减去预处理删掉的误报行**',
                  json.dumps(rows),
                  json.dumps([len(INNER_KEPT_ROWS), len(OUTER_KEPT_ROWS)]))
    removed = [item.get('removedFalsePositives') for item in result['sheets']]
    checker.check(removed == [len(INNER_ROWS) - len(INNER_KEPT_ROWS),
                              len(OUTER_ROWS) - len(OUTER_KEPT_ROWS)],
                  '每张 sheet 各报出删掉的误报行数（内外各 1 行）',
                  json.dumps(removed), '[1, 1]')
    checker.check(columns == [len(INNER_HEADER), len(OUTER_HEADER)],
                  '列数 30 / 21 —— 两份的列集本来就不同，**不做并集对齐**',
                  json.dumps(columns), json.dumps([len(INNER_HEADER), len(OUTER_HEADER)]))
    sources = [item['sourceFile'] for item in result['sheets']]
    checker.check(sources == [inner_file, outer_file],
                  '每张 sheet 的源是**各自那份**文件（不是同一份搬两遍）',
                  json.dumps(sources, ensure_ascii=False),
                  json.dumps([inner_file, outer_file], ensure_ascii=False))
    checker.check(all(item['sourceSheet'] == SOURCE_SHEET_NAME for item in result['sheets']),
                  f'两边的源 sheet 都是「{SOURCE_SHEET_NAME}」（平台侧契约，不是第一张）',
                  json.dumps([item['sourceSheet'] for item in result['sheets']], ensure_ascii=False),
                  json.dumps([SOURCE_SHEET_NAME] * 2, ensure_ascii=False))

    # 日志里那句口径说明是给用户看的：预处理删误报行、两份不合并
    preprocess_logs = [line for line in result['logs'] if '[预处理]' in line and '误报' in line]
    checker.check(len(preprocess_logs) == 2,
                  '每张 sheet 各有一条「[预处理] … 误报 …」日志（删了几行要看得见）',
                  json.dumps(preprocess_logs, ensure_ascii=False), '（两条）')

    # —— 读回产物逐格比。到这儿才真的证明"文件里落了什么"。
    workbook = load_workbook(result['filePath'], data_only=True)
    checker.check(workbook.sheetnames == [INNER_SHEET, OUTER_SHEET],
                  '产物工作簿里就这两张 sheet（顺序也一致）',
                  json.dumps(workbook.sheetnames, ensure_ascii=False),
                  json.dumps([INNER_SHEET, OUTER_SHEET], ensure_ascii=False))

    inner = workbook[INNER_SHEET]
    outer = workbook[OUTER_SHEET]
    inner_values = sheet_values(inner)
    outer_values = sheet_values(outer)

    checker.check(inner_values[0] == INNER_HEADER,
                  '内网那张的表头**逐字**等于内网源的表头（30 列）',
                  json.dumps(inner_values[0][:6], ensure_ascii=False) + ' …',
                  json.dumps(INNER_HEADER[:6], ensure_ascii=False) + ' …')
    checker.check(outer_values[0] == OUTER_HEADER,
                  '外网那张的表头**逐字**等于外网源的表头（21 列）—— '
                  '不是把内网那份套过来、也不是两份的并集',
                  json.dumps(outer_values[0][:6], ensure_ascii=False) + ' …',
                  json.dumps(OUTER_HEADER[:6], ensure_ascii=False) + ' …')

    # 逐格比：数据行与源表（删掉误报行之后）一模一样（含日期那种"数字格式还原"的单元格）
    checker.check(inner_values[1:] == INNER_KEPT_ROWS,
                  '内网那张的数据行 = 源**删掉误报行之后**逐格相同（含日期单元格 —— 数字格式要还原回来）',
                  json.dumps([[row[0], row[9], str(row[10])] for row in inner_values[1:]],
                             ensure_ascii=False, default=str))
    checker.check(outer_values[1:] == OUTER_KEPT_ROWS,
                  '外网那张的数据行 = 源**删掉误报行之后**逐格相同（半角括号那行也删掉了）',
                  json.dumps([[row[0], row[9], row[10]] for row in outer_values[1:]],
                             ensure_ascii=False))

    disposition_index = INNER_HEADER.index('处置状态')
    dispositions = [row[disposition_index] for row in inner_values[1:]]
    checker.check(all('误报' not in str(value) for value in dispositions),
                  '内网那张里「处置完成（误报）」那行**已删**（用户口径 2026-10-21：'
                  '所有漏洞取值都在预处理之后）',
                  json.dumps(dispositions, ensure_ascii=False))

    outer_disposition_index = OUTER_HEADER.index('处置状态')
    outer_dispositions = [row[outer_disposition_index] for row in outer_values[1:]]
    checker.check(all('误报' not in str(value) for value in outer_dispositions),
                  '外网那张里半角的「处置完成(误报)」那行**也已删**'
                  '（只差括号全半角/空白的退路要生效）',
                  json.dumps(outer_dispositions, ensure_ascii=False))

    # 取错 sheet 的现场：诱饵那张（第 3 张）独有的 IP 一行都不该出现在产物里
    asset_index = INNER_HEADER.index('资产IP')
    assets = [row[asset_index] for row in inner_values[1:]]
    checker.check(DECOY_EXTRA_IP not in assets,
                  f'诱饵 sheet（{DECOY_SHEET}，表头与第 4 张逐字相同、行是它的子集）'
                  '里的独有行不在产物里 —— 取的是第 4 张，不是"随便取一张"',
                  json.dumps(assets, ensure_ascii=False))
    checker.check(len(assets) == len(INNER_KEPT_ROWS),
                  '内网那几行**除误报行外全在**、一行没少（取错 sheet 只会少行，不会报错）',
                  len(assets), len(INNER_KEPT_ROWS))

    # 标记色透传（用户口径 2026-10-30，按**格**）：源上怎么标，产物上就怎么标 ——
    # 整行标的那行整行粉；只标一格的那行**只有那一格**粉（不能顺手把整行涂满），
    # 没标过的行一个格都不粉。
    marked_output_row = MARKED_INNER_ROW + 2  # 表头占第 1 行
    marked_fills = {
        cell_fill_hex(inner.cell(row=marked_output_row, column=col))
        for col in range(1, len(INNER_HEADER) + 1)
    }
    checker.check(marked_fills == {MARKED_COLOR},
                  '源上整行标的行，产物上整行粉红（一格不少、也没有漏成半行）',
                  json.dumps(sorted(marked_fills, key=str)), json.dumps([MARKED_COLOR]))

    single_output_row = MARKED_OUTER_ROW + 2
    single_col = OUTER_HEADER.index(MARKED_SINGLE_COLUMN) + 1
    single_fills = {
        col: cell_fill_hex(outer.cell(row=single_output_row, column=col))
        for col in range(1, len(OUTER_HEADER) + 1)
    }
    checker.check(single_fills.get(single_col) == MARKED_COLOR
                  and {color for col, color in single_fills.items() if col != single_col} == {None},
                  f'源上只标「{MARKED_SINGLE_COLUMN}」那一格的行，产物上也**只**那一格粉'
                  '（按格透传，不把整行涂满）',
                  json.dumps(single_fills, ensure_ascii=False, sort_keys=True)[:160] + ' …')

    unmarked_row = next(
        row for row in range(2, 2 + len(INNER_KEPT_ROWS))
        if row != marked_output_row
    )
    checker.check(cell_fill_hex(inner.cell(row=unmarked_row, column=1)) != MARKED_COLOR,
                  '没被标过的那一行**不会**被顺手涂粉（判定是按源表底色，不是按行号猜）',
                  json.dumps(cell_fill_hex(inner.cell(row=unmarked_row, column=1))))
    checker.check(result['sheets'][0].get('markedRows') == [marked_output_row],
                  '返回值的 markedRows 报的就是这一行（不静默，方便日志里看见）',
                  json.dumps(result['sheets'][0].get('markedRows')), json.dumps([marked_output_row]))
    checker.check(result['sheets'][1].get('markedRows') == [single_output_row],
                  '外网那份只标了一格，markedRows 也只报这一行（同一行多个标记格只报一次）',
                  json.dumps(result['sheets'][1].get('markedRows')),
                  json.dumps([single_output_row]))
    return workbook


def check_idempotent(checker, bridge, fixture, output):
    """幂等闸：同一份 zip 重跑一次不重写文件（这层要能被安全地重复调用）。"""
    checker.section('2】幂等（同一份 zip 重跑不重写文件）')
    before = sha256(output)
    result, error = extract(bridge, fixture, output)
    checker.check(error is None, '第二次跑不报错', error or '（无）')
    if error:
        return
    checker.check(result['ran'] is False and result['alreadyPresent'] is True,
                  '第二次跑报 ran=false / alreadyPresent=true（跳过，不重算）',
                  json.dumps({'ran': result['ran'], 'alreadyPresent': result['alreadyPresent']}))
    checker.check(result['sheets'] == [],
                  '跳过时 sheets 是空数组（没重读，也就没有行数可报）',
                  json.dumps(result['sheets'], ensure_ascii=False), '[]')
    checker.check(sha256(output) == before,
                  '产物**字节不变**（跳过就是真的一个字节都没写）',
                  sha256(output)[:16], before[:16])


def check_failures(checker, bridge, workdir):
    # 验收产物只写可写根：集群上这个根是 Runtime Guard 注入的 SKILL_OUTPUT_DIR。
    output_root = (os.environ.get('SKILL_OUTPUT_DIR') or '').strip()
    if output_root and not os.path.abspath(str(workdir)).startswith(os.path.abspath(output_root) + os.sep):
        raise RuntimeError(f'验收工作目录必须位于 SKILL_OUTPUT_DIR 下: {workdir}')
    """五条打包/中间件形态没对上时的失败口径 —— 都不许"退化到能跑就行"。"""
    checker.section('3】契约没对上时当场抛（不退化、不覆盖）')

    # 3.1 输出已存在但不是本脚本的形态（写到一半的中间件）
    shape = workdir / 'half.xlsx'
    workbook = Workbook()
    workbook.active.title = '不是这个形态'
    workbook.save(shape)
    good_zip = build_zip(workdir / 'ok.zip', {
        INNER_FILE: build_source_workbook(workdir / 'i.xlsx', INNER_HEADER, INNER_ROWS),
        OUTER_FILE: build_source_workbook(workdir / 'o.xlsx', OUTER_HEADER, OUTER_ROWS),
    })
    _, error = extract(bridge, good_zip, str(shape))
    checker.check(bool(error) and '不是本脚本的形态' in (error or ''),
                  '输出已存在但 sheet 不对 -> 抛（不覆盖、也不"顺手补齐"）',
                  error or '（没有报错）')

    # 3.2 zip 里缺外网那份
    only_inner = build_zip(workdir / 'only-inner.zip', {
        INNER_FILE: build_source_workbook(workdir / 'i2.xlsx', INNER_HEADER, INNER_ROWS),
    })
    _, error = extract(bridge, only_inner)
    checker.check(bool(error) and '外网' in (error or ''),
                  'zip 里没有含「外网」的 xlsx -> 抛，消息里点名「外网」',
                  error or '（没有报错）')

    # 3.3 源工作簿里没有那张清单 sheet（前几张是概览/指引/子集）
    no_target = build_source_workbook(workdir / 'no-target.xlsx', INNER_HEADER, INNER_ROWS,
                                      include_decoy=True)
    wit = load_workbook(no_target)
    del wit[SOURCE_SHEET_NAME]
    wit.save(no_target)
    missing_sheet_zip = build_zip(workdir / 'no-sheet.zip', {
        INNER_FILE: no_target,
        OUTER_FILE: build_source_workbook(workdir / 'o3.xlsx', OUTER_HEADER, OUTER_ROWS),
    })
    _, error = extract(bridge, missing_sheet_zip)
    checker.check(bool(error) and SOURCE_SHEET_NAME in (error or '') and '现有' in (error or ''),
                  f'源里没有「{SOURCE_SHEET_NAME}」-> 抛，并把**实际有哪些 sheet** 报出来'
                  '（不许退而取第一张：概览那张看起来也像一张表）',
                  error or '（没有报错）')

    # 3.4 成员不是 xlsx（zip 里塞的是坏字节）
    junk = workdir / 'junk.xlsx'
    junk.write_bytes(b'this is not an xlsx at all')
    bad_member_zip = build_zip(workdir / 'bad-member.zip', {
        INNER_FILE: junk,
        OUTER_FILE: build_source_workbook(workdir / 'o4.xlsx', OUTER_HEADER, OUTER_ROWS),
    })
    _, error = extract(bridge, bad_member_zip)
    checker.check(bool(error) and '不是 xlsx' in (error or ''),
                  'zip 成员不是 xlsx -> 抛人话（不是 BadZipFile 的 traceback）',
                  error or '（没有报错）')

    # 3.5 zip 里一个 xlsx 都没有
    empty_zip = build_zip(workdir / 'empty.zip', {'说明.txt': junk})
    _, error = extract(bridge, empty_zip)
    checker.check(bool(error) and '一个 xlsx 都没有' in (error or ''),
                  'zip 里一个 xlsx 都没有 -> 抛，并把条目名列出来',
                  error or '（没有报错）')


def _write_text(path, text):
    # 只允许写可写根（集群是 SKILL_OUTPUT_DIR）；越界当场报错，不静默写只读的 skill 根。
    output_root = (os.environ.get('SKILL_OUTPUT_DIR') or '').strip()
    if output_root and not os.path.abspath(str(path)).startswith(os.path.abspath(output_root) + os.sep):
        raise RuntimeError(f'验收产物必须写在 SKILL_OUTPUT_DIR 下: {path}')
    path.write_text(text, encoding='utf-8')
    return path


def main():
    decode_argv()
    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    bridge = payload.get('bridge')
    if not bridge:
        raise SystemExit('缺少 bridge（谁调我、到哪回溯）')

    checker = Checker()
    # 集群上 skill 根只读、/tmp 不持久：有 SKILL_OUTPUT_DIR 就把验收产物落那里。
    workdir = Path(tempfile.mkdtemp(
        prefix='v2-vuln-extract-',
        dir=(os.environ.get('SKILL_OUTPUT_DIR') or None),
    ))
    try:
        inner = build_source_workbook(workdir / 'src-inner.xlsx', INNER_HEADER, INNER_ROWS)
        outer = build_source_workbook(workdir / 'src-outer.xlsx', OUTER_HEADER, OUTER_ROWS)
        fixture = build_zip(workdir / '客户A-漏洞报告-20261016.zip', {
            INNER_FILE: inner,
            OUTER_FILE: outer,
            # 多余的非 xlsx 条目：不看、也不因为多一个文件就报错
            '说明.txt': _write_text(workdir / '说明.txt', '本压缩包由平台生成'),
        })
        # 输出路径不给 -> 走 vulnWorkbookPath 的推导（生产就是这条路）
        expected_output = str(Path(fixture).with_suffix('.xlsx'))

        result, error = extract(bridge, fixture)
        checker.check(error is None, '解一份正常的下载件不报错', error or '（无）')
        if error:
            return checker

        checker.check(Path(result['filePath']) == Path(expected_output),
                      '不传 outputPath -> 中间件落在「同目录同主名换后缀」那个路径上'
                      '（幂等闸就压在这个路径上）',
                      result['filePath'], expected_output)

        check_product(checker, result, INNER_FILE, OUTER_FILE)
        check_idempotent(checker, bridge, fixture, result['filePath'])
        check_failures(checker, bridge, workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if checker.failures:
        print(f'\n{len(checker.failures)} 项未通过')
        for label in checker.failures:
            print(f'  ✗ {label}')
        return None
    print('\n解包层验收全部通过')
    return True


if __name__ == '__main__':
    outcome = main()
    # 退出码 2 = 断言没过（1 会被 python_cmd 当成"解释器不存在"，见 verify_write_layer.py）
    raise SystemExit(0 if outcome else 2)
