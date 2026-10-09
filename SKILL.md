---
name: v2-sangfor-report-downloader
description: 从 mssw 平台下载资产/事件/告警/漏洞/弱密码总表、合并成一份季报 Excel 报告，并用它端到端生成 PPT 汇报材料，或对已生成的 PPT 按页重写。Trigger on: 某客户某时间段的季报数据；协同运营报告 / 托管运营报告的 PPT；以及「把第 N 页改一改」。
---

# 报告下载器 + PPT 生成（mssw）

一条命令出交付物：**下载总表 → 合并 Excel →（可选）驱动内置 PPT 引擎出 `.pptx`**。

> 本 skill 绑定 **mssw** 平台。登录态由 muad（session-manager）代管，脚本自动取得 ——
> **无需也不得手动粘贴 Cookie 或准备 Cookie 文件**。业务入口由 `config/api_config.json` 决定。

> ⏱ **本 skill 是前台任务**（`muad.skill.json` 不声明 `longTask`）：命令**跑完才返回**，
> 一条命令含「下载总表 → 合并 Excel → 生成 PPT」，耗时**几分钟到几十分钟**。
>
> **stdout 恰好一个 JSON 对象（结果），进度日志全在 stderr** —— 排障直接读 stderr，
> 里面有 `[mode]` / `[platform]` / `[session]` / `[paged-export]` 这些行。
> 失败时把 stderr 里的报错原文带上，不要只转述结论。
>
> **同一条命令只跑一次。** 中途长时间没有输出是正常的，不要因为「没动静」就再跑一遍 ——
> 那会重复下载、多发一份产物给用户。

## 🚀 快速调用速查

| 场景 | 命令 |
|---|---|
| **出 PPT**（默认协同运营报告） | `node pipeline.js generate --customer "客户中文名" --start 2026-05-12 --end 2026-05-13` |
| **只要 Excel**（用户明确不要 PPT） | `node mssw_downloader.js --customer "客户中文名" --start 2026-05-12 --end 2026-05-13` |
| **托管运营报告** | 同 generate，加 `--template mss_classic_ops_3` |
| **mock 试跑**（用户明确要求） | 同 generate，加 `--mock`：**唯一作用是本次不调 LLM**，PPT 的 AI 位填成字面量 `[token: AI generated content]`；其余（下载、取值、渲染）全部照常真跑。要连下载一并跳过：加 `--excel <已有xlsx> --no-download` |
| **改已生成 PPT 的某一页** | `node pipeline.js rewrite --slide 36 --prompt "更强调改进闭环，300 字内"` |
| **查哪些页可改** | `node pipeline.js list-slides --template mss_classic_ops_2 --rewritable --json` |
| **排障** | `node pipeline.js doctor --verify-vendor --probe-engine --fingerprint` |

命令都在 skill 根目录下执行；全量参数看 `node pipeline.js --help`。

## 跑之前：向用户收齐参数

| 参数 | 说明 |
|---|---|
| `--customer <中文名>` | **必填**。平台按**全等**匹配客户名，一个字的差别就会报「未找到匹配的客户」。这时让用户确认全名，或改用 `--customer-id` 直接给 ID。 |
| `--start` / `--end` | 统计起止日，`YYYY-MM-DD`。 |
| 报告类型 | 默认协同运营报告；用户明确说「托管运营报告 / simple」才换 `mss_classic_ops_3`。 |

客户全名或时间段不清楚时**回去问用户**，不要自己编一个日期范围。

## 输出

**一次运行 = 一个目录**，Excel 与 PPT 不分家（不存在「只搬走 PPT、漏了 Excel」这种交付事故）：

```text
outputs/{YYYYMMDD_HHMMSS}/                   ← pipeline.js generate
  {客户}_report.xlsx                          工作簿
  {客户}_report_{模板id}.pptx                  成片
  {客户}_report_{模板id}_重写版_P{n}.pptx       重写版（另存，不覆盖原稿）
outputs/_logs/{入口}.{时间戳}.log             本次运行的**完整日志**（见下）
```

- 集群下 `outputs/` 在 Runtime Guard 注入的 `SKILL_OUTPUT_DIR` 里（skill 根**只读**）。
- 单跑 `node mssw_downloader.js` 时 Excel 直接落在可写根（集群 `SKILL_OUTPUT_DIR/`、本地 skill 根），
  可用 `--output-dir` 改。

### 运行日志（排障先读它）

每轮运行都会落一份**完整日志**（stdout/stderr 上的东西都在里面，含 Python 子进程的输出、
异常栈、结果 JSON 与退出码），路径同时出现在结果 JSON 的 **`log.path`**：

- 集群：`$SKILL_OUTPUT_DIR/outputs/_logs/<入口>.<时间戳>.log`；本地：`<skill 根>/outputs/_logs/`。
- **排障用它，不要只依赖转述的 stderr** —— stderr 会被截断，转述会丢关键字段
  （2026-09-24 就丢过「403 是哪个接口」，白白多跑一轮）。
- 日志里**不会有凭据**：疑似凭据的行整行不写。但贴给用户前仍自己看一眼。
- 失败时把日志里的**报错原文**带上（`MSSW 请求失败 403 [POST /…/接口名]: {…}` 这种，
  方括号里就是出错的接口），不要只写「下载失败」。
- `--quiet` 只压控制台，不影响日志文件。

