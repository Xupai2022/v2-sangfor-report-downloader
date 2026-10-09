# data/samples/ —— mssw 总表样本

**这个目录的存在，决定了 AI 能不能开工。**

[AI_TASK_SPEC.md](../../AI_TASK_SPEC.md) §1 规定：写 `compute` 之前必须拿到**六份总表的真实表头**。
拿不到，AI 只能猜列名 —— 而猜错的列名不会报错，只会静默返回 0。所以：

> **没有样本的表，对应的格子一律保持 `unresolved`，不许推测。**

## 放什么

每份总表导出一份**真实样本**，文件名固定为：

| 文件名 | 对应 `ctx` 字段 | 报告里的去处 |
|---|---|---|
| `asset.xlsx` | `assetRows` | 资产表 sheet + IP→安全域映射 + 业务系统统计 |
| `event.xlsx` | `eventRows` | 事件表 sheet |
| `alarm.xlsx` | `alarmRows` | 告警表 sheet |
| `vuln.xlsx` | `vulnRows` | 资产漏洞表 sheet |
| `weakpwd.xlsx` | `weakPwdRows` | 弱密码表 sheet（R3a） |
| `exposed.xlsx` | `exposedRows` | 暴露面 sheet |

要求：

- **真表头，够用就行** —— 不用全量数据，几十行足够看清列名与取值形态
- **不要脱敏改列名** —— 列名被改过，AI 就是照着一个假的表头写代码
- **保留平台原始形态** —— 合并表头、汇总行、首行空行都要留着，这些会影响解析口径
- 文件名不要带客户名（[.gitignore](../../.gitignore) 已忽略 `data/samples/*.xlsx`，样本不入库）

## 为什么不能只给「列名清单」

清单是人转述的，样本是平台给的。两者不一致时以样本为准 ——
所以直接给样本，省掉一层可能出错的中转。

## 样本没到位时能做什么

有一部分格子**不读总表**，因此不受本目录阻塞，现在就能定：

| 类型 | 格数 | 依据 |
|---|---|---|
| `mode: 'blank'`（确定清空） | 67 | [stats/r1_baseline.js](../../stats/r1_baseline.js) 的 `blankCells` |

其余格子（读六份总表才能算的）**等样本**。
