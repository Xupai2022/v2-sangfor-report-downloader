---
name: v2-sangfor-report-downloader
description: 从 mssw 平台下载资产/事件/告警/漏洞/弱密码/暴露面六份总表，并生成指定客户、指定时间段的本地 Excel 报告。仅在用户明确要原始报表数据、Excel 工作簿，或只要资产表、暴露面、事件表、告警表、漏洞表等单项数据时使用。不要在用户最终目标是生成 AI PPT 报告时使用；那种场景应优先使用 ai-ppt-pipeline，它会先调用本下载器再继续生成 PPT。
---

# 深信服报告下载器（v2 / mssw 平台）

仅在需要本地 mssw 数据提取和 Excel 生成时使用本技能。

> 本技能是 `sangfor-report-downloader`（SOAR+XDR 双平台）的迁移版本，改为从 **mssw 单平台**取数。
> 报告结构、单元格、命令参数与老版本**完全一致**，仅数据来源不同。
> 迁移规则与取数对照见仓库内 `MIGRATION.md`。

## 适用场景

- “下载某客户某时间段的报告”
- “帮我出一份 Excel 报表”
- “只要资产表/暴露面/事件表/告警表/漏洞表”
- “先把原始 response 导出来看看”

不要用本技能做端到端 AI PPT 生成。
PPT 模板选择不在本技能处理；用户要求协同运营报告/plus 或托管运营报告/simple 时，切换到 `ai-ppt-pipeline` 并传对应 `--template`。

## 前置条件

1. Chrome Cookie 插件已经安装并已写出 Cookie 文件。
   - mssw Cookie: `C:\Users\$env:USERNAME\Downloads\mssw_cookies.txt`
2. 当前项目已经执行过 `npm install`。
3. 调用方已经给出明确的结构化参数，例如客户名、客户 ID、开始日期、结束日期，以及可选的报告类型。

## 核心命令

直接调用仓库根目录下的脚本。

```powershell
node mssw_downloader.js `
  --customer "客户中文名" `
  --start "2026-05-12" `
  --end "2026-05-13" `
  --cookie-path "C:\Users\$env:USERNAME\Downloads\mssw_cookies.txt"
```

重保（护网）时间用 `--protect-start` / `--protect-end` 传入，与老版本一致：

```powershell
node mssw_downloader.js `
  --customer "客户中文名" `
  --start "2026-05-12" `
  --end "2026-05-13" `
  --protect-start "2026-05-01" `
  --protect-end "2026-05-07"
```

> 命令参数与老仓库保持一致，唯一移除的是 `--xdr-cookie-path` / `--xdr-base-url`（不再调 XDR）。

## 输出

主输出是一份 Excel 工作簿，包含 7 个 sheet：

```text
数据统计 / 资产表 / 暴露面 / 资产漏洞表 / 告警表 / 事件表 / 弱密码表
```

其中 `弱密码表` 是相对老版本的**新增** sheet，其余 6 个与老版本完全一致。

```text
{customer或customer_id}_report.xlsx
```

可用 `--output-dir` 指定输出目录。

如果使用 `--response-only`，则保存原始 JSON 响应文件，而不是生成工作簿。

## 重要说明

- 生成的工作簿可以作为后续 PPT 生成的 Excel 输入，但本技能本身只到 Excel 为止。
- PPT 模板由后续 `ai-ppt-pipeline` 选择：默认协同运营报告 `mss_classic_ops_2`；用户明确指定托管运营报告/simple 时使用 `mss_classic_ops_3`。
- 数据来源为 mssw 平台的六份总表（资产/事件/告警/漏洞/弱密码/暴露面）。其中**弱密码表既用于「数据统计」取数，也单独落一个 `弱密码表` sheet**。
- 不再需要 XDR Cookie；老版本的 `--xdr-cookie-path` 已移除。
- 如果用户要的是 AI PPT，或者要对 PPT 进行重写，不要停留在本技能，应切换到 `ai-ppt-pipeline` 或 `ai-report-generator`。
- 如果用户明确只要某一个表，保留其显式指定的报告类型，不要默认扩成全部数据。