- **最终回复**（进度消息只是过程，结果只由这一条发出）**必须**包含：

  1. **`MEDIA: <产物绝对路径>`** —— 只有这一行会让运行时把文件作为附件发给用户；
     光写路径用户拿不到文件。路径**原样照抄**脚本给的值（绝对路径，`SKILL_OUTPUT_DIR` 下），
     **不要**改成相对路径、不要截断、不要改名、不要复制到别处。
     Excel 与 PPT 都要交付就各写一行（各是独立的 `MEDIA:` 行）。
  2. 这次是哪家客户、哪个周期 —— 让用户一眼核对没跑错。
  3. PPT 的真实状态：已成片 / **未生成**（此时 Excel 仍可交付）/ 是 mock 产物（**不可当成品**，
     当次是否为 mock 看 `ppt.llm.used_mock`）/ 命中硬约束 3 的半成品情况。

工作簿的 sheet 结构、样式主题与取值现状见 [references/report-excel.md](references/report-excel.md)。

## 退出码

`0` 成功 · `1` 未预期错误 · `2` 参数错 · `3` LLM 不可用 · `4` vendor 损坏 ·
`5` 模板/页/token 不存在 · `6` 渲染失败 · `7` 引擎内部错 · `8` 下载失败 · `9` PPT 超时 ·
`10` **登录态拿不到**（session 过期或该客户无权限）。

stdout **只出恰好一个 JSON 对象**（进度日志全走 stderr）。成功看 `run_dir / excel / ppt`；
失败看顶层 **`error`** —— 它有 `code` / `message` / `hint` / `detail`，**照 `hint` 处理**，
必要时把 `message` 里的人话转述给用户（注意 `error` 与 `ppt` 是并列的两个键，
`ppt.ok=false` 时原因在 `error` 里，不在 `ppt` 里）。

> **失败恒出 JSON，成功要 `--json`。** 只跑 `node mssw_downloader.js`（不带 `--json`）时，
> 成功路径按历史行为**不打** stdout；但**失败路径无条件**打那一个 JSON —— 否则脚本拿到的
> stdout 是 0 字节，退出码也只剩一个笼统的值，只能人肉去读日志。
> 两个入口（`pipeline.js` / `mssw_downloader.js`）的 `code` / 退出码 / `hint` 由
> [mssw_errors.js](mssw_errors.js) 一处定义，不会各说各的。

- 退出码非 0 但 `excel.ok=true` ⇒ **Excel 已生成，PPT 失败**（`error.excel_path` 就是它）。
  可以直接把 Excel 当交付物给用户，但必须如实说明 PPT 没出来。
- 退出码 `10` 是「拿不到登录态」，看 `error.code` 分三种，**该找的人不同**：
  - `platform_not_configured` —— Console 里没配本平台凭据。**重试和让用户重新登录都没用**，
    转述「请联系管理员配置平台凭据」，不要让用户手工粘 Cookie。
  - `auth_required` —— 会话过期 / 账号未绑定，让用户重新登录平台后再跑。
  - `session_rejected` —— 拿到登录态了，但**网关不认**（403 / `code=9451` 非法操作，或 `9002`
    没权限）。`message` 里方括号内就是出错的接口。本地模式几乎总是 cookie 文件过期/被顶掉，
    集群模式几乎总是入口环境打错 —— 具体看 `hint`，它已按模式分开写。
  三者都**不要**改代码，也不要在命令里塞 Cookie。

## 四条硬约束

1. **不要手改 `vendor/`** —— 它是上游 `report-generation` 的逐字快照，改了就破坏 1:1
   （`doctor --verify-vendor` 会查出来）。要跟上上游就走 `node scripts/vendor_sync.js`。
2. **PPT 必须有 `.env.ppt`**（内含 `OPENAI_API_KEY`）：本地在 skill 根，集群在 `SKILL_OUTPUT_DIR`。
   缺失时**硬失败退出 3**，不会静默降级 —— 除非显式传 `--mock`（mock 产物**不是成品**，不可交付）。
3. **当前 PPT 是半成品**：`数据统计` 的取值口径远未填满，成片会大量印「失败」。
   这是**数据缺口不是集成 bug**，成因与实测见 [references/report-excel.md](references/report-excel.md)。
   交付前如实告知用户，不要承诺一份完整的成片。
4. **重写只动 AI 位**，不可能误改 Excel 数据位；重写版另存新文件，不覆盖原稿。

## 本地调试（可选）

只有**没有 session-manager** 时才需要：加 `--cookie-path <cookie.txt>` 即切到本地模式，
直接读该 cookie 文件、走 `https://<域名>`，行为与历史版本逐字一致。
换环境用 `--mssw-base-url <域名 或 http://host:port>`；**换完 URL 要配同环境签发的 cookie**
（会话不跨环境，网关只会回 403 / `9451` / `9002`，不会告诉你环境打错了）。

> ⚠️ **cookie 文件必须是当前登录的那个会话。** MSSW 一个账号只保留一个活会话 ——
> **在浏览器里重新登录会立刻顶掉之前导出的 cookie 文件**，症状就是 403 / `code=9451`
> 「非法操作」，而且跟入口、请求头都无关（换个域名、删掉几个头都一样报）。
> 遇到 9451 先重新导出一次 cookie 再排查别的。

集群下**不要**传 `--cookie-path`，也不要传 `--mssw-*` 系列。

Python 解释器不用管：本地取 `python`、集群取 `python3`（`python_cmd.js` 按平台定，各带另一个
做备选）。要指定就在命令里加 `--python <路径>`，或设 `PYTHON` 环境变量。

---

PPT 引擎的模板与可重写页、封面覆盖规则、`rewrite` 细节、`doctor` 排障清单：
见 [references/ppt-engine.md](references/ppt-engine.md)。
