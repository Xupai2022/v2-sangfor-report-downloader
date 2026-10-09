# v2 迁移文档：mssw 单平台总表取数

> 状态：**草稿 v0.3**（取值层口径待逐格定稿）
> 本仓库：`C:\Users\User\Desktop\v2-sangfor-report-downloader`
>
> **v0.3 变更**：**本仓库口径完全自定，不参照任何外部实现**。删除 R5/R6/R7 三条以外部实现为基准的规则；
> 删除「计算层输入字段清单」一节（改由 `stats/context.js` 定义）；删除以其它平台为对照的数据源表与阻塞项；
> 删除 `CELL_SOURCE_MAP.md` 与 `scripts/bootstrap_baseline.js` 两个以外部实现为来源的产物。

---

## 1. 背景与目标

报告生成链路：

```
mssw_cookies.txt ─→ 下载六份「总表」(资产/事件/告警/漏洞/弱密码/暴露面)
                        ↓
              从总表直接读出单元格取值 ─→ 写入 data.xlsx 模板 ─→ {customer}_report.xlsx
```

**产物形态固定**：报告结构、sheet 组成、单元格地址与含义都不变（R1–R3）。
**取值逻辑自定**：每个格子算什么、怎么算，由本仓库自己定义，唯一权威是登记表里那一格的 `desc`。

### 已确认的前提

| # | 事项 | 结论 |
|---|---|---|
| 1 | 平台范围 | **只用 mssw**，不调任何其它平台 |
| 2 | 资产表 | mssw 也能导出资产表，共**六份**总表 |
| 3 | 弱密码表 | 除取数外，还要额外落一个 `弱密码表` sheet（见 R3a） |
| 4 | Cookie 路径 | `mssw_cookies.txt` 从 `C:\Users\User\Downloads` 读取 |
| 5 | 接口资料 | 用户提供接口文档/抓包 |
| 6 | git | 分支 `master` |

---

## 2. 迁移原则（硬约束）

**任何一条与某次具体改动冲突时，先停下来问，不要自行放宽。**

### 冻结类（产物形态，必须一模一样）

| 规则 | 内容 |
|---|---|
| **R1 单元格冻结** | 「数据统计」sheet 的单元格地址、含义、数量**完全不变**。不新增、不删减、不换位 |
| **R2 模板冻结** | `data.xlsx` 原样使用，不改表头、公式、合并单元格、格式 |
| **R3 输出冻结** | 6 个 sheet 名称与顺序不变：`数据统计 / 暴露面 / 资产漏洞表 / 资产表 / 告警表 / 事件表`（顺序即 `data.xlsx` 模板的真实顺序），各表列名与列序不变。<br>**新增第 7 个 sheet `弱密码表`**（见 R3a）—— 唯一一处有意的输出变更 |
| **R4 参数复用** | CLI 参数原样保留（含 `--protect-start` / `--protect-end` 重保时间）。只允许**删除**已失效的数据源参数、**新增** mssw 数据源参数 |

### 新增类

| 规则 | 内容 |
|---|---|
| **R3a 新增弱密码表 sheet** | ① 追加在现有 6 个 sheet **之后**，不插队、不改变原有 6 个的顺序<br>② 不改变「数据统计」sheet 的任何单元格（R1 仍然成立）<br>③ 该 sheet 的列定义由弱密码总表的实际列决定，需与弱口令的三个口径（管理员 / 全量 / 已处置）对齐后确定 |

### 取值类

