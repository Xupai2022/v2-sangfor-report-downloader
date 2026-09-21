# v2 迁移文档：SOAR+XDR 双平台取数 → mssw 单平台总表取数

> 状态：**草稿 v0.2**（取数层细节待 mssw 接口资料补齐后定稿）
> 老仓库：`C:\Users\User\Desktop\sangfor-report-downloader`
> 新仓库：`C:\Users\User\Desktop\v2-sangfor-report-downloader`
>
> **v0.2 变更**：弱密码表也落 sheet（报告变 7 个 sheet，见 R3a）· cookie 路径定为 `C:\Users\User\Downloads\mssw_cookies.txt` · 确认清理死输入

---

## 1. 背景与目标

老仓库 `sangfor-report-downloader` 的报告生成链路是：

```
SOAR 分页接口 (逐页拉事件/告警/漏洞原始 doc)  ┐
SOAR 若干统计接口 (order/branch, weak_pwd, topn) ├─→ 本地枚举映射/聚合 ─→ 写入 data.xlsx 模板 ─→ {customer}_report.xlsx
XDR  ~16 个接口 (日志检索/告警/事件处置)        ┘
```

痛点：事件表、告警表这类走接口**逐页拉 + 本地做枚举映射再写 Excel**，很慢。

新仓库的目标：**改为从单独的 mssw 平台取数**。

```
mssw_cookies.txt ─→ 下载六份「总表」(资产/事件/告警/漏洞/弱密码/暴露面)
                        ↓
              从总表直接读出单元格取值 ─→ 写入同一个 data.xlsx 模板 ─→ {customer}_report.xlsx
```

**这是一次取值逻辑的迁移，不是重写。** 总体框架、报告结构、输出文件完全不变。

### 已确认的前提（与用户确认过）

| # | 事项 | 结论 |
|---|---|---|
| 1 | 平台范围 | **mssw 全包，不再调 XDR**。`xdr_cookies.txt` 废弃 |
| 2 | 资产表 | **mssw 也能导出资产表**，实际是**六份**总表，不是五份 |
| 3 | 弱密码表 | **除取数外，还要额外落一个 `弱密码表` sheet**（见 R3a） |
| 4 | Cookie 路径 | `mssw_cookies.txt` 从 **`C:\Users\User\Downloads`** 读取 |
| 5 | 死输入 | **可清理**（见 §5 末） |
| 6 | 接口资料 | 用户**稍后提供接口文档/抓包**；本次只要文档正确，不写取数代码 |
| 7 | git | 删除原空 `.git` 后重新 `init`，分支 `master` |

---

## 2. 迁移原则（硬约束）

这 13 条是所有改动的前置判据。**任何一条与某次具体改动冲突时，先停下来问，不要自行放宽。**

### 冻结类（老仓库已有的，必须一模一样）

| 规则 | 内容 |
|---|---|
| **R1 单元格冻结** | 「数据统计」sheet 的单元格地址、含义、数量**完全不变**。不新增、不删减、不换位。老仓库写 D121 的，新仓库还是 D121，还是那个含义 |
| **R2 模板冻结** | `data.xlsx` 原样使用，不改表头、公式、合并单元格、格式 |
| **R3 输出冻结** | 老仓库的 6 个 sheet 名称与顺序不变：`数据统计 / 资产表 / 暴露面 / 资产漏洞表 / 告警表 / 事件表`，各表列名与列序不变。<br>**新增第 7 个 sheet `弱密码表`**（见 R3a）—— 这是本次迁移**唯一**一处有意的输出变更 |
| **R4 参数复用** | 老仓库 CLI 参数原样保留（含 `--protect-start` / `--protect-end` 重保时间）。只允许**删除**已失效的数据源参数、**新增** mssw 数据源参数 |
| **R5 接缝冻结** | `generateReport({...})` 的**入参签名不变**（见 §3）。这是迁移的唯一接缝 |
| **R6 计算层最小改动** | `data_formatter.js` 的 `buildStatisticsCells` / `populateStatisticsSheet` / 日期区间引擎 / 业务系统统计**尽量零改动** |
| **R7 重保逻辑复用** | `HOLIDAY_PROTECTION_PERIODS` 节假日表、护网/重保区间切分、跨年补齐逻辑全部复用 |

### 新增类（本次迁移**唯一**一处输出变更）

