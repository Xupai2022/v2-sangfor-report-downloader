# 附录：单元格取数对照表

> 本文件是 [MIGRATION.md](MIGRATION.md) 的附录，为 R1（单元格冻结）提供权威清单。
> 基准：老仓库 `data_formatter.js` 的 `buildStatisticsCells`(L1298–1977) + `populateStatisticsSheet`(L1979–2006)。
> 模板 `data.xlsx` 的「数据统计」sheet `!ref = A1:N97`，但代码会写到 **137 行**（超出 `!ref`）。
>
> **范围说明**：本清单只覆盖**「数据统计」sheet**（R1 的对象）。
> 新增的 `弱密码表` sheet（R3a）不在范围内 —— 它没有老基准，需单独定义列并人工验收。

## 0. 规模

代码最坏情况触及 **429 个地址**，构成如下：

| 区块 | 地址数 |
|---|---|
| 固定/条件单点单元格 | 184 |
| 月度趋势矩阵 (C..N × 10 行) | 120 |
| 护网周期清单 L4:M30 | 54 |
| 重保区 F91:H97 | 21 |
| TopN 区 rows 62–66 | 30 |
| 事件类型 TOP5 C/D51–55 | 10 |
| 威胁定义区 rows 133–137 | 44 |

单次典型运行真正写入的数据约 **184–230** 个。

### 两条写语义（迁移时极易踩坑）

1. `populateStatisticsSheet` **跳过**值为 `''`/`null`/`undefined` 的项（L1996）。
   所以代码里 `N79: ''`、`D65: ''` 这类**不会**清空模板原有的 `手写` 字样 —— 它们本就该保留。
   真正清空只有 `__blankCells` 循环（L1991）做得到。
2. `__blankCells` 在值映射**之前**应用。同一地址同时出现在两个列表时，最终是值映射的内容（如 C51–D55、D3–D9）。

---

## 1. 按数据来源归类

### 🟢 资产表（Excel buffer 透传）— 依赖面最广

`assetWorkbookBuffer` 一个输入同时支撑了下面全部单元格。**这是迁移中牵动最多的一处。**

| 单元格 | 含义 | 依赖 |
|---|---|---|
| D3/D4/D5 | TOP3 核心业务系统名称 | `businessSystems` ∩ 资产表 → `collectBusinessSystemIpSets` |
| D7/D8/D9 | 各系统风险总数 | 同上，IP 维度聚合 |
| C18/D18/E18 | 核心系统已闭环风险分布 | 同上 |
| K79 | 内网服务器资产数量 | 资产类型=服务器 ∧ 安全域=内网 |
| K80 | 内网 MSS 服务资产数 | + 服务类型=服务内 |
| G16 | 业务系统数量 | `countDistinctBusinessSystems` |
| G17 / G18 | 服务器资产数 / PC 资产数 | 资产类型 + 服务内 |
| G6 / H6 / I6 | 核心系统威胁告警数分布 | 告警表行 IP ∩ 各系统 IP 集 |
| G10 / G14 | 核心系统事件数 / 威胁事件总数 | 事件表行 IP ∩ 各系统 IP 集 |
| G12 / G13 | 核心系统风险总数 / 闭环数 | Σ `businessSystemStats` |
| I123 | 业务系统 IP 已处置弱口令合计 | `weakPwdHandledTotalsByIp` ∩ 各系统 IP 集 |

> **安全域映射**（漏洞表/事件表里的「安全域」列）也来自这里，见 `soar_transformer.loadAssetSecurityDomainMap`。
> 你已确认 mssw 能导出资产表，则该组单元格的迁移路径是通的，但**列名/取值口径要对齐**。

### 🟢 覆盖干净、迁移无风险