| 规则 | 内容 |
|---|---|
| **R5 口径自定** | 「数据统计」sheet 每个格子的取值口径由**本仓库自定**，唯一权威是该格登记记录里的 `desc`。<br>**不参照任何外部实现** —— 包括不做对照、不搬运、不以别处的输出作为对错依据。 |
| **R6 已删除** | 原「计算口径不变」。与本仓库口径自定（R5）冲突，已废止。编号保留，不再重排。 |
| **R7 已删除** | 原「重保逻辑复用」。重保口径按 R5 自定。编号保留，不再重排。 |
| **R8 取值层与产出层分离** | 变更集中在「每个单元格的值从哪来」这一段。产出层（sheet 合并、模板写入、美化）不动 |
| **R9 一表一函数** | 每份总表对应一个 `fetch*`（下载到磁盘）+ 一个 `parse*`（读成内存行对象），职责单一，不交叉。<br>读取层是通用的（[scripts/parse_table_rows.py](scripts/parse_table_rows.py) + [mssw_parser.js](mssw_parser.js)），加一份表只加一个 `fetch*` 与一个列白名单，不写第二个读表器。行对象的契约见 CELL_REGISTRY.md §7（C4–C7） |
| **R10 缺数不静默** | 任一总表缺失/解析失败时，对应单元格留**空**并记录到错误列表，**绝不填 0**。填 0 会污染百分比和平均值 |
| **R11 口径写清** | 时间戳单位统一用**秒**，日期区间统一用**闭区间**，去重规则逐格写明。这些必须落在 `desc` 里（H10） |
| **R12 映射表集中** | 所有枚举/中文名映射放在独立的 map 文件，不散落在逻辑里 |
| **R13 不引入外部平台** | 本仓库不保留任何非 mssw 平台的接口代码。所有取值只来自六份总表与 CLI 参数 |
| **R14 地址登记表** | 「数据统计」sheet 的取值层一律写成**一地址一条记录**的登记表：`addr` 是主键，算法写在记录里，不写在变量名里。字段格式、写模式、硬约束（H1–H10）、测试描述格式见 **[CELL_REGISTRY.md](CELL_REGISTRY.md)**。<br>本条的落地要求：① 「数据统计」sheet 只能由 `stats/write_statistics_sheet.js` 写入；② 每格的 `verify` 由测试人员填写，未填不得进入验收 |

---

## 3. 计算层输入：`ctx`

**唯一权威是 [stats/context.js](stats/context.js)。** 本文件不复述 `ctx` 的字段清单 ——
字段一旦在这里抄一遍，就有了两个版本，迟早对不上（C1 要求 `ctx` 只在 `context.js` 拼装）。

约定：六份总表各对应一个 `ctx` 字段，字段名与总表一一对应，**不起别名**（C2）。

---

## 4. 数据源

| mssw 总表 | `ctx` 字段 | 供数去处 |
|---|---|---|
| 资产表 | `assetRows` | 「资产表」sheet + IP→安全域映射 + 业务系统统计 |
| 事件表 | `eventRows` | 「事件表」sheet + 事件类单元格 |
| 告警表 | `alarmRows` | 「告警表」sheet + 告警类单元格 |
| 漏洞表 | `vulnRows` | 「资产漏洞表」sheet + 漏洞类单元格 |
| 弱密码表 | `weakPwdRows` | 「弱密码表」sheet（R3a）+ 弱口令类单元格 |
| 暴露面表 | `exposedRows` | 「暴露面」sheet + 暴露面类单元格 |

> 弱密码表**除**供「数据统计」的单元格外，**还要额外落一个 `弱密码表` sheet**（R3a）。
> 因此报告是 **7 个 sheet** —— 唯一一处输出变更。

---

## 5. 风险与待定

### 🔴 待定口径的格子

「数据统计」sheet 有 **429 个**地址要填。其中 **385 个**是 `mode:'unresolved'`（口径未定）；
另外 44 个已转正：3 个**报告参数格**（J1 客户名称 / L1 报告期起 / M1 报告期止，值是 CLI 入参直传、
不依赖总表，格式 `YYYY/MM/DD`，见 [stats/periods.js](stats/periods.js)）+ 14 格告警定性统计
（C133:I134）+ 21 格事件定性统计（C135:I137）+ 6 格核心业务系统（D3/D4/D5 + D7/D8/D9）。

```bash
npm run cell:todo       # 待办清单
npm run cell -- D24     # 查一格
```

两个前置：

1. **六份总表的样本** —— 放到 [data/samples/](data/samples/)（见其 README）。
   没有样本就无法确认列名，对应格子不得定口径（AI_TASK_SPEC.md 铁律 1）。
2. **每格的取值口径** —— 由你投喂（[AI_TASK_SPEC.md](AI_TASK_SPEC.md) §6.1），或直接写进登记表。

### 🟡 待确认：总表的形态