| 规则 | 内容 |
|---|---|
| **R3a 新增弱密码表 sheet** | 老仓库弱密码数据只用于「数据统计」取数；新仓库**额外落一个 `弱密码表` sheet**。<br>约束：<br>① 追加在现有 6 个 sheet **之后**，不插队、不改变原有 6 个的顺序<br>② 不改变「数据统计」sheet 的任何单元格（R1 仍然成立）<br>③ 该 sheet 的列定义由弱密码总表的实际列决定，需与老仓库弱口令口径（管理员/全量/已处置）对齐后确定 |

### 改写类（只改取值逻辑）

| 规则 | 内容 |
|---|---|
| **R8 只改取值层** | 变更集中在「options 对象里每个字段的值从哪来」这一段。计算层、输出层不动 |
| **R9 一表一函数** | 每份总表对应一个 `fetch*`（下载到磁盘）+ 一个 `parse*`（读成内存行对象），职责单一，不交叉 |
| **R10 缺数不静默** | 任一总表缺失/解析失败时，对应单元格留**空**并记录到错误列表，**绝不填 0**。填 0 会污染百分比和平均值 |
| **R11 口径对齐** | 沿用老仓库的时间戳单位（秒）、去重规则、边界包含关系。迁移不引入口径变化 |
| **R12 映射表集中** | 所有枚举/中文名映射放在独立的 map 文件，不散落在逻辑里 |
| **R13 不带 XDR 代码** | 新仓库不保留任何 XDR 接口代码；XDR 来源的单元格改为从总表算（见 §5 风险） |

---

## 3. 关键接缝：`generateReport` 入参签名

