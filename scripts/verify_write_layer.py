#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""写入层验收 —— 主体。

查四件事，缺一不可：

  【1】429 格登记表 + ctx：只有 J1/L1/M1 落值，其余 385 格一个字都不写
      （其中 14 格要读告警表、21 格要读事件表、6 格核心业务系统要读四份总表与
       --business-systems，验收用的 ctx 三样都不带，它们必须走缺数路径：不写值、记 errors）
  【2】各写模式（取值 / alias / percent / literal / blank / 抛错 / undefined / unresolved）
       是否按 CELL_REGISTRY.md §4 的语义工作
  【3】端到端（buildReport + ctx，不美化）：「数据统计」相对模板的变化必须**只有** J1/L1/M1
  【3.5】表格预处理：事件表末尾追加「内网外网资产」列，取值/原有列/表头行都对
  【4】生产路径（默认套美化）：走完整交付路径后客户名与报告期还在交付物里
  【5】总表读取层（parse_table_rows.py）：行对象契约 —— 键是表头文字、每行带全键、
       空值空串、缺列不补键、重名抛错、时间给 epoch 秒
  【6】告警定性统计端到端：接上告警总表后 C133:I134 真的落进报告；
       列名被改 / 空表这两种边界必须一个值都不写、全进错误列表
  【7】核心业务系统端到端：接上四份总表与 --business-systems 后 D3/D4/D5 落系统名、
       D7/D8/D9 落「漏洞 + 弱密码 + 事件」三段之和；少传系统 / 资产表缺列 /
       漏洞表缺列这几种边界必须不写值、全进错误列表；而
       资产表「所属业务」整列为空 -> 那是 0（用户口径），不是缺数；
       漏洞 / 弱密码 / 事件哪一份整份没读到 -> 那一段按 0 计、其余段照算（同为用户口径），
       只有**资产表**缺席才整格不写值 —— 它是「业务归属 -> IP」的钥匙，缺的不是一段
  【8】事件定性统计端到端：接上事件总表后 C135:I137 真的落进报告（135 行名称 /
       136 行数量 / 137 行占比，各 7 槽）；列名被改 / 空表 / 整列全是占位符 `-`
       这三种边界必须一个值都不写、全进错误列表

分工：**JS 只回答"我决定写什么"**（plan 子命令），本文件回答"文件里到底落了什么"。
所以每一条断言都要读回落盘后的文件 —— 内存里对不算数。

用法（一般不用手敲，走 `npm run verify:write`）:
    python scripts/verify_write_layer.py '<{"repo":..., "bridge":...}>'