需要知道六份总表是「接口直接返回 xlsx / zip」还是「接口返回 JSON 行」、列名是否中文、
是否有合并表头、是否含汇总行（汇总行会污染行数统计）。样本到位即可解答。

### 🟡 待确认：`弱密码表` sheet 的列定义

用总表原始列，还是归类成「IP / 账号 / 服务 / 状态」这种报告口径。

---

## 6. 目标文件结构

```
v2-sangfor-report-downloader/
├── .gitignore                 ✅
├── package.json               ✅
├── data.xlsx                  ✅ 模板（R2 冻结）
├── MIGRATION.md               ✅ 本文件
├── CELL_REGISTRY.md           ✅ 单元格登记表约束（R14：写法规范 + H1–H10）
├── WORKFLOW.md                ✅ 一页流程：每格取值 3 步 + 取完值之后的 5 件事
├── AI_TASK_SPEC.md            ✅ 给写代码的 AI 看的作业规程（禁止清单 + 提示词模板）
├── SKILL.md                   ✅
├── mssw_downloader.js         ⏳ 主入口：CLI 解析 + 编排
├── mssw_client.js             ⏳ 六份总表下载
├── mssw_errors.js             ✅ 失败分类：code / 退出码 / hint（pipeline 与下载器共用一份判据）
├── mssw_transformer.js        ⏳ 总表行 → 报告列
├── report_writer.js           ✅ 编排层：算 writes 计划 → 交 build_report.py 落值 → 调 beautify_report.py 美化
├── data/
│   └── samples/               ⏳ 六份总表样本（不入库，见其 README）
├── stats/                     ⏳ 「数据统计」sheet 取值层（R14）
│   ├── r1_baseline.js         ✅ 🔒 R1 基准：429 个地址，只读。K1 的对账依据
│   ├── context.js             ✅ C1：六份总表 + 报告参数 → ctx
│   ├── periods.js             🟡 日期格式化（`YYYY/MM/DD`）已用；区间 / 重保切分待 M1.5
│   ├── metrics/               ⏳ 共用派生量，按域拆（event/alarm/vuln/weakpwd/asset/exposed/protection）
│   ├── cells/                 ⏳ 地址登记表，一地址一条（与 metrics 同域划分）
│   ├── index.js               ✅ 汇总 CELLS
│   └── write_statistics_sheet.js ✅ F2：唯一决策点，交出 [{addr, value, mode}] 写入计划（不碰文件）
├── scripts/
│   ├── build_report.py        ✅ 唯一的 Excel 写入口（openpyxl）：搬表 + 预处理 + 落值 + 落盘
│   ├── report_preprocess.py   ✅ 表格预处理：IP → 内网/外网 映射，事件表追加「内网外网资产」列
│   ├── beautify_report.py     ✅ 统一视觉规范（openpyxl，主题见 excel_beautifier/themes）
│   ├── verify_write_layer.py  ✅ 写入层验收主体（openpyxl 逐格读回）
│   ├── verify_write_layer.js  ✅ 验收 JS 侧：出计划 / 产报告 / 入口（薄，见其头注）
│   ├── cell.js                ✅ 单元格查询 / 校验命令（CELL_REGISTRY §9）
│   └── _path_helper.py        ✅ 中文路径 B64 编解码（配合 path_helper.js）
└── cookie_reader.js           ✅
```

> ### 为什么 Excel 读写全在 Python
>
> Node 侧**零依赖**：`package.json` 没有 `dependencies`，没有 `node_modules`。
> 原来唯一的 npm 依赖是 SheetJS（`xlsx`），它社区版**能读样式但写不出样式**
> （字体/填充/边框只有 Pro 版支持），于是模板里的格式、图片会被静默丢掉 ——
> 那其实违反了 R2「不改表头、公式、合并单元格、格式」。openpyxl 本来就是仓库的硬依赖
> （美化那一步在用），改用它是**既去掉依赖、又修掉问题**。
>
> 分工：**JS 只回答"写什么"，Python 负责落笔**。所以
> `stats/write_statistics_sheet.js` 交出写入计划而不再直接写 sheet（F2 的约束没松，
> 决策点还是它一个），`report_writer.js` 退化成编排层。
> 迁移是逐格对拍过的，与 SheetJS 版的差异逐条记在 `scripts/build_report.py` 头注里。

