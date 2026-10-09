# PPT 引擎：模板、封面、重写与排障

## 目录

- [模板](#模板)
- [generate 常用参数](#generate-常用参数)
- [封面/周期覆盖](#封面周期覆盖默认开)
- [按页重写](#按页重写)
- [引擎的三条既定行为](#引擎的三条既定行为不是-bug)
- [输出布局与 stdout 契约](#输出布局与-stdout-契约)
- [doctor 排障](#doctor-排障)

## 模板

| 模板 id | 用途 | 可重写页（有 AI 位） |
|---|---|---|
| `mss_classic_ops_2` | **默认**：协同运营报告 | 35 / 36 / 39 / 40 |
| `mss_classic_ops_3` | 用户明确要「托管运营报告 / simple」时 | 9 / 10 / 11 / 13 |

`node pipeline.js list-slides --template <id> --rewritable --json` 可以现查哪几页可重写，**不碰 LLM**。

## generate 常用参数

| 参数 | 说明 |
|---|---|
| `--template <id>` | 见上表 |
| `--focus <a,b>` | `业务保护` / `漏洞`（或 `脆弱性`）/ `告警`；**默认三个全开**，`--no-focus` 则不注入偏好文本 |
| `--business-systems <a,b,c>` | 核心系统名，最多 3 个；分隔符中英文逗号、顿号、分号均可 |
| `--excel <p>` | 用现成 `*_report.xlsx`，**跳过下载**（验收、重跑用） |
| `--no-download` | 只出 PPT，不下载；必须与 `--excel` 一起用 |
| `--mock` | 用 mock 值填 AI 位：不烧 LLM 额度，但**产物不是真实内容** |
| `--require-llm` | `OPENAI_API_KEY` 为空即失败 |
| `--ppt-timeout-ms <ms>` | pptgen 超时，默认 1800000（30 分钟）；超时只杀进程，**不删已产出的文件** |
| `--run-dir <d>` | 指定 run 目录；默认每次新铸一个 `outputs/{YYYYMMDD_HHMMSS}` |
| `--force` | 仅当 `--run-dir` 指向已有非空目录时才有意义：覆盖它 |

**每次运行 → 一个新目录**（名字就是开始时间），所以重复跑 generate 不会撞车、也不需要
`--force` 去腾位置 —— 每次运行的 Excel 与 PPT 都原样留着，想对比两次结果直接比目录。
`--force` 只剩一个用途：显式 `--run-dir` 指向已有非空目录时覆盖它（不覆盖是默认，
免得把「刚重写完的几页」无声抹掉）。

顺序硬编码：**先 Excel，后 PPT**。PPT 失败**不回滚 Excel** —— stderr 会明确打
「Excel 已生成，PPT 失败」，stdout JSON 里 `excel.ok=true` / `ppt.ok=false`，退出码非零。
这就是「Excel 可以暂时当最终交付物」的落地点。

## 封面/周期覆盖（默认开）

走下载路径时，`数据统计` 的 `J1/L1/M1` 已由写入层用 CLI 入参写好（客户名 / 报告期起止，
格式 `2026/05/12`）。但 `--excel` 可以指向任意一份工作簿（比如手填的模板），那里面这三格
可能还是模板原文 `xx公司` / `2025-08-01 ~ 2026-03-17`，而**这个周期会进 AI 提示词**
（模型会按错误报告期写总结）。

所以 `generate` 仍然在**内存里**用 `--customer/--start/--end` 覆盖这几格，**不写回 Excel**
（守住 `CELL_REGISTRY.md` F2：`数据统计` 写哪一格只由 `stats/write_statistics_sheet.js` 决定，
落笔在 `scripts/build_report.py`；pptgen 一个格子都不写回）。
覆盖是幂等的。JSON 里回 `cover_source: "cli" | "excel"` 与逐条 `cover_overlays`，
所以在打开 PPT 之前就能核对封面来自哪。

传了 `--excel` 时 `--start` / `--end` 可省，**但建议照常传** —— 省掉之后封面周期会保持
Excel 里的模板值，而它**会进 AI 提示词**。

## 按页重写

```bash
node pipeline.js rewrite --slide 36 --prompt "更强调威胁运营的改进闭环，控制在 300 字内"
```

- `--slide` 接受页码或 `slide_key`。
- `--target-tokens` 只改指定的 token（精确 token 或精确中文名，**不做模糊匹配** ——
  用户打错一个字时静默改错页面，比报错糟得多）。
- 默认读 `outputs/latest.json` 定位「最近一次生成」；也可 `--run-dir` / `--slidespec` 指定。
- **重写版另存新文件**，不覆盖原稿。
- 指定的页没有 AI 位时返回 `slide_not_rewritable` + `detail.rewritable_slides` 候选清单 ——
  拿这份清单去问用户改哪一页，**不要自己猜**。

## 引擎的三条既定行为（不是 bug）

1. `render()` 是**从模板 pptx 全量重放**（先 `unlink` 目标再另存），所以用户在 PowerPoint 里
   手改过的排版会全部丢失（与线上服务行为一致）。
2. 同一份 slidespec 重渲是**幂等**的（`render()` 只读模板 + slidespec，不改 slidespec）。
3. 重写**不重跑 Excel 抽取**（除非显式 `--excel`），`tenant_input` 从 run 目录的 `input.json` 读回。

## 输出布局与 stdout 契约

```text
outputs/
  latest.json                                    # 「最近一次生成」的指针（原子写）
  {YYYYMMDD_HHMMSS}/                             # 本次运行独占，名字就是开始时间
    {客户}_report.xlsx                           # Excel（--excel 时这份来自外部，不在目录里）
    {客户}_report_{模板id}.pptx                   # 成片
    {客户}_report_{模板id}_重写版_P{n}.pptx        # 重写版（另存，不覆盖原稿）
    slidespec.json                               # 当前状态（rewrite 原地更新它）
    slidespec.original.json                      # generate 当时的快照，供回溯对比
    slidespec.P{n}.{ts}.json                     # 每次 rewrite 的审记快照
    input.json                                   # 引擎入参 + 命名依据；rewrite 复用它
    manifest.json                                # generate / rewrite 历史
  _engine_state/                                 # 引擎自己的 OUTPUTS_DIR 被重定向到这里
  _logs/
```

**成片名与上游服务同形**：上游 `report-generation` 落盘叫 `{input_id}_{template_id}.pptx`，
下载时再前缀 `%Y%m%d_%H%M%S_`。本仓库把 `input_id` 的对应物取成**源 Excel 的词干**，
所以成片永远能与它的源 Excel 对上 —— 自己下载的 Excel 是 `{客户}_report.xlsx` → 成片
`{客户}_report_mss_classic_ops_2.pptx`；`--excel plus_data.xlsx` → 成片
`plus_data_mss_classic_ops_2.pptx`。

`_engine_state/` 的作用是把引擎的任何写入关在本 workspace 内，**保证不往 `report-generation` 写东西**。

stdout **只出恰好一个 JSON 对象**（进度日志全走 stderr），字段含
`ok / command / run_dir / excel / ppt / failures / timings`。

## doctor 排障

```bash
node pipeline.js doctor --verify-vendor --probe-engine --fingerprint --probe-llm --json
```

`doctor` 是**唯一**的排障入口，逐项给 `ok` 与 `hint`：vendor 快照 sha256 是否漂移、
引擎符号签名是否还对得上、数据指纹是否变化、Python 依赖是否齐、`.env.ppt` 是否就位、
LLM 是否可达、模板是否可读，并断言引擎链路没有误引入 `backend.services`
（那条链会拉 `qdrant` / `sentence-transformers`）。

**升级 `vendor/` 之后先跑它**：全绿 = 适配成功；不绿 = 它会指出要改哪一处，
而需要改的代码**只可能在 `pptgen/engine.py` 一个文件里**。

`.env.ppt` 的查找顺序（Node 与 Python 两侧一致）：

1. 已注入的 `MSS_ENV_PATH`
2. `<SKILL_OUTPUT_DIR>/.env.ppt`（集群可写区）
3. `<repo>/.env.ppt`（本地原路径）