"""

import datetime
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# 集群上 skill 根是只读挂载：绝不让 Python 往那儿写 __pycache__
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import Workbook, load_workbook

from _path_helper import decode_argv
from build_report import apply_statistics_writes
from parse_table_rows import parse_table_rows

# 模板里带公式的格子：I1 = TODAY()，C7/C8/C9 = D3/D4/D5（TOP3 系统名）。
#
# 这几格的**缓存值**在落盘后必然消失：openpyxl 整本重存时公式格只写 <f> 不写 <v>
# （Excel 打开会自己重算，肉眼看不出来）。旧版是美化那一步才丢，现在 build 这一步就丢 ——
# 属于 build_report.py 头注里记的第 4 条有意差异。所以比对时把它们单列出来，不算"被改坏"。
#
# 注意：引擎只读 L1/M1（都是字符串），一个字都不碰这几格，本仓的取值层也与它们无关。
FORMULA_CELLS = ['C7', 'C8', 'C9', 'I1']

# 接上 ctx 后「数据统计」**应该**变的格子，只此三个。
EXPECTED_CHANGED = ['J1', 'L1', 'M1']

# 登记表全量：429 格 = 3 个报告参数 + 14 格告警定性 + 21 格事件定性 + 6 格核心业务系统
#            + 385 个口径未定。
EXPECTED_WRITTEN = 3
EXPECTED_UNRESOLVED = 385

# 事件定性那 21 格（C135:I137）的行号与槽位数。投喂的口径是「最多 7 个」、地址范围 C..I，
# 所以是 7 个槽位 —— 注意 R1 基准里这三行其实有 10 个（C..L），J/K/L 那 9 格按 R1 冻结
# 原样留在 unresolved，不在本段断言里（见 stats/cells/_baseline.js 的头注）。
EVENT_LABEL = 'GPT定性标签'
EVENT_LABEL_ROW = 135
EVENT_COUNT_ROW = 136
EVENT_SHARE_ROW = 137
EVENT_SLOTS = 7

# 要读总表（或 CLI 入参）才能算的格子。验收用的 ctx **不带任何总表、也不带
# --business-systems**（见 verify_write_layer.js 的 CTX_ARGS），所以这些格子必然走缺数路径：
# 一个值都不写，全部记进 errors（R10 / H6 禁止填 0）。
#
# 这里逐格点名，而不是只数个数 —— 数个数的话，一格偷偷吞掉缺数、
# 另一格被顺手填了 0，总数照样对得上。附带断言它们一个都没进写入计划。
EXPECTED_ALARM_CELLS = [
    'C133', 'D133', 'E133', 'F133', 'G133', 'H133', 'I133',
    'C134', 'D134', 'E134', 'F134', 'G134', 'H134', 'I134',
]
EXPECTED_EVENT_CELLS = [
    f'{chr(ord("C") + rank)}{row}'
    for row in (EVENT_LABEL_ROW, EVENT_COUNT_ROW, EVENT_SHARE_ROW)
    for rank in range(EVENT_SLOTS)
]
EXPECTED_CORE_SYSTEM_CELLS = ['D3', 'D4', 'D5', 'D7', 'D8', 'D9']
EXPECTED_MISSING_TABLE = (EXPECTED_ALARM_CELLS + EXPECTED_CORE_SYSTEM_CELLS
                          + EXPECTED_EVENT_CELLS)

# 事件表追加列的验收值（fixture 见 make_fixtures）。
EVENT_COLUMN = ['C1', 'C2', 'C3', 'C4', 'C5']
EVENT_EXPECTED = {
    'C1': '内网外网资产',
    'C2': '外网',        # 10.0.0.1 在资产表里是「暴露」
    'C3': '内网',        # 10.0.0.2 是「未暴露」
    'C4': '不在资产表',  # 10.0.0.99 查不到
    'C5': None,          # 影响资产为空 -> 留空（连 IP 都没有，写「不在资产表」是无中生有）
}

TEMPLATE_SHEET = '数据统计'
EVENT_SHEET = '事件表'

# 告警定性统计（C133:I134）的 fixture。**表头必须是真的「告警定性」** ——
# 这个列名是从 outputs/ 的产物里取的（见 stats/metrics/alarm.js 的头注），
# 不是编的；编一个别的名字就等于把这条验收建立在一个假前提上。
ALARM_QUALIFICATION = '告警定性'
ALARM_LABEL_ROW = 133
ALARM_SHARE_ROW = 134

# 行序与取值刻意安排过，一份 fixture 覆盖四件事：
#   · 频次排行：未知威胁 3 > 业务行为 2 > …
#   · 并列按**首次出现行序**：定向攻击（第 6 行）与病毒（第 8 行）都只有 1 次，定向攻击在前
#   · 空定性不占名次、**也不进分母**（分母是 7 不是 8）
#   · 凑不满 7 名时靠后的槽位写空串（G/H/I 两行共 6 格）
ALARM_TABLE = [
    [ALARM_QUALIFICATION, '主机IP'],
    ['未知威胁', '10.0.0.1'],
    ['未知威胁', '10.0.0.2'],
    ['未知威胁', '10.0.0.3'],
    ['业务行为', '10.0.0.4'],
    ['业务行为', '10.0.0.5'],
    ['定向攻击', '10.0.0.6'],
    ['', '10.0.0.7'],
    ['病毒', '10.0.0.8'],
]
ALARM_LABELS = ['未知威胁', '业务行为', '定向攻击', '病毒', '', '', '']
ALARM_COUNTS = [3, 2, 1, 1, 0, 0, 0]
ALARM_TOTAL = 7

# 14 格的全量地址：C..I × 133/134（列序 = 名次，从 0 起）
ALARM_ADDRS = [
    f'{chr(ord("C") + rank)}{row}'
    for row in (ALARM_LABEL_ROW, ALARM_SHARE_ROW)
    for rank in range(len(ALARM_LABELS))
]

# ---------------------------------------------------------------------------
# 事件定性统计（C135:I137：135 名称 / 136 数量 / 137 占比）的 fixture
# ---------------------------------------------------------------------------
#
# 表头必须是**真的「GPT定性标签」** —— 列名取自平台直出的产物与中间件
# （见 stats/metrics/event.js 的 GPT_LABEL_COLUMN 头注），不是编的。
#
# 行序与取值刻意安排过，一份 fixture 覆盖五件事：
#   · 频次排行：银狐病毒 3 > 未知威胁 2 > 挖矿木马 1 = 病毒 1
#   · 并列按**首次出现行序**：挖矿木马（第 6 行）与病毒（第 8 行）都只有 1 次，挖矿木马在前
#   · **占位符 `-` 不算一种定性、也不进分母**（分母是 7 不是 8）—— 这是本列最要紧的一条：
#     真实事件表里那一列绝大多数行都是 `-`（华能集团样本 2290/2347），
#     算进去的话报告的第 1 名会是一个横杠
#   · 空串 / 纯空白同样不算一种定性（不进分母）
#   · 凑不满 7 名时靠后的槽位写空串（E..I 三行共 15 格）
EVENT_TABLE_ROWS = [
    [EVENT_LABEL, '事件名称'],
    ['银狐病毒', 'e1'],
    ['银狐病毒', 'e2'],
    ['银狐病毒', 'e3'],
    ['未知威胁', 'e4'],
    ['未知威胁', 'e5'],
    ['挖矿木马', 'e6'],
    ['-', 'e7'],
    ['病毒', 'e8'],
    ['', 'e9'],
    ['   ', 'e10'],
]
EVENT_LABELS = ['银狐病毒', '未知威胁', '挖矿木马', '病毒', '', '', '']
EVENT_COUNTS = [3, 2, 1, 1, 0, 0, 0]
# 分母 = 全部有效定性的出现总次数 = 3+2+1+1 = 7（`-`、空串、纯空白都不进）
EVENT_TOTAL = 7

# 21 格的全量地址：C..I × 135/136/137（列序 = 名次，从 0 起）
EVENT_ADDRS = [
    f'{chr(ord("C") + rank)}{row}'
    for row in (EVENT_LABEL_ROW, EVENT_COUNT_ROW, EVENT_SHARE_ROW)
    for rank in range(EVENT_SLOTS)
]

# ---------------------------------------------------------------------------
# 核心业务系统（D3/D4/D5 系统名 + D7/D8/D9 风险总数）的 fixture
# ---------------------------------------------------------------------------
#
# 表头同样必须是**真实列名**（与 stats/metrics/*.js 里那些常量同一个来源）：
# 资产表「所属业务」「IP地址」、漏洞表「风险资产」「威胁标签」、弱密码表「风险资产」、
# 事件表「影响资产」「安全事件二级分类」。编一个别的名字，这条验收证明的就不是
# 生产能跑通，而是一个只存在于本文件里的假前提。
#
# 四份表的行刻意互相咬合：同一台机器既在漏洞表里也在弱密码表、事件表里，
# 这样「三段相加」才是可辨的 —— 只要有一段没算上，三个总数就都对不上。

CORE_SYSTEMS = ['OA系统', '财务系统', '运维系统']

# 期望的风险总数拆解：(漏洞, 弱密码, 事件)。写拆解而不是只写和，是为了挂在报告里
# 一眼能看出是哪一段没对上；和由它算出来，改一处不会两边漂。
#
# 三个总数刻意互不相等（4 / 5 / 1）：相等的话「把两个系统的 IP 集合换了个个儿」
# 这种错照样能过 —— 每个数都还对得上，只是对错了系统。
CORE_SYSTEM_BREAKDOWN = [(2, 1, 1), (2, 1, 2), (0, 0, 1)]
CORE_SYSTEM_RISK_TOTALS = [sum(parts) for parts in CORE_SYSTEM_BREAKDOWN]

# 这 6 格的地址：D3/D4/D5 名字、D7/D8/D9 风险总数
CORE_SYSTEM_CELLS = ['D3', 'D4', 'D5', 'D7', 'D8', 'D9']

# 只在 D7/D8/D9 里挑。名字那 3 格不依赖总表、永远在写，所以凡是断言「落值的就是这几个数」
# 的地方都要躲开它们（writes_of 返回的是原样子典，比全集会把 D3/D4/D5 也算进来）。
CORE_RISK_TOTAL_CELLS = ['D7', 'D8', 'D9']

# 资产表：业务归属 -> IP。第 3 行那格挂着两个系统（加工后的多段值，见
# scripts/process_asset_table.py），所以它在两个系统的 IP 集合里都算；
# 第 5 行没有业务归属 —— 空串不含任何系统名，这一行谁都不命中（边界二把「这一列
# 整个是空的」单独拎出来验：那是 0，不是缺数）；
# 第 6 行的「运维系统」名下有资产、但一条风险都没有 —— 期望 0（**不是**缺数）。
CORE_ASSET_TABLE = [
    ['IP地址', '互联网暴露', '所属业务', '资产名称'],
    ['10.0.0.1', '暴露', 'OA系统1', 'a'],              # 子串命中：传「OA系统」要认这个
    ['10.0.0.2', '未暴露', '财务系统, OA系统', 'b'],   # 多段业务名，两个系统都命中
    ['10.0.0.3', '未暴露', '财务系统', 'c'],
    ['10.0.0.4', '未知', '', 'd'],
    ['10.0.0.5', '未知', '运维系统', 'e'],
]

# 漏洞表：威胁标签是顿号分隔的多标签。第 4 行两个标签都含关键词 ——
# **一行只算一条**（这正是 stats/metrics/vuln.js 头注里那 77 行的由来，
# 按标签计数会把这一行算成两条）；第 3 行一个关键词都不含；第 6 行的 IP 不在任何
# 系统名下（不能因为「反正有 IP」就算进去）；第 7 行的标签整个为空。
CORE_VULN_TABLE = [
    ['风险资产', '威胁标签', '漏洞名称'],
    ['10.0.0.1', '活跃漏洞、高可利用', 'v1'],
    ['10.0.0.1', '活跃漏洞、有攻击代码披露', 'v2'],
    ['10.0.0.2', '高可利用、热点漏洞', 'v3'],
    ['10.0.0.3', '热点漏洞、勒索利用', 'v4'],
    ['10.0.0.9', '高可利用', 'v5'],
    ['10.0.0.5', '', 'v6'],
]

# 弱密码表：有多少行就是多少条，别的列一个字都不看。
# 10.0.0.2 刻意**不在**这张表里 —— 它同时属于 OA 和财务两个系统，出现在哪张表里
# 就给两个系统各加一条（那两个数永远相等）。留一台只属于一个系统的机器（10.0.0.1 /
# 10.0.0.3），三个系统的总数才分得开。
CORE_WEAKPWD_TABLE = [
    ['风险资产', '弱点类型'],
    ['10.0.0.1', 'ssh弱口令'],
    ['10.0.0.3', 'rdp弱口令'],
    ['10.0.0.99', 'ssh弱口令'],
]

# 事件表：「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」才算一条。
# 第 3 行「SSH账号暴力破解」是刻意的反例 —— 含「账号」但不含「账号安全」，不算
# （判据是子串，不是含「账号」两个字），真实平台的二级分类就是这种复合词；
# 第 5 行的影响资产带 `(资产组名:xx)` 后缀（平台真实写法，见 stats/metrics/rows.js
# 的 normalizeIp），归一后仍要命中 10.0.0.5；三个关键词各有一条真命中
# （账号安全 / 弱密码 / 弱口令），少测一个就分不出「漏了哪个词」。
CORE_EVENT_TABLE = [
    ['影响资产', '安全事件二级分类', '事件名称'],
    ['10.0.0.2', '账号安全事件', 'e1'],
    ['10.0.0.2', 'SSH账号暴力破解', 'e2'],
    ['10.0.0.3', '弱密码爆破', 'e3'],
    ['10.0.0.5(资产组名:管理IP范围)', 'SSH弱口令', 'e4'],
    ['10.0.0.5', '下载恶意文件', 'e5'],
]


# ---------------------------------------------------------------------------
# 与 JS 侧桥接
# ---------------------------------------------------------------------------

def call_bridge(bridge, *args):
    """跑一次 scripts/verify_write_layer.js 的子命令，返回它 stdout 的 JSON。"""
    proc = subprocess.run(
        ['node', str(bridge), *args],
        capture_output=True, text=True, encoding='utf-8',
    )
    if proc.returncode != 0:
        raise RuntimeError(f'node {args[0] if args else ""} 失败: {proc.stderr.strip()}')
    return json.loads(proc.stdout.strip())


# ---------------------------------------------------------------------------
# 逐格比对：模板 vs 落盘结果
# ---------------------------------------------------------------------------

def value_map(path, sheet_name):
    """addr -> (类型, 值, 数字格式, 公式缓存值)，只收「有值」的格子。

    只比「有值」的格子：openpyxl 落盘时会丢掉没有值的空壳单元格，所以拿整份快照
    对比必然不等 —— 那是 openpyxl 的既有行为（旧版 SheetJS 同样如此），与取值层无关。
    这里比的是「值有没有被改动」，空壳消失不计。

    缓存值必须另读一遍 data_only=True：data_only=False 读公式格拿到的是公式串
    （`=TODAY()`），前后一模一样，看不出缓存的丢失。
    """
    wb = load_workbook(path, data_only=False)
    wb_cached = load_workbook(path, data_only=True)
    ws, ws_cached = wb[sheet_name], wb_cached[sheet_name]

    out = {}
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None or cell.value == '':
                continue
            cached = ws_cached[cell.coordinate].value
            out[cell.coordinate] = (cell.data_type, cell.value, cell.number_format, cached)
    return out


def changed_addrs(before, after):
    """两份 value_map 的差异，返回已排序的地址数组。"""
    changed = [k for k, v in after.items() if before.get(k) != v]
    changed += [k for k in before if k not in after]
    return sorted(changed)


def render(entry):
    """把 value_map 的一条记录压成一行，方便打错误信息。"""
    if entry is None:
        return '(无)'
    kind, value, fmt, cached = entry
    text = json.dumps(value, ensure_ascii=False, default=str)
    if fmt and fmt != 'General':
        text += f' [z={fmt}]'
    if kind == 'f' and cached is not None:
        text += f' [缓存={json.dumps(cached, ensure_ascii=False, default=str)}]'
    return text


class Checker:
    """攒断言，最后统一报告有几条没过 —— 不要在第一条就中断，那样看不到后面的问题。"""

    def __init__(self):
        self.failures = []

    def check(self, ok, label, actual, expected=None):
        mark = '✓' if ok else '✗'
        suffix = '' if expected is None else f'  (期望 {expected})'
        print(f'  {mark} {label}: {actual}{suffix}')
        if not ok:
            self.failures.append(label)

    def note(self, label, actual):
        print(f'  · {label}: {actual}')

    def section(self, title):
        print(f'\n【{title}】')


# ---------------------------------------------------------------------------
# fixture：三份平台导出表的替身
# ---------------------------------------------------------------------------

def write_sheet(path, aoa):
    wb = Workbook()
    ws = wb.active
    for row in aoa:
        ws.append(row)
    wb.save(path)
    return str(path)


def make_fixtures(directory):
    """表头必须用**真实列名**：资产表要有「IP地址」「互联网暴露」，事件表要有「影响资产」，
    否则表格预处理会按「平台改列名」直接抛错 —— 那是刻意的失败口径，不是 bug。

    五份表一份都不能少：build_report.py 的 TABLE_SHEET_NAMES 把「缺哪份下载结果」
    当硬错误（宁可不出报告，也不出一份缺 sheet 的报告）。这里的内容只够把各 sheet
    填出来，与取值层无关 —— 取值层那份 fixture 是 make_core_system_tables。
    """
    directory.mkdir(parents=True, exist_ok=True)
    return {
        'asset': {'filePath': write_sheet(directory / 'asset.xlsx', [
            ['IP地址', '互联网暴露', '资产名称'],
            ['10.0.0.1', '暴露', 'a'],
            ['10.0.0.2', '未暴露', 'b'],
        ])},
        'alarm': {'filePath': write_sheet(directory / 'alarm.xlsx', [
            ['表头A', '表头B'], ['y', 2],
        ])},
        'event': {'filePath': write_sheet(directory / 'event.xlsx', [
            ['影响资产', '事件名称'],
            ['10.0.0.1', 'e1'],
            ['10.0.0.2', 'e2'],
            ['10.0.0.99', 'e3'],
            ['', 'e4'],
        ])},
        'vuln': {'filePath': write_sheet(directory / 'vuln.xlsx', [
            ['风险资产', '威胁标签', '漏洞名称'],
            ['10.0.0.1', '高可利用', 'v1'],
        ])},
        'weakpwd': {'filePath': write_sheet(directory / 'weakpwd.xlsx', [
            ['风险资产', '弱点类型'],
            ['10.0.0.1', 'ssh弱口令'],
        ])},
    }


def make_alarm_table(directory):
    """告警定性统计（C133:I134）专用 fixture，见 ALARM_TABLE 的说明。

    与 make_fixtures 里那份 'alarm' 是两件事：那份表头是「表头A/表头B」，
    用来验「ctx 里没有告警行时那 14 格走缺数路径」；这份表头是真的「告警定性」，
    用来验「有告警行时它们真的落值」。
    """
    directory.mkdir(parents=True, exist_ok=True)
    return write_sheet(directory / 'alarm-qualified.xlsx', ALARM_TABLE)


def make_event_table(directory):
    """事件定性统计（C135:I137）专用 fixture，见 EVENT_TABLE_ROWS 的说明。

    与 make_fixtures 里那份 'event'（表头是「影响资产/事件名称」）不是一回事：
    那份用来验「事件表缺席时那些格子走缺数路径」，这份表头是真的「GPT定性标签」，
    用来验「有事件表时那 21 格真的落值」。
    """
    directory.mkdir(parents=True, exist_ok=True)
    return write_sheet(directory / 'event-qualified.xlsx', EVENT_TABLE_ROWS)


def make_core_system_tables(directory):
    """核心业务系统（D3/D4/D5 + D7/D8/D9）专用 fixture，四份表的说明见各自的常量定义。

    与 make_fixtures 里那份 'asset' 是两件事：那份表头只有「IP地址/互联网暴露」，
    用来验「资产表没有业务归属列时那 6 格走缺数路径」；这份带「所属业务」，
    用来验「有业务归属时风险总数真的算得出来」。两半都得有 —— 各自都对、
    接起来不匹配，正是这次"没落盘"的病根。
    """
    directory.mkdir(parents=True, exist_ok=True)
    return {
        'asset': write_sheet(directory / 'core-asset.xlsx', CORE_ASSET_TABLE),
        'vuln': write_sheet(directory / 'core-vuln.xlsx', CORE_VULN_TABLE),
        'weakpwd': write_sheet(directory / 'core-weakpwd.xlsx', CORE_WEAKPWD_TABLE),
        'event': write_sheet(directory / 'core-event.xlsx', CORE_EVENT_TABLE),
    }


# ---------------------------------------------------------------------------
# 【1】登记表全量：写了该写的，也没写不该写的
# ---------------------------------------------------------------------------

def check_plan_registry(checker, bridge):
    """这一条要同时证明三件事：写了该写的 3 格、**没写**不该写的 385 格、
    以及要读总表而总表缺席的 41 格走缺数路径（不写值、记 errors）。

    没写不该写的那些才是这条验收真正防的东西 —— 口径未定的格子被"顺手填个 0"是最隐蔽的错。
    """
    checker.section('1】429 格登记表 + ctx（只比计划，不落盘')
    plan = call_bridge(bridge, 'plan', 'registry')

    checker.check(len(plan['unresolved']) == EXPECTED_UNRESOLVED,
                  'unresolved 不写入', len(plan['unresolved']), EXPECTED_UNRESOLVED)
    checker.check(len(plan['written']) == EXPECTED_WRITTEN,
                  'written 落值', len(plan['written']), EXPECTED_WRITTEN)
    checker.check(len(plan['writes']) == EXPECTED_WRITTEN,
                  'writes 计划条数', len(plan['writes']), EXPECTED_WRITTEN)
    checker.check(sorted(e['addr'] for e in plan['errors']) == sorted(EXPECTED_MISSING_TABLE),
                  f"errors 覆盖缺数的 {len(EXPECTED_MISSING_TABLE)} 格",
                  ' '.join(sorted(e['addr'] for e in plan['errors'])),
                  ' '.join(sorted(EXPECTED_MISSING_TABLE)))
    checker.check(not set(EXPECTED_MISSING_TABLE) & set(plan['written']),
                  '缺数格一个都没写',
                  '是' if not set(EXPECTED_MISSING_TABLE) & set(plan['written']) else '否')
    checker.check(plan['written'] == EXPECTED_CHANGED,
                  '落值的地址', ' '.join(plan['written']), ' '.join(EXPECTED_CHANGED))
    checker.check(not set(EXPECTED_CHANGED) & set(plan['unresolved']),
                  'J1/L1/M1 不在 unresolved 里', '是' if not set(EXPECTED_CHANGED) & set(plan['unresolved']) else '否')

    # 落的值也要对：客户名照抄，报告期是 YYYY/MM/DD **斜杠**（与 PPT 封面的横杠刻意不同）
    values = {w['addr']: w['value'] for w in plan['writes']}
    checker.check(values.get('J1') == '一致验收客户', 'J1 客户名称',
                  json.dumps(values.get('J1'), ensure_ascii=False), '"一致验收客户"')
    checker.check(values.get('L1') == '2026/05/12', 'L1 周期起始日',
                  json.dumps(values.get('L1'), ensure_ascii=False), '"2026/05/12"（斜杠）')
    checker.check(values.get('M1') == '2026/05/13', 'M1 周期结束日',
                  json.dumps(values.get('M1'), ensure_ascii=False), '"2026/05/13"（斜杠）')
    return plan


# ---------------------------------------------------------------------------
# 【2】各写模式的语义
# ---------------------------------------------------------------------------

def check_modes(checker, bridge, template):
    checker.section('2】各 mode 语义（JS 出计划 -> Python 落笔 -> 读回来看）')

    plan = call_bridge(bridge, 'plan', 'modes')
    wb = load_workbook(template, data_only=False)
    apply_statistics_writes(wb, plan['writes'])
    ws = wb[TEMPLATE_SHEET]

    def at(addr):
        cell = ws[addr]
        if cell.value is None:
            return None
        text = json.dumps(cell.value, ensure_ascii=False)
        if cell.number_format and cell.number_format != 'General':
            text += f' [z={cell.number_format}]'
        return text

    checker.check(at('D24') == '42', 'D24 取值', at('D24'), '"42"')
    checker.check(at('D12') == '7', 'D12 取值', at('D12'), '"7"')
    checker.check(at('G110') == '7', 'G110 alias（与 D12 同值）', at('G110'), '"7"')
    checker.check(at('D34') == '0.8125 [z=0.00%]', 'D34 percent（值 + 百分号格式）',
                  at('D34'), '"0.8125 [z=0.00%]"')
    checker.check(at('D30') == '"手写"', 'D30 literal', at('D30'), '"手写"')
    # blank 要真把模板原值清掉，而不是"没写进去"—— 所以挑的是模板里有旧值的格子
    checker.check(at('D25') in (None, '""'), 'D25 blank（清掉模板原值）', at('D25'), '(空)')

    # 缺数路径：抛错和返回 undefined 都必须**一个字都不写**，且进 errors（R10/H6 禁止填 0）
    errors = {e['addr']: e['message'] for e in plan['errors']}
    checker.check(at('G99') == at('G101'), 'G99/G101 缺数都没写',
                  f'G99={at("G99")} G101={at("G101")}')
    checker.check(set(errors) == {'G99', 'G101'}, 'errors 覆盖缺数的两格',
                  ' '.join(sorted(errors)), 'G101 G99')
    # unresolved 的格子必须**保持模板原样**：既不写值也不清空（H7）。所以拿模板的真实
    # 旧值当基准比 —— 断言"它是空的"是错的，模板里本来有值的话那反而是被清掉了。
    template_value = load_workbook(template, data_only=False)[TEMPLATE_SHEET]['I124'].value
    checker.check(ws['I124'].value == template_value, 'I124 unresolved（保持模板原样，不写入）',
                  json.dumps(ws['I124'].value, ensure_ascii=False),
                  json.dumps(template_value, ensure_ascii=False))
    checker.check(plan['written'] and 'I124' not in plan['written'],
                  'I124 不在写入计划里', '是' if 'I124' not in plan['written'] else '否')
    checker.check('D25' not in errors, 'blank 不算 error', '是' if 'D25' not in errors else '否')
    checker.note('errors 明细', json.dumps(plan['errors'], ensure_ascii=False))


# ---------------------------------------------------------------------------
# 【3】/【4】端到端
# ---------------------------------------------------------------------------

def check_end_to_end(checker, label, template, report, built, beautify):
    """相对模板的变化必须只有 J1/L1/M1（公式格另算）。

    这里查的是**接线**本身：除了这三格，接上 ctx 不能动任何一格 —— 尤其是公式格，
    取值层不许碰它们（碰了就是把模板的活公式改成死值）。
    """
    title = '4】生产路径（buildReport + ctx + 默认美化）' if beautify \
        else '3】端到端（buildReport + ctx，落盘后再读回来，不美化）'
    checker.section(title)

    stats = built['statistics']
    checker.check(stats['connected'] is True, 'statistics.connected', stats['connected'], True)
    checker.check(len(stats['written']) == EXPECTED_WRITTEN,
                  'statistics.written', len(stats['written']), EXPECTED_WRITTEN)
    checker.check(len(stats['unresolved']) == EXPECTED_UNRESOLVED,
                  'statistics.unresolved', len(stats['unresolved']), EXPECTED_UNRESOLVED)
    checker.check(sorted(e['addr'] for e in stats['errors']) == sorted(EXPECTED_MISSING_TABLE),
                  f"statistics.errors 覆盖缺数的 {len(EXPECTED_MISSING_TABLE)} 格",
                  ' '.join(sorted(e['addr'] for e in stats['errors'])),
                  ' '.join(sorted(EXPECTED_MISSING_TABLE)))
    # 计划写了几格就得落几格，差一格都说明 Python 侧悄悄丢了
    checker.check(len(stats['applied']) == EXPECTED_WRITTEN,
                  'statistics.applied（实际落笔）', len(stats['applied']), EXPECTED_WRITTEN)

    after = value_map(report, TEMPLATE_SHEET)
    changes = changed_addrs(value_map(template, TEMPLATE_SHEET), after)
    value_changes = [a for a in changes if a not in FORMULA_CELLS]
    formula_changes = [a for a in changes if a in FORMULA_CELLS]

    checker.check(value_changes == EXPECTED_CHANGED, '相对模板有变化的非公式格',
                  ' '.join(value_changes) or '（无）', ' '.join(EXPECTED_CHANGED))
    checker.note('落盘后的值', ' '.join(f'{a}={render(after.get(a))}' for a in EXPECTED_CHANGED))
    checker.check(formula_changes == FORMULA_CELLS, '公式格缓存值丢失（已知差异，见头注第 4 条）',
                  ' '.join(formula_changes) or '（无）')

    # 公式本身必须还在（R2 模板冻结：不许把活公式改成死值）
    wb = load_workbook(report, data_only=False)
    ws = wb[TEMPLATE_SHEET]
    formulas = {a: ws[a].value for a in FORMULA_CELLS}
    checker.check(all(isinstance(v, str) and v.startswith('=') for v in formulas.values()),
                  '公式格仍是公式', json.dumps(formulas, ensure_ascii=False))

    checker.note('非数据统计 sheet', ' '.join(f"{s['name']}({s['rowCount']}行)" for s in built['sheets']))
    if beautify:
        checker.check(built['beautify']['ok'] is True, '美化已执行', built['beautify']['ok'], True)
        checker.note('美化主题', built['beautify'].get('theme'))
    else:
        checker.check(built['beautify']['ok'] is False, '本段不套美化', built['beautify']['ok'], False)
    return after


def check_preprocess(checker, report, built):
    checker.section('3.5】表格预处理（事件表追加列）')

    pre = built['preprocess']
    checker.check(pre['ran'] is True, 'preprocess.ran', pre['ran'], True)
    checker.check(pre['asset']['mapped'] == 2, '资产表映射 IP 数', pre['asset']['mapped'], 2)
    checker.check(pre['asset']['headerRow'] == 1, '资产表表头行', pre['asset']['headerRow'], 1)
    checker.check(pre['event']['addedColumn'] == 'C', '事件表新增列', pre['event']['addedColumn'], 'C')
    checker.check(pre['event']['header'] == '内网外网资产', '新列列名',
                  pre['event']['header'], '内网外网资产')
    checker.note('取值分布', json.dumps(pre['event']['tallies'], ensure_ascii=False))

    ws = load_workbook(report, data_only=False)[EVENT_SHEET]
    for addr, expected in EVENT_EXPECTED.items():
        actual = ws[addr].value
        checker.check(actual == expected, f'{addr} 新列取值', json.dumps(actual, ensure_ascii=False),
                      json.dumps(expected, ensure_ascii=False))

    # 原有列一列都不能动：PPT 引擎和人工核对都按原列位置读
    checker.check(ws['A1'].value == '影响资产' and ws['B1'].value == '事件名称',
                  '原有列原样', f'A1={ws["A1"].value} B1={ws["B1"].value}')
    checker.check(ws.calculate_dimension() == 'A1:C5', '事件表范围',
                  ws.calculate_dimension(), 'A1:C5')


# ---------------------------------------------------------------------------
# 【5】/【6】告警定性统计：读取层 + 落盘
# ---------------------------------------------------------------------------

def check_alarm_reader(checker, workdir):
    """断言读取层（scripts/parse_table_rows.py）的行对象契约。

    契约写在那个脚本的头注里，四条规矩没有一条是"顺手写的"：规矩 2/3 正是
    stats/metrics/alarm.js 里 hasOwnProperty 防线赖以成立的前提 —— 读取层要是把
    「列不存在」和「列存在但整列为空」混为一谈，取值层就再也分不出
    「平台改了列名」和「这段时间没有告警」，而后者本该是安静留空。
    """
    checker.section('5】总表读取层（parse_table_rows.py 的行对象契约）')
    directory = workdir / 'reader'
    directory.mkdir(parents=True, exist_ok=True)

    def parse(aoa, name, columns=None, sheet=None):
        payload = {'path': write_sheet(directory / name, aoa), 'columns': columns}
        if sheet is not None:
            payload['sheet'] = sheet
        return parse_table_rows(payload)

    # —— 规矩 1/2：键是表头文字；每行带全键；白名单外的列不进行对象
    parsed = parse(ALARM_TABLE, 'qualified.xlsx', columns=[ALARM_QUALIFICATION])
    checker.check(parsed['rowCount'] == len(ALARM_TABLE) - 1,
                  '数据行数（表头行不算）', parsed['rowCount'], len(ALARM_TABLE) - 1)
    checker.check(all(list(row.keys()) == [ALARM_QUALIFICATION] for row in parsed['rows']),
                  '每行的键就是请求的列（白名单外的列一列都不带）',
                  json.dumps(parsed['rows'][0], ensure_ascii=False))
    checker.check([row[ALARM_QUALIFICATION] for row in parsed['rows']]
                  == [row[0] for row in ALARM_TABLE[1:]],
                  '定性列逐行取值',
                  ' '.join(row[ALARM_QUALIFICATION] or '(空)' for row in parsed['rows']))
    checker.check(parsed['header'] == [ALARM_QUALIFICATION, '主机IP'],
                  'header 回报的是整表表头（诊断用，不受白名单影响）',
                  json.dumps(parsed['header'], ensure_ascii=False))
    checker.check(parsed['missingColumns'] == [] and parsed['unnamedColumns'] == 0,
                  '没有缺列 / 没有无名列',
                  f"missing={parsed['missingColumns']} unnamed={parsed['unnamedColumns']}")

    # —— 规矩 2/3 的分界：列存在但整列为空（每行都带这个键、值是空串）
    parsed = parse([['告警定性', '主机IP'], ['', '10.0.0.1'], ['', '10.0.0.2']],
                   'blank-col.xlsx', columns=[ALARM_QUALIFICATION])
    checker.check(all(ALARM_QUALIFICATION in row and row[ALARM_QUALIFICATION] == ''
                      for row in parsed['rows']),
                  '列存在但整列为空 -> 每行仍带这个键、值为空串（≠ 列不存在）',
                  json.dumps(parsed['rows'], ensure_ascii=False))

    # —— 规矩 3：表头里没有这一列 -> 一行都不带这个键，并回报 missingColumns
    parsed = parse([['主机IP'], ['10.0.0.1']], 'no-col.xlsx', columns=[ALARM_QUALIFICATION])
    checker.check(parsed['rows'] == [{}],
                  '表头没有这一列 -> 一行都不带这个键（hasOwnProperty 防线的信号）',
                  json.dumps(parsed['rows'], ensure_ascii=False))
    checker.check(parsed['missingColumns'] == [ALARM_QUALIFICATION],
                  'missingColumns 回报缺的列',
                  json.dumps(parsed['missingColumns'], ensure_ascii=False))

    # —— 空表（只有表头）不是错误：rows 为空，但列在表头里，所以不算缺列
    parsed = parse([[ALARM_QUALIFICATION, '主机IP']], 'empty.xlsx', columns=[ALARM_QUALIFICATION])
    checker.check(parsed['rowCount'] == 0 and parsed['rows'] == []
                  and parsed['missingColumns'] == [],
                  '空表 -> rows 为空且不报错（列本身在表头里）',
                  f"rows={len(parsed['rows'])} missing={parsed['missingColumns']}")

    # —— 规矩 4：表头重名抛错（宁可炸，也不静默丢一列）
    duplicated = None
    try:
        parse([[ALARM_QUALIFICATION, ALARM_QUALIFICATION], ['a', 'b']],
              'dup.xlsx', columns=[ALARM_QUALIFICATION])
    except ValueError as error:
        duplicated = str(error)
    checker.check(duplicated is not None and '重名' in duplicated,
                  '表头重名 -> 抛错', duplicated or '没抛（错！）')

    # —— 整行无值的行丢掉：与合并引擎 collect_source_rows 同口径，
    #    否则取值层数出的行数与交付物里肉眼看到的行数对不上
    parsed = parse([['告警定性'], ['未知威胁'], [None], ['病毒']],
                   'ragged.xlsx', columns=[ALARM_QUALIFICATION])
    checker.check([row[ALARM_QUALIFICATION] for row in parsed['rows']] == ['未知威胁', '病毒'],
                  '整行无值的行被丢掉', json.dumps(parsed['rows'], ensure_ascii=False))

    # —— 时间列给的是 epoch **秒**（R11），不是 Excel 序列号（那是"天"）
    moment = datetime.datetime(2026, 5, 12, 10, 9, 39)
    parsed = parse([['时间', '告警定性'], [moment, '未知威胁']], 'time.xlsx', columns=['时间'])
    expected_seconds = int(moment.replace(tzinfo=datetime.timezone.utc).timestamp())
    checker.check(parsed['rows'][0]['时间'] == expected_seconds,
                  '时间列是 epoch 秒（R11）', parsed['rows'][0]['时间'], expected_seconds)


def check_alarm_end_to_end(checker, bridge, workdir, fixtures, alarm_path):
    """告警表接进 ctx 之后，那 14 格必须**真的落盘**，且不惊动别的格子。

    这条是本次改动的正题：在此之前生产路径压根没把总表喂进 ctx（mssw_downloader.js
    的 createContext 只给了客户名和报告期），14 格全走缺数路径，报告里一个值都没有。
    所以这里不只看计划，还要把落盘的文件读回来逐格比 —— 内存里对不算数。

    另外两条边界（缺列 / 空表）走的是 plan 而不是 build：它们与落盘无关，
    断的是"必须一个值都不写、且全进错误列表"。
    """
    checker.section('6】告警定性统计端到端（C133:I134 真的落进报告）')

    built = call_bridge(bridge, 'build', _b64(json.dumps({
        'outputPath': str(workdir / 'out-alarm.xlsx'),
        'tables': fixtures,
        'alarmPath': alarm_path,
        'beautify': False,
    })))

    stats = built['statistics']
    expected_written = sorted(EXPECTED_CHANGED + ALARM_ADDRS)
    # 本段只接告警表：核心业务系统那 6 格、事件定性那 21 格都缺表，走缺数路径
    expected_errors = sorted(EXPECTED_CORE_SYSTEM_CELLS + EXPECTED_EVENT_CELLS)
    checker.check(stats['connected'] is True, 'statistics.connected', stats['connected'], True)
    checker.check(sorted(stats['written']) == expected_written,
                  '落值的地址 = 3 个报告参数格 + 14 格告警统计',
                  ' '.join(sorted(stats['written'])))
    checker.check(sorted(e['addr'] for e in stats['errors']) == expected_errors,
                  'errors 只剩核心业务系统 6 格 + 事件定性 21 格',
                  ' '.join(sorted(e['addr'] for e in stats['errors'])),
                  ' '.join(expected_errors))
    checker.check(len(stats['unresolved']) == EXPECTED_UNRESOLVED,
                  'statistics.unresolved', len(stats['unresolved']), EXPECTED_UNRESOLVED)
    checker.check(len(stats['applied']) == len(expected_written),
                  'statistics.applied（实际落笔，Python 侧没丢格）',
                  len(stats['applied']), len(expected_written))

    ws = load_workbook(built['filePath'], data_only=False)[TEMPLATE_SHEET]
    for rank, (label, count) in enumerate(zip(ALARM_LABELS, ALARM_COUNTS)):
        column = chr(ord('C') + rank)
        label_addr = f'{column}{ALARM_LABEL_ROW}'
        share_addr = f'{column}{ALARM_SHARE_ROW}'

        actual_label = ws[label_addr].value or ''
        checker.check(actual_label == label, f'{label_addr} 定性名称',
                      json.dumps(actual_label, ensure_ascii=False),
                      json.dumps(label, ensure_ascii=False))

        # 分母是**全部定性的出现总次数**（ALARM_TOTAL=7），不是前几名之和。
        # fixture 里那行空定性不进分母 —— 若误按 8 算，C134 会变成 0.375 而不是 3/7。
        share = ws[share_addr].value
        if count:
            expected_share = count / ALARM_TOTAL
            ok = isinstance(share, (int, float)) and abs(share - expected_share) < 1e-12
            shown, want = json.dumps(share), json.dumps(expected_share)
        else:
            ok, shown, want = share in (None, ''), json.dumps(share, ensure_ascii=False), '(空)'
        checker.check(ok, f'{share_addr} 占比', shown, want)
        checker.check(ws[share_addr].number_format == '0.00%',
                      f'{share_addr} 百分号格式', ws[share_addr].number_format, '0.00%')

    # 边界一：表头里没有「告警定性」（平台改了列名）-> 14 格全进错误列表、一个都不写
    # （这段的 ctx 不带 --business-systems，所以核心业务系统那 6 格也必然在 errors 里）
    edges = workdir / 'alarm-edges'
    edges.mkdir(parents=True, exist_ok=True)
    missing_path = write_sheet(edges / 'renamed.xlsx',
                               [['主机IP', '告警名称'], ['10.0.0.1', '未知威胁']])
    plan = call_bridge(bridge, 'plan', 'alarm', _b64(json.dumps({'path': missing_path})))
    alarm_errors = {e['addr']: e['message'] for e in plan['errors'] if e['addr'] in ALARM_ADDRS}
    checker.check(sorted(alarm_errors) == sorted(ALARM_ADDRS),
                  '列名被改 -> 14 格全进错误列表',
                  ' '.join(sorted(alarm_errors)))
    checker.check(not set(ALARM_ADDRS) & set(plan['written']),
                  '列名被改 -> 一个值都不写',
                  '是' if not set(ALARM_ADDRS) & set(plan['written']) else '否')
    checker.check(all('找不到' in m for m in alarm_errors.values()),
                  '错误信息点明是「找不到列」而不是「没有数据」',
                  json.dumps(alarm_errors.get('C133'), ensure_ascii=False))

    # 边界二：空表 -> 同样不写值、全进错误列表（R10/H6：缺数不静默，绝不填 0）
    empty_path = write_sheet(edges / 'empty-table.xlsx',
                             [[ALARM_QUALIFICATION, '主机IP']])
    plan = call_bridge(bridge, 'plan', 'alarm', _b64(json.dumps({'path': empty_path})))
    alarm_errors = {e['addr']: e['message'] for e in plan['errors'] if e['addr'] in ALARM_ADDRS}
    checker.check(sorted(alarm_errors) == sorted(ALARM_ADDRS),
                  '空表 -> 14 格全进错误列表',
                  ' '.join(sorted(alarm_errors)))
    checker.check(not set(ALARM_ADDRS) & set(plan['written']),
                  '空表 -> 一个值都不写',
                  '是' if not set(ALARM_ADDRS) & set(plan['written']) else '否')
    checker.check(plan['parsed']['rowCount'] == 0, '空表行数为 0', plan['parsed']['rowCount'], 0)


# ---------------------------------------------------------------------------
# 【7】核心业务系统：四份总表 + --business-systems
# ---------------------------------------------------------------------------

def check_core_system(checker, bridge, workdir, fixtures, template):
    """D3/D4/D5 是 CLI 传进来的名字，D7/D8/D9 是「资产表业务归属 -> IP ->
    漏洞 / 弱密码 / 事件」三段相加。

    三段相加这件事**只有整条链一起跑才验得出**：读取层各自读对、取值层各自算对、
    接起来少加一段，报告上照样是个看着合理的数。所以这里既看计划，也把落盘的文件
    读回来逐格比（内存里对不算数）。
    """
    checker.section('7】核心业务系统端到端（D3/D4/D5 系统名 + D7/D8/D9 风险总数）')

    paths = make_core_system_tables(workdir / 'core-systems')
    edges = workdir / 'core-edges'
    edges.mkdir(parents=True, exist_ok=True)

    def plan(business_systems, table_paths=None):
        return call_bridge(bridge, 'plan', 'core', _b64(json.dumps({
            'paths': paths if table_paths is None else table_paths,
            'businessSystems': business_systems,
        })))

    def writes_of(result, cells):
        """只取关心的格子 —— 计划里永远还有 3 个报告参数格（J1/L1/M1，值来自 CLI，
        与总表无关），逐条比全集会把它们算成"多写的格子"。"""
        return {w['addr']: w['value'] for w in result['writes'] if w['addr'] in cells}

    def errors_of(result, cells):
        """同上：本段不接告警表，那 14 格必然也在 errors 里，只挑关心的格子看。"""
        return {e['addr']: e['message'] for e in result['errors'] if e['addr'] in cells}

    # —— 正题：三个系统都传了、四份总表都在
    result = plan(CORE_SYSTEMS)
    values = writes_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(values) == sorted(CORE_SYSTEM_CELLS),
                  '落值的地址就这 6 格', ' '.join(sorted(values)), ' '.join(CORE_SYSTEM_CELLS))
    checker.check(errors_of(result, CORE_SYSTEM_CELLS) == {},
                  '核心业务系统 6 格没有缺数',
                  json.dumps(errors_of(result, CORE_SYSTEM_CELLS), ensure_ascii=False))
    # 告警那 14 格与事件定性那 21 格在这段是**应该**报缺数的（plan core 不读它们要的列），
    # 所以要比的不是"errors 为空"，而是"报了错的格子只有这些已知没接输入的那些"
    stray = sorted(set(e['addr'] for e in result['errors'])
                   - set(ALARM_ADDRS) - set(CORE_SYSTEM_CELLS) - set(EXPECTED_EVENT_CELLS))
    checker.check(stray == [], '除告警 14 格、事件定性 21 格与核心系统 6 格外没有别的格子报错',
                  ' '.join(stray) or '（无）')
    checker.check(sorted(result['parsed']) == ['asset', 'event', 'vuln', 'weakpwd'],
                  '四份总表都读到了', ' '.join(sorted(result['parsed'])),
                  'asset event vuln weakpwd')

    for rank, name in enumerate(CORE_SYSTEMS):
        addr = f'D{3 + rank}'
        checker.check(values.get(addr) == name, f'{addr} 系统名（原样照抄 CLI 入参）',
                      json.dumps(values.get(addr), ensure_ascii=False),
                      json.dumps(name, ensure_ascii=False))
    for rank, (parts, total) in enumerate(zip(CORE_SYSTEM_BREAKDOWN, CORE_SYSTEM_RISK_TOTALS)):
        addr = f'D{7 + rank}'
        checker.check(values.get(addr) == total,
                      f'{addr} {CORE_SYSTEMS[rank]} 风险总数（漏洞 {parts[0]} + 弱密码 {parts[1]}'
                      f' + 事件 {parts[2]}）',
                      repr(values.get(addr)), total)
    checker.note('三个系统的总数', f'OA={CORE_SYSTEM_RISK_TOTALS[0]} '
                 f'财务={CORE_SYSTEM_RISK_TOTALS[1]} 运维={CORE_SYSTEM_RISK_TOTALS[2]}'
                 '（刻意互不相等：相等的话把两个系统的 IP 集合换个个儿也照样过）')

    # —— 端到端：落盘后读回来（内存里对不算数）
    built = call_bridge(bridge, 'build', _b64(json.dumps({
        'outputPath': str(workdir / 'out-core.xlsx'),
        'tables': fixtures,
        'statsPaths': paths,
        'businessSystems': CORE_SYSTEMS,
        'beautify': False,
    })))

    stats = built['statistics']
    checker.check(sorted(stats['written']) == sorted(EXPECTED_CHANGED + CORE_SYSTEM_CELLS),
                  '落值的地址 = 3 个报告参数格 + 6 格核心业务系统',
                  ' '.join(sorted(stats['written'])))
    # 本段不接告警表，那 14 格走缺数路径（事件定性那 21 格读的是另一列，也不在）——
    # 正好证明多接一份总表不会顺带把别的格子带上
    written_elsewhere = sorted(set(e['addr'] for e in stats['errors'])
                               - set(ALARM_ADDRS) - set(EXPECTED_EVENT_CELLS))
    checker.check(written_elsewhere == [],
                  'errors 只剩告警 14 格与事件定性 21 格（本段不接这两份输入）',
                  ' '.join(written_elsewhere) or '（无）')
    checker.check(len(stats['applied']) == len(EXPECTED_CHANGED) + len(CORE_SYSTEM_CELLS),
                  'statistics.applied（实际落笔，Python 侧没丢格）',
                  len(stats['applied']), len(EXPECTED_CHANGED) + len(CORE_SYSTEM_CELLS))

    ws = load_workbook(built['filePath'], data_only=False)[TEMPLATE_SHEET]
    for rank, name in enumerate(CORE_SYSTEMS):
        actual = ws[f'D{3 + rank}'].value
        checker.check(actual == name, f'D{3 + rank} 系统名（落盘）',
                      json.dumps(actual, ensure_ascii=False), json.dumps(name, ensure_ascii=False))
    for rank, total in enumerate(CORE_SYSTEM_RISK_TOTALS):
        actual = ws[f'D{7 + rank}'].value
        checker.check(actual == total, f'D{7 + rank} 风险总数（落盘）', repr(actual), total)

    # —— 边界一：只传 2 个系统 -> 第 3 个槽位不写值、记错误，**保持模板原样**
    #    （用户口径：保持 unresolved 不动。既不填 0 —— 那会被读成「这个系统风险数是 0」，
    #     也不清空 —— 那会把模板里原有的东西抹掉）
    result = plan(CORE_SYSTEMS[:2])
    values = writes_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(values) == ['D3', 'D4', 'D7', 'D8'],
                  '只传 2 个 -> 落值的地址', ' '.join(sorted(values)), 'D3 D4 D7 D8')
    checker.check(values.get('D7') == CORE_SYSTEM_RISK_TOTALS[0]
                  and values.get('D8') == CORE_SYSTEM_RISK_TOTALS[1],
                  '只传 2 个 -> 前两个系统的风险总数照算',
                  f"D7={values.get('D7')} D8={values.get('D8')}",
                  f'D7={CORE_SYSTEM_RISK_TOTALS[0]} D8={CORE_SYSTEM_RISK_TOTALS[1]}')
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(errors) == ['D5', 'D9'], '只传 2 个 -> 缺数的是第 3 个槽位',
                  ' '.join(sorted(errors)), 'D5 D9')
    checker.check(all('只给了 2 个系统' in m for m in errors.values()),
                  '错误信息点明是「这个槽位没传系统」而不是「算不出数」',
                  json.dumps(errors.get('D9'), ensure_ascii=False))

    built = call_bridge(bridge, 'build', _b64(json.dumps({
        'outputPath': str(workdir / 'out-core-two.xlsx'),
        'tables': fixtures,
        'statsPaths': paths,
        'businessSystems': CORE_SYSTEMS[:2],
        'beautify': False,
    })))
    ws = load_workbook(built['filePath'], data_only=False)[TEMPLATE_SHEET]
    template_ws = load_workbook(template, data_only=False)[TEMPLATE_SHEET]
    for addr in ('D5', 'D9'):
        checker.check(ws[addr].value == template_ws[addr].value,
                      f'{addr} 保持模板原样（第 3 个系统没传）',
                      json.dumps(ws[addr].value, ensure_ascii=False),
                      json.dumps(template_ws[addr].value, ensure_ascii=False))

    # —— 边界二：资产表「所属业务」整列一个字都没有 -> 三格风险总数**归零**，不是缺数。
    #    真实数据里这一列大面积为空（见 stats/metrics/asset.js 头注）：这一列空着只说明
    #    「这些机器不属于任何核心系统」，三个系统名下都没有资产，数出来就是 0。
    #    当成缺数的话，一份本来算得出来的报告会整片留空 —— 报 0 与不写值是两回事，
    #    前者是结论，后者是「没算出来」（R10/H6 禁的是后者被写成 0）。
    blank_asset = write_sheet(edges / 'asset-blank-business.xlsx', [
        ['IP地址', '互联网暴露', '所属业务', '资产名称'],
        ['10.0.0.1', '暴露', '', 'a'],
        ['10.0.0.2', '未暴露', '', 'b'],
    ])
    result = plan(CORE_SYSTEMS, dict(paths, asset=blank_asset))
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(not errors,
                  '所属业务整列为空 -> 6 格都不报错（空列是数据，不是缺数）',
                  json.dumps(errors, ensure_ascii=False), '（无）')
    checker.check(writes_of(result, CORE_SYSTEM_CELLS) == {
                      'D3': CORE_SYSTEMS[0], 'D4': CORE_SYSTEMS[1], 'D5': CORE_SYSTEMS[2],
                      'D7': 0, 'D8': 0, 'D9': 0},
                  '所属业务整列为空 -> 3 格风险总数是 0（不是缺数），系统名照写',
                  json.dumps(writes_of(result, CORE_SYSTEM_CELLS), ensure_ascii=False),
                  json.dumps({'D3': CORE_SYSTEMS[0], 'D4': CORE_SYSTEMS[1],
                              'D5': CORE_SYSTEMS[2], 'D7': 0, 'D8': 0, 'D9': 0},
                             ensure_ascii=False))

    # —— 边界二之二：资产表里**根本没有**「所属业务」这一列 -> 这才是缺数。
    #    与上一条的分界就是 CELL_REGISTRY.md §7 C5：列在、值为空 = 数据本身为空（0）；
    #    列不在 = 列名对不上（平台动了表头），没人能证明这列是空的，所以不许数出 0。
    renamed_asset = write_sheet(edges / 'asset-renamed-business.xlsx', [
        ['IP地址', '互联网暴露', '业务归属', '资产名称'],
        ['10.0.0.1', '暴露', 'OA系统1', 'a'],
    ])
    result = plan(CORE_SYSTEMS, dict(paths, asset=renamed_asset))
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(errors) == ['D7', 'D8', 'D9'],
                  '资产表缺「所属业务」列 -> 只有 3 格风险总数缺数', ' '.join(sorted(errors)), 'D7 D8 D9')
    checker.check(all('找不到' in m for m in errors.values()),
                  '错误信息点明是「找不到列」而不是「没有数据」',
                  json.dumps(errors.get('D7'), ensure_ascii=False))

    # —— 边界三：漏洞表被改了列名（平台动了表头）-> 缺数，且错误信息点明是缺列
    renamed_vuln = write_sheet(edges / 'vuln-renamed.xlsx', [
        ['风险资产', '风险标签'],
        ['10.0.0.1', '高可利用'],
    ])
    result = plan(CORE_SYSTEMS, dict(paths, vuln=renamed_vuln))
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(errors) == ['D7', 'D8', 'D9'],
                  '漏洞表缺「威胁标签」-> 3 格风险总数缺数', ' '.join(sorted(errors)), 'D7 D8 D9')
    checker.check(all('找不到' in m for m in errors.values()),
                  '错误信息点明是「找不到列」而不是「没有数据」',
                  json.dumps(errors.get('D7'), ensure_ascii=False))

    # —— 边界四：某一份**风险表**整份没读到（下载失败）-> 那一段按 0 计，其余段照算（用户口径）。
    #    缺表不再让整格作废：三个数照落，只是各少一段。这条口径下**报告上完全看不出**
    #    少算了一段 —— 这正是它危险的地方 —— 所以取值层之外还有一道声：mssw_downloader.js
    #    拼 ctx 时会把「哪几份表没下到」写进运行日志。这里钉的是取值层的三个数。
    #    CORE_SYSTEM_BREAKDOWN 的 (漏洞, 弱密码, 事件) 顺序就是这里的 index。
    for missing, index, label in [('vuln', 0, '漏洞表'),
                                  ('weakpwd', 1, '弱密码表'),
                                  ('event', 2, '事件表')]:
        result = plan(CORE_SYSTEMS, {k: v for k, v in paths.items() if k != missing})
        expected = {f'D{7 + rank}': sum(parts) - parts[index]
                    for rank, parts in enumerate(CORE_SYSTEM_BREAKDOWN)}
        values = writes_of(result, CORE_RISK_TOTAL_CELLS)
        checker.check(values == expected,
                      f'{label}缺席 -> 那一段按 0 计、其余段照算',
                      json.dumps(values, ensure_ascii=False), json.dumps(expected, ensure_ascii=False))
        checker.check(not errors_of(result, CORE_SYSTEM_CELLS),
                      f'{label}缺席 -> 6 格都不报错（缺表不整格作废）',
                      json.dumps(errors_of(result, CORE_SYSTEM_CELLS), ensure_ascii=False), '（无）')

    # —— 边界四之二：**资产表**缺席是另一回事。它不是三段里的一段，是「业务归属 -> IP」
    #    的钥匙：钥匙没了，另外三份表一个 IP 都对不上。这时按 0 算等于报告说「三个系统
    #    都没有风险」—— 那是编的，不是算的。所以整格不写值、记错误（R10/H6）。
    result = plan(CORE_SYSTEMS, {k: v for k, v in paths.items() if k != 'asset'})
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(errors) == ['D7', 'D8', 'D9'],
                  '资产表缺席 -> 3 格风险总数缺数（缺的不是一段，是钥匙）',
                  ' '.join(sorted(errors)), 'D7 D8 D9')
    checker.check(all('资产表没读到' in m for m in errors.values()),
                  '资产表缺席 -> 报错点明缺的是资产表（不是「少一段」）',
                  json.dumps(errors.get('D7'), ensure_ascii=False))

    # —— 边界五：传了 4 个系统 -> 6 格全不写、全记错。
    #    模板里只有 3 个槽位（PPT 侧 core_system_1/2/3），**静默丢掉第 4 个**会让报告
    #    与用户传的东西对不上，所以宁可一格都不写。生产路径上 mssw_downloader.js 还会
    #    更早一步用 badRequest 拦掉，压根走不到写报告这步。
    result = plan(CORE_SYSTEMS + ['测试系统'])
    checker.check(not set(CORE_SYSTEM_CELLS) & set(result['written']),
                  '传 4 个系统 -> 这 6 格一个值都不写',
                  '是' if not set(CORE_SYSTEM_CELLS) & set(result['written']) else '否')
    errors = errors_of(result, CORE_SYSTEM_CELLS)
    checker.check(sorted(errors) == sorted(CORE_SYSTEM_CELLS),
                  '传 4 个系统 -> 6 格全进错误列表', ' '.join(sorted(errors)))
    checker.check(all('最多 3 个' in m for m in errors.values()),
                  '错误信息点明是「最多 3 个」',
                  json.dumps(errors.get('D7'), ensure_ascii=False))
    # 多出来的那个系统不许被安顿到别处去：除了这 6 格、告警 14 格与事件定性 21 格，
    # 不该有别的格子报错
    stray = sorted(set(e['addr'] for e in result['errors'])
                   - set(CORE_SYSTEM_CELLS) - set(ALARM_ADDRS) - set(EXPECTED_EVENT_CELLS))
    checker.check(stray == [], '传 4 个系统 -> 没有别的格子被牵连', ' '.join(stray) or '（无）')


# ---------------------------------------------------------------------------
# 【8】事件定性统计：C135:I137 落盘
# ---------------------------------------------------------------------------

def check_event_end_to_end(checker, bridge, workdir, fixtures, event_path):
    """事件表接进 ctx 之后，事件定性那 21 格必须**真的落盘**，且不惊动别的格子。

    与【6】（告警定性）同一套路 —— 同一套排行算法（stats/metrics/ranking.js），
    只有数据源（ctx.eventRows）与列名（「GPT定性标签」）不同。三段：
    135 行名称 / 136 行数量 / 137 行占比，各 7 个槽位。

    这里比【6】多一条最要紧的断言：**占位符 `-` 与空白都不算一种定性、也不进分母**。
    真实事件表那一列绝大多数行都是 `-`（华能集团样本 2290/2347），算进去的话
    报告的第 1 名会是一个横杠。fixture 里那三行若被算进去，分母会变成 10、
    第 5 名还会多出一个「-」。

    另外三条边界（缺列 / 空表 / 整列全是占位符）走 plan 而不是 build：
    它们与落盘无关，断的是"必须一个值都不写、且全进错误列表"。
    """
    checker.section('8】事件定性统计端到端（C135:I137 真的落进报告）')

    built = call_bridge(bridge, 'build', _b64(json.dumps({
        'outputPath': str(workdir / 'out-event.xlsx'),
        'tables': fixtures,
        'eventPath': event_path,
        'beautify': False,
    })))

    stats = built['statistics']
    expected_written = sorted(EXPECTED_CHANGED + EVENT_ADDRS)
    expected_errors = sorted(EXPECTED_ALARM_CELLS + EXPECTED_CORE_SYSTEM_CELLS)
    checker.check(stats['connected'] is True, 'statistics.connected', stats['connected'], True)
    checker.check(sorted(stats['written']) == expected_written,
                  '落值的地址 = 3 个报告参数格 + 21 格事件定性',
                  ' '.join(sorted(stats['written'])), ' '.join(expected_written))
    checker.check(sorted(e['addr'] for e in stats['errors']) == expected_errors,
                  'errors 只剩告警 14 格 + 核心业务系统 6 格（本段只接事件表）',
                  ' '.join(sorted(e['addr'] for e in stats['errors'])), ' '.join(expected_errors))
    checker.check(len(stats['unresolved']) == EXPECTED_UNRESOLVED,
                  'statistics.unresolved', len(stats['unresolved']), EXPECTED_UNRESOLVED)
    checker.check(len(stats['applied']) == len(expected_written),
                  'statistics.applied（实际落笔，Python 侧没丢格）',
                  len(stats['applied']), len(expected_written))

    ws = load_workbook(built['filePath'], data_only=False)[TEMPLATE_SHEET]
    for rank, (label, count) in enumerate(zip(EVENT_LABELS, EVENT_COUNTS)):
        column = chr(ord('C') + rank)
        label_addr = f'{column}{EVENT_LABEL_ROW}'
        count_addr = f'{column}{EVENT_COUNT_ROW}'
        share_addr = f'{column}{EVENT_SHARE_ROW}'

        actual_label = ws[label_addr].value or ''
        checker.check(actual_label == label, f'{label_addr} 定性名称',
                      json.dumps(actual_label, ensure_ascii=False),
                      json.dumps(label, ensure_ascii=False))

        actual_count = ws[count_addr].value
        if count:
            checker.check(actual_count == count, f'{count_addr} 出现行数', repr(actual_count), count)
        else:
            checker.check(actual_count in (None, ''), f'{count_addr} 无此名次 -> 空串',
                          json.dumps(actual_count, ensure_ascii=False), '(空)')

        # 分母是全部**有效**定性的出现总次数（EVENT_TOTAL=7）：`-` / 空串 / 纯空白都不进。
        # 若把 `-` 算进去，C137 会是 3/8 而不是 3/7；把空串与纯空白再算上则是 3/10。
        share = ws[share_addr].value
        if count:
            expected_share = count / EVENT_TOTAL
            ok = isinstance(share, (int, float)) and abs(share - expected_share) < 1e-12
            shown, want = json.dumps(share), json.dumps(expected_share)
        else:
            ok, shown, want = share in (None, ''), json.dumps(share, ensure_ascii=False), '(空)'
        checker.check(ok, f'{share_addr} 占比', shown, want)
        checker.check(ws[share_addr].number_format == '0.00%',
                      f'{share_addr} 百分号格式', ws[share_addr].number_format, '0.00%')

    # 边界一：表头里没有「GPT定性标签」（平台改了列名）-> 21 格全进错误列表、一个都不写
    edges = workdir / 'event-edges'
    edges.mkdir(parents=True, exist_ok=True)
    renamed = write_sheet(edges / 'renamed.xlsx',
                          [['事件名称', 'GPT研判结论'], ['e1', '银狐病毒']])
    plan = call_bridge(bridge, 'plan', 'event', _b64(json.dumps({'path': renamed})))
    event_errors = {e['addr']: e['message'] for e in plan['errors'] if e['addr'] in EVENT_ADDRS}
    checker.check(sorted(event_errors) == sorted(EVENT_ADDRS),
                  '列名被改 -> 21 格全进错误列表', ' '.join(sorted(event_errors)))
    checker.check(not set(EVENT_ADDRS) & set(plan['written']),
                  '列名被改 -> 一个值都不写',
                  '是' if not set(EVENT_ADDRS) & set(plan['written']) else '否')
    checker.check(all('找不到' in m for m in event_errors.values()),
                  '错误信息点明是「找不到列」而不是「没有数据」',
                  json.dumps(event_errors.get('C135'), ensure_ascii=False))

    # 边界二：空表（只有表头）-> 同样不写值、全进错误列表（R10/H6：缺数不静默，绝不填 0）
    empty = write_sheet(edges / 'empty-table.xlsx', [[EVENT_LABEL, '事件名称']])
    plan = call_bridge(bridge, 'plan', 'event', _b64(json.dumps({'path': empty})))
    event_errors = {e['addr']: e['message'] for e in plan['errors'] if e['addr'] in EVENT_ADDRS}
    checker.check(sorted(event_errors) == sorted(EVENT_ADDRS),
                  '空表 -> 21 格全进错误列表', ' '.join(sorted(event_errors)))
    checker.check(plan['parsed']['rowCount'] == 0, '空表行数为 0', plan['parsed']['rowCount'], 0)

    # 边界三：整列都是占位符 `-` / 空白 -> **一种定性都没有**，仍然一个值都不写。
    #         这条是「`-` 不是一种定性」的正面证据：若把它当定性，C135 会写成一个横杠。
    placeholders = write_sheet(edges / 'placeholder.xlsx', [
        [EVENT_LABEL, '事件名称'],
        ['-', 'e1'],
        ['--', 'e2'],
        ['   ', 'e3'],
        ['', 'e4'],
    ])
    plan = call_bridge(bridge, 'plan', 'event', _b64(json.dumps({'path': placeholders})))
    event_errors = {e['addr']: e['message'] for e in plan['errors'] if e['addr'] in EVENT_ADDRS}
    checker.check(sorted(event_errors) == sorted(EVENT_ADDRS),
                  '整列全是占位符 / 空白 -> 21 格全进错误列表', ' '.join(sorted(event_errors)))
    checker.check(not set(EVENT_ADDRS) & set(plan['written']),
                  '整列全是占位符 -> 一个值都不写（`-` 不是一种定性）',
                  '是' if not set(EVENT_ADDRS) & set(plan['written']) else '否')


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    # JS 侧传进来的参数过了 encodePath（B64: 前缀），中文路径要靠它还原
    decode_argv()
    options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    repo = Path(options.get('repo') or Path(__file__).resolve().parent.parent)
    bridge = Path(options.get('bridge') or (repo / 'scripts' / 'verify_write_layer.js'))
    template = repo / 'data.xlsx'

    if not template.exists():
        raise SystemExit(f'模板不存在: {template}')

    workdir = Path(tempfile.mkdtemp(prefix='v2-verify-'))
    checker = Checker()

    try:
        print('=' * 72)
        print('  写入层验收 —— 「数据统计」取值层 / 表格预处理 / 交付路径')
        print('=' * 72)
        print(f'  模板 {template}')
        print(f'  临时目录 {workdir}')

        check_plan_registry(checker, bridge)
        check_modes(checker, bridge, template)

        fixtures = make_fixtures(workdir / 'fixtures')
        ctx_state = {}

        def build(label, name, beautify):
            result = call_bridge(bridge, 'build', _b64(json.dumps({
                'outputPath': str(workdir / name),
                'tables': fixtures,
                'beautify': beautify,
            })))
            ctx_state[label] = result
            return result

        plain = build('plain', 'out.xlsx', beautify=False)
        check_end_to_end(checker, 'plain', template, plain['filePath'], plain, beautify=False)
        check_preprocess(checker, plain['filePath'], plain)

        pretty = build('pretty', 'out-beautified.xlsx', beautify=True)
        check_end_to_end(checker, 'pretty', template, pretty['filePath'], pretty, beautify=True)

        # 告警定性统计（C133:I134）：读取层契约 + 接了总表之后的落盘结果。
        # 上面那两段 build **不带**总表，验的是"没表时 14 格走缺数"；这两段验的是
        # "有表时真的落值"。两半都得有 —— 各自都对、接起来不匹配，正是这次"没落盘"的病根。
        check_alarm_reader(checker, workdir)
        check_alarm_end_to_end(checker, bridge, workdir, fixtures, make_alarm_table(workdir / 'fixtures'))

        # 核心业务系统（D3/D4/D5 + D7/D8/D9）：接上四份总表与 --business-systems
        # 之后才落值。上面那两段 build **不带**这两样，验的是"没输入时 6 格走缺数"。
        check_core_system(checker, bridge, workdir, fixtures, template)

        # 事件定性统计（C135:I137）：与【6】同一套排行算法，换数据源与列名。
        # 同样两半 —— 上面两段 build 不带事件总表（21 格走缺数），这段验"有表时真落值"。
        check_event_end_to_end(checker, bridge, workdir, fixtures,
                               make_event_table(workdir / 'fixtures'))

        print('\n' + '=' * 72)
        if checker.failures:
            print(f'  ✗ 验收未通过：{len(checker.failures)} 条')
            for name in checker.failures:
                print(f'      - {name}')
            # 退出码**必须是 2 不能是 1**：python_cmd.js 把「退出码 1 且 stderr 为空」
            # 当成"解释器不存在"（Windows 上 python3 的应用执行别名就那么退），
            # 用 1 的话入口会误以为 python 不可用，转头去试 python3 然后报 ENOENT。
            return 2
        print('  ✓ 全部通过')
        return 0
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _b64(text):
    """跑 bridge 时把它要的参数编码成 B64:<base64>，与 path_helper.js 的 encodePath 对齐。"""
    import base64
    return 'B64:' + base64.b64encode(text.encode('utf-8')).decode('ascii')


if __name__ == '__main__':
    raise SystemExit(main())