---

## 7. 里程碑

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **M0** | 仓库初始化、迁移文档、迁移规则 | ✅ 完成 |
| **M1** | `stats/` 骨架（ctx 契约 + 429 条登记记录 + `scripts/cell.js` 校验），`--check` 全绿 | ✅ 完成 |
| **M1.5** | 逐格定口径：填 `compute` + `desc`；`--check` 全绿 | 样本 + 口径 |
| **M2** | mssw cookie 读取 + 六份总表下载 | 接口文档 |
| **M3** | 总表解析 → 总表进 `ctx`（读取层已建：`parse*` 通用，当前接了告警表 —— C133:I134 要读它；事件表 —— C135:I137 要读它；其余四份只在 `--business-systems` 给了时才读。再加一份表 = 加一个列白名单，不写第二个读表器） | M2 + 样本 |
| **M4** | 剩余待定格的口径（需要额外数据源的） | 你决策 |
| **M5** | `弱密码表` sheet（R3a） | M3 |
| **M6** | **端到端验收**：跑通全流程生成报告，由测试人员逐格核对 | M3/M4 |
| **M7** | SKILL.md 定稿 | M6 |

> **M6 的判据是每格的 `verify`。** `verify` 为空即视为未验收（V2）。
> 核对方式是**人工按 `desc` 复核** —— 每格的 `desc` 必须写到「不开代码也能照着数一遍」的程度，
> 否则这一格就是不可验收的。这是 H10 存在的理由。
> `弱密码表` 是新 sheet，无既有地址，单独走人工验收。

---

## 8. 本阶段完成情况

- [x] 仓库初始化（分支 `master`）
- [x] `.gitignore`（含 `data/samples/*.xlsx`）
- [x] `package.json`
- [x] `data.xlsx` 模板
- [x] 迁移文档 + 迁移规则
- [x] 单元格登记表约束 [CELL_REGISTRY.md](CELL_REGISTRY.md)
- [x] 一页流程 [WORKFLOW.md](WORKFLOW.md)
- [x] AI 作业规程 [AI_TASK_SPEC.md](AI_TASK_SPEC.md)（含可复制的提示词模板）
- [x] **M1 骨架**：
  - `stats/r1_baseline.js` —— R1 基准 429 个地址（🔒 只读）
  - `npm run cell:check` 全绿：K1 地址集合对账 429/429、K2–K4 通过、label 覆盖 100%
  - `npm run verify:write` 通过：接入 ctx 后**只有 3 个报告参数格**（J1 客户名 / L1 报告期起 /
    M1 报告期止）被写，其余一格不动
  - **接线已通**：`mssw_downloader.js` 用 `createContext` 拼 ctx 传给 `buildReport`；无 ctx / 有 ctx
    两条路径均验证（无 ctx = 模板原样，有 ctx = 只改那 3 格）
  - ⏳ 426 格 `desc` / `compute` 待定（M1.5）；`verify` 待测试人员填写
  - ⚠️ 已知问题：美化步骤（openpyxl 整本重存）会抹掉模板公式格的缓存值
    （I1 `=TODAY()`、C7/C8/C9 `=D3/D4/D5`），程序按值读会得到空 / 0；Excel 打开会自己重算，
    引擎也不读这几格，故暂不阻塞。`npm run verify:write` 的【4】每次都会把它打出来
- [x] `SKILL.md`
- [ ] 六份总表样本（`data/samples/`）
- [ ] 逐格口径

## 9. 需要你做/确认的事

| # | 事项 | 状态 |
|---|---|---|
| 1 | 提供 mssw 接口文档/抓包 | ⏳ 已给漏洞表/弱密码表（2026-10-08），其余待给 |
| 2 | 提供六份总表样本（放 `data/samples/`） | ⏳ |
| 3 | 逐格投喂取值口径（格式见 [AI_TASK_SPEC.md](AI_TASK_SPEC.md) §6.1） | ⏳ |
| 4 | `弱密码表` sheet 的列定义 | ✅ 按平台导出原样落表（29 列，2026-10-08） |
| 5 | 按 [CELL_REGISTRY.md](CELL_REGISTRY.md) §6 为每格填写 `verify` | ⏳ 测试人员 |