**这是整个迁移的支点。** 老仓库 [sangfor_downloader.js:1021-1075](../sangfor-report-downloader/sangfor_downloader.js#L1021-L1075) 构造 options 对象传给 `data_formatter.generateReport()`。

迁移后的新仓库只需产出**形状完全相同**的 options 对象，`data_formatter.js` 可近乎原样搬过来。

按来源分组（共 47 个 key）：

**A. 直接透传（参数/路径）**
`customer` `customerId` `startDate` `endDate` `protectStartDate` `protectEndDate` `reportTemplatePath` `outputDir` `businessSystems` `eventHeaders` `alarmHeaders` `vulnHeaders` `eventHeaderDisplayMap` `alarmHeaderDisplayMap`

**B. 整表透传（Excel buffer）**
`assetWorkbookBuffer` `exposedSurfaceWorkbookBuffer`

**C. 从总表算（本地聚合）**
`eventData` `eventStats` `alarmData` `vulnData` `vulnRawRowCount` `exposedSurfacePortCount`

**D. 弱密码（老仓库走 4 次接口，新仓库从弱密码表算）**
`weakPwdSummaryTotal` `weakPwdSummaryList` `weakPwdAllSummaryList` `weakPwdAllTotalsByIp` `weakPwdAllTotal` `weakPwdHandledTotal` `weakPwdHandledAdminTotal` `weakPwdHandledList` `weakPwdHandledTotalsByIp` `g126`

**E. 重保（`--protect-start/--protect-end` 驱动）**
`d129` `d130` `xdrHolidayLogSearchCounts` `xdrMonthlyIn2outLogSearchCounts` `xdrMonthlyOut2inLogSearchCounts`

**F. 老仓库走 XDR/SOAR 统计接口，需重新定义取法**
`topnReportStats` `orderBranchCounts` `xdrLogSearchCount` `xdrIn2outLogSearchCount` `xdrOut2inLogSearchCount` `xdrRejectedExternalToInternalCount` `xdrG99LogSearchCount` `xdrG100AlertCount` `xdrG101IncidentCount` `xdrG102IncidentHandledCount` `xdrG103IncidentCount` `xdrG105IncidentCount` `xdrG106IncidentCount` `xdrG107IncidentCount` `xdrAlertThreatDefineCounts` `xdrIncidentThreatDefineCounts`

> **F 组是本次迁移的主要风险**（16 个字段）。详见 §5。

---

## 4. 数据源对照表

| 老来源 | 新来源 | 备注 |
|---|---|---|
| SOAR `event_table` 分页接口 | **事件表总表** | 老仓库逐页拉原始 doc 再映射；新仓库读总表 |
| SOAR `alarm_list` 分页接口 | **告警表总表** | 同上 |
| SOAR `vuln_list_port_split` 分页接口 | **漏洞表总表** | 注意老仓库一条原始 doc 会按 `second_level` 端口**拆成多行**，总表已是拆好的形态，需核对 |
| SOAR `weak_pwd/summary_list` ×4 次调用 | **弱密码表总表** | 4 次调用分别对应「全部 / 默认口径 / 已处置(I122) / 管理员已处置(I118)」，总表需能反推这四个口径。**除供数外还落 `弱密码表` sheet（R3a）** |
| SOAR `asset/download` 接口 | **资产表总表** | 同时供「资产表」sheet、「IP→安全域」映射、业务系统统计 |
| SOAR `exposed_surface_mss/*` 导出 zip | **暴露面表总表** | 老仓库要解 zip 取里面唯一的 xlsx 的「统计」sheet |
| SOAR `order/v1/branch/dev` | 待定 | D100/D101/D102/D105 |
| SOAR `tool_box/topn/*` | 待定 | `topnReportStats` |
| XDR `~16 个接口` | **待定（高风险）** | 见 §5 |

> **注意**：弱密码表**除**给「数据统计」的单元格供数（`g126`、I118、I122 等）**外**，还要额外落一个 `弱密码表` sheet（R3a）。因此报告是 **7 个 sheet**，不是 6 个 —— 这是本次迁移唯一一处输出变更。

---

## 5. 风险与阻塞项

### 🔴 阻塞 1：约 99 个地址原样依赖 XDR，新取法未知

单元格全量清点后（见 [CELL_SOURCE_MAP.md](CELL_SOURCE_MAP.md)），XDR 侧的暴露面比预想大：

| 区块 | 地址数 | 老依赖 |
|---|---|---|
| 威胁定义区 rows 133–137 | 44 | `fetchXdrAlertThreatDefineCounts` / `…IncidentThreatDefineCounts` |
| 月度趋势 {col}71/72/73 | 最多 36 | `xdrMonthlyIn2out*` / `xdrMonthlyOut2in*` |
| G99–G107 | 9 | 9 个独立 XDR fetcher |
| G91–G97 重保日均攻击数 | 7 | `xdrHolidayLogSearchCounts` |
| D23 / D27 / D61 | 3 | `xdrRejectedExternalToInternalCount` / `xdrLogSearchCount` / `xdrOut2inLogSearchCount` |
| D21（部分） | 1 | 同 D23 |

**必须确认这些值在 mssw 的哪份总表、哪一列、按什么口径算得出。**

⚠️ 特别提醒：**G100/G101 不能想当然地换成 mssw 告警表/事件表的行数。** 它们的语义是「XDR 侧的告警表/事件表统计」，与报告里那两张表未必同源同口径，需要你明确。

若某字段在 mssw 侧确实无对应数据，需你决定：**留空 / 改口径 / 保留 XDR 调用**（即推翻前提 1）。

### 🔴 阻塞 2：约 35 个地址依赖 SOAR 的独立统计接口

这些不是表数据，是单独的聚合接口，mssw 未必有对应物：

| 区块 | 地址数 | 老依赖 |
|---|---|---|
| TopN 三块（地域/类型/被攻击主机） | 30 | `tool_box/topn/*` |
| D100/D101/D102/D105 | 4 | `order/v1/branch/dev`（订单分支，重保订单数） |
| I81 暴露面风险端口数量 | 1 | `exposed_surface_mss/ip_list_statistics` |

TopN 能否从总表（告警表/事件表）本地聚合出来，是这组的核心问题；D100–D105 是订单系统数据，总表里大概率没有。

### 🟡 待确认：老仓库的两处已知问题是否顺带修

- `--output-dir` 对最终工作簿生效，但 `saveJsonResponse` 恒写脚本目录（老仓库 bug）
- `--business-systems` 在交互模式下丢失

迁移时**默认保持原状**（R8 只改取值层），除非你要求一并修。

### 🟡 待确认：总表的形态

需要知道六份总表是「接口直接返回 xlsx / zip」还是「接口返回 JSON 行」、列名是否中文、是否有合并表头、是否含汇总行（汇总行会污染行数统计）。

已知的解析要求（来自老仓库口径）：

- **漏洞表总表**：老仓库一条原始 doc 会按 `second_level` 端口**拆成多行**（`transformVulnDocs` 用 `flatMap`），所以打印行数时区分「原始记录数」和「Excel 明细行数」。总表若是已拆好的形态，`vulnRawRowCount` 的口径需要重新定义
- **暴露面表**：老仓库要解 zip、取里面唯一 xlsx 的「统计」sheet，并**按单元格坐标**读 E4/E5/E2:E13。总表若不是这个布局，I79/I80/D128 的取法要改
- **弱密码表**：老仓库 4 次调用分别对应「全部 / 默认口径 / 已处置(I122) / 管理员已处置(I118)」，总表需能反推这四个口径；**同时要确定 `弱密码表` sheet 的列定义**（用总表原始列，还是归类成「IP / 账号 / 服务 / 状态」这种报告口径）
- **资产表**：需含 `资产类型`(服务器/终端)、`安全域`(内网/外网)、`服务类型`(服务内)、`*IP/URL`、`安全域` 这些列，否则 §1 里那 14 组单元格连带业务系统统计全断

### 🟢 死输入清理（已确认执行）

清点中发现的死输入，迁移时直接删掉：`xdrIn2outLogSearchCount`、`weakPwdAllSummaryList`、`stats.sceneCounts`、`stats.accountSecurityEventCountForE80`。
它们传了但从不被读取，删除不改变任何单元格。

---

## 6. 目标文件结构

```
v2-sangfor-report-downloader/
├── .gitignore                 ✅ 已建
├── package.json               ✅ 已建
├── data.xlsx                  ✅ 已复制（模板，R2 冻结）
├── MIGRATION.md               ✅ 本文件
├── CELL_SOURCE_MAP.md         ✅ 单元格取数附录（429 个地址全量清点）
├── SKILL.md                   ✅ 复用老仓库，仅改 cookie 路径/平台名/去 XDR
├── mssw_downloader.js         ⏳ 主入口：CLI 解析 + 编排（框架复用老 sangfor_downloader.js）
├── mssw_client.js             ⏳ 对应老 api_client.js：六份总表下载（待接口资料）
├── mssw_transformer.js        ⏳ 对应老 soar_transformer.js：总表行 → 报告列
├── mssw_stats.js              ⏳ 新增：从总表行直接算统计量（替代 order/branch、weak_pwd、XDR）
├── data_formatter.js          ⏳ 从老仓库搬运，仅改必要的取数口（R6）
├── cookie_reader.js           ⏳ 复用（待确认 mssw cookie 格式是否一致）
└── data/                      ⏳ 映射表
```

---

## 7. 迁移里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **M0** | 仓库初始化、迁移文档、迁移规则 | ✅ 完成 |
| **M1** | 搬运 `data_formatter.js` + 模板，跑通「用假 options 生成报告」 | 无 |
| **M2** | mssw cookie 读取（`C:\Users\User\Downloads\mssw_cookies.txt`）+ 六份总表下载 | 接口文档 |
| **M3** | 总表解析 → 重新实现 §3 的 C/D 组字段 | M2 + 样例总表 |
| **M4** | 重新定义 §3 的 F 组字段（XDR 与 SOAR 统计接口的替代方案） | 你决策 |
| **M5** | `弱密码表` sheet（R3a） | M3 |
| **M6** | 端到端对拍：新仓库与老仓库对同一客户同一时间段，逐单元格比对 | M3/M4 |
| **M7** | SKILL.md 定稿 | M6 |

> **M6 是最重要的验收**：R1 的「单元格不变」不能靠人工看，要写一个逐单元格 diff 脚本，用老仓库产出的报告作为基准。
> 注意对拍范围是**原有 6 个 sheet 的单元格**；`弱密码表` 是新 sheet，无基准可比，单独走人工验收。

---

## 8. 本阶段完成情况

- [x] 删除空 `.git` 后重新初始化（分支 `master`）
- [x] `.gitignore`（沿用老仓库规则 + 补 mssw 相关忽略项）
- [x] `package.json` 骨架（复用命令脚本命名）
- [x] `data.xlsx` 模板复制
- [x] 迁移文档 + 14 条迁移规则（R1–R13 + R3a）
- [x] 单元格取数对照附录 [CELL_SOURCE_MAP.md](CELL_SOURCE_MAP.md)（429 个地址全量清点）
- [x] `SKILL.md`（复用老仓库，仅改平台名/cookie/去 XDR）
- [ ] §5 两个阻塞项的答复（等 mssw 接口资料）

## 9. 需要你做/确认的事

已确认：cookie 路径 `C:\Users\User\Downloads\mssw_cookies.txt` ✅ · 弱密码表落 sheet ✅ · 清理死输入 ✅ · `.git` 已删 ✅

| # | 事项 | 状态 |
|---|---|---|
| 1 | 提供 mssw 接口文档/抓包 | ⏳ 待你提供 |
| 2 | §5 阻塞 1：XDR 那 ~99 个地址的新取法，含 G100/G101 口径 | ⏳ 待决策 |
| 3 | §5 阻塞 2：TopN 与 D100–D105 是否能在 mssw 侧找到替代 | ⏳ 待决策 |
| 4 | `弱密码表` sheet 的列定义（总表原始列 vs 报告口径） | ⏳ 待接口资料 |
| 5 | §5 末：老仓库两处已知 bug（`--output-dir` 对 response 文件失效、交互模式丢 `--business-systems`）默认**保持原状**，是否要一并修？ | ⏳ 待决策 |
