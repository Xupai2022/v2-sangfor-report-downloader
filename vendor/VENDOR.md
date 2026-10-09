# vendor/mss_ai_ppt_sample_assets — 上游 PPT 引擎快照

本目录是 `report-generation` 服务里 PPT 引擎的**逐字快照**，不是我们写的代码。

**vendor/ 里的文件永远不手改。** 改了行为就开始漂移，而且 `scripts/vendor_sync.js --check`
会把它报成「被改」—— 那条警报的价值在于「vendor 里出现任何差异都一定是事故」。
所有适配逻辑都在 `pptgen/`，尤其是 `pptgen/engine.py`。

## 溯源

| 项 | 值 |
|---|---|
| 源仓库 | `C:\Users\User\Desktop\report-generation` |
| 源目录 | `mss_ai_ppt_sample_assets/` |
| 上游 commit | `fed14124c7ccc93b4775e69a944379163a4df306`（`fed1412`，2026-07-17，「ppt外部有链接」） |
| 拷贝日期 | 见 `MANIFEST.json` 的 `copied_at` |
| 文件数 / 体积 | 见 `MANIFEST.json` 的 `file_count` / `total_bytes`（约 83 个 / 27M） |
| 逐文件 sha256 | `MANIFEST.json` 的 `files` 段 |

**上游工作树当时是脏的**，`plus.pptx` / `plus_descriptor.json` / `plus_data.xlsx` /
`models/templates.py` / `modules/excel_handler.py` / `modules/llm_orchestrator.py` /
`modules/ppt_generator.py` 处于 `MM` 状态，比 `fed1412` 已提交的版本新。
所以**溯源以 `files` 段的 sha256 为准**，commit 只是参考坐标 —— 想复现这份快照，
拿不到字节相同的文件，除非上游先把那几个文件提交了。

## 保留/排除规则

规则的唯一真相是 `vendor/MANIFEST.json` 的 `exclude` 段，**不在本文件重复一遍**
（两处维护必然漂移）。这里只说原则：

**整棵目录树照搬，只排除重资产树、游离草稿与垃圾文件。全部 Python 源码都保留**
（含 `services/` `routers/` `schemas/` `app.py` `tests/`）。

保留整棵树而不是「只拷必需模块子集」，是为了让**「上游改了什么就拷什么过来」变成目录级
1:1 的动作**。只拷子集的话，上游一旦把某个函数从 `services/` 挪进 `modules/`、
或让 `modules/__init__.py` 新增一条对 `services/` 的 re-export，局部副本就缺文件、
import 直接失败 —— 而那种失败要翻半天才看得出来。

代价：`services/` → `rag_service` → `qdrant` / `sentence-transformers` 这条链在 vendor 里是存在的。
它**只在被 import 时才炸**，而 `pptgen/engine.py` 从不 import `services/`，
`pptgen/doctor.py` 会显式断言 `sys.modules` 里没有 `mss_ai_ppt_sample_assets.backend.services`。
真炸了也是响亮的 `ModuleNotFoundError`，不是静默错值 —— 这种失败我们欢迎。

## 上游改了服务，怎么升级这里

```bash
node scripts/vendor_sync.js                                    # 按 MANIFEST.json 重拉快照
node pipeline.js doctor --verify-vendor --probe-engine --fingerprint --json
#   ├─ 全绿            → 完事
#   ├─ engine.* 不匹配 → 只改 pptgen/engine.py 一个文件
#   ├─ fingerprint 变化 → 上游动了单元格映射或 descriptor 的 source，人工确认影响面
#   └─ 依赖缺失        → 补 requirements.txt
node pipeline.js generate --excel "一致性验收客户_report.xlsx" --mock --json   # 冒烟
```

`vendor_sync.js` 读的是 `MANIFEST.json` 的 `exclude` 段，不是自己内嵌一套规则；
`doctor.py` 读的是同一份。规则只维护一处。

## 不保证兼容

**本目录不承诺与上游任意版本兼容。** 快照 + `pptgen/engine.py` 的适配面能吸收的，是
「同样在这些文件里改实现」这类变化。下面这些情况它吸收不了，需要重设计：

- **上游把生成能力搬离 `modules/`**（例如又把生成逻辑收回 FastAPI、改成异步任务队列、
  或换成另一个进程/服务）。那时 `engine.py` 依赖的符号会消失，`doctor --probe-engine`
  会报警。这是架构级变化，不是拷文件能覆盖的。
- **上游改了 `engine.py` 那 7 个符号的签名**。能靠改 `engine.py` 一个文件吸收，
  但那一次必须人工改，不是零成本。
- **上游改了 `config.py` 的 env 变量名**。改 `bootstrap.py` 注入的名字，
  `doctor` 会断言注入的变量确实被 `settings` 消费。
- **上游改了 `excel_handler.py` 的硬编码单元格地址**。这是唯一的**静默**风险：
  字段数会变，PPT 少渲染十几个格子却不报错。`doctor --fingerprint` 把它变成响亮的告警。

## 上游原始文档

- `README.md` — 上游自己写的说明
- `backend/requirements.txt` — 上游服务的完整依赖（含 fastapi / qdrant /
  sentence-transformers）。**本仓库不用这份**，我们只装引擎链路的依赖，见仓库根的
  `requirements.txt`。