| 单元格 | 含义 | 依赖 |
|---|---|---|
| D6 | 安全风险总数 | `d10 + d11WeakPwdTotal + d12` |
| D10 / C80 | 高危可利用漏洞数 | 漏洞表：等级=高危 ∧ 可利用=是 |
| D12 / D17 / D68 / D115 / G110 / G123 | 最新漏洞影响资产数 | 事件表 `affected_assets` IP 计数 |
| D13 | 已闭环风险总数 | `d17 + d14 + d15` |
| D14 / D116 / G23 / G124 | 已防护漏洞数 | 漏洞表 跟进状态=已防护 |
| D15 / D117 / G24 | 已修复漏洞数 | 漏洞表 跟进状态=已修复 |
| D20 | 被通报风险总数 | `d21 + g22` |
| D22 / G4 | 安全策略调优数量 | `eventStats.strategyOptimizeCount` |
| D24 | 恶意外联告警数 | 告警表 `attack_direction='内-外'` |
| D28 | 重要时期告警数 | 告警表 ∩ 节假日区间（**重保**） |
| D29 / D91 | 重要时期事件数 | 事件表 ∩ 节假日区间（**重保**） |
| D34 | 高危漏洞防护率 | 漏洞表，`formatRatioAsPercentage` |
| D35–D38 | 平均分析/响应时间、已闭环漏洞数、威胁事件数 | 事件表/漏洞表 |
| D80 | 已闭环外网资产漏洞数 | 漏洞表 外网 ∧ 已 |
| D83–D85 / E83–E85 / F83–F85 | 高/中/低危漏洞数与闭环率 | 漏洞表 |
| D110 / D111 / G122 | 高危漏洞总数 / 唯一 IP 数 | 漏洞表 |
| D112 / D11 / E80 | 弱口令+账号安全 | 弱密码表 + 事件表 |
| D114 | 未公开威胁事件数 | 事件表 `type` 含 未公开威胁 |
| D122 | 高危+最新漏洞影响资产 | `d110 + d115` |
| D126 | 网站篡改/黑链事件数 | 事件表二级类型 |
| D130 | hw 时间事件总数 | 事件表 ∩ `--protect-*`（**重保**） |
| D129 | 漏洞端口拆分统计 | 漏洞表 `second_level` ∩ `protectStart-7d ~ protectEnd`（**重保**） |
| G5 | 威胁告警总数 | 告警表 `type` 含 外部威胁 |
| G7–G9 | 威胁平均遏制时间 / 安全事件总数 / 平均响应 | 事件表 |
| G22 | — | `d14 + d15` |
| G125 | 弱口令总数（全量） | 弱密码表 |
| G126 | 漏洞表含「弱口令」工单数 | 漏洞表 `name` 含 弱口令 |
| I82 / K81–K83 | 外网/内网资产漏洞数 | 漏洞表 内/外网 |
| I122 / D16 | 已处置弱口令数 | 弱密码表 |
| I124 | 木马/病毒已闭环事件数 | 事件表 |
| I79 / I80 / D128 | 互联网 IP/端口数、暴露面合计 | **暴露面表** E4/E5、E2:E13 |
| C49–G55 | 安全事件总数、响应/处置时长、闭环率、类型 TOP5 | 事件表 |
| G51–G55 | 平均识别/响应/遏制/处置/闭环时间 | 事件表 |
| {col}58,59 | 月度平均响应时长 | 事件表 |
| {col}75 | 月度告警数 | 告警表 |
| {col}86–88 | 月度漏洞趋势 | 漏洞表 |
| D62–D64 / D67 | 实时威胁告警、MSS 工单、威胁工单响应、最新威胁情报 | 告警表/事件表 |
| G111–G119 | 核心系统闭环（3 系统） | 漏洞表 + 弱密码表 + 事件表 |
| D90 / D92 / F91–F97 / H91–H97 / L4:M30 / M3 | 重保区值守次数、周期名、防御率、护网清单 | **本地派生 + 硬编码** |

### 🔴 老仓库走独立接口，mssw 侧取法未知

**A. 原 XDR 接口（前提 1 已定不再调 XDR）— 约 99 个地址**

| 单元格 | 含义 | 老依赖 |
|---|---|---|
| D23 | 已拦截外联次数 | `xdrRejectedExternalToInternalCount` |
| D21 | 外联通报风险次数 | 上式 + `d24`（部分依赖） |
| D27 | 重要时期安全日志数 | `xdrLogSearchCount` |
| D61 | 外部攻击日志数量 | `xdrOut2inLogSearchCount` |
| G99 | 报告期日志统计 | `fetchXdrLogSearchCount` |
| G100 | 报告期告警表统计 | `fetchXdrAlertTableCount` |
| G101 | 报告期事件表统计 | `fetchXdrIncidentTableCount` |
| G102 | 报告期已处置事件表统计 | `fetchXdrIncidentTableQueryCount` |
| G103 | 已处置非白名单事件 | `fetchXdrG103IncidentCount` |
| G104 | 差异数 | `g102 - g103`（本地派生） |
| G105 | 已处置（非白名单） | `fetchXdrG105IncidentCount` |
| G106 | 处置中/挂起 | `fetchXdrG106IncidentCount` |
| G107 | 待处置 | `fetchXdrG107IncidentCount` |
| {col}71/72/73 | 月度外部攻击数/恶意外联数 | `xdrMonthlyOut2in*` / `xdrMonthlyIn2out*`（最多 36 格） |
| G91–G97 | 重保期日均攻击数 | `xdrHolidayLogSearchCounts` |
| C133–I133 / C134–I134 | 告警威胁定义名称 / 占比 | `fetchXdrAlertThreatDefineCounts` |
| C135–L135 / C136–L136 / C137–L137 | 事件威胁定义名称/数量/占比 | `fetchXdrIncidentThreatDefineCounts` |

> G100/G101 的语义是「XDR 侧告警表/事件表统计」，与报告里 mssw 的告警表/事件表**未必同源**，
> 迁移时不能想当然地直接换成 mssw 表的行数 —— 口径需你确认。

**B. 原 SOAR 统计接口**

| 单元格 | 含义 | 老依赖 |
|---|---|---|
| D100 | 订单总数 | `orderBranchCounts.d101 + .d102` |
| D101 | type=3 订单数 | `order/v1/branch/dev` |
| D102 | type=25 + type=999 订单数 | 同上 |
| D105 | type=12 订单数 | 同上 |
| F62–F66 / G62–G66 | 攻击来源地域 TOP5 | `topnReportStats.srcIpGeos` |
| I62–I66 / J62–J66 | 攻击类型 TOP5 | `topnReportStats.threatTypes` |
| L62–L66 / M62–M66 | 遭受外部攻击的主机 TOP5 | `topnReportStats.dstIps` |
| I81 | 暴露面风险端口数量 | `fetchExposedSurfaceIpListStatistics` |

### ⚫ 硬编码 / 不写入

| 单元格 | 值 | 说明 |
|---|---|---|
| D30 | `'手写'` | 字面量 |
| D32 / D92 | `'100%'` | 字面量 |
| H91–H97 | `'100%'` | 重保防御率 ×7，不计算 |
| D121 | `` `${d122 + d126}+15-3/15-4/15-5` `` | 后半段是冻结字面量 |
| D129 / D130 | `'无hw时间无数据'` | 未传 `--protect-*` 时 |
| D25 / D33 / D39 / D65 / D66 / G11 / G21 / M61 / N79 / {col}74 | `''` | **不写入**（见 §0 写语义），模板 `手写` 保留 |

---

## 2. `__blankCells` 完整清单

```
blankTrendCells:
  C51..C55, D51..D55                                   (5 行 × 2 列)
  F62..F66, G62..G66, I62..I66, J62..J66, L62..L66, M62..M66   (5 行 × 6 列)
  对每个 i >= displayMonthCount 的月份 i，列 col = C..N:
    {col}58, {col}59, {col}71, {col}72, {col}73, {col}74, {col}75,
    {col}86, {col}87, {col}88                          (10 行 × 缺失月数)
holidaySummaryBlankCells:
  F91..F97, G91..G97, H91..H97                         (7 行 × 3 列)
literals:
  'D3','D4','D5','D7','D8','D9'
```

合计 = `blankTrendCells.concat(holidaySummaryBlankCells, ['D3'..'D9'])`

## 3. `__percentCells` 完整清单

```
告警威胁定义占比  → C134,D134,E134,F134,G134,H134,I134
事件威胁定义占比  → C137,D137,E137,F137,G137,H137,I137,J137,K137,L137
字面量            → G113, G116, G119
```

经 `setWorksheetPercentCellValue` 写入 `z = '0.00%'`，且**仅当该地址同时存在于值映射中**才生效。

---

## 4. 死输入（迁移时可清理，不影响单元格）

| 项 | 位置 | 说明 |
|---|---|---|
| `xdrIn2outLogSearchCount` | 解构于 L1326 | 全程未被读取（只用月度数组） |
| `weakPwdAllSummaryList` | 解构于 L1315 | 全程未被读取 |
| `stats.sceneCounts` | `soar_transformer` L785–791 | 计算了但无单元格消费 |
| `stats.accountSecurityEventCountForE80` | `soar_transformer` L781–783 | 无消费；E80 实际用 `countEventRowsByManageSubTypeKeywords` 重算 |
| 月度趋势 rows 76/77 | 模板有 `B76=有效事件数`、`B77=风险主机数` | 代码从不写入 |

## 5. 单元格别名（同一值写多处，迁移时可放心合并实现）

`D115`/`G123`=`d12` · `D116`/`G124`=`d14` · `D117`=`d15` · `D118`=`d16` · `D110`/`G122` · `G110`=`d115` · `D22`=`G4` · `D91`=`d29` · `D17`=`d12`

## 6. 两套重保口径（易混）

| | 驱动 | 涉及单元格 |
|---|---|---|
| 节假日重保 | 硬编码 `HOLIDAY_PROTECTION_PERIODS`(L409–431)，**与 `--protect-*` 无关** | D28, D29, D90, D91, F91–H97 |
| 手工护网时间 | 用户传 `--protect-start/--protect-end` | M3, L4:M30, D129, D130 |

> `HOLIDAY_PROTECTION_PERIODS` 覆盖 2023-12-30 ~ **2026-10-07**，**无 2027 及以后条目** —— 报告期超出该范围时重保统计会空。迁移时沿用现状（R7），但这值得你知道。
