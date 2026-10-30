'use strict';

/**
 * M1 骨架：R1 基准的 429 个地址全量登记。
 *
 * ⚠️ 地址数从 429 变 428 是本文件**第一次删地址**（用户口径 2026-10-12）：
 * 原 G11 那条登记是 M1 清点时按"模板 G 列有一格"补的，label 当时猜成「核心系统事件数量」，
 * 与 G10 重名。查证后确认模板里 **F11 是空的**（那一格在「数据统计」sheet 上没有任何标题，
 * F10 的「核心系统事件数量」对应的是值格 G10），G11 没有可填的口径、也没有名字，
 * 于是删掉这条登记，并同步删掉 R1 基准里的这一个地址（见 stats/r1_baseline.js 的说明）。
 * 核心系统事件数量只有 G10 一格。
 *
 * ⚠️ 地址数从 428 变回 429 是本文件**唯一一次加地址**（用户口径 2026-10-12）：
 * 补登记 **D104**（模板「数据统计」第 104 行「EDR-sangfor」的值格）—— M1 清点时漏了这一格，
 * 同一个组件块里的 D100/D101/D102（以及后来删掉的 D105）都在，只有夹在 D102 与 D105 之间的 D104 没进。
 * 加它的理由与口径见 stats/r1_baseline.js 的说明与 stats/metrics/device.js 的头注。
 *
 * ⚠️ 地址数从 429 变 428 是本文件**第二次删地址**（用户口径 2026-10-13）：
 * 删掉 `u('D105', 'type=12 订单数')` 这条登记 —— D105 是组件块里「EDR」一行的值格，
 * 但这一格没有任何取值口径（label 是 M1 清点时猜的），写入层不写它、也没有消费方：
 * plus ppt 模板上原来取 D105 的那个占位符（slide 9 的 `aes_count`「AES 覆盖端点」）
 * 已改指 D104。于是连 R1 基准里的这一个地址一起删掉（见 stats/r1_baseline.js 的说明），
 * 与同块的另两行「第三方」（D103/D106）一样不进基准。
 *
 * ⚠️ 地址数从 428 变回 429 是本文件**第二次加地址**（用户口径 2026-10-13）：
 * 补登记 **D103**（模板「数据统计」第 103 行「第三方」的值格，同一个组件块里，
 * 夹在 D102 与 D104 之间）—— 用户口径「D103 是第三方数量」，取第三方设备列表接口
 * 报的 `data.count`，见 stats/metrics/third_party.js 的头注与 stats/r1_baseline.js 的说明。
 * 同块的 D106（另一行「第三方」）仍未接、不进基准。
 * 本次**没有**新增地址：G99 本来就在基准里（一直是 unresolved），这一轮只是把口径补上。
 *
 * ⚠️ **过渡态文件。** 除下面标出的已转正记录外，其余格子的口径都还没定，
 * 都是 mode:'unresolved'、compute 为空 —— 它们一个值都不产生，写进报告的行为
 * 与 M1 之前完全一致。
 *
 * 已转正的是 329 格：
 *   · 4 个**报告参数格**（J1 / L1 / M1 / M3）：客户名 / 报告期起 / 报告期止 / 护网时间，
 *     前三个是 CLI 入参（--customer / --start / --end）直传；M3 取
 *     --protect-start / --protect-end（可选，没传写空串）—— 都没有"口径未定"这回事
 *   · 14 格**告警定性统计**（C133:I134）：口径由投喂确定，共用 stats/metrics/alarm.js
 *   · 7 格**核心业务系统**（D3/D4/D5 系统名 + D6 安全风险总数 + D7/D8/D9 各自的风险总数）：
 *     名字取 CLI 的 --business-systems，每个系统的风险总数按「资产表业务归属 -> IP ->
 *     漏洞/弱密码/事件」三段相加，D6 是那三格之和，口径见 stats/metrics/core_system.js
 *   · 1 格**核心系统风险总数**（G12）：= D7 + D8 + D9，只做加法、不重算
 *     （用户口径 2026-10-22）；与 D6 同一个加式、同一个函数
 *     coreSystemRiskGrandTotal，但两格各留一条记录、不是 alias
 *   · 3 格**核心系统已闭环风险总数**（C18/D18/E18）：D13 的四段（D14 + D15 + D16 + D17）
 *     按各系统 IP 集合圈定后相加，数行数、保留 D14/D15 重叠、系统之间各算各的
 *     （用户口径 2026-10-22）
 *   · 1 格**核心系统闭环风险数**（G13）：= C18 + D18 + E18，只做加法、不重算
 *     （用户口径 2026-10-22），与 G12 是并行的两条加式
 *   · 1 格**高危可利用漏洞数**（D10）：漏洞表「威胁标签」列含「高可利用」的行数，
 *     全表 = 内网 + 外网两份相加、不去重，口径见 stats/metrics/vuln.js
 *   · 1 格**高危可利用漏洞数**（C80）：值 = D10，走 alias、不重算（用户口径 2026-10-21）
 *   · 1 格**最新漏洞影响资产数**（D12）：漏洞表「威胁标签」列含「热点漏洞」的漏洞
 *     影响到的资产台数（按「风险资产」去重，不是数行数），
 *     口径见 stats/metrics/vuln.js（与 D10 同一份选行、不同的归总）
 *   · 1 格**最新威胁情报数量**（D67）：两份漏洞表全表里「威胁标签」列含「热点漏洞」的
 *     行数（用户口径 2026-10-19；投喂写的「漏洞标签」= 实际表头「威胁标签」），
 *     口径见 stats/metrics/vuln.js 的 hotVulnCount
 *   · 1 格**最新威胁影响资产数**（D68）：值 = D12，走 alias、不重算
 *     （用户口径 2026-10-19，先给过独立口径、随后改成 alias D12）
 *   · 1 格**未公开威胁去重资产数**（D115）：值 = D12，走 alias、不重算
 *     （用户口径 2026-10-22）
 *   · 1 格**未公开威胁去重资产数**（G110）：值 = D12，走 alias、不重算
 *     （用户口径 2026-10-22；与 D115 同值，两格各自 alias D12，不是链式 alias）
 *   · 1 格**受影响的最新漏洞数**（D17）：漏洞表全表里「威胁标签」列含「热点漏洞」的
 *     **行数**（= D67 同一个派生量 hotVulnCount；用户口径 2026-10-22 由 alias D12 纠正 ——
 *     格名是「漏洞数」，不是资产台数）
 *   · 1 格**已修复漏洞数**（D15）：漏洞表「处置状态」列**包含**「处置完成」的行数
 *     （用户口径 2026-10-26 由整格精确相等改成包含；带括号的四种形态都算；
 *     全表 = 内网 + 外网两份相加；「处置完成（误报）」的行在下载层预处理时就已删掉，
 *     口径 2026-10-21），口径见 stats/metrics/vuln.js
 *   · 1 格**已修复漏洞数**（D117）：值 = D15，走 alias、不重算（用户口径 2026-10-22）
 *   · 1 格**已闭环外网资产漏洞数**（D80）：**互联网漏洞表**里「处置状态」含「处置完成」
 *     的行数（用户口径 2026-10-21；只看外网那一张 sheet，读 ctx.vulnOuterRows），
 *     口径见 stats/metrics/vuln.js 的 closedOuterVulnCount
 *   · 1 格**外网资产漏洞数量**（I82）：**互联网漏洞表**的有效数据行数
 *     （用户口径 2026-10-21；预处理已删掉「处置完成（误报）」的行，读 ctx.vulnOuterRows），
 *     口径见 stats/metrics/vuln.js 的 internetVulnRowCount
 *   · 1 格**内网MSS资产安全漏洞总数**（K81）：**内网漏洞表**的有效数据行数
 *     （用户口径 2026-10-23；读 ctx.vulnInnerRows，与 I82 同一套读法、换一张 sheet），
 *     口径见 stats/metrics/vuln.js 的 intranetVulnRowCount
 *   · 1 格**已防护漏洞数**（K82）：值 = D14，走 alias、不重算（用户口径 2026-10-23）
 *   · 1 格**内网已修复漏洞数**（K83）：**内网漏洞表**里「处置状态」整格精确等于
 *     `处置完成（已修复）/（已缓解）/（接受风险）/（忽略）` 四种之一的行数
 *     （用户口径 2026-10-23；读 ctx.vulnInnerRows，不读「AF 防护规则」列），
 *     口径见 stats/metrics/vuln.js 的 fixedInnerVulnCount
 *   · 3 格**高危 / 中危 / 低危漏洞**（D83 / D84 / D85）：漏洞表全表（内网 + 外网两份）
 *     里「修复优先级」整格精确等于「急需修复」/「尽快修复」/「建议修复」的行数
 *     （用户口径 2026-10-23），口径见 stats/metrics/vuln.js 的
 *     high/medium/lowPriorityVulnCount
 *   · 3 格**高中低漏洞分布已闭环数**（E83 / E84 / E85）：在 D83 / D84 / D85 的判据上
 *     再加「处置状态」**包含**「处置完成」（includes，与 D80 同一档；用户口径 2026-10-23），
 *     口径见 stats/metrics/vuln.js 的 high/medium/lowPriorityClosedVulnCount
 *   · 3 格**高中低漏洞分布闭环率**（F83 / F84 / F85）：= E83÷D83 / E84÷D84 / E85÷D85，
 *     只做除法、不重算（用户口径 2026-10-23）；percent 模式写小数，分母为 0 时
 *     各写一句「无X危漏洞，所以无闭环率」（不写 0，同 F80 / F49），
 *     口径见 stats/metrics/vuln.js 的 high/medium/lowPriorityClosureRate
 *   · 1 格**高危漏洞防护率**（D34）：分子 ÷ 分母（用户口径 2026-10-26，同日修订）。
 *     分母 = 漏洞表全表（内网 + 外网两份）里「修复优先级」整格精确等于「急需修复」
 *     （用户说的「高」）的行数；分子 = **只在内网漏洞表**里同时满足
 *     「修复优先级」=「急需修复」、「AF 防护规则」=「有效」**且**
 *     「处置状态」=「处置完成（已缓解）」（用户说的「已处置（已缓解）」）的行数 ——
 *     「AF 防护规则」只有内网表有，外网高危漏洞只进分母、不进分子；percent 模式写小数，
 *     分母为 0 时写「无高危漏洞，所以无防护率」（不写 0，同 F49 / F80 / F83），
 *     口径见 stats/metrics/vuln.js 的 highVulnProtectionRate
 *   · 1 格**已闭环风险总数**（D13）：= D14 + D15 + D16 + D17，只做加法、不重算
 *     （用户口径 2026-10-22），口径见 stats/metrics/closed_risk.js
 *   · 1 格**已防护漏洞数**（D14）：**内网漏洞表**里「AF 防护规则」=「有效」且
 *     「处置状态」=「处置完成（已缓解）」的行数（用户口径 2026-10-22，两列都整格精确匹配；
 *     只看内网那一张 sheet，读 ctx.vulnInnerRows），
 *     口径见 stats/metrics/vuln.js 的 protectedVulnCount
 *   · 1 格**已防护漏洞数**（D116）：值 = D14，走 alias、不重算（用户口径 2026-10-22）
 *   · 1 格**高危可利用漏洞闭环率**（F80）：(D14 + D15) / D10（用户口径 2026-10-22），
 *     percent 模式写小数；只做加法和除法、不重算三个加数、不交集不去重；
 *     分母为 0 时写「无高危可利用漏洞，所以无闭环率」这句话，不写 0，
 *     口径见 stats/metrics/vuln.js 的 highExploitableClosureRate
 *   · 1 格**管理员弱口令数量**（D11）：资产表「重要级别」=「核心」的资产上，
 *     弱密码表（内网 + 互联网两份）行数 + 事件表账号安全类行数，
 *     口径见 stats/metrics/admin_weakpwd.js
 *   · 1 格**管理员弱口令数量**（D112）：值 = D11，走 alias、不重算
 *     （用户口径 2026-10-22）
 *   · 1 格**管理员弱口令去重资产数**（D113）：与 D11 同一批命中行、同一个核心资产范围，
 *     但两段各自按「风险资产」/「影响资产」归一后**去重数台数**、再相加
 *     （用户口径 2026-10-22），口径见 stats/metrics/admin_weakpwd.js 的
 *     adminWeakPwdAssetCount
 *   · 1 格**管理员弱密码数**（E80）：值 = D11，走 alias、不重算（用户口径 2026-10-21）
 *   · 1 格**已处置弱口令数量**（D16）：弱密码表（内网 + 互联网两份）「处置状态」精确
 *     等于「处置完成」的行数
 *     ＋ 事件表里「安全事件二级分类」含「弱口令」且「处置状态」精确等于「处置完成」的行数，
 *     两段相加、不去重（跨两份表），口径见 stats/metrics/disposed_weakpwd.js
 *     （两段各自落在 weakpwd.js / event.js，与 D11 同一个形状）
 *   · 1 格**已处置管理员弱口令数**（D118）：值 = D16，走 alias、不重算
 *     （用户口径 2026-10-22）
 *   · 1 格**威胁告警总**（G5）：告警表「GPT研判结论」精确等于「真实攻击未成功」的告警
 *     行数（全表、按行计数不去重），口径见 stats/metrics/alarm.js
 *     ⚠️ 这一列只有部分客户的告警表才有：表里有行、却没有这一列时写
 *     「该客户告警表无GPT研判结论，无法计算」（用户口径 2026-10-19，是结论不是缺数）
 *   · 1 格**实时威胁告警数量**（D62）：值 = G5，走 alias，不重算（H5 / 用户口径 2026-10-19），
 *     G5 写那句「无GPT研判结论」时它照抄同一句
 *   · 1 格**MSS威胁工单数量**（D63）：事件表全表里「GPT研判结论」精确等于「真实攻击未成功」
 *     的行数（用户口径 2026-10-19，按行计数不去重、不按 IP 圈行），口径见
 *     stats/metrics/event.js 的 gptVerdictEventCount
 *   · 3 格**核心系统威胁告警数量**（G6/H6/I6，对应系统 1/2/3）：
 *     与 D3/D4/D5 同一批系统名 -> 资产表「所属业务」-> IP 集合，
 *     再数告警表里「GPT研判结论」=「真实攻击未成功」且「主机IP」落在集合里的行数，
 *     口径见 stats/metrics/core_system.js 的 coreSystemThreatAlarmTotalAt
 *     ⚠️ 告警表缺「GPT研判结论」列时同样写那句话、不记错误；缺「主机IP」仍记错误
 *   · 1 格**威胁平均遏制时间**（G7）：事件表里「GPT研判结论」精确等于「真实攻击未成功」的行，
 *     取这些行的遏制时长（事件遏制时间 − 专家研判时间，分钟）的非空均值；没有可平均的
 *     样本时写 0（用户口径 2026-10-14，从前写空串、已作废），口径见 stats/metrics/event.js
 *     的 averageContainedMinutes
 *     ⚠️ 遏制时长那一列**不是平台导出的**：它由表格预处理在**下载之后、解析之前**追加进
 *     事件表下载件（取值层在预处理之后，见 mssw_preprocess.js），所以本格读得到、也不必
 *     自己再算 —— 同一个口径全仓只有 report_preprocess.py 一处实现
 *   · 21 格**事件定性统计**（C135:I137：135 行名称 / 136 行数量 / 137 行占比）：
 *     口径由投喂确定，共用 stats/metrics/event.js 的 gpt*
 *   · 1 格**处置安全事件总数**（G8）：事件表「处置状态」列**整格精确等于**
 *     「已遏制 / 处置完成 / 已忽略」三者之一的事件行数（全表、按行计数不去重），
 *     口径见 stats/metrics/event.js 的 disposedEventCount
 *     ⚠️ 模板 F8 原写「安全事件总数」。2026-10-10 用户确认「xlsx 写错了」，
 *     已把模板那一格改成「处置安全事件总数」，本 label 随之对齐 —— 这是 R2 模板冻结的
 *     一次显式例外，只动这一格文字，地址 / 公式 / 格式 / 图片一个字节没变。
 *   · 1 格**事件平均响应时长**（G9）：在 G8 选出的那批已处置事件**之上**再精确匹配
 *     「推送状态」=「已推送」的行，取「响应时长」（专家研判时间 − 组件检出时间，分钟）的
 *     非空均值；没有可平均的样本时写 **0**，
 *     口径见 stats/metrics/event.js 的 averageResponseMinutes
 *     ⚠️ 选行复用 disposedEventRows —— G8 与 G9 是同一批行，判据只写一遍（H4）
 *     ⚠️ 「响应时长」与 G7 的「遏制时长」同源同性质：由表格预处理在**下载之后、解析之前**
 *     追加进事件表下载件，本格只读不算；「推送状态」则是平台导出的真实列（请求体 push_status）
 *   · 1 格**核心系统事件数量**（G10）：把 `--business-systems` 传进来的**全部**系统名
 *     逐个去资产表「所属业务」圈 IP、**并成一个集合**，再数事件表里「影响资产」精确
 *     落在该集合里的**行数**（不看二级分类 / 处置状态 / 定性 —— 与 D7:D9 的事件那一段
 *     刻意不同），口径见 stats/metrics/core_system.js 的 coreSystemsEventCount
 *     （IP 并集是 coreSystemsIpsUnion，数行是 stats/metrics/event.js 的 eventCountOnIps）
 *     ⚠️ **只有 G10 是「核心系统事件数量」**（原来 G11 那条重名登记已按用户口径 2026-10-12 删除）
 *   · 1 格**核心系统威胁事件总数**（G14）：输入与 G10 **逐字相同**（同一个 `--business-systems`
 *     -> 资产表「所属业务」-> IP **并集**、同一份事件表、同一个「影响资产」精确查找），
 *     只多一道筛：命中的行还要「GPT研判结论」整格精确等于「真实攻击未成功」，
 *     口径见 stats/metrics/core_system.js 的 coreSystemsThreatEventCount
 *     （IP 并集共用 coreSystemsIpsUnion，数行是 stats/metrics/event.js 的 threatEventCountOnIps）
 *     ⚠️ G14 恒 ≤ G10（前者的候选行是后者的子集）—— **不是 alias**，两格各算各的
 *   · 1 格**业务系统数量**（G16）：资产表「所属业务」列里出现过的**不同内容**的条目数
 *     （整格内容算一个条目，不按逗号拆开；去首尾空白 + 转小写；空内容跳过），
 *     口径见 stats/metrics/asset.js 的 businessSystemCount
 *     ⚠️ 与 `--business-systems` 无关（问的是"资产表里登记了几种业务"，不是"传进来的那几个"）
 *   · 2 格**资产类型台数**（G17 服务器资产数量 / G18 PC资产数量）：资产表「资产类型(一级)」
 *     这一列里**整格精确等于**「服务器」/「终端」的**行数**（一台一行、不去重），
 *     两格只差一个待匹配的类型值，共用 stats/metrics/asset.js 的 assetCountByPrimaryType
 *     ⚠️ 精确相等、不含量 / 前缀匹配：`服务器区`、`X86服务器` 都不算；
 *     「网络设备」两格都不计（两格的关键词互斥）。也不读「资产类型(二级)」那一列。
 *     ⚠️ 与 `--business-systems` 无关，也不叠加报告期过滤（与 G16 同一条）。
 *     ⚠️ 「资产类型(一级)」这一列此前没有任何格子要，已按本条加进资产表的列白名单
 *     （mssw_downloader.js 的 ASSET_TABLE_SPEC.columns）
 *   · 2 格**内网服务器 / 内网MSS服务资产数**（K79 / K80，用户口径 2026-10-21）：
 *     资产表「互联网暴露」=「未暴露」**且**「资产类型(一级)」=「服务器」的行数；
 *     K80 在同一条件上再要求「托管状态」=「基础托管」或「深度托管」。
 *     两格共用 stats/metrics/asset.js 的 intranetServerAssetCount
 *   · 4 格**接入组件数量**（D100 SIP数量 / D101 AF数量 / D102 STA数量 / D104 EDR数量）：
 *     数设备列表接口里 `devType` 落在各组件代号集合上的**设备台数**（一行一台、不去重），
 *     四格只差一个代号集合，共用 stats/metrics/device.js 的 deviceCountByType
 *     ⚠️ 这 4 格是**读非总表数据源**的格子（ctx.deviceRows，见 stats/context.js 的
 *     SOURCE_FIELDS）—— 设备列表接口没有下载件、没有 parse 环节、报告里也没有对应 sheet
 *     ⚠️ D102 只有 `devType = 25` 一个代号（**没有 999**）；D104 数的是 EDR **整族 6 个**代号
 *     （用户口径 2026-10-13）；详见 stats/metrics/device.js 的代号表
 *     ⚠️ **接口调不通 -> 四格写「接口不通无值」**（长期口径，用户口径 2026-10-13）——
 *     这四格不拦整份报告；与"接口答了、0 台"（写 0）刻意分开，见 stats/context.js 的
 *     UNAVAILABLE_TEXT（往后凡是从接口取数的格子都照这一条办）
 *     ⚠️ 模板里这四行的**行名**是「NDR-sangfor」/「AF」/「STA」/「EDR-sangfor」
 *     （第 100/101/102/104 行；同一个块里「第三方」那两行见下一条），
 *     label 按用户投喂写成 SIP数量 / AF数量 / STA数量 / EDR数量；
 *     紧接着的 D105「EDR」是**另一行**，已于 2026-10-13 连登记一起删除（用户口径
 *     「不需要 D105 的口径了」；ppt 上取它的占位符已改指 D104），别与 D104 混为一格
 *   · 1 格**第三方数量**（D103）：组件块里「第三方」那一行的值格 —— 取**第三方设备列表接口**
 *     （POST /api/apex/thirdparty/v1/app/instance/list）报的 `data.count`，**不翻页、不按行重算**，
 *     口径见 stats/metrics/third_party.js
 *     ⚠️ 与上面那 4 格**不是同一把尺子**：那 4 格数的是深信服设备列表里 devType 命中代号集合的
 *     行数，本格是**另一个接口**报的第三方（非深信服）应用实例总数 —— 两个集合互不相交、也不相加
 *     ⚠️ 它是**第二个读非总表数据源**的格子，但读的是**标量**而不是行集
 *     （ctx.thirdPartyCount，见 stats/context.js 的 SCALAR_SOURCE_FIELDS）
 *     ⚠️ **接口调不通 -> 写「接口不通无值」**（同上那条长期口径）；同块的 D106（另一行「第三方」）
 *     仍未接、不进基准
 *   · 1 格**xdr日志数**（G99）：模板第 99 行「xdr日志数」的值格 —— 报告期内
 *     「网络安全日志」条数 + 「终端安全日志」条数（同一接口问两次、两张表相加，**不是总表**），
 *     报告期**就是 --start/--end**（起 00:00:00 / 止 23:59:59），
 *     口径见 stats/metrics/security_log.js
 *     ⚠️ 它也是**读非总表数据源**的格子，且是**标量**（ctx.securityLogCount，
 *     见 stats/context.js 的 SCALAR_SOURCE_FIELDS）；**接口调不通 -> 写「接口不通无值」**
 *     ⚠️ label 原为 M1 清点时写的「报告期日志统计」，2026-10-13 按模板 F99 的原文
 *     「xdr日志数」对齐（用户口径就叫这个名）—— 只改 label，地址没动
 *   · 1 格**已拦截外联次数**（D23，用户口径 2026-10-14）—— 与 G99 **同一个日志量端点的
 *     第二问**：同一批表、同一段时间，每张表多一条 `searchString` 过滤串
 *     （网络「内→外 且已拦截」、终端「已拦截」），两张表相加，
 *     口径见 stats/metrics/security_log.js 的 interceptedOutboundLogCount
 *     ⚠️ 它也是**标量**（ctx.interceptedOutboundCount）—— 与 G99 同属
 *     stats/context.js 的 SCALAR_SOURCE_FIELDS，但**各断各的**：一次不通只让读它的那格
 *     写「接口不通无值」，不牵连另一格（下载层问两次，见 mssw_downloader.js）
 *   · 1 格**外部攻击日志数量**（D61，用户口径 2026-10-17）—— 与 G99/D23 **同一个日志量端点**
 *     的**第三问**：只问**网络安全日志一张表**，`searchString` 为
 *     `filter srcIpTag=0 AND dstIpTag=1`（外→内，即从外部打进来的攻击），取 `data.total`；
 *     口径见 stats/metrics/security_log.js 的 externalAttackLogCount
 *     ⚠️ 它是**标量**（ctx.externalAttackLogCount）—— 与 G99/D23 同属
 *     stats/context.js 的 SCALAR_SOURCE_FIELDS，但**各断各的**：一次不通只让本格
 *     写「接口不通无值」，不牵连另外两格（下载层问第三次，见 mssw_downloader.js）
 *   · 24 格**外部攻击数（按月）**（C71:N71 月份标签 / C72:N72 对应条数，用户口径 2026-10-20）——
 *     把报告期切成月份桶（与 C58:N59 同一条月份轴），**逐月**用 D61 那条接口条件
 *     （网络安全日志一张表、`filter srcIpTag=0 AND dstIpTag=1`）各问一次，
 *     首尾月的时间范围**裁到报告期**；最多 12 个月、不足的槽位标签与值都留空，
 *     口径见 stats/metrics/security_log.js 的 monthlyExternalAttackSeries
 *     ⚠️ 数据源是**序列**（ctx.monthlyExternalAttackCounts，见 stats/context.js 的
 *     SERIES_SOURCE_FIELDS）：与 monthRange 等长同序，**数组元素** `null` = 那个月接口不通
 *     （只有那一格写「接口不通无值」，其余月份照落）
 *     ⚠️ 与 D61 是**同一个接口、两个问题**（整段 vs 逐月），不互相推算
 *   · 12 格**恶意外联数（按月）**（C73:N73，用户口径 2026-10-20）—— **与 C71:N72 同一条
 *     月份轴、同一套逐月问法**（报告期切月、首尾月裁到报告期、最多 12 个月、不足留空），
 *     只换过滤串：日志量端点、网络安全日志一张表、
 *     `filter srcIpTag=1 AND dstIpTag=0`（内→外），逐月各取一次 `data.total`；
 *     本行**没有自己的标签行**，月份标签就是 C71:N71 那一行，
 *     口径见 stats/metrics/security_log.js 的 monthlyMaliciousOutboundSeries
 *     ⚠️ 数据源是**序列**（ctx.monthlyMaliciousOutboundCounts，与 C71:N72 同属
 *     SERIES_SOURCE_FIELDS，三档语义逐字相同）
 *     ⚠️ 与 D23「已拦截外联次数」**不是同一条口径**：D23 的抓包串还带 `action = 2`，
 *     本条件没有那一条 —— 数的是全部内→外日志（含未拦截）
 *   · 12 格**告警数（按月）**（C75:N75，用户口径 2026-10-20）—— 与上面两组**同一条月份轴**
 *     （月份标签仍是 C71:N71），数据源换成**告警表**：按「最早发生时间」列（文本，先归一成
 *     `YYYY-MM-DD`）的日期落桶，数每个桶的行数；一行一票、不去重，首尾月裁到报告期；
 *     空表 -> 每月 0，缺列 -> 不写值 + 记错误（不静默数 0），
 *     口径见 stats/metrics/alarm.js 的 monthlyAlarmSeries
 *     ⚠️ 与 D28「重要时期告警数」读的是**同一列、不同口径**（D28 比重要时期段、
 *     本组比月份桶），两者不互相推算
 *   · 36 格**漏洞趋势 / 剩余漏洞数量 / 已闭环漏洞数**（C86:N88，用户口径 2026-10-23）——
 *     与上面三组**同一条月份轴**（86 行 = 月份标签 `2026-06`）；数据源是**漏洞表全表**
 *     （内网 + 互联网两张 sheet 拼起来的 ctx.vulnRows）：87 行按「首次发现时间」的日期落桶、
 *     一行一票数漏洞数；88 行在同样落桶的漏洞里再数「处置状态」**包含**「处置完成」的那些
 *     （仍按**首次发现时间**所在月份 +1，不按处置时间分桶）；
 *     空表 -> 每月 0，缺列 -> 不写值 + 记错误（不静默数 0），
 *     口径见 stats/metrics/vuln.js 的 monthlyVulnSeries
 *     ⚠️ 「首次发现时间」已随本条加进漏洞表的列白名单（VULN_TABLE_SPEC）
 *   · 1 格**恶意外联告警数**（D24，用户口径 2026-10-14）—— 告警表「访问方向」列**整格
 *     精确等于「内➝外」**的行数（一行一票、不去重；全表、不看别的列），
 *     口径见 stats/metrics/alarm.js 的 outboundAlarmCount
 *     ⚠️ 匹配值是**表里实际写的那三个字**（`➝` 是 U+279D），不是口述的「内到外」——
 *     照口述匹配会安静地数出 0（与"一条外联告警都没有"长得一样），已当场跟用户核对过
 *     ⚠️ 「访问方向」这一列已随本条加进告警表的列白名单（ALARM_TABLE_COLUMNS）
 *   · 1 格**外联通报风险次数**（D21，用户口径 2026-10-14）—— **值 = D23 + D24**：
 *     两个加数各走各的具名口径（H4），本格自己不重复任何一边的取数逻辑，
 *     口径见 stats/metrics/security_log.js 的 outboundReportRiskCount
 *     ⚠️ 一半是日志条数、一半是告警行数，**两个数据源不去重**（同一次外联两边各算一次）
 *     ⚠️ D23 那一半接口不通时**本格整格写「接口不通无值」**（穿透，不当 0 只加另一半）
 *   · 5 格**重要时期**（D27「重要时期安全日志数」/ D28「重要时期告警数」/ D29「重要时期事件数」，
 *     用户口径 2026-10-14；D90「重要时期值守次数」/ D91「重要时期安全事件数」，
 *     用户口径 2026-10-26）—— 一律以「重要时期 = 报告期 ∩ 法定节假日放假整段」为准
 *     （定义见 stats/periods.js 的 importantPeriods，数据 stats/holidays.js）：
 *     ⚠️ **与 CLI 的 --protect-start/--protect-end 无关**（用户原话「重要时期与 cli 传入的
 *     重保时间无关」；2026-10-27 起那两个参数只叫**护网时间**，与重保概念脱离）
 *     —— 模板备注 2026-10-27 已由用户改过：E27 现在写「节假日，不算护网时间」，
 *     E28/E29 的旧备注（「重保周期/重保时间范围」）已删，模板与本仓口径一致；
 *     M3「护网时间」走 ctx.protectRange，是另一回事。
 *     「重保」在本仓专指**重要节假日**：L4:M10「重保周期清单」与 F91:F97、G91:G97
 *     处理同一批节假日（用户口径 2026-10-27），都跟护网时间无关
 *     · D27 在**下载层**算：报告期先切成重要时期段，**逐段**问「网络安全日志 + 终端安全日志」
 *     （不筛，与 G99 同一个端点），各段相加 —— 标量 ctx.importantPeriodLogCount，
 *     口径见 stats/metrics/important_period.js；接口调不通 -> 写「接口不通无值」、
 *     报告期内无重要时期 -> 0（结论，连接口都不调）
 *     · D28 / D29 在**取值层**按段过滤行：分别读告警表「最早发生时间」（**文本**）与
 *     事件表「事件创建时间」（真 datetime -> **epoch 秒**）—— 两种形态经同一个
 *     cellDateOnly 归一后按日期比（闭区间两端都算），一行一票、不去重；
 *     两列已随本条加进 ALARM_TABLE_COLUMNS / EVENT_TABLE_COLUMNS
 *     · D90「重要时期值守次数」（用户口径 2026-10-26：「计算的是用户传入的起止时间内，
 *     命中的节假日的数量」）—— 数**节假日条目**，不是一个一个数天数：
 *     `importantPeriods` 逐节日一条、已裁到报告期内，条数即命中数（中秋 + 国庆 = 2；
 *     报告期把国庆右端裁短仍是 1 次）。一张总表都不读；无交集 -> 0。
 *     · D91「重要时期安全事件数」（用户口径 2026-10-26：「精确查找事件表『事件创建时间』
 *     列，如果时间命中节假日的时间区间就加一」）—— 判据与 D29 **逐字相同**，
 *     共用 importantPeriodEventCount（H4）；两格各自登记、不走 alias，
 *     所以事件表缺列时两格**各自**报"找不到列"。
 *   · 1 格**告警行数**（G100「xdr告警数」）—— 告警表总表的**行数**，一个列名都不读
 *     （用户口径 2026-10-13「G100 是告警数，取告警表的告警行数」），
 *     口径见 stats/metrics/alarm.js 的 alarmRowCount
 *     ⚠️ label 原为 M1 清点时猜的「报告期告警表统计」，2026-10-13 按模板 F100 的原文
 *     「xdr告警数」对齐 —— 只改 label，地址没动（模板里 F 列才是这些格子的标题，
 *     清点时抄错了，同批 G101/G102/G106/G107 一并对齐）
 *   · 1 格**事件行数**（G101「xdr事件数」）—— 事件表总表的**行数**，一个列名都不读
 *     （用户口径 2026-10-13「G101 是事件数，取事件表事件行数」），
 *     口径见 stats/metrics/event.js 的 eventRowCount
 *     ⚠️ 与同表的 G8 / G106 / G107 是**三回事**：那三格按「处置状态」精确命中某个值筛行，
 *     本格一行都不筛 —— 同一份事件表上本格是"全表行数"，处置状态为空 / 占位符的行
 *     只进本格，不进那三格
 *     ⚠️ D38「威胁和事件数量」数的是**同一件事**（同一份表、同一个 eventRowCount），
 *     所以两格的值**必然相等**，却**刻意不走 alias** —— 投喂原文「不要复用，重新查」，
 *     D38 有自己的 compute；改动了其中一处的口径，另一处要跟着想一遍（见 D38 的记录）
 *   · 1 格**已处置事件数**（G102）—— 用户口径 2026-10-13 给的那三个状态
 *     （已遏制 / 已忽略 / 处置完成）与 G8 逐字相同，所以本格**与 G8 同值**：
 *     走 alias 指向 G8，不重抄一遍（H5）；算法与边界全见 G8
 *   · 2 格**按处置状态数行**（G106 处置中事件数 / G107 待处置事件数）—— 事件表「处置状态」
 *     整格精确等于「处置中」/「待处置」的行数（用户口径 2026-10-13），
 *     两格只差一个状态值，共用 stats/metrics/event.js 的 eventCountByDisposition（H4）
 *     ⚠️ 与 G102/G8 那批是**互斥的两批行**；空值 / 占位符 `-` 两格都不进
 *   · 2 格**保护率常量格**（D32 资产覆盖率 / D33 威胁遏制率）—— 报告里永远写 100.00%
 *     （用户口径 2026-10-13「默认写 100%」），不读任何一份总表、永远落值、没有"缺数"这一档。
 *     两条 compute 引的是同一个具名常量（H4），但**刻意不互相 alias**（H5 说的是"一个值写到
 *     多个地址"，这两格是两条各自独立的指标口径、今天恰好都取默认值）——
 *     见 stats/metrics/protection.js 的头注
 *   · 3 格**按推送状态求时长均值**（D35 平均分析时间 / D36 平均响应时间 / E49 事件平均处置时长）
 *     —— 事件表「推送状态」整格精确等于「已推送」的行，其**预处理追加的**
 *     「识别时长」/「响应时长」/「处置时长」列的非空均值（用户口径 2026-10-13），
 *     三格只差一个时长列，共用 stats/metrics/event.js 的 averagePushedDurationMinutes（H4）
 *     ⚠️ 与 G9「事件平均响应时长」**不是同一个格**：G9 只数 G8 那批**已处置**事件里已推送的，
 *     这三格一道处置状态的筛都没有（D36 与 G9 读同一列、值不同，不能互相 alias）
 *     ⚠️ 没有可平均的样本 -> 写 **0**、不记错误（与 G9 同一条「没有就写0」；G7 从前写空串，
 *     那条口径 2026-10-14 已作废，现在这几格与 G7 落法一致）
 *     ⚠️ D49「事件平均响应时间」**复用 D36**（alias，用户口径 2026-10-13「复用D36」）——
 *     本条另记在下一段，见 D36 / D49 的记录
 *   · 5 格**平均时长五连**（G51 平均识别时长 / G52 平均响应时长 / G53 平均遏制时长 /
 *     G54 平均处置时长 / G55 平均闭环时长，用户口径 2026-10-13 **第二版**）——
 *     事件表**全表**、**一道筛都没有**，五列时长各自的非空均值（用户原话：
 *     「这五个单元格的时间，不用跟推送状态挂钩，跟 alias 的不一样的」）——
 *     五格**各写各的 compute**：averageEventDurationMinutes(ctx, 各自的时长列)
 *     ⚠️ 与上面 D35 / D36 / E49（只数「推送状态」=「已推送」那批）是**同一列、不同尺子**：
 *     第二版口径把同一天早些时候那四条 alias（G51→D35、G52→D36、G54→E49、G55→E49）
 *     整个撤掉了，五格现在与那三格**无关**，同一份表上两边值不同才算对
 *     ⚠️ G53 与 G7「威胁平均遏制时间」**读同一列、不是同一把尺子**（G7 那道筛是
 *     「GPT研判结论」= 真实攻击未成功），两格值必须不一样
 *     ⚠️ G54 与 G55 **恒同值**（预处理给「处置时长」与「闭环时长」用的是同一条算式）
 *     却**刻意不互为 alias**，与 D32/D33、D38/G101 同一条安排
 *     ⚠️ label 按用户投喂改名（模板 F51:F55 原文是「识别 / 响应 / 遏制 / 处置 / 闭环」，
 *     左边 E51:E55 那个合并标题写的是「平均处置时间（分钟）」）—— 地址一个都没动
 *   · 1 格**已闭环漏洞数量**（D37 第 37 行）—— 与 D15「已修复漏洞数」**同值**：
 *     「漏洞表」「处置状态」列**包含**「处置完成」的行数
 *     （用户口径 2026-10-13：「精确查找漏洞表『处置状态』列，找值严格匹配『处置完成』的，
 *     算命中，算总数」；判据 2026-10-16 曾随 D15 一起改成前缀，2026-10-22 又随 D15 改回
 *     整格精确相等，2026-10-26 再随 D15 改成包含 —— 两格始终同源），
 *     走 alias 指向 D15、一个字都不重算（H5）
 *     ⚠️ 用户口径 2026-10-13 曾先给过一版「D37 = G14 + G5」，当天已改成本条 ——
 *     以本条为准，别照旧口径去读 G14/G5（旧口径那条 compute 已整个删掉，不是留着的第二份）
 *   · 1 格**已修复漏洞数**（G24，用户口径 2026-10-14）—— 与 D15「已修复漏洞数」同值，
 *     走 alias 指向 D15、一个字都不重算（H5）；算法与边界全见 D15
 *   · 1 格**威胁和事件数量**（D38）—— 事件表总表的**行数**，与 G101「xdr事件数」口径逐字相同
 *     （用户口径 2026-10-13「取事件表所有事件总行数」），本格有自己的 compute
 *     ⚠️ 投喂的原话是「可能其他单元格也算过这个，**不要复用，重新查**」——
 *     与 G101 **同值却刻意不走 alias**（H5 被这次投喂显式压过，与 D32/D33 那对同款）
 *   · 1 格**安全事件总数**（C49）—— 与 D38 同值，走 alias 指向 D38（用户口径 2026-10-13）
 *   · 1 格**事件平均响应时间**（D49）—— 与 D36 同值，走 alias 指向 D36（用户口径 2026-10-13）
 *     ⚠️ C49 / D49 落在模板第 48/49 行那块：标题在第 48 行（C48/D48），值在**第 49 行**
 *   · 1 格**事件闭环率**（F49 第 49 行）—— 事件表「处置状态」整格精确等于「处置完成」的
 *     **行数** ÷ C49（= D38 = 事件表总行数），用户口径 2026-10-13；只认「处置完成」一个状态，
 *     与 G8 那三个状态刻意不同（同一份表上两个数必须不一样）
 *     ⚠️ 是本仓**唯一**一格会在分母为 0 时写一句**话**（「无事件，所以无闭环率」）的 percent 格 ——
 *     不写 0（0.00% 会被读成"有事件、一条都没闭环"），见 stats/metrics/event.js
 *     ⚠️ 模板里标题在第 48 行的 F48、值是第 49 行的 F49
 *   · 10 格**安全事件类型 TOP5**（C51:C55 名称 / D51:D55 次数，用户口径 2026-10-13）——
 *     事件表「安全事件二级分类」这一列**按整格取值**做频次排行：一行一票、取前 5 名、
 *     有几个取几个，C 列写分类名、同一行的 D 列写同一个名次的次数。
 *     ⚠️ 与 D7/D8/D9、D11、D16 读的**是同一列、却不是同一把尺子**：那几格是"含关键词就归类"
 *     （子串包含、一行可同时归进多个类），本块是"整格等于什么就记什么"（一行只算一票）
 *     ⚠️ 空表 / 整列都是占位符 -> **名称列与数量列一起写空串**，不写 0
 *     （没有第 4 名时"第 4 名有 0 个"是假信息，见 stats/metrics/event.js 的 categoryRanking）
 *   · 10 格**攻击来源地域分布top5**（F62:F66 地域名 / G62:G66 攻击数量，用户口径 2026-10-19）——
 *     数据源是 **topn 接口**（device_list -> src_ip_geo），不是六份总表：没有下载件、
 *     没有 parse 环节、报告里也没有对应的 sheet。按响应**原顺序**落前 5 行，不重排、
 *     不合并相同地域；少于 5 行时剩下的格子写空串；接口不通时十格都写
 *     「topn接口不通无法取值」（不是空串、也不是 0）。口径见 stats/metrics/top_src_geo.js
 *     ⚠️ label 按模板真实表头对齐（F61「攻击来源地域分布top5」/ G61「攻击数量」）——
 *     这十格在 M1 清点时除 F62/G62 外都抄成了别的列的标题
 *   · 10 格**攻击类型top5**（I62:I66 类型名 / J62:J66 攻击数量，用户口径 2026-10-19）——
 *     数据源同样是 **topn 接口**（device_list -> threat_type，请求体与 src_ip_geo 逐字相同、
 *     只换端点），不是六份总表。按响应**原顺序**落前 5 行，不按 attack_count 重排；
 *     少于 5 行时剩下的格子写空串；接口不通时十格都写「topn接口不通无法取值」。
 *     口径见 stats/metrics/threat_type.js
 *     ⚠️ label 按模板真实表头对齐（I61「攻击类型top5」/ J61「攻击数量」）；用户投喂时
 *     叫「威胁类型 Top 5」，接口字段是 threat_type —— 三处指同一个东西
 *   · 10 格**遭受外部攻击的主机 / 日志数量**（L62:L66 目的 IP / M62:M66 攻击次数，
 *     用户口径 2026-10-20，用户叫「目的 IP Top 5 名称和对应的数量」）——
 *     数据源同样是 topn 接口（device_list -> dst_ip，请求体与 src_ip_geo 逐字相同，
 *     只把 ip_type 换成 dst_ip），不是六份总表。按响应**原顺序**落前 5 行；
 *     少于 5 行时剩下的格子写空串；接口不通时十格都写「topn接口不通无法取值」。
 *     口径见 stats/metrics/dst_ip.js
 *     ⚠️ label 按模板真实表头对齐（L61「遭受外部攻击的主机」/ M61「日志数量」）
 *   · 1 格**暴露面数**（D128，用户口径 2026-10-19）：暴露面下载件「文档说明」sheet 里
 *     13 项子类型文字右侧「总数」之和（缺项 / 重复 / 非数字不写部分和），
 *     口径见 stats/metrics/exposed.js
 *   · 1 格**暴露面风险端口数量**（I81，用户口径 2026-10-19）：暴露面下载件
 *     「高危端口&服务」sheet 的数据行数（不含表头；只有表头 -> 0），
 *     口径见 stats/metrics/exposed.js
 *   · 2 格**互联网IP数量 / 互联网端口数量**（I79 / I80，用户口径 2026-10-21）：
 *     暴露面下载件「文档说明」汇总表里**包含**「IP资产」/「端口资产」的格子，
 *     取**右侧一格**的值（投喂原话的 sheet 名与实际不符，按真实结构读），
 *     口径见 stats/metrics/exposed.js 的 internetIpAssetCount / internetPortAssetCount
 *   · 1 格**HW及前一周已加固中高危漏洞数**（D129，用户口径 2026-10-26）：
 *     [--protect-start − 7 天, --protect-end] 窗口内**不按「修复优先级」筛**、
 *     只要「处置状态」含「处置完成」（已修复）或满足 D14（已防护）的漏洞行数（两张漏洞表各数各的再相加），
 *     没传 HW 时间写 0，口径见 stats/metrics/vuln.js 的 hwHardenedVulnCount
 *   · 2 格**已闭环漏洞总数 / 已防护漏洞数**（G22 / G23，用户口径 2026-10-26）：
 *     G23 = alias D14（走 alias，不读表）；G22 = G23 + G24，只做加法、不重算
 *     （G24 = alias D15，所以数值上就是 D14 + D15，与 F80 的分子共用
 *     protectedPlusSettledVulnCount），口径见 stats/metrics/vuln.js
 *
 * ⭐ `--business-systems` 是**可选参数**（用户口径 2026-10-12）。本域只有两条落法：
 *   · 写**系统名本身**的 D3/D4/D5：槽位空着就没东西可写 -> 不写值 + 记错误。
 *   · 写**算出来的数**的 D6 合计、D7/D8/D9 风险总数、G6/H6/I6 威胁告警数量、
 *     G10 事件数量、G14 威胁事件总数：槽位空着那个数就是 **0**，不记错误（从前是不写值 + 记错误）。
 * "一个系统都没传"与"只传了 1–2 个"**同一档**：缺的槽位就是没有这个系统，那个数就是 0，
 * 不另立一条口径（--business-systems 本来就是可选的，没给够不是错）。
 * 判据在 stats/metrics/core_system.js 的 coreSystemSlotName
 * （G10 与 G14 走 noCoreSystems 提前落 0）。
 *
 * ⚠️ 第 135-137 行在 R1 基准里有 **10 个槽位**（C..L，且 percentCells 也把 J137:L137
 * 列了进去），但投喂的口径是「最多 7 个」、地址范围给到 C..I。本文件按投喂实现 C..I；
 * J135:L137 这 9 格**仍留在 unresolved**（R1 冻结：既不删也不凭空填）。
 * 要给它们补上第 8/9/10 名，只需照 C..I 再添 9 条记录。
 *
 * M1.5 会按数据源把它拆成 CELL_REGISTRY.md §8 规定的域文件
 * （event / alarm / vuln / weakpwd / asset / exposed / protection + literal），
 * 届时每格补齐 compute / desc / verify，并从本文件移走。
 *
 * label 取自模板「数据统计」sheet；模板里为空白的格子（J1/L1/M1/M3）label 是手写的，
 * 在记录里逐条注明了。
 * verify 由测试人员按 CELL_REGISTRY.md §6 填写（V1）—— 其他角色不填（V3）。
 */

const { formatReportDate, formatReportDateRange } = require('../periods');
const { qualificationLabelAt, qualificationShareAt, gptVerdictAlarmCount,
        alarmRowCount, outboundAlarmCount, monthlyAlarmCountAt,
        GPT_VERDICT_MISSING_TEXT } = require('../metrics/alarm');
const { gptLabelAt, gptCountAt, gptShareAt, disposedEventCount,
        averageContainedMinutes, averageResponseMinutes,
        eventRowCount, gptVerdictEventCount, eventCountByDisposition, eventClosureRate,
        IN_PROGRESS_EVENT_STATUS, PENDING_EVENT_STATUS,
        averagePushedDurationMinutes, RECOGNIZE_DURATION_COLUMN,
        DISPOSAL_DURATION_COLUMN,
        RESPONSE_DURATION_COLUMN,
        CONTAINED_DURATION_COLUMN,
        CLOSURE_DURATION_COLUMN,
        averageEventDurationMinutes,
        categoryLabelAt, categoryCountAt,
        buildMonthSeries, monthLabelAt, monthMeanAt,
        CREATE_MONTH_COLUMN } = require('../metrics/event');
const { coreSystemNameAt, coreSystemRiskTotalAt, coreSystemRiskGrandTotal,
        coreSystemClosedRiskTotalAt, coreSystemClosedRiskGrandTotal,
        coreSystemThreatAlarmTotalAt, coreSystemsEventCount,
        coreSystemsThreatEventCount } = require('../metrics/core_system');
const { highExploitableVulnCount, hotVulnCount, hotVulnAssetCount,
        settledVulnCount, protectedVulnCount, protectedPlusSettledVulnCount,
        closedOuterVulnCount,
        hwHardenedVulnCount,
        internetVulnRowCount, intranetVulnRowCount, fixedInnerVulnCount,
        highPriorityVulnCount, mediumPriorityVulnCount, lowPriorityVulnCount,
        highPriorityClosedVulnCount, mediumPriorityClosedVulnCount,
        lowPriorityClosedVulnCount,
        highPriorityClosureRate, mediumPriorityClosureRate, lowPriorityClosureRate,
        highExploitableClosureRate, highVulnProtectionRate,
        monthlyVulnLabelAt, monthlyVulnCountAt, monthlyClosedVulnCountAt } = require('../metrics/vuln');
const { adminWeakPwdCount, adminWeakPwdAssetCount } = require('../metrics/admin_weakpwd');
const { closedRiskTotal } = require('../metrics/closed_risk');
const { disposedWeakPwdCount } = require('../metrics/disposed_weakpwd');
const { businessSystemCount, assetCountByPrimaryType,
        intranetServerCount, intranetMssAssetCount,
        SERVER_ASSET_TYPE, PC_ASSET_TYPE } = require('../metrics/asset');
const { deviceCountByType, SIP_DEVICE_TYPES, AF_DEVICE_TYPES,
        STA_DEVICE_TYPES, EDR_DEVICE_TYPES } = require('../metrics/device');
const { thirdPartyDeviceCount } = require('../metrics/third_party');
const { securityLogCount, interceptedOutboundLogCount,
        externalAttackLogCount, outboundReportRiskCount,
        monthlyExternalAttackLabelAt, monthlyExternalAttackCountAt,
        monthlyMaliciousOutboundCountAt } = require('../metrics/security_log');
const { importantPeriodLogCount, importantPeriodAlarmCount,
        importantPeriodEventCount, importantPeriodDutyCount,
        importantPeriodLabelAt, importantPeriodDefenseRateAt,
        importantPeriodNameAt, importantPeriodRangeAt,
        importantPeriodDailyAverageAt,
        hwEventCount } = require('../metrics/important_period');
const { defaultProtectionRate } = require('../metrics/protection');
const { TOP_SRC_GEO_UNAVAILABLE_TEXT, srcIpGeoLabelAt,
        srcIpGeoAttackCountAt } = require('../metrics/top_src_geo');
const { THREAT_TYPE_UNAVAILABLE_TEXT, threatTypeLabelAt,
        threatTypeAttackCountAt } = require('../metrics/threat_type');
const { DST_IP_UNAVAILABLE_TEXT, dstIpLabelAt,
        dstIpAttackCountAt } = require('../metrics/dst_ip');
const { exposedSurfaceTotal, exposedHighRiskPortCount,
        internetIpAssetCount, internetPortAssetCount } = require('../metrics/exposed');

/**
 * 事件定性那 21 格共用的几句口径（投喂原文：「精确取事件表 sheet 的『GPT定性标签』列，
 * 135 行是最多 7 个，136 行是对应的数量，137 行是比例」）。
 *
 * 拼在每条 desc 里而不是只写一次引用 —— desc 要能**不开代码照着数一遍**（H10），
 * 跳去看别处就等于没写。
 */
const EVENT_RULES = '「事件表」总表中「GPT定性标签」这一列的取值。按行计数，一行一票；'
  + '一行只有一个定性，不拆分、不去重（该列实测是单值，没有顿号之类的多值分隔符）。'
  + '不过滤报告期 —— 事件表导出时已按 --start/--end 取数。'
  + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
  + '该列的空值、以及平台的占位符「-」都不算一种定性、也不进占比分母'
  + '（「-」是 mssw 导出的列级「无」标记：同一张「事件表」里 IOC / 状态说明两列 6033 行'
  + '**全部**是「-」，本列在华能集团样本里也是 2347 行中的 2290 行 —— 算进去的话第 1 名就是个横杠）。';

/** 名次文案：rank 0 是「最多」，其余是「第 N 多」。 */
const eventRankText = (rank) => (rank === 0 ? '最多' : `第 ${rank + 1} 多`);

/** 凑不满这个名次时的补白句（rank 0 永远有值，不用这句）。 */
const eventShortfallText = (rank) => (rank === 0 ? ''
  : `表中不同定性不足 ${rank + 1} 个时，本格写空串；`);

/**
 * 空表句：21 格共用，只有「本格是第几名」不同。
 *
 * 事件表为空（0 行）、或所有行的定性都为空 / 都是占位符时，本格写**空串** ——
 * 没有定性就是没有定性，名次槽位本来就该是空的，与「不同定性不足 N 个」是同一条落法。
 * 这不是缺数：下载一定发生，事件表下不到时 scripts/build_report.py 就拦下了、整份报告不出，
 * 取值层见到的表一定在（0 行是正常数据）。会报错的只剩「表里有行、但没有「GPT定性标签」列」。
 */
const EVENT_MISSING = '事件表为空、或所有行的定性都为空 / 都是占位符时，本格写空串。';

/**
 * 事件定性的一格。
 *
 * @param {string} addr 地址（C..I × 135/136/137）
 * @param {number} rank 名次，从 0 起（列序即名次）
 * @param {'label'|'count'|'share'} kind 这一格取名称 / 数量 / 占比
 */
function eventCell(addr, rank, kind) {
  if (kind === 'count') {
    return {
      addr,
      label: '事件威胁定义数量',
      desc: `「事件表」总表中「GPT定性标签」出现次数${eventRankText(rank)}的那个定性的**出现行数**`
        + `（同一名次，只是取数量不取名称 —— 第 135 行同一列取的是名称）。`
        + EVENT_RULES + eventShortfallText(rank) + EVENT_MISSING,
      compute: (ctx) => gptCountAt(ctx, rank),
      verify: ''
    };
  }
  if (kind === 'share') {
    return {
      addr,
      label: '事件威胁定义占比',
      mode: 'percent',
      desc: `「事件表」总表中出现次数${eventRankText(rank)}的那个「GPT定性标签」的占比`
        + ` = 该定性的出现行数 ÷ 全部定性的出现总次数。`
        + '分母是全量，不是前几名之和，所以第 135 行各名称的占比加起来通常小于 100%。'
        + EVENT_RULES + eventShortfallText(rank) + EVENT_MISSING,
      compute: (ctx) => gptShareAt(ctx, rank),
      verify: ''
    };
  }
  return {
    addr,
    label: '事件威胁定义名称',
    desc: `「事件表」总表中「GPT定性标签」出现次数${eventRankText(rank)}的定性名称。`
      + EVENT_RULES + eventShortfallText(rank) + EVENT_MISSING,
    compute: (ctx) => gptLabelAt(ctx, rank),
    verify: ''
  };
}

/**
 * 21 格的地址在登记表里**逐格字面写**（R14 / R1：一地址一条记录，地址必须能 grep、
 * 能肉眼核对，不靠循环拼）。列序即名次：C = 第 1 名（rank 0）… I = 第 7 名（rank 6）。
 */

// ---------------------------------------------------------------------------
// 安全事件类型 TOP5（C51:C55 分类名 / D51:D55 对应次数）
// ---------------------------------------------------------------------------

/**
 * 事件类型 TOP5 共用的一句口径（用户口径 2026-10-13 的投喂原文见下）。
 *
 * 与事件定性那 21 格的 EVENT_RULES 是**同一套算法换一列**（`GPT定性标签` ->
 * `安全事件二级分类`），所以两句刻意分开写、不硬拼成一个函数：列名不同、消费的格子不同，
 * 哪天其中一处改了判据，另一处不该被顺手改掉。共用的是底层 buildRanking（H4）。
 *
 * 拼在每条 desc 里而不是只写一次引用 —— desc 要能**不开代码照着数一遍**（H10）。
 */
const CATEGORY_RULES = '「事件表」总表中「安全事件二级分类」这一列的取值。按行计数，一行一票；'
  + '一行只有一个分类，不拆分、不去重（该列实测是单值，没有顿号之类的多值分隔符）。'
  + '不过滤报告期 —— 事件表导出时已按 --start/--end 取数。'
  + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
  + '该列的空值、以及平台的占位符「-」都不算一种分类、也不进排序'
  + '（「-」是 mssw 导出的列级「无」标记：同一张「事件表」里 IOC / 状态说明两列 6033 行'
  + '**全部**是「-」，算进去的话第 1 名就是个横杠）。'
  + '⚠️ 与 D7/D8/D9、D11、D16 读的**是同一列、却不是同一把尺子**：那几格按'
  + '「分类里包含 弱口令 / 弱密码 / 账号安全」数命中行数（子串判定），本块是整格取值后'
  + '按频次排行 —— `Telnet弱口令` 与 `Web弱口令` 在这里是**两个**不同的分类各占一项，'
  + '在那边都只算「弱口令」那一段的命中行。';

/** 名次文案：rank 0 是「最多」，其余是「第 N 多」。 */
const categoryRankText = (rank) => (rank === 0 ? '最多' : `第 ${rank + 1} 多`);

/** 凑不满这个名次时的补白句（rank 0 永远有值，不用这句）。 */
const categoryShortfallText = (rank) => (rank === 0 ? ''
  : `表中不同分类不足 ${rank + 1} 个时，本格写空串；`);

/**
 * 空值句：10 格共用 —— 整块只有 5 个名次槽位，第 1 名缺席就是「一个都没有」。
 *
 * 事件表为空（0 行）、或所有行的分类都为空 / 都是占位符时，本块**一格都不写值**：
 * 用户口径 2026-10-13「一个都没有为空」。这不是缺数：下载一定发生，事件表下不到时
 * scripts/build_report.py 就拦下了、整份报告不出，取值层见到的表一定在（0 行是正常数据）。
 * 会报错的只剩「表里有行、但没有「安全事件二级分类」列」。
 */
const CATEGORY_MISSING = '事件表为空、或所有行的分类都为空 / 都是占位符时，本格写空串'
  + '（用户口径 2026-10-13「一个都没有为空」）—— 5 个名次槽位本来就该是空的。'
  + '⚠️ 本块的**数量列 D51:D55 也跟着写空串**，不写 0：分类都没有，就没有"对应的次数"'
  + '可言，`0` 会被读成"这个分类出现过 0 次"，那是另一句话。';

/**
 * 事件类型 TOP5 的一格。
 *
 * 地址在登记表里逐格字面写（R14 / R1），行序即名次：
 * C51 = 第 1 名（rank 0）… C55 = 第 5 名（rank 4），数量列 D51:D55 与之一一对应。
 * 「最多 5 个、有几个取几个」就是这套槽位：表里只有 3 种分类时，第 4/5 名写空串。
 *
 * @param {string} addr 地址（C/D × 51..55）
 * @param {number} rank 名次，从 0 起
 * @param {'label'|'count'} kind 这一格取分类名 / 对应次数
 */
function categoryCell(addr, rank, kind) {
  if (kind === 'count') {
    return {
      addr,
      label: '安全事件类型TOP5',
      desc: `「事件表」总表中「安全事件二级分类」出现次数${categoryRankText(rank)}的那个分类的`
        + `**出现行数**（用户口径 2026-10-13：「D51:D55 就是对应的类型的次数」——`
        + `与 C 列同一行的那一格是**同一个名次**，只是取数量不取名称）。`
        + CATEGORY_RULES + categoryShortfallText(rank) + CATEGORY_MISSING,
      compute: (ctx) => categoryCountAt(ctx, rank),
      verify: ''
    };
  }
  return {
    addr,
    label: '安全事件类型TOP5',
    desc: `「事件表」总表中「安全事件二级分类」出现次数${categoryRankText(rank)}的分类名称`
      + '（用户口径 2026-10-13：「C 列是精确查找事件表『安全事件二级分类』列，统计每个非空值的'
      + '分类出现的次数，按照大到小排列，从 C51 到 C55 填这个分类的类别，最多取 5 个，'
      + '有几个取几个。一个都没有为空」）。'
      + CATEGORY_RULES + categoryShortfallText(rank) + CATEGORY_MISSING,
    compute: (ctx) => categoryLabelAt(ctx, rank),
    verify: ''
  };
}

/**
 * C58:N59 那 24 格的共用口径（用户口径 2026-10-14）。
 *
 * 抽成常量再拼进每格 desc：24 格是同一件事的 12 个槽位 × 2 行，逐格重抄一遍口径
 * 既容易抄漏也容易抄歪 —— 与 CATEGORY_RULES / THREAT_ALARM_RULES 同一写法。
 * 但它**仍然写进每一格的 desc**（不是"见某格"）：照着一格就能把数数出来（H10）。
 */
const MONTH_RULES =
  '口径：① **月份桶**由报告期（CLI 的 --start/--end）切出来 —— 含首尾两端所在的那两个月、'
  + '中间一个月不落、连续升序；超过 12 个月时取**最晚的 12 个**（用户口径 2026-10-14）。'
  + '桶只由报告期决定，与表里有没有那个月的数据无关。'
  + '② **分桶**按预处理追加的「事件创建月份」列整格相等 —— 那一列是「事件创建时间」'
  + '取年月写成的 `2026-07` 形态**文本**（由 scripts/report_preprocess.py 的 '
  + '`append_month_column` 在下载之后、解析之前追加），落在哪个月就计进那个月。'
  + '⚠️ 那一列只在下载件里给取值层用，报告「事件表」sheet 上会被'
  + ' scripts/build_report.py 剔掉（用户口径 2026-10-14）。'
  + '③ **均值**= 该月全部行的「响应时长」的**非空值平均**（分钟；空的行退出分母、不整行连坐），'
  + '均值不再二次舍入。某个月一行都没有、或那些行的响应时长全空 -> 写 **0**'
  + '（用户口径 2026-10-14「写 0」；与 G7/G9/D35/D36/E49/G51:G55 同一条落法）。'
  + '⚠️ 「事件创建月份」为空 / 认不出的行、以及落在报告期之外的月份，**不落进任何桶**'
  + '（用户口径：「『事件创建时间』不可能为空」—— 真为空时它自然落不进桶，'
  + '不是把它算进某个月）。'
  + '④ **槽位**：C58..N58 与 C59..N59 各 12 个，从左到右对应上面那份桶清单的第 1..12 个。'
  + '报告期不足 12 个月时，多出来的槽位**标签与值都留空**（用户口径 2026-10-14）——'
  + '那与「桶内没有样本写 0」是两件事：前者是"这个槽位根本没有对应的月份"。';

/** 上面那条口径的缺列尾巴 —— 与 G7/G9 同一档（缺列不静默，R10）。 */
const MONTH_MISSING =
  ' 缺列 -> 本格不写值 + 记错误，按顺序查两列：「事件创建月份」->「响应时长」'
  + '（前者缺席 = 预处理那一步没算出月份，多半是「事件创建时间」这一列平台改了名）。'
  + '⚠️ 事件表**一行都没有**时**不算缺列**：报告期里那几个月确实没有事件，'
  + '范围内每个槽位都写 0、越界槽位留空，一格错误都不记（空表是结论，不是缺数）。';

/**
 * C58:N59 的一格 —— 「按月平均响应时长」的第 index 个槽位。
 *
 * 用户口径 2026-10-14：58 行 = 月份标签（`2026-07` 形态）、59 行 = 对应均值。
 * 两个 kind 共用同一个量（buildMonthSeries，H4）：取值层只切一次桶、求一次均值，
 * 24 格各自从这个序列里取自己那一格。
 *
 * 地址在登记表里逐格字面写（R14 / R1）：C58..N58 与 C59..N59 逐格调用，
 * 不写成循环拼地址 —— 地址必须可 grep（与 categoryCell 同一条理由）。
 *
 * @param {string} addr 地址（列 × 58 / 59）
 * @param {number} index 槽位，从 0 起（0 = 桶清单里最早的那个月）
 * @param {'label'|'mean'} kind 这一格取月份标签 / 对应均值
 */
function monthCell(addr, index, kind) {
  const ordinal = index + 1;
  if (kind === 'mean') {
    return {
      addr,
      label: '平均响应时长 · 第' + ordinal + '列',
      desc: `第 ${ordinal} 个月份桶的**平均响应时长**（分钟）—— 「事件表」里落在报告期`
        + `第 ${ordinal} 个月的那些行，其「响应时长」列的非空平均值`
        + '（用户口径 2026-10-14：「按传入时间起止划分月份，然后统计事件表『事件创建时间』列，'
        + '如果在对应的月份，就统计他的『响应时长』列的非空平均值」「59 行 = 均值」）。'
        + MONTH_RULES + MONTH_MISSING,
      compute: (ctx) => monthMeanAt(buildMonthSeries(ctx), index),
      verify: ''
    };
  }
  return {
    addr,
    label: '月份 · 第' + ordinal + '列',
    desc: `第 ${ordinal} 个月份桶的**月份标签**（「2026-07」形态，用户口径 2026-10-14：`
      + '「月份标签写 2026-07」「58 行 = 月份标签」）。标签与下面 C59 行的均值'
      + '**一一对应**：同一列的两格说的是同一个月。'
      + MONTH_RULES
      + ' ⚠️ 本格落的是**文本**不是日期型 —— 取值层拿它当桶键做字符串相等比较，'
      + '落成日期型会被 Excel 还原成日期、读回来就不是同一个东西了。'
      + MONTH_MISSING,
    compute: (ctx) => monthLabelAt(buildMonthSeries(ctx), index),
    verify: ''
  };
}

/**
 * C71:N72「威胁运营趋势 / 外部攻击数」那 24 格的共用口径（用户口径 2026-10-20）。
 *
 * 与 MONTH_RULES 同一写法：24 格是同一件事的 12 个槽位 × 2 行，逐格重抄只容易抄歪，
 * 但仍然**写进每一格的 desc**（不写"见某格"）：照着一格就能把数数出来（H10）。
 */
const MONTHLY_ATTACK_RULES =
  '口径（用户口径 2026-10-20：「按照输入的时间范围划分出月份，按照月份调用多次 D61 的接口条件，'
  + '然后把 2026-01 这种格式写在 C71:N71，72 行写对应的查到的值，最多 12 个月，月份不足就留空，'
  + '首尾月要限定在输入的时间范围里」）：'
  + '① **月份桶**由报告期（CLI 的 --start/--end）切出来 —— 含首尾两端所在的那两个月、'
  + '中间一个月不落、连续升序；超过 12 个月时取**最晚的 12 个**。桶只由报告期决定，'
  + '与平台在那个月有没有日志无关。'
  + '② **每个桶各调一次 D61 那条接口**：日志量端点、只问**网络安全日志一张表**、'
  + '`searchString` = `filter srcIpTag=0 AND dstIpTag=1`（外→内，与 D61 逐字相同），取 `data.total`。'
  + '**首尾月的时间范围裁到报告期**：报告期从 2026-01-15 起时 2026-01 那段问的是 01-15 ~ 01-31；'
  + '报告期到 2026-03-10 止时 2026-03 那段问的是 03-01 ~ 03-10；中间各月是整月。'
  + '③ **槽位**：C71..N71 与 C72..N72 各 12 个，从左到右对应上面那份桶清单的第 1..12 个。'
  + '报告期不足 12 个月时，多出来的槽位**标签与值都留空** —— 那是"这个槽位根本没有对应的月份"，'
  + '与"那个月接口答了 0"、"那个月接口不通"都不是一回事。'
  + '⚠️ 与 D61「外部攻击日志数量」是**同一个接口、两个不同的问题**：D61 问报告期整段、落一个总数；'
  + '本块把报告期切成月逐月问，**不拿 D61 的数去均摊、也不拿各月之和回填 D61**。'
  + '⚠️ 报告期一变，整行的标签与值一起变 —— 标签是谁由报告期决定，不是按"表里有数据的月份"排。';

/** 上面那条口径的落值边界 —— 与接口类数据源同一条（"不通"与"0"分得开，长期口径）。 */
const MONTHLY_ATTACK_MISSING =
  ' 落值：那个月接口**答了** -> 写它报的条数（0 也是结论："那个月一条外部攻击日志都没有"）；'
  + '那个月接口**不通** -> 本格写「接口不通无值」（各月各自独立地断，一个月的失败不牵连另外几个月）；'
  + '槽位越界（报告期不足 12 个月）-> 写**空串**，不写 0。'
  + '⚠️ 报告期本身取不到合法日期 / 起止倒置时取值层直接抛错（本块一格都不写）——'
  + '那是参数错，与接口不通不是一回事。';

/**
 * C71:N72 的一格 —— 「外部攻击数（按月）」的第 index 个槽位。
 *
 * 用户口径 2026-10-20：71 行 = 月份标签（`2026-01` 形态）、72 行 = 对应条数。
 * 两个 kind 共用同一条月份轴（`monthRange` / `monthPeriods`，H4）：逐月调接口那一步在
 * 下载层按 `monthPeriods` 走一遍，取值层只按槽位取，不重算月份。
 *
 * @param {string} addr 地址（列 × 71 / 72）
 * @param {number} index 槽位，从 0 起（0 = 桶清单里最早的那个月）
 * @param {'label'|'count'} kind 这一格取月份标签 / 对应条数
 */
function monthlyAttackCell(addr, index, kind) {
  const ordinal = index + 1;
  if (kind === 'count') {
    return {
      addr,
      label: '外部攻击数 · 第' + ordinal + '列',
      desc: `第 ${ordinal} 个月份桶的**外部攻击日志条数**（网络安全日志里「外→内」的 data.total，`
        + '按该月的日期范围问 D61 那条接口；用户口径 2026-10-20「72 行写对应的查到的值」）。'
        + MONTHLY_ATTACK_RULES + MONTHLY_ATTACK_MISSING
        + ' ⚠️ 本格落的是**原始条数**：模板给这一行的数字格式是 `0.0,"万"`（显示时除以 1000、'
        + '带「万」字），格式只在显示层生效，不要为了"好看"先把数除一遍。',
      compute: (ctx) => monthlyExternalAttackCountAt(ctx, index),
      verify: ''
    };
  }
  return {
    addr,
    label: '威胁运营趋势---XDR平台获取 · 第' + ordinal + '列',
    desc: `第 ${ordinal} 个月份桶的**月份标签**（「2026-01」形态，用户口径 2026-10-20：`
      + '「把 2026-01 这种格式写在 C71:N71」）。标签与下面 C72 行的条数**一一对应**：'
      + '同一列的两格说的是同一个月。'
      + MONTHLY_ATTACK_RULES
      + ' ⚠️ 本格落的是**文本**不是日期型（模板这几格带 `mm-dd-yy` 格式，落成日期会被 Excel'
      + ' 显示成 01-26 那种样子、读回来也不是同一个字符串）—— 与 C58:N58 的月份标签同一落法。'
      + MONTHLY_ATTACK_MISSING,
    compute: (ctx) => monthlyExternalAttackLabelAt(ctx, index),
    verify: ''
  };
}

/**
 * C73:N73「威胁运营趋势 / 恶意外联数」那 12 格的共用口径（用户口径 2026-10-20）。
 *
 * 与 `MONTHLY_ATTACK_RULES` 是**同一条月份轴、同一套逐月问法**，差别只在过滤串方向
 * （外→内 换成 内→外）；所以这份 desc 只写"哪里不同"，月份桶与槽位规则照抄过来
 * （照着一格就能把数数出来，H10 —— 不写"见 C71"）。
 */
const MONTHLY_OUTBOUND_RULES =
  '口径（用户口径 2026-10-20：「C73:N73是每个月的恶意外联数，一样切分月份，拿日志接口，'
  + '请求体条件是 srcIpTag=1 AND dstIpTag=0」）：'
  + '① **月份桶**与 C71:N72 共用同一条（报告期切月、含首尾两端所在的两个月、连续升序、'
  + '超过 12 个月取最晚的 12 个；**首尾月裁到报告期**）。本行**没有自己的标签行** —— '
  + '月份标签就是 C71:N71 那一行，同一列的 C71 与 C73 说的是同一个月。'
  + '② **每个桶各调一次日志量接口**：只问**网络安全日志一张表**，'
  + '`searchString` = `filter srcIpTag=1 AND dstIpTag=0`（内→外），取 `data.total`。'
  + '⚠️ 与 D23「已拦截外联次数」**不是同一条口径**：D23 的抓包串还带 `action = 2`（只要已拦截的），'
  + '本条条件里没有那一条 —— 数的是**全部**内→外日志，含已拦截与未拦截。'
  + '③ **槽位**：C73..N73 共 12 个，从左到右对应月份桶清单的第 1..12 个；'
  + '报告期不足 12 个月时多出来的槽位**写空串**（那个槽位没有对应的月份）。'
  + '⚠️ 报告期一变，这一行的值与 C71:N71 的标签一起变。';

/** 上面那条口径的落值边界 —— 与 MONTHLY_ATTACK_MISSING 逐字同一套（"不通"与"0"分得开）。 */
const MONTHLY_OUTBOUND_MISSING =
  ' 落值：那个月接口**答了** -> 写它报的条数（0 也是结论："那个月一条内→外日志都没有"）；'
  + '那个月接口**不通** -> 本格写「接口不通无值」（各月各自独立地断，一个月的失败不牵连另外几个月）；'
  + '槽位越界（报告期不足 12 个月）-> 写**空串**，不写 0。'
  + '⚠️ 报告期本身取不到合法日期 / 起止倒置时取值层直接抛错（本块一格都不写）——'
  + '那是参数错，与接口不通不是一回事。';

/**
 * C73:N73 的一格 —— 「恶意外联数（按月）」的第 index 个槽位。
 *
 * 月份轴不在这里算：与 C71:N72 共用 `monthRange` / `monthPeriods`（H4），
 * 下载层按 `monthPeriods` 逐月问 `fetchMsswMonthlyMaliciousOutboundLogCounts`，
 * 取值层只按槽位取。
 *
 * @param {string} addr 地址（列 × 73）
 * @param {number} index 槽位，从 0 起（0 = 桶清单里最早的那个月）
 */
function monthlyOutboundCell(addr, index) {
  const ordinal = index + 1;
  return {
    addr,
    label: '恶意外联数 · 第' + ordinal + '列',
    desc: `第 ${ordinal} 个月份桶的**内→外日志条数**（网络安全日志里「内→外」的 data.total；`
      + '用户口径 2026-10-20「每个月的恶意外联数」）。'
      + MONTHLY_OUTBOUND_RULES + MONTHLY_OUTBOUND_MISSING
      + ' ⚠️ 本格落的是**原始条数**：模板给这一行的数字格式是 `0.0,"万"`（显示时除以 1000、'
      + '带「万」字），格式只在显示层生效，不要为了"好看"先把数除一遍。',
    compute: (ctx) => monthlyMaliciousOutboundCountAt(ctx, index),
    verify: ''
  };
}

/**
 * C75:N75「威胁运营趋势 / 告警数」那 12 格的共用口径（用户口径 2026-10-20）。
 *
 * 与上面两组**同一条月份轴**（标签仍是 C71:N71），但数据源换成了**告警表**：
 * 按「最早发生时间」的日期落桶数行，不调接口。
 */
const MONTHLY_ALARM_RULES =
  '口径（用户口径 2026-10-20：「C75:N75是每个月的告警数：按照告警表精确查找『最早发生时间』列，'
  + '也是按照月份划分。看这些告警在每个月时间范围内的个数」）：'
  + '① **月份桶**与 C71:N72 / C73:N73 共用同一条（报告期切月、含首尾两端所在的两个月、'
  + '连续升序、超过 12 个月取最晚的 12 个；**首尾月裁到报告期**）。本行**没有自己的标签行** —— '
  + '月份标签就是 C71:N71 那一行。'
  + '② **判据**是告警表「最早发生时间」列（表头**整名相等**），这列是文本'
  + '（如 `2026-09-30 20:56:18`），先归一成 `YYYY-MM-DD` 再按**日期**与每个桶的'
  + '`[起, 止]`（两端闭区间）比较 —— 时刻不影响归属，报告期之外的日期不进任何桶。'
  + '**一行一票**、不去重、不按告警 ID / 主机IP 合并，也不看别的列。'
  + '③ **槽位**：C75..N75 共 12 个，从左到右对应月份桶清单的第 1..12 个；'
  + '报告期不足 12 个月时多出来的槽位**写空串**（那个槽位没有对应的月份）。';

/** 上面那条口径的落值边界 —— 表格格与接口格不同：没有"接口不通"这一档。 */
const MONTHLY_ALARM_MISSING =
  ' 落值：告警表**有行** -> 写该月的行数（0 也是结论："那个月一条告警都没有"）；'
  + '告警表**空**（0 行）-> 每个月都写 0（不检查列 —— 空表本来就没有可读的时间）；'
  + '该列**整根不在**（平台改列名）-> 本块**不写值、各格记错误**（与 D28 同一条缺列防线）；'
  + '该列在、也有非空值、但一个都解析不出日期 -> 当场抛错（不能静默数出 0）。'
  + '⚠️ 这不是接口数据源，**没有「接口不通无值」这一档**。';

/**
 * C75:N75 的一格 —— 「告警数（按月）」的第 index 个槽位。
 *
 * 月份轴不在这里算：与 C71:N72 / C73:N73 共用 `monthPeriods`（H4），
 * 取值层只按槽位取。
 *
 * @param {string} addr 地址（列 × 75）
 * @param {number} index 槽位，从 0 起（0 = 桶清单里最早的那个月）
 */
function monthlyAlarmCell(addr, index) {
  const ordinal = index + 1;
  return {
    addr,
    label: '告警数 · 第' + ordinal + '列',
    desc: `第 ${ordinal} 个月份桶内的**告警行数**（告警表「最早发生时间」的日期落在该桶内，`
      + '用户口径 2026-10-20「看这些告警在每个月时间范围内的个数」）。'
      + MONTHLY_ALARM_RULES + MONTHLY_ALARM_MISSING
      + ' ⚠️ 本格落的是**原始行数**：模板给 C75:N75 的数字格式是 General（没有 72–74 行那种'
      + ' `0.0,"万"` 显示格式），不要为了对齐上面几行先把数除一遍。',
    compute: (ctx) => monthlyAlarmCountAt(ctx, index),
    verify: ''
  };
}

/**
 * C86:N88「漏洞趋势 / 剩余漏洞数量 / 已闭环漏洞数」那 36 格的共用口径
 * （用户口径 2026-10-23）。
 *
 * 与上面三组按月格（C71:N72 / C73:N73 / C75:N75）**同一条月份轴**，数据源换成漏洞表：
 * 86 行 = 月份标签、87 行 = 每个月的漏洞数、88 行 = 其中「处置状态」含「处置完成」的数。
 */
const MONTHLY_VULN_RULES =
  '口径（用户口径 2026-10-23：「C86：N88 是漏洞趋势和剩余漏洞数量，86 行是按照输入的事件范围'
  + '按月划分，得到的对应的月份，如 2026-06。87 行是两张漏洞表精确查找『首次发现时间』列……'
  + '每个漏洞对应的时间划分到对应的月份，就加一……最多取 12 个月，少于 12 个月就后面的留空，'
  + '多于 12 个月就取最近的 12 个月。88 行是每个月已闭环漏洞数，精确查找两个漏洞表的'
  + '『处置状态』列，如果值包含『处置完成』，就算命中，然后看他们的『首次发现时间』'
  + '所在的月份然后加一」）：'
  + '① **月份桶**与 C58:N59 / C71:N72 / C75:N75 共用同一条（报告期切月、含首尾两端所在的两个月、'
  + '连续升序、超过 12 个月取最晚的 12 个；**首尾月裁到报告期**）。标签是 `2026-06` 形态的文本。'
  + '② **数据源**是**漏洞表全表** = 「内网漏洞表」+「互联网漏洞表」两张 sheet 拼起来的行数组。'
  + '判据列是「发现时间\n（填充此单元格为粉红色代表最近扫描新增漏洞）」（2026-10-29 前叫'
  + '「首次发现时间」，表头**整名相等**；同一张表还有「最近发现时间」，不会误撞），'
  + '这列是日期文本，先归一成 `YYYY-MM-DD` 再按**日期**与每个桶的 `[起, 止]`'
  + '（两端闭区间）比较 —— 时刻不影响归属，报告期之外的日期不进任何桶。'
  + '**一行一票**、不去重、不按资产 / 漏洞名称合并。'
  + '③ **槽位**：C86..N86 是月份标签、C87..N87 是每个月的漏洞数、C88..N88 是其中已闭环的数；'
  + '同一列的三个格说的是同一个月。报告期不足 12 个月时多出来的槽位**标签与值都留空**'
  + '（那个槽位没有对应的月份，与"那个月 0 条"、"那个月缺列"都不是一回事）。';

/** 上面那条口径的落值边界 —— 表格格与接口格不同：没有"接口不通"这一档。 */
const MONTHLY_VULN_MISSING =
  ' 落值：漏洞表**有行** -> 写该月的行数（0 也是结论："那个月一条漏洞都没有"）；'
  + '漏洞表**空**（0 行）-> 每个月都写 0（不检查列 —— 空表本来就没有可读的时间）；'
  + '「发现时间（…）」或「处置状态」**整根不在**（平台改列名）-> 本块**不写值、各格记错误**；'
  + '时间列在、也有非空值、但一个都解析不出日期 -> 当场抛错（不能静默数出 0）。'
  + '⚠️ 这不是接口数据源，**没有「接口不通无值」这一档**。';

/**
 * C86:N88 的一格。
 *
 * 月份轴不在这里算：与上面几组共用 `monthPeriods`（H4），取值层只按槽位取。
 *
 * @param {string} addr 地址（列 × 86 / 87 / 88）
 * @param {number} index 槽位，从 0 起（0 = 桶清单里最早的那个月）
 * @param {'label'|'count'|'closed'} kind 这一格取月份标签 / 漏洞数 / 已闭环数
 */
function monthlyVulnCell(addr, index, kind) {
  const ordinal = index + 1;
  const tail = ' ⚠️ 本块只在 `ctx.vulnRows` 上数（内网 + 互联网两份拼起来的全表），'
    + '不按「威胁标签」「修复优先级」等别的列收窄。';

  if (kind === 'count') {
    return {
      addr,
      label: '剩余漏洞数量 · 第' + ordinal + '列',
      desc: `第 ${ordinal} 个月份桶内的**漏洞行数** —— 「首次发现时间」的日期落在该桶内的`
        + '漏洞一行算一条（用户口径 2026-10-23「每个漏洞对应的时间划分到对应的月份，就加一」）。'
        + MONTHLY_VULN_RULES + MONTHLY_VULN_MISSING + tail,
      compute: (ctx) => monthlyVulnCountAt(ctx, index),
      verify: ''
    };
  }

  if (kind === 'closed') {
    return {
      addr,
      label: '已闭环漏洞数 · 第' + ordinal + '列',
      desc: `第 ${ordinal} 个月份桶内的**已闭环漏洞行数** —— 在 87 行同一批（「首次发现时间」`
        + '日期落在该桶内）的漏洞里，再看「处置状态」列：**包含**「处置完成」就算命中'
        + '（includes，与 D80 / E83 同一判据：`处置完成（已修复）/（已缓解）/（接受风险）/'
        + '（忽略）` 与裸「处置完成」都算，`待处置` / `处置中` 不算），'
        + '然后按**它自己的「首次发现时间」所在月份** +1，不是按处置时间分桶'
        + '（用户口径 2026-10-23「看他们的『首次发现时间』所在的月份然后加一」）。'
        + '所以本行每个月都不大于同列 87 行的数。'
        + MONTHLY_VULN_RULES + MONTHLY_VULN_MISSING + tail,
      compute: (ctx) => monthlyClosedVulnCountAt(ctx, index),
      verify: ''
    };
  }

  return {
    addr,
    label: '漏洞趋势 · 第' + ordinal + '列',
    desc: `第 ${ordinal} 个月份桶的**月份标签**（「2026-06」形态，用户口径 2026-10-23：`
      + '「86 行是按照输入的事件范围按月划分，得到的对应的月份，如 2026-06」）。'
      + '标签与同列 87 行（漏洞数）、88 行（已闭环数）**一一对应**：同一列的三格说的是同一个月。'
      + MONTHLY_VULN_RULES + MONTHLY_VULN_MISSING
      + ' ⚠️ 本格落的是**文本**不是日期型（模板这几格带日期格式，落成日期会被 Excel'
      + ' 显示成别的样子、读回来也不是同一个字符串）—— 与 C58:N58 / C71:N71 同一落法。',
    compute: (ctx) => monthlyVulnLabelAt(ctx, index),
    verify: ''
  };
}

/**
 * 三格口径的共用句：G6/H6/I6 是同一件事的三个槽位（系统 1 / 2 / 3），只有系统名与
 * 槽位号不同，所以三段文字拼一份、逐格复用 —— 与 eventCell 同一写法。
 * 三段都要能**不开代码照着数一遍**（H10），所以不写成"见别处"。
 */
const THREAT_ALARM_RULES = {
  // 第一步：系统名 -> 该系统名下的资产 IP 集合
  ips: '第一步「资产表 -> IP 集合」：取「资产表」总表中「所属业务」整格**子串包含**该系统名'
    + '（大小写与首尾空白不敏感、不做分词，所以传「oa」也会命中「OA系统1」）的那些行，'
    + '把它们的「IP地址」汇成一个集合；IP 两侧都剥掉尾部的括号说明'
    + '（平台实测会给出 `33.33.35.57(未归类组)` 这种形态）。'
    + '「所属业务」为空的行不属于任何业务系统，跳过；命中业务但没写 IP 的资产也跳过。',
  // 第二步：IP 集合 -> 告警行数
  alarms: '第二步「IP 集合 -> 告警行数」：在「告警表」总表里，'
    + '先取「GPT研判结论」**整格精确等于**「真实攻击未成功」的告警行'
    + '（比较前只去首尾空白；「真实攻击成功」「等待GPT研判」、占位符「-」都不算命中），'
    + '再看这些行的「主机IP」是否落在上面那个集合里（同样剥括号说明），'
    + '落在集合里的行计数 —— 按行计数、一行一票，不去重、不按告警 ID 合并。'
};

/**
 * 边界句：三格共用，只有「本格是第几个系统」不同。
 *
 * 有两种"读不到列"，落法**不同**（用户口径 2026-10-19）：
 *   · 告警表里有行、却没有「GPT研判结论」列 —— 有些客户的告警表本来就没有这一列，
 *     本格写 `GPT_VERDICT_MISSING_TEXT` 那句结论文字（与 G5 一样），**不记错误、不填 0**；
 *   · 资产表缺「所属业务」/「IP地址」、或告警表缺「主机IP」—— 记入错误列表、不写值
 *     （平台改了列名，静默按 0 算等于拿一份没读到的数据当没有）。
 * 表为空（0 行）**不在内**：那是「这段时间确实没有」-> 写 0。
 * **槽位没给系统也不在内**（用户口径 2026-10-12：--business-systems 是可选的，
 * 没给够不是错）—— 第 N 个系统没传时本格写 0。
 */
const threatAlarmMissingText = (rank) => '告警表里有行、却没有「GPT研判结论」列时，'
  + `本格写「${GPT_VERDICT_MISSING_TEXT}」（用户口径 2026-10-19：有些客户的告警表本来`
  + '就没有这一列 —— 这是结论，不是缺数，不记错误、也不填 0）。'
  + '会记入错误列表的只剩：资产表缺「所属业务」/「IP地址」列，或告警表缺「主机IP」列'
  + '（平台改了列名）—— 这时本格不写值（不填 0）。'
  + `⚠️ 第 ${rank + 1} 个系统没传（--business-systems 少传或一个都没传）**不在此列**：`
  + '本格写 0（用户口径 2026-10-12，--business-systems 本来就是可选参数）。';

/**
 * 核心系统威胁告警数量的一格（G6/H6/I6）。
 *
 * @param {string} addr 地址
 * @param {number} rank 槽位，从 0 起（G6 = 第 1 个系统、H6 = 第 2 个、I6 = 第 3 个，
 *   与 D3/D4/D5 的系统名槽位一一对应）
 * @param {string} label 模板里这一格的中文含义（三格措辞略有不同，逐格取模板原文）
 */
function threatAlarmCell(addr, rank, label) {
  return {
    addr,
    label,
    desc: `第 ${rank + 1} 个核心业务系统（系统名取 CLI 的 --business-systems 第 ${rank + 1} 个，`
      + `与 D${rank + 3} 同一槽位）上的威胁告警**行数**。`
      + THREAT_ALARM_RULES.ips + THREAT_ALARM_RULES.alarms
      + '该系统名下一条这样的告警都没有时本格写 0（0 是结论，不是缺数）；'
      + '资产表为空（这个系统名下没有资产）、或告警表为空时同样是 0。'
      + `**--business-systems 没给到第 ${rank + 1} 个时也写 0**（用户口径 2026-10-12：`
      + '它是可选参数，槽位空着就是没有这个系统，这个数就是 0）。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内，本仓取值层不叠加第二道时间过滤。'
      + threatAlarmMissingText(rank),
    compute: (ctx) => coreSystemThreatAlarmTotalAt(ctx, rank),
    verify: ''
  };
}

/**
 * 组件（设备）块 4 格共用的口径（投喂原文：「D100 标签是 SIP 数量、D101 标签是 AF 数量、
 * D102 是 STA 数量、D104 是 EDR 数量」，接口参考 C:\Users\User\Desktop\health-checkup-report）。
 *
 * 拼在每条 desc 里而不是只写一次引用 —— desc 要能**不开代码照着数一遍**（H10），
 * 跳去看别处就等于没写。
 */
const DEVICE_RULES = '数据来自**设备列表接口**'
  + '（POST /api/apex/device/v1/devices/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false，'
  + '请求体 devStatus [1,2,3,4] 四档全要、pageSize 1000 全量翻页），'
  + '**不是六份总表里的任何一份** —— 它没有下载件、没有 parse 环节、报告里也没有对应的 sheet。'
  + '按**设备行数**计数：一行一台设备，一台一票；不按 IP / 设备名 / 设备 ID 去重'
  + '（同一条设备在接口里出现两次就是 2）。'
  + '不过滤报告期 —— 设备台账报的是**当前的接入情况**，接口不带时间参数，与 --start/--end 无关'
  + '（与资产表那几格同一条：台账类数据本仓不另加时间条件）。'
  + '也不叠加第二位过滤：设备状态范围由**请求体**定死（devStatus 四档全要），'
  + '取值层不对 devStatus / isDelete 再做一次筛选 —— 请求就是那一道筛。'
  + '与 --business-systems 无关：问的是"一共接进来几台某型设备"，'
  + '不是"某个业务系统名下有几台"，所以不拿 D3/D4/D5 过滤、也不做子串匹配。';

/**
 * 4 格的边界句：只有一种真异常，其余落到 0、落到"接口不通无值"、或落到"这台设备算哪一格"。
 */
const DEVICE_MISSING = '边界：一台这种设备都没有（接口返回 0 台 -> 取值层收到的是空数组）'
  + '时本格写 **0**（0 是结论 —— 那正是"这个客户没接这种设备"，不是缺数）；'
  + '**设备列表接口调不通**时本格写「**接口不通无值**」'
  + '（长期口径，用户口径 2026-10-13：接口不通**不拦整份报告**，这一格就写这六个字 —— '
  + '不是 0（0 是"接口答了、一台都没有"那个结论），也不是不写值。'
  + '下载层把失败收成"读不到"那一档交给取值层，真实原因在运行日志里）；'
  + '接口有设备行、却没有任何一行带 `devType` 字段（平台改了字段名）-> 不写值 + 记错误'
  + '（禁止静默数出 0）。'
  + '不属于这四个代号集合的设备（AC、云镜、aTrust、第三方设备…）这 4 格一个都不算 ——'
  + '同一个块里的「第三方」两行是**另一条口径**：D103 已于 2026-10-13 接通'
  + '（走第三方设备列表接口、取它报的总数，见下面那条登记），D106 仍未接。';

/**
 * 第三方（D103）那一条的口径（用户口径 2026-10-13：「D103 是第三方数量」，
 * 实现参考 C:\Users\User\Desktop\health-checkup-report，复用它的取法）。
 *
 * 拼在 desc 里而不是只写一次引用 —— desc 要能**不开代码照着数一遍**（H10）。
 */
const THIRD_PARTY_RULES = '数据来自**第三方设备列表接口**'
  + '（POST /api/apex/thirdparty/v1/app/instance/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false），'
  + '取接口报的 **`data.count`**（第三方应用实例总数）—— **不翻页、不按行重算**'
  + '（参考实现 health-checkup-report 的 collectMsswDeviceCategoryCounts 就是这么取的）。'
  + '⚠️ 它与同一个块里的 D100/D101/D102/D104 **不是同一把尺子**：'
  + '那 4 格数的是**深信服设备列表**里 `devType` 命中各代号集合的**行数**，'
  + '本格读的是**另一个接口**报的**第三方（非深信服）**应用实例台账 ——'
  + '两个集合互不相交（第三方实例根本不在深信服设备列表里），也不相加。'
  + '不过滤报告期 —— 第三方台账报的是**当前的接入情况**，接口不带时间参数，'
  + '与 --start/--end 无关。与 --business-systems 无关：问的是"一共接进来多少个第三方实例"，'
  + '不是"某个业务系统名下有几个"。';

/**
 * D103 的边界句：真异常只有一类，其余落到 0 或落到「接口不通无值」。
 */
const THIRD_PARTY_MISSING = '边界：接口答了、一个第三方实例都没有时本格写 **0**'
  + '（0 是结论 —— 那正是"这个客户没接第三方"，不是缺数）；'
  + '**接口调不通**时本格写「**接口不通无值**」'
  + '（长期口径，用户口径 2026-10-13：接口不通**不拦整份报告**，这一格就写这六个字 —— '
  + '不是 0（0 是"接口答了、一个都没有"那个结论），也不是不写值。'
  + '下载层把失败收成"读不到"那一档交给取值层，真实原因在运行日志里）；'
  + '接口**没给 `data.count`**（或给的不是数字）-> 不写值 + 记错误（禁止静默当 0）。';

/**
 * 组件块的一格（D100/D101/D102/D104）。
 *
 * 4 格只差一个 devType 代号集合与对应的中文名，过滤条件只写在
 * stats/metrics/device.js 的 deviceCountByType 一处（H4）。
 *
 * @param {string} addr 地址
 * @param {string} label 模板里这一格的中文含义（用户投喂的标签）
 * @param {number[]} deviceTypes 这一格认的 devType 代号集合
 * @param {string} typeText 代号在 desc 里的读法（逐格不同，见各格的调用）
 */
function deviceCell(addr, label, deviceTypes, typeText) {
  return {
    addr,
    label,
    desc: `设备列表接口里 \`devType\` 属于 ${typeText} 的**设备台数**。`
      + DEVICE_RULES
      + '四个代号集合（SIP / AF / STA / EDR 家族）**互不相交**，'
      + '所以同一台设备不会在这 4 格里被数两次。'
      + DEVICE_MISSING,
    compute: (ctx) => deviceCountByType(ctx, deviceTypes),
    verify: ''
  };
}

/**
 * F62:G66「攻击来源地域分布top5 / 攻击数量」十格的共用口径（用户口径 2026-10-19）。
 *
 * 两列五行，同一行是同一个名次：F 列（第 62..66 行）= 地域名，G 列（同一行）= 攻击次数。
 * 数据源是 topn 接口（第一问 device_list 拼 device_infos、第二问 src_ip_geo），
 * 不是六份总表里的任何一份 —— 没有下载件、没有 parse 环节、报告里也没有对应的 sheet。
 *
 * @param {string} addr 单元格地址
 * @param {number} rank 名次（0..4）
 * @param {'label'|'count'} kind label = 地域名，count = 攻击次数
 */
function topSrcGeoCell(addr, rank, kind) {
  const position = `第 ${rank + 1} 名`;
  const common = `topn 接口（POST /gateway/workflow/order/v1/tool_box/topn/device_list `
    + '先取设备台账：只取 device_type + device_id，按 device_id 去重、不按 device_status 过滤；'
    + '再 POST .../tool_box/topn/src_ip_geo）在报告期内返回的源 IP 归属地排行。'
    + `报告期 = CLI 的 --start/--end（起 00:00:00、止 23:59:59.999，本地时区），`
    + '请求体 topn=5、date_scope=0。'
    + `本格是响应列表里的${position}：**行序照接口返回原样**，不按 attack_count 重排、`
    + '不合并相同地域（接口排的是 top5 源 IP，不是 top5 地域聚合）。'
    + '响应少于 5 行时，剩下的名次格子写空串（接口答了、就是没那么多）；'
    + `接口不通时本格写「${TOP_SRC_GEO_UNAVAILABLE_TEXT}」（不是空串、也不是 0）。`;

  return {
    addr,
    label: kind === 'label' ? '攻击来源地域分布top5' : '攻击数量',
    desc: kind === 'label'
      ? `${common}本格取该行的 \`src_ip_geo\`，写 JSON 解码后的中文（如「法国 巴黎」），`
        + '不是字面的 `\\uXXXX`；空格分隔符原样保留。'
      : `${common}本格取该行的 \`attack_count\`，落数字、不转字符串。`
        + '同一份响应里两行地域相同也各占一个名次，不合并、不累加。',
    compute: kind === 'label'
      ? (ctx) => srcIpGeoLabelAt(ctx, rank)
      : (ctx) => srcIpGeoAttackCountAt(ctx, rank),
    verify: ''
  };
}

/**
 * I62:J66「攻击类型top5 / 攻击数量」十格的共用口径（用户口径 2026-10-19）。
 *
 * 两列五行，同一行是同一个名次：I 列（第 62..66 行）= 威胁类型名，J 列 = 攻击次数。
 * 数据源是 topn 接口（device_list -> threat_type），请求体与 F62:G66 那次逐字相同、
 * 只换端点；不是六份总表里的任何一份。
 *
 * @param {string} addr 单元格地址
 * @param {number} rank 名次（0..4）
 * @param {'label'|'count'} kind label = 威胁类型名，count = 攻击次数
 */
function threatTypeCell(addr, rank, kind) {
  const position = `第 ${rank + 1} 名`;
  const common = `topn 接口（POST /gateway/workflow/order/v1/tool_box/topn/device_list `
    + '先取设备台账：只取 device_type + device_id，按 device_id 去重、不按 device_status 过滤；'
    + '再 POST .../tool_box/topn/threat_type，请求体与同行的 src_ip_geo 逐字相同）'
    + '在报告期内返回的威胁类型排行。'
    + `报告期 = CLI 的 --start/--end（起 00:00:00、止 23:59:59.999，本地时区），`
    + '请求体 topn=5、date_scope=0。'
    + `本格是响应列表里的${position}：**行序照接口返回原样**，不按 attack_count 重排。`
    + '响应少于 5 行时，剩下的名次格子写空串（接口答了、就是没那么多）；'
    + `接口不通时本格写「${THREAT_TYPE_UNAVAILABLE_TEXT}」（不是空串、也不是 0）。`;

  return {
    addr,
    label: kind === 'label' ? '攻击类型top5' : '攻击数量',
    desc: kind === 'label'
      ? `${common}本格取该行的 \`threat_type\`，写 JSON 解码后的中文（如「代码注入」），`
        + '不是字面的 `\\uXXXX`。平台未归类的「-」原样保留（接口已经把它排进 top5，'
        + '删掉会让后面的名次整体前移）。'
      : `${common}本格取该行的 \`attack_count\`，落数字、不转字符串。`
        + '不按类型合并、不累加。',
    compute: kind === 'label'
      ? (ctx) => threatTypeLabelAt(ctx, rank)
      : (ctx) => threatTypeAttackCountAt(ctx, rank),
    verify: ''
  };
}

/**
 * L62:M66「遭受外部攻击的主机 / 日志数量」十格的共用口径（用户口径 2026-10-20）。
 *
 * 两列五行，同一行是同一个名次：L 列（第 62..66 行）= 目的 IP，M 列 = 攻击次数。
 * 数据源是 topn 接口（device_list -> dst_ip），请求体与 F62:G66 那次逐字相同、
 * 只换端点与 ip_type；不是六份总表里的任何一份。
 *
 * @param {string} addr 单元格地址
 * @param {number} rank 名次（0..4）
 * @param {'label'|'count'} kind label = 目的 IP，count = 攻击次数
 */
function dstIpCell(addr, rank, kind) {
  const position = `第 ${rank + 1} 名`;
  const common = `topn 接口（POST /gateway/workflow/order/v1/tool_box/topn/device_list `
    + '先取设备台账：只取 device_type + device_id，按 device_id 去重、不按 device_status 过滤；'
    + '再 POST .../tool_box/topn/dst_ip，请求体与同行的 src_ip_geo 逐字相同、'
    + '只把 ip_type 换成 dst_ip）在报告期内返回的目的 IP 排行。'
    + `报告期 = CLI 的 --start/--end（起 00:00:00、止 23:59:59.999，本地时区），`
    + '请求体 topn=5、date_scope=0。'
    + `本格是响应列表里的${position}：**行序照接口返回原样**，不按 attack_count 重排。`
    + '响应少于 5 行时，剩下的名次格子写空串（接口答了、就是没那么多）；'
    + `接口不通时本格写「${DST_IP_UNAVAILABLE_TEXT}」（不是空串、也不是 0）。`;

  return {
    addr,
    label: kind === 'label' ? '遭受外部攻击的主机' : '日志数量',
    desc: kind === 'label'
      ? `${common}本格取该行的 \`dst_ip\`（目的 IP）。响应里的 \`src_ip\` 是聚合过的`
        + '（如「202.0.134.111、202.0.100.138等14个IP」），\`asset_name\`、\`threat_type\`'
        + ' 同样只是附带展示字段 —— 本块一个都不读。'
      : `${common}本格取该行的 \`attack_count\`，落数字、不转字符串。`
        + '两行攻击次数相同也各占一个名次，不合并、不累加。',
    compute: kind === 'label'
      ? (ctx) => dstIpLabelAt(ctx, rank)
      : (ctx) => dstIpAttackCountAt(ctx, rank),
    verify: ''
  };
}

/** 未定口径的记录。M1 阶段全部用它。 */
const u = (addr, label = '') => ({
  addr,
  label,
  desc: '',
  verify: '',
  mode: 'unresolved',
  note: 'M1 骨架，口径待定（见 CELL_REGISTRY.md）'
});

/**
 * F91:F97 / H91:H97「重要时期安全态势分布」的逐槽位格子 —— 7 个槽位按时间升序
 * 排报告期内命中的节假日（用户口径 2026-10-26，口径见 stats/metrics/important_period.js
 * 的 importantPeriodLabelAt / importantPeriodDefenseRateAt）。
 *
 * 槽位个数是**固定 7 个**：有几个节日填几行，其余槽位写空串（不填 0、不清空）。
 * 跨年报告期超过 7 条时取最晚 7 条（与 C58:N59 月份桶「超过 12 个取最晚 12 个」同一条）。
 *
 * @param {string} addr
 * @param {number} index 0..6 槽位
 * @param {'label'|'rate'} kind F 列写节日名 / H 列写防御率
 */
function importantPeriodDistributionCell(addr, index, kind) {
  if (kind === 'label') {
    return {
      addr,
      label: '重要时期安全态势分布 · 节日名',
      desc: '报告期内命中的第 ' + (index + 1) + ' 个节假日（时间升序、取最晚 7 条中的第 '
        + (index + 1) + ' 条），起名规则「节假日名（裁剪后起止日期）」，'
        + '日期用斜杠 YYYY/MM/DD，段已按报告期裁剪（用户口径 2026-10-26）。'
        + '名字用简称：清明 / 五一 / 端午 / 中秋 / 国庆；2025 合并条目写「国庆、中秋」。'
        + '该槽位没有节日 -> 写空串（那是结论，不是缺数）。'
        + '口径见 stats/metrics/important_period.js 的 importantPeriodLabelAt。',
      compute: (ctx) => importantPeriodLabelAt(ctx, index),
      verify: ''
    };
  }

  return {
    addr,
    label: '重要时期安全态势分布 · 防御率',
    desc: '与同一行 F 列的那个节假日配套的「防御率」：有节假日的行恒为 **1**，'
      + '模板数字格式 `0%` 显示成 100%；该槽位没有节日 -> 写空串（用户口径 2026-10-26 '
      + '「自动把对应有效行的 H 列的格填上 100%」）。本格不读任何表、不是算出来的比率。'
      + '口径见 stats/metrics/important_period.js 的 importantPeriodDefenseRateAt。',
    compute: (ctx) => importantPeriodDefenseRateAt(ctx, index),
    verify: ''
  };
}

/**
 * L4:L10 / M4:M10「重保周期清单」的逐槽位格子（用户口径 2026-10-27）。
 *
 * 重保 = 重要节假日：清单就是**报告期内命中的节假日**，与 F91:F97 共用同一份
 * 槽位序列（`importantPeriodDisplayRows`，按时间升序、最多取最晚 7 条，H4）。
 * 区别只在落法：F 列把「简称（日期范围）」写在一格里，这里拆成两列 ——
 *   L 列写节日**简称**（中秋 / 国庆 …）
 *   M 列写**日期范围**（2026/09/25-2026/09/27，斜杠）
 *
 * 槽位固定 7 个：有几个节日填几行，其余槽位写空串（不填 0、不清空）。
 * ⚠️ 与 M3「护网时间」**无关**：本清单只跟报告期与法定节假日表走，
 * 不看 CLI 的 --protect-start / --protect-end（护网时间）。
 *
 * @param {string} addr
 * @param {number} index 0..6 槽位
 * @param {'name'|'range'} kind L 列写简称 / M 列写日期范围
 */
function importantPeriodListCell(addr, index, kind) {
  if (kind === 'range') {
    return {
      addr,
      label: '重保周期清单 · 时间范围',
      desc: '报告期内命中的第 ' + (index + 1) + ' 个节假日的**日期范围**'
        + '（时间升序、取最晚 7 条中的第 ' + (index + 1) + ' 条），'
        + '形如 2026/09/25-2026/09/27（斜杠 YYYY/MM/DD，与 L1/M1 同一种格式）；'
        + '段已按报告期裁剪。与同一行 L 列是同一个节日（用户口径 2026-10-27）。'
        + '该槽位没有节日 -> 写空串（那是结论，不是缺数）。'
        + '口径见 stats/metrics/important_period.js 的 importantPeriodRangeAt。',
      compute: (ctx) => importantPeriodRangeAt(ctx, index),
      verify: ''
    };
  }

  return {
    addr,
    label: '重保周期清单 · 节日名',
    desc: '报告期内命中的第 ' + (index + 1) + ' 个节假日的**简称**'
      + '（时间升序、取最晚 7 条中的第 ' + (index + 1) + ' 条）：'
      + '清明 / 五一 / 端午 / 中秋 / 国庆；2025 合并条目写「国庆、中秋」；'
      + '表里以后新增、这里没登记的节日名原样输出（不猜简称、也不丢行）。'
      + '日期范围在同行 M 列（用户口径 2026-10-27）。'
      + '该槽位没有节日 -> 写空串（那是结论，不是缺数）。'
      + '口径见 stats/metrics/important_period.js 的 importantPeriodNameAt。',
    compute: (ctx) => importantPeriodNameAt(ctx, index),
    verify: ''
  };
}

/**
 * G91:G97「日均攻击数」的逐槽位格子（用户口径 2026-10-27）。
 *
 * 每格 = **该重要时期段的日志量 ÷ 该段天数**（闭区间首尾都算）。段与槽位与
 * F91:F97 / H91:H97 / L4:M10 共用同一份 `importantPeriodDisplayRows`（H4）。
 * 不做舍入 —— 显示格式由模板的 `0.0,"万"` 决定。
 *
 * 三档：接口不通 -> 写「接口不通无值」（7 格都写，不写 0）；该槽位没有节日 -> 空串；
 * 段数对不上 -> 抛错（H6：不补 0、不截断）。
 *
 * @param {string} addr
 * @param {number} index 0..6 槽位
 */
function importantPeriodDailyCell(addr, index) {
  return {
    addr,
    label: '日均攻击数',
    desc: '报告期内命中的第 ' + (index + 1) + ' 个节假日的**日均攻击数**'
      + '（时间升序、取最晚 7 条中的第 ' + (index + 1) + ' 条）：'
      + '该重要时期段的日志量 ÷ 该段天数（闭区间首尾都算），用户口径 2026-10-27。'
      + '段的日志量与 D27「重要时期安全日志数」来自同一次逐段问，本格取该段原值；'
      + '接口不通 -> 写「接口不通无值」（不写 0）；该槽位没有节日 -> 写空串（那是结论）。'
      + '不做舍入，显示格式由模板的 `0.0,"万"` 决定。'
      + '口径见 stats/metrics/important_period.js 的 importantPeriodDailyAverageAt。',
    compute: (ctx) => importantPeriodDailyAverageAt(ctx, index),
    verify: ''
  };
}

module.exports = [
  {
    addr: 'C18',
    label: '受影响的最新漏洞数',
    desc: '第 1 个核心业务系统（与 D3 同名的那个）名下的**已闭环风险总数** —— '
      + '把 D13 那个加式（D14 + D15 + D16 + D17）原样搬过来，每一项只数'
      + '「IP 落在该系统集合里」的行（用户口径 2026-10-22）。'
      + '① 资产表：「所属业务」列**子串包含**该系统名的行，取其「IP地址」得到该系统 IP 集合；'
      + '② 四段各自按「风险资产」（漏洞表 / 弱密码表）或「影响资产」（事件表）归一后'
      + '**精确落在**集合里再计数：D14 内网漏洞表（AF 防护规则 = 有效 且 处置状态 = '
      + '处置完成（已缓解））、D15 漏洞表全表（处置状态含「处置完成」）、'
      + 'D16 弱密码表两段 + 事件表一段、D17 漏洞表全表（威胁标签含「热点漏洞」）。'
      + '判据、表来源、加式都复用 D13 的四个加数，本格只多一道 IP 圈定（H4）。'
      + '⚠️ 三个口径（用户 2026-10-22 明确）：数**行数**、不去重；D14/D15 的重叠**保留**；'
      + '一台资产同属两个系统时两个槽位**各计一次**（所以 C18 + D18 + E18 可能大于 D13）。'
      + '「风险资产」/「影响资产」为空的行不属于任何系统，本格不数（常态下三者之和 ≤ D13）。'
      + '不按报告期过滤：四段的取数各自已在下载层用掉报告期。'
      + '边界：该系统名下一条已闭环风险都没有 -> 写 0（是 0，不是缺数）；'
      + '资产表为空、或该系统名下没有资产 -> IP 集合是空集 -> 写 0；'
      + '第 1 个系统没传 -> 写 0（与 D7/D8/D9 同一条，不记错误）；'
      + '资产表缺「所属业务」/「IP地址」列、或四段里任一段缺列 -> 整格不写值 + 记错误'
      + '（错误文案就是那一段自己的，不拿剩下几段凑数）。'
      + '口径见 stats/metrics/core_system.js 的 coreSystemClosedRiskTotalAt 与 '
      + 'stats/metrics/closed_risk.js 的 closedRiskTotalOnIps。',
    compute: (ctx) => coreSystemClosedRiskTotalAt(ctx, 0),
    verify: ''
  },
  {
    addr: 'C49',
    label: '安全事件总数',
    desc: '同 D38 —— 本格与 D38「威胁和事件数量」是**同一个数**（用户口径 2026-10-13：'
      + '「C49 也是安全事件总数，可以复用D38」）。'
      + 'D38 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界、空表行为全部见 D38 的 desc，本格一个字都不重算。'
      + '（模板里这一格的标题在第 48 行的 C48「安全事件总数」、值是第 49 行的 C49 ——'
      + '与 D48「事件平均响应时间」/ E48「事件平均处置时长」/ F48「事件闭环率」'
      + '那三个标题下的值格同一行。）',
    alias: 'D38',
    verify: ''
  },
  categoryCell('C51', 0, 'label'),
  categoryCell('C52', 1, 'label'),
  categoryCell('C53', 2, 'label'),
  categoryCell('C54', 3, 'label'),
  categoryCell('C55', 4, 'label'),
  monthCell('C58', 0, 'label'),
  monthCell('C59', 0, 'mean'),
  monthlyAttackCell('C71', 0, 'label'),
  monthlyAttackCell('C72', 0, 'count'),
  monthlyOutboundCell('C73', 0),
  monthlyAlarmCell('C75', 0),
  {
    addr: 'C80',
    label: '高危可利用漏洞数',
    desc: '同 D10 —— 本格与 D10「高危可利用漏洞数」同值（用户口径 2026-10-21：'
      + '「C80 是高危可利用漏洞数，alias D10」）。'
      + 'D10 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界（只认「高可利用」、全表 = 内网 + 互联网两份相加、不按报告期过滤）、'
      + '空表行为全部见 D10 的 desc，本格一个字都不重算。'
      + '⚠️ 本格因此不读表：D10 缺「威胁标签」列时两格一起不写值 + 记错误，'
      + '报的是「alias 目标 D10 没有算出值」。',
    alias: 'D10',
    verify: ''
  },
  monthlyVulnCell('C86', 0, 'label'),
  monthlyVulnCell('C87', 0, 'count'),
  monthlyVulnCell('C88', 0, 'closed'),
  {
    addr: 'C133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数最多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 0),
    verify: ''
  },
  {
    addr: 'C134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数最多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 0),
    verify: ''
  },
  eventCell('C135', 0, 'label'),
  eventCell('C136', 0, 'count'),
  eventCell('C137', 0, 'share'),
  {
    addr: 'D3',
    label: 'TOP3的核心业务系统',
    desc: '第 1 个核心业务系统的名称，直接取 CLI 的 --business-systems 的第 1 个参数，'
      + '不参与统计、不随总表数据变化（与客户名 J1 同一类）。按 CLI 传入顺序填 D3/D4/D5。'
      + '名称两端空白与分隔符由 CLI 侧切好（全角逗号/顿号/分号都认），本格原样落。'
      + '边界：没传第 1 个系统时本格不写值、模板原样保留；传了 4 个及以上时本格记入错误列表'
      + '（模板里只有 3 个槽位，多的无处可放）。'
      + '⚠️ --business-systems 是可选参数、没给够第 1 个时，D6:D9 / G6/H6/I6 / G10 那几格按'
      + '用户口径 2026-10-12 写 **0**，本格（与 D4/D5）**仍然不写值** —— 本格写的是系统名本身，'
      + '不是算出来的数，没有名字就没有可写的东西，所以不跟着写 0。',
    compute: (ctx) => coreSystemNameAt(ctx, 0),
    verify: ''
  },
  {
    addr: 'D4',
    label: 'TOP3的核心业务系统',
    desc: '第 2 个核心业务系统的名称，取 --business-systems 的第 2 个参数。其余同 D3。',
    compute: (ctx) => coreSystemNameAt(ctx, 1),
    verify: ''
  },
  {
    addr: 'D5',
    label: 'TOP3的核心业务系统',
    desc: '第 3 个核心业务系统的名称，取 --business-systems 的第 3 个参数。其余同 D3。',
    compute: (ctx) => coreSystemNameAt(ctx, 2),
    verify: ''
  },
  {
    addr: 'D6',
    label: '安全风险总数',
    desc: '三个核心业务系统的风险总数**合计**，也就是 D7 + D8 + D9 三格的值直接相加 —— '
      + '本格不另起口径：每个系统的数怎么来的、三段（漏洞 + 弱密码 + 事件）各按哪张表哪些行算，'
      + '见 D7 的 desc，本格只是把算好的三个数加起来，不重新过滤、不另做一遍。'
      + '相加不去重：同一台机器挂在两个系统名下时，它在两个系统里各算一次，本格也照样各加一次。'
      + '三个槽位一个不落地加：--business-systems 只给了 2 个系统时，第 3 个槽位没有系统，'
      + '它对 D9 的贡献是 0，本格就是前两个数之和；一个都没给时三格全是 0，本格就是 0。'
      + '不按报告期过滤（同 D7：四份总表导出时已按平台口径取数）。'
      + '边界：**--business-systems 没给够的槽位按 0 加**（用户口径 2026-10-12：它是可选参数，'
      + '槽位空着就是没有这个系统，不是"取不到数"）；'
      + '传了 4 个及以上系统时本格不写值、记入错误列表（模板里只有核心系统 1/2/3 三个槽位）；'
      + '资产表 / 漏洞表 / 弱密码表（内网 + 互联网两份）/ 事件表里有行、但读不出要读的列'
      + '（平台改了列名）时，'
      + '对应的数算不出来，本格不写值、记入错误列表；'
      + '某一份表这次是空的（0 行）时，那一段就是 0，本格跟着按 0 加（0 是结论，不是缺数）；'
      + '各系统名下一条风险都没有时三个数都是 0，本格就是 0（是 0，不是缺数）。',
    compute: (ctx) => coreSystemRiskGrandTotal(ctx),
    verify: ''
  },
  {
    addr: 'D7',
    label: '系统1',
    desc: '第 1 个核心业务系统（与 D3 同名的那个）的风险总数 = 漏洞风险 + 弱密码风险 + 事件风险，'
      + '三段互不重叠、直接相加，不去重。三段都按**行数**算：'
      + '① 资产表：「所属业务」列**子串包含**该系统名（大小写与首尾空白不敏感，如传「oa系统」命中'
      + '「OA系统1」「财务系统, oa系统」）的行，取其「IP地址」得到该系统 IP 集合；'
      + '② 漏洞表：「风险资产」等于集合中某个 IP 的行里，「威胁标签」含「高可利用」或「热点漏洞」'
      + '的行数（一行最多算一条，两个标签都含也只算一条）；'
      + '③ 弱密码表（内网 + 互联网两份，ctx 里已拼接成全表）：「风险资产」等于集合中某个 IP 的行数；'
      + '④ 事件表：「影响资产」等于集合中某个 IP 的行里，「安全事件二级分类」含「弱口令」「弱密码」'
      + '「账号安全」之一的行数。'
      + '不按报告期过滤：四份总表导出时已按平台口径取数，本格不叠加第二道时间过滤。'
      + '边界：漏洞表 / 弱密码表（内网 + 互联网两份）/ 事件表里哪一份这次是空的（0 行），'
      + '那一段就是 0、其余段照算（0 是结论，不是缺数 —— 下载一定发生，下不到的表'
      + '在 scripts/build_report.py 就被拦下了，流程根本走不到取值层）；'
      + '资产表里找不到「所属业务」或「IP地址」列、漏洞 / 弱密码表（两份）/ 事件表里找不到要读的列 '
      + '—— 这些是整格取不到数，本格不写值并记入错误列表（禁止填 0）；'
      + '⭐ 第 1 个系统没传（--business-systems 是可选的，少传或一个都没传）**不在此列**：'
      + '这个槽位没有系统，这个数就是 0（用户口径 2026-10-12），不记错误 —— 别跟上面那条'
      + '"取不到数"混为一谈，那是"该有却读不出"，这是"本来就没有这个系统"；'
      + '资产表为空、或「所属业务」整列都是空的客户，该系统 IP 集合是空集，三段都数出 0，'
      + '本格为 0（是 0，不是缺数）；'
      + '该系统名下有资产但一条风险都没有时同样为 0（三个来源都数出 0）。',
    compute: (ctx) => coreSystemRiskTotalAt(ctx, 0),
    verify: ''
  },
  {
    addr: 'D8',
    label: '系统2',
    desc: '第 2 个核心业务系统（与 D4 同名的那个）的风险总数，算法与计数口径同 D7。边界同 D7。',
    compute: (ctx) => coreSystemRiskTotalAt(ctx, 1),
    verify: ''
  },
  {
    addr: 'D9',
    label: '系统3',
    desc: '第 3 个核心业务系统（与 D5 同名的那个）的风险总数，算法与计数口径同 D7。边界同 D7。',
    compute: (ctx) => coreSystemRiskTotalAt(ctx, 2),
    verify: ''
  },
  {
    addr: 'D10',
    label: '高危可利用漏洞数',
    desc: '「漏洞表」总表中「威胁标签」列含「高可利用」的行数。判据是**这一列的值里出现这四个字**，'
      + '不是整段标签等于它 —— 标签串是一整格文本，形如「有攻击代码披露、高可利用」'
      + '或直接是「高可利用」都算；标签为空的行不算。'
      + '分隔符是顿号或**全角逗号**（2026-10-16 那份新下载件的外网表里有全角逗号拼的），'
      + '判据是"包含"，两种都认。'
      + '只认「高可利用」这一个标签：一行里只有「热点漏洞」不算（核心业务系统风险总数那一段'
      + '是两个标签都算，与本格刻意不同）。'
      + '按行计数，一行最多算一条；不去重、不按漏洞名称合并（同一台机器上的同一个漏洞'
      + '被导出多次就是多行）。'
      + '数的是**全表** —— 2026-10-16 起漏洞表是**两份**（内网漏洞表 + 互联网漏洞表），'
      + '「全表」= 两份**相加**（与老接口那张单一导出等价，见 stats/metrics/vuln.js 头注）；'
      + '与 --business-systems 传没传、传了什么都无关。'
      + '不按报告期过滤 —— 漏洞表导出时已按「首次发现时间」落在报告期内（同 D7，'
      + '本仓取值层不叠加第二道时间过滤）。'
      + '边界：漏洞表为空（0 行）、或报告期内一条漏洞都没有时为 0（是 0，不是缺数）；'
      + '表头里没有「威胁标签」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => highExploitableVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D11',
    label: '管理员弱口令数量',
    desc: '核心资产上的弱口令数量，**两段之和**。'
      + '范围：资产表里「重要级别」列**精确等于**「核心」的那些行，取该行「IP地址」列的值，'
      + '得到核心资产 IP 集合（精确相等，不是包含 —— 「核心业务」这种更长的值不算）。'
      + '第一段：弱密码表（内网 + 互联网两份，ctx 里已拼接成全表）里'
      + '「风险资产」列的值属于核心资产集合的行数。'
      + '第二段：事件表里「安全事件二级分类」列含「弱口令 / 弱密码 / 账号安全」中任意一个，'
      + '**且**该行「影响资产」列的值属于核心资产集合的行数。'
      + '两段都按行计数、一行最多算一条、不去重（同一台机器上两个账号的弱口令是两行就是两条）。'
      + '不按报告期过滤 —— 两份表导出时已按平台口径取数（同 D7，本格不叠加第二道时间过滤）。'
      + '边界：弱密码表（两份）或事件表为空（0 行）时，那一段就是 0、另一段照算'
      + '（与 D7:D9 同一条口径）；'
      + '资产表为空（0 行）、或核心资产一台都没有时，核心资产集合是空集，两段都是 0'
      + '（是 0，不是缺数）；'
      + '核心资产上确实没有弱口令时同样是 0（是 0，不是缺数）；'
      + '资产表表头里没有「重要级别」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => adminWeakPwdCount(ctx),
    verify: ''
  },
  {
    addr: 'D12',
    label: '最新漏洞影响资产数',
    desc: '「漏洞表」总表中「威胁标签」列含「热点漏洞」的漏洞，**影响到的资产台数**。'
      + '判据是**这一列的值里出现这四个字**，不是整段标签等于它 —— 标签串是一整格文本，'
      + '形如「热点漏洞、勒索利用」或直接是「热点漏洞」都算；标签为空的行不算。'
      + '分隔符是顿号或**全角逗号**（2026-10-16 那份新下载件的外网表里有全角逗号拼的），'
      + '判据是"包含"，两种都认。'
      + '只认「热点漏洞」这一个标签：一行里只有「高可利用」不算（D10 是它的镜像，'
      + '两格关键词互斥，同一行若两个标签都含则两格各算一次）。'
      + '**归总是按「风险资产」列去重，不是数行数** —— 同一台资产上有三条热点漏洞只算 1 台，'
      + '与 label 里的「资产数」一致（D10 才是数行数，两格刻意不同）。'
      + '去重前先用 normalizeIp 归一（与 D7 那一段同一把尺子），'
      + '于是「10.0.0.4」与「10.0.0.4(未归类组)」算同一台。'
      + '「风险资产」为空的行**不计入**（指不到任何一台资产上，拿空串当一台会让台数虚增 1）。'
      + '数的是**全表** —— 2026-10-16 起漏洞表是**两份**（内网漏洞表 + 互联网漏洞表），'
      + '「全表」= 两份**相加**（与老接口那张单一导出等价，见 stats/metrics/vuln.js 头注）；'
      + '⚠️ 对**本格**「相加」指的是**两份的行拼成一份之后再去重**，不是"两份各自去重再求和"：'
      + '同一台资产在两份里各有一条热点漏洞，两种做法会差 1（当日实测 87 + 77 = 164，'
      + '合成一份去重是 **163** —— 163 才是老接口那张单一导出会给出的数）。'
      + '与 --business-systems 传没传、传了什么都无关。'
      + '不按报告期过滤 —— 漏洞表导出时已按「首次发现时间」落在报告期内（同 D7，'
      + '本仓取值层不叠加第二道时间过滤）。'
      + '边界：漏洞表为空（0 行）、或报告期内一条热点漏洞都没有时为 0（是 0，不是缺数）；'
      + '表头里没有「威胁标签」或「风险资产」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => hotVulnAssetCount(ctx),
    verify: ''
  },
  {
    addr: 'D13',
    label: '已闭环风险总数',
    desc: '**D14 + D15 + D16 + D17 四个数相加**（用户口径 2026-10-22：'
      + '「D13是已闭环风险总数，取值是D14+D15+D16+D17」）。'
      + '四个加数各自都是**有名字的格子**，本格只做加法、一个字都不重算（H4）：'
      + 'D14「已防护漏洞数」（内网漏洞表里「AF 防护规则」=「有效」且「处置状态」='
      + '「处置完成（已缓解）」的行数）+ D15「已修复漏洞数」（漏洞表全表里「处置状态」'
      + '含「处置完成」的行数）+ D16「已处置弱口令数量」（弱密码表两段 + 事件表一段）'
      + '+ D17「受影响的最新漏洞数」（漏洞表全表里「威胁标签」含「热点漏洞」的行数）。'
      + '⚠️ 照抄加式、**不做交集 / 去重**：D14 命中的行本来就同时会被 D15 计入'
      + '（「处置完成（已缓解）」也含「处置完成」），这是用户给的加式，别改成集合运算。'
      + '与 --business-systems 无关：四个加数各自都不按业务系统圈。'
      + '不按报告期过滤：四个加数的取数各自已在下载层用掉报告期，本仓取值层不叠加第二道过滤。'
      + '边界：四个加数都是 0 -> 写 **0**（结论，不是缺数）；'
      + '任何一个加数缺列 / 读不到（例如内网漏洞表缺「AF 防护规则」列）-> 本格整格不写值 +'
      + '记错误 —— 少了一个加数却看上去"算完了"，比明说"没取到数"更容易被当成结论；'
      + '错误文案就是那个加数自己的。'
      + '口径见 stats/metrics/closed_risk.js 的 closedRiskTotal。',
    compute: (ctx) => closedRiskTotal(ctx),
    verify: ''
  },
  {
    addr: 'D14',
    label: '已防护漏洞数',
    desc: '「内网漏洞表」里「AF 防护规则」列**整格精确等于**「有效」'
      + '**且**「处置状态」列**整格精确等于**「处置完成（已缓解）」的行数。'
      + '用户口径（2026-10-22）：「精确查找内网漏洞表的『AF 防护规则』列，值精确匹配『有效』，'
      + '且精确查找『处置状态』列的值精确匹配『处置完成（已缓解）』，则加一」。'
      + '「精确查找」= 按列名**逐字**找到这一列（「AF 防护规则」中间有一个空格）；'
      + '「精确匹配」= 整格相等，比较前只去首尾空白 —— 不是包含、也不是前缀：'
      + '「处置完成（已修复）」「处置完成（接受风险）」「处置完成（忽略）」以及不带括号的'
      + '「处置完成」都**不算**，这是与 D15 / D80（两格都是包含判据）的分界。'
      + '只数「内网漏洞表」这一张 sheet，**外网那份不算** —— 数据源是 ctx.vulnInnerRows'
      + '（下载层单独读的那张表），不是内网 + 外网拼起来的 ctx.vulnRows。'
      + '按行计数，一行最多算一条；不去重、不按漏洞名称合并；'
      + '不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D15/D80 同一条）。'
      + '内网漏洞表为空（0 行）-> 写 0（结论，不是缺数）；'
      + '表里有行、却没有「AF 防护规则」列或「处置状态」列 -> 不写值 + 记错误'
      + '（「AF 防护规则」是平台新增的列，旧导出件里没有，别把缺列当成 0）。'
      + '口径见 stats/metrics/vuln.js 的 protectedVulnCount。',
    compute: (ctx) => protectedVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D15',
    label: '已修复漏洞数',
    desc: '「漏洞表」总表中「处置状态」列的值**包含**「处置完成」的行数（口径 2026-10-26）。'
      + '判据是**包含**（includes），不是整格相等、不是前缀 —— 带括号的'
      + '「处置完成（已修复）」「处置完成（已缓解）」「处置完成（接受风险）」「处置完成（忽略）」'
      + '四种**都算**，半角括号的 `处置完成(已修复)` 也算；`待处置` / `处置中` 不算。'
      + '口径变过三次（都记在这，免得回头看见旧数据对不上）：'
      + '2026-10-08 起是整格精确等于；2026-10-16 平台把四种形态拆成带括号的写法、'
      + '精确匹配数出 0（实际 43 行 = 内网 33 + 外网 10），当时改成了「以『处置完成』开头」的前缀判据；'
      + '2026-10-22 用户改成**整格精确等于**；2026-10-26 用户原话'
      + '「D15改一下，改成包含『处置完成』就算」，改定为当前的**包含**判据。'
      + '⚠️ 误报行在**下载层预处理**里就已经被整行删掉（用户口径 2026-10-21，'
      + 'scripts/extract_vuln_report.py 的 drop_false_positive_rows）—— 删行发生在搬表与解析之前；'
      + '包含判据本身**会**认带括号的「处置完成（误报）」，删行是本格数得对的前提。'
      + '比较前去掉首尾空白（多打一个空格不算另一种处置状态）。'
      + '按行计数，一行最多算一条；不去重、不按漏洞名称合并。'
      + '数的是**全表** —— 2026-10-16 起漏洞表是**两份**（内网漏洞表 + 互联网漏洞表），'
      + '「全表」= 两份**相加**；'
      + '与 --business-systems 传没传、传了什么都无关。'
      + '不按报告期过滤 —— 漏洞表导出时已按「首次发现时间」落在报告期内'
      + '（同 D7/D10/D12，本仓取值层不叠加第二道时间过滤）。'
      + '边界：漏洞表为空（0 行）、或报告期内一条「处置完成」都没有时为 0（是 0，不是缺数）；'
      + '表头里没有「处置状态」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => settledVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D16',
    label: '已处置弱口令数量',
    desc: '弱口令的**已处置条数**，**两段之和**，两段来自两份不同的表、不去重。'
      + '第一段：弱密码表（内网 + 互联网两份，ctx 里已拼接成全表）里「处置状态」列的'
      + '值**整格精确等于**「处置完成」的行数'
      + '（全表、不看 IP —— 与核心资产、与 --business-systems 传没传都无关）。'
      + '第二段：事件表里「安全事件二级分类」列的值**含「弱口令」这三个字**，'
      + '**且**该行「处置状态」列的值**整格精确等于**「处置完成」的行数（两个条件同时满足，'
      + '不是二选一；同样是全表、不看 IP）。'
      + '两段的判据一把尺子：处置状态一律**整格精确相等**，比较前只去首尾空白，'
      + '不做全半角 / 括号归一 —— 弱密码表实测出现过「处置完成（误报）」与'
      + '「处置完成(误报)」（全角半角两种括号），这两种**都不算**（与「处置完成」'
      + '不是同一个字符串），「待处置」当然也不算。'
      + '分类那一段则是**包含**而非相等：实测平台的二级分类写成「Telnet弱口令」'
      + '「Web弱口令」这种复合词，等值比较会一条都匹配不上；「SSH账号暴力破解」'
      + '不含「弱口令」三字，不算（本格只认「弱口令」，不跟着 D11 放宽到'
      + '「弱密码 / 账号安全」—— 那是另一格的投喂口径）。'
      + '两段都按行计数、一行最多算一条，不去重、不按账号 / 端口 / 事件 ID 合并：'
      + '同一台资产上两个账号各有一条已处置的弱口令，就是 2 条。'
      + '不按报告期过滤 —— 两份表导出时都已按平台口径取数（弱密码表按「首次发现时间」、'
      + '事件表按 --start/--end，同 D10/D15，本仓取值层不叠加第二道时间过滤）。'
      + '边界：任一份表为空（0 行）时那一段是 0、另一段照算（报告期窗口里弱密码表'
      + '一条都没有本来就是空表，0 是结论不是缺数）；两段都是 0 时本格写 0；'
      + '弱密码表有行却没有「处置状态」列、或事件表有行却没有「安全事件二级分类」/'
      + '「处置状态」列（平台改了列名）时，本格不写值、记入错误列表（不填 0）。',
    compute: (ctx) => disposedWeakPwdCount(ctx),
    verify: ''
  },
  {
    addr: 'D17',
    label: '受影响的最新漏洞数',
    desc: '「漏洞表」总表（内网 + 互联网两份拼成一份）里「威胁标签」列含「热点漏洞」的**行数**'
      + '（用户口径 2026-10-22：格名是「漏洞数」，取的是漏洞**条数**，不是资产台数）。'
      + '与 D67「最新威胁情报数量」是**同一个派生量**（hotVulnCount），一行算一条、'
      + '不去重、不按漏洞名称合并。'
      + '判据是**这一列的值里出现这四个字**，不是整段标签等于它 —— 标签串是一整格文本，'
      + '形如「热点漏洞、勒索利用」或直接是「热点漏洞」都算；分隔符顿号 / 全角逗号都认；'
      + '标签为空的行不算。只认「热点漏洞」这一个标签：一行里只有「高可利用」不算'
      + '（D10 是它的镜像）。'
      + '⚠️ 与 D12「最新漏洞影响资产数」**不是一个量**：D12 按「风险资产」去重数**台数**，'
      + '本格数**条数** —— 同一台资产上有三条热点漏洞，D12 算 1 台、本格算 3 条。'
      + '（2026-10-22 之前本格登记为 alias D12，是把「漏洞数」当成了「资产数」，已纠正；'
      + 'D68「最新威胁影响资产数」= D12 那条 alias 不受影响。）'
      + '数的是**全表** —— 两份漏洞表的行拼成一份再数，与老接口那张单一导出等价'
      + '（见 stats/metrics/vuln.js 头注）。'
      + '与 --business-systems 传没传、传了什么都无关；'
      + '不按报告期过滤 —— 漏洞表导出时已按「首次发现时间」落在报告期内'
      + '（同 D10/D12，本仓取值层不叠加第二道时间过滤）。'
      + '边界：漏洞表为空（0 行）、或一条热点漏洞都没有时为 0（是 0，不是缺数）；'
      + '表头里没有「威胁标签」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => hotVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D18',
    label: '分布1',
    desc: '第 2 个核心业务系统（与 D4 同名的那个）名下的已闭环风险总数，'
      + '算法与计数口径同 C18（D13 的四段按该系统 IP 集合圈定后相加，数行数、'
      + '保留 D14/D15 重叠、系统之间各算各的）。边界同 C18。',
    compute: (ctx) => coreSystemClosedRiskTotalAt(ctx, 1),
    verify: ''
  },
  u('D20', '被通报风险总数'),
  {
    addr: 'D21',
    label: '外联通报风险次数',
    desc: '**D23 + D24 两个数相加**（用户口径 2026-10-14「D21 是外联通报风险次数，取值是 D23 + D24」）。'
      + '两个加数各自都是**有名字的格子**，所以本格只做加法、一个字都不重算（H4）：'
      + 'D23「已拦截外联次数」（日志量接口：网络安全日志 + 终端安全日志两张表里'
      + '「已拦截的外联」条数之和）+ D24「恶意外联告警数」（告警表「访问方向」列'
      + '整格精确等于「内➝外」的行数）。'
      + '⚠️ 两半来自**两个不同的数据源、两把不同的尺子**（一半是日志条数、一半是告警行数），'
      + '所以相加这件事本身有意义 —— 别把它当成"同一个东西的两种算法"去取其一。'
      + '也正因为是两条路，两半**不去重**：同一次外联如果既留了已拦截日志、又起了告警，'
      + '在这次相加里会各算一次（用户给的就是这个加式，本格不额外做交集）。'
      + '与 --business-systems 无关：两个加数都不按业务系统圈。'
      + '不按报告期过滤：两半的取数各自已经在下载层用掉报告期（日志量接口吃 --start/--end、'
      + '告警表导出按首次发生时间圈定），本仓取值层不叠加第二道时间过滤。'
      + '边界：两个加数都是 0（报告期内既没有已拦截外联日志、也没有外联告警）-> 写 **0**'
      + '（0 是结论，不是缺数）；'
      + '⚠️ **D23 那一半接口调不通时，本格整格写「接口不通无值」**（用户口径 2026-10-14 确认）——'
      + '不是 0、也不是只用 D24 那一半凑个数：少算了一半却看上去"算完了"，'
      + '比明说"没取到数"更容易被当成结论（长期口径见 stats/context.js 的 UNAVAILABLE_TEXT）；'
      + 'D24 那一半来自总表、没有"不通"这一档（表 0 行就是 0）。',
    compute: (ctx) => outboundReportRiskCount(ctx),
    verify: ''
  },
  u('D22', '安全策略调优数量'),
  {
    addr: 'D23',
    label: '已拦截外联次数',
    desc: '**报告期内已拦截的外联日志条数**（用户口径 2026-10-14）。'
      + '数据来自**日志量接口**（不是六份总表里的任何一份：没有下载件、没有 parse 环节、'
      + '报告里也没有对应的 sheet）：与 G99「xdr日志数」**是同一个端点上的另一次问** ——'
      + 'POST /gateway/mss-mdr/web/api/mssw/mss-mdr/v1/logs-aggregations-count，'
      + '同一批表、同一段时间，**每张表多带一条 `searchString` 过滤串**，两张表各取 `data.total` 后**相加**'
      + '（相加这一步在 mssw_client.js 的 fetchMsswInterceptedOutboundCount 里）。'
      + '两条过滤串逐字照用户给的浏览器抓包，按表各一条：'
      + '网络安全日志 `filter srcIpTag=1 AND dstIpTag=0 AND action = 2`'
      + '（「内→外」那个方向 —— `srcIpTag=1` 是内、`dstIpTag=0` 是外 —— **且**「已拦截」`action = 2`，'
      + '两个条件是 AND）；'
      + '终端安全日志 `filter action = 2`（终端日志没有方向概念，只筛「已拦截」）。'
      + '其余请求体字段与 G99 完全一致：时间给 **epoch 秒**、「客户」靠请求体里那条'
      + '「客户 = 当前客户」的约束圈（请求头不带 `x-mssw-company-id`）。'
      + '计数口径：**按日志条数**，一行一票，不去重、不按外联目标 / 源 IP 合并 —— '
      + '两条日志指向同一个外联目标时算 2（与 G99 同一条：平台怎么数，就照它数）。'
      + '⚠️ 本格数的是**日志条数**，与 D24「恶意外联告警数」（告警表行数）是**两套完全不同的东西**，'
      + '同一段时间里两个数一般不相等（也不是谁包含谁），D21 把两者相加正因为它们是两条独立的路。'
      + '报告期**就是命令行 --start/--end**（用户口径 2026-10-13，与 G99 同一把尺子）：'
      + '起 = 起始日 00:00:00、止 = 结束日 23:59:59（本地时区）换算成秒；'
      + '⚠️ 抓包里那两个数差整 30 天，是浏览器前端的默认窗口，**不是口径**，不做任何收窄。'
      + '与 --business-systems 无关：日志量是整个租户的，不按业务系统圈。'
      + '边界：报告期内一条这样的日志都没有（接口答了、两张表都是 0）时本格写 **0**'
      + '（0 是结论，不是缺数）；**接口调不通**时写「**接口不通无值**」'
      + '（长期口径：接口不通**不拦整份报告**，这一格就写这六个字 —— 不是 0，也不是不写值；'
      + '真实原因在运行日志里。⚠️ 这一问与 G99 那一问**各断各的**：'
      + '本格不通不影响 G99 落值，反之亦然）；'
      + '接口**没给数量**（`data.total` 不是数字）-> 不写值 + 记错误（禁止静默当 0）。',
    compute: (ctx) => interceptedOutboundLogCount(ctx),
    verify: ''
  },
  {
    addr: 'D24',
    label: '恶意外联告警数',
    desc: '「告警表」总表中「访问方向」列的值**整格精确等于「内➝外」**的行数'
      + '（用户口径 2026-10-14：「精确查找告警表『访问方向』列，精确匹配值是『内到外』，统计行数」）。'
      + '⚠️ **匹配值以表里实际写的那三个字为准**：中间那个字符是 `➝`（U+279D，实心三角箭头），'
      + '不是「到」、不是「→」（U+2192）、也不是 `->` —— 口述时写的是「内到外」，'
      + '但表里没有「内到外」这个值，照口述去匹配会数出 0，**而且不会报错**'
      + '（"一个都没匹配上"与"这类告警一条都没有"在结果上长得一样）。'
      + '这一点已当场跟用户核对过，用户确认按表里实际的值匹配。'
      + '实测该列在告警中间件（`tmp/verify_vuln/cli_downloads/alert_20261008122724.xlsx` 的'
      + '「安全告警」sheet，10 万行）里只有四个取值：`内➝外`、`外➝内`、`无`、`内➝内`。'
      + '判据是**整格精确相等**，不是包含 —— 「外➝内」「内➝内」都含「内」「外」两个字，'
      + '用包含去比会把它们一起数进来（同 G5「真实攻击未成功」、D15「处置完成」那两条分界）。'
      + '比较前去掉首尾空白（多打一个空格不算另一个方向）。'
      + '计数口径：**按行计数，一行一票**，不去重、不按告警 ID / 主机IP 合并，'
      + '也不看任何别的列（不看处置状态、不看告警定性、不看研判结论）——'
      + '与同表 G100「xdr告警数」/ G5 同一套"一行一票"。'
      + '⚠️ 本格数的是**告警行数**，与 D23「已拦截外联次数」（日志条数，日志接口）'
      + '是两套完全不同的数据源 —— 别把两者当成"同一个东西的两种算法"（D21 把两者相加，'
      + '正因为它们是两条独立的路）。'
      + '数的是**全表**：与 --business-systems 传没传、传了什么都无关。'
      + '不按报告期过滤 —— 告警表导出时已按首次发生时间落在报告期内（--start/--end 在下载层用掉），'
      + '本仓取值层不叠加第二道时间过滤（与告警定性那 14 格、G5/G100 同一条）。'
      + '边界：告警表为空（0 行）、或报告期内一条「内➝外」告警都没有时为 **0**'
      + '（0 是结论，不是缺数 —— 下载一定发生，告警表下不到时 scripts/build_report.py '
      + '直接报「缺少告警表的下载结果」、整份报告不出）；'
      + '表头里没有「访问方向」列（平台改了列名）时不写值、记入错误列表（禁止静默数出 0）。'
      + '算法见 stats/metrics/alarm.js 的 outboundAlarmCount。',
    compute: (ctx) => outboundAlarmCount(ctx),
    verify: ''
  },
  u('D25', '本次汇报周期被通报次数'),
  {
    addr: 'D27',
    label: '「重要时期安全日志数」',
    desc: '**重要时期**内网络安全日志 + 终端安全日志的条数之和。'
      + '重要时期的定义是「报告期 ∩ 中国法定节假日**放假整段**（含调休连休）」，'
      + '逐节日一条、每条裁到报告期内 —— 定义与数据见 stats/periods.js 的 importantPeriods '
      + '与 stats/holidays.js，用户口径 2026-10-14。'
      + '⚠️ **与 CLI 的 --protect-start/--protect-end 无关**（用户原话「重要时期与 cli 传入的'
      + '重保时间无关」；2026-10-27 起那两个参数只叫**护网时间**）—— 报告里 M3「护网时间」'
      + '走 ctx.protectRange，是另一回事。'
      + '做法（用户原话「按照日志查询接口，根据重要时间，**分段**查网络安全日志+终端安全日志，'
      + '无需额外的筛选条件…**分段的结果求和**」）：报告期先切成重要时期段，'
      + '**逐段**各问一次日志量接口（段内仍是"一次问两张表、相加"，与 G99 同一个端点、'
      + '同一种不筛的问法），各段的数再相加。分段与求和都发生在**下载层**'
      + '（要发 N 次请求，取值层是纯函数、不碰网络）—— 见 mssw_client.js 的 '
      + 'fetchMsswImportantPeriodLogCount 与 mssw_downloader.js 的 readImportantPeriodLogCount；'
      + '本格只把接口那一档翻成值，算法见 stats/metrics/important_period.js。'
      + '⚠️ 模板 E27 的备注 2026-10-27 已由用户改成「节假日，不算护网时间」，'
      + '与本格口径一致（旧备注「重保周期+重要节假日」当时按用户 2026-10-14 的明文口径'
      + '只算节假日、不含重保周期）。'
      + '边界：报告期内与任何节假日都不相交 -> **0**（那是结论，**连接口都不调**）；'
      + '两张表相加、**不去重**（同一件事两边各算一次）；'
      + '**某一段**接口调不通 -> **整格**写「接口不通无值」、不写"已通的那几段之和"'
      + '（后者会把"少算了几段"伪装成"算完了"，同 D21 对 D23 的加法穿透口径）；'
      + '「这段时间平台没收到日志」是另一档（接口答了、总数 0 -> 写 0）。'
      + '⚠️ 报告期越出节假日表覆盖范围（早于 2025-01-01 / 晚于 2028-12-31）时 '
      + 'importantPeriods 抛错、**整份报告停** —— 那是配置错（表不够用，要补 '
      + 'stats/holidays.js），不是缺数，不静默当作"这段没有节假日"。',
    compute: (ctx) => importantPeriodLogCount(ctx),
    verify: ''
  },
  {
    addr: 'D28',
    label: '「重要时期告警数」',
    desc: '「告警表」总表里，「最早发生时间」列**落在任一重要时期内**的行数'
      + '（用户口径 2026-10-14：「精确查找**告警表**的**「最早发生时间」**列，'
      + '如果里面的时间落在重要时间，就加一」）。'
      + '⚠️ 重要时期 = 报告期 ∩ 法定节假日放假整段，见 D27 那条与 stats/periods.js '
      + '（**与护网时间无关**；模板 E28 原来的备注「告警表在重保时间范围的」'
      + '2026-10-27 已由用户删除，本仓从来只按节假日段筛）。'
      + '⚠️ 实测「最早发生时间」这一列是**文本**（形如 `2026-09-30 20:56:18`），'
      + '与 D29 那一列（真 datetime -> epoch 秒）形态不同，两边都经 '
      + 'stats/metrics/rows.js 的 cellDateOnly 归一成 `YYYY-MM-DD` 再比。'
      + '匹配按**日期**、不按时刻：段的两端**闭区间**都算（节假日首日 `00:00:00` 与'
      + '末日 `23:59:59` 都算数，末日的次日 `00:00:00` 不算）。'
      + '计数口径：**按行计数，一行一票**，不去重、不按告警 ID / 主机IP 合并，也不看别的列。'
      + '数的是**全表**（与 --business-systems 无关），且**不叠加第二道时间过滤** —— '
      + '告警表导出时已按首次发生时间落在报告期内，重要时期 ⊆ 报告期，本格只在期内再筛一层。'
      + '边界：告警表为空（0 行）、或报告期内没有重要时期、或一条都不落在这几段内 -> **0**'
      + '（0 是结论，不是缺数）；该格时间是空串 / 占位符（`-`）/ 认不出的 -> 跳过那一行；'
      + '表头里没有「最早发生时间」列（平台改了列名）-> 不写值 + 记入错误列表'
      + '（禁止静默数出 0 —— 那与"一条都没有"长得一样）；'
      + '⚠️ 该列在、也有非空值，却**一个都解析不出**是日期 -> **抛错**（同上，不许静默 0）。'
      + '算法见 stats/metrics/important_period.js 的 importantPeriodAlarmCount。',
    compute: (ctx) => importantPeriodAlarmCount(ctx),
    verify: ''
  },
  {
    addr: 'D29',
    label: '「重要时期事件数」',
    desc: '「事件表」总表里，「事件创建时间」列**落在任一重要时期内**的行数'
      + '（用户口径 2026-10-14：「精确查找**事件表**的**「事件创建时间」**列，'
      + '如果里面的时间落在重要时间，就加一」）。'
      + '⚠️ 重要时期的定义、匹配口径（按日期、两端闭区间、一行一票、跳空值、缺列不写值、'
      + '整列解析不出则抛错）与 D28 **逐字相同** —— 差别只在**表与列**'
      + '（H4：两边共用 stats/metrics/important_period.js 里同一段计数逻辑）。'
      + '⚠️ 这一列是**平台导出的真列**，实测是**真 datetime**，经 scripts/parse_table_rows.py '
      + '后拿到的是 **epoch 秒（数字）** —— 与 D28 那列（文本）不同，'
      + '还原日期走 UTC（parse_table_rows.py 把 naive datetime 当 UTC 转，'
      + '走本地 getter 会在午夜附近把日期退回前一天），见 stats/metrics/rows.js 的 cellDateOnly。'
      + '⚠️ 别与预处理追加的「事件创建月份」（C58:N59 用的月份桶键）混为一列。'
      + '算法见 stats/metrics/important_period.js 的 importantPeriodEventCount。',
    compute: (ctx) => importantPeriodEventCount(ctx),
    verify: ''
  },
  u('D30', '「遏制率」'),
  {
    addr: 'D32',
    label: '资产覆盖率',
    mode: 'percent',
    desc: '**常量格**：报告里这一格永远写 100.00%，不由任何一份总表算出来 ——'
      + '用户口径 2026-10-13「D32 是资产覆盖率、D33 是威胁遏制率，默认写 100%」，'
      + '模板里这两格旁边本来就写着「默认100%」（E33）。'
      + '不按报告期过滤：它不读任何数据，报告期对它没有意义。'
      + '计数单位 / 去重规则：都不适用（一个常量，没有行、没有资产、也没有去重）。'
      + '无数据 / 分母为 0：不适用 —— 它**永远落值**，没有"缺数"这一档：'
      + '一份总表都没接、总表全空、甚至平台改了列名，它照写 100.00%。'
      + '落法：按 percent 模式写**小数 1**、格子数字格式 0.00%（CELL_REGISTRY.md §4），'
      + '报告里显示 100.00%；不是字符串「100%」、也不是数字 100。'
      + '⚠️ 与 D33 的默认值相同，但**不是一个量**（两条各自独立的指标口径），'
      + '刻意不走 alias：见 stats/metrics/protection.js 的头注。',
    compute: () => defaultProtectionRate(),
    verify: ''
  },
  {
    addr: 'D33',
    label: '威胁遏制率',
    mode: 'percent',
    desc: '**常量格**：报告里这一格永远写 100.00%，不由任何一份总表算出来 ——'
      + '用户口径 2026-10-13「D32 是资产覆盖率、D33 是威胁遏制率，默认写 100%」，'
      + '模板里这一格旁边本来就写着「默认100%」（E33，且这一格原来的数字格式就是 0%）。'
      + '不按报告期过滤：它不读任何数据，报告期对它没有意义。'
      + '计数单位 / 去重规则：都不适用（一个常量，没有行、没有资产、也没有去重）。'
      + '无数据 / 分母为 0：不适用 —— 它**永远落值**，没有"缺数"这一档：'
      + '一份总表都没接、总表全空、甚至平台改了列名，它照写 100.00%。'
      + '落法：按 percent 模式写**小数 1**、格子数字格式 0.00%（CELL_REGISTRY.md §4），'
      + '报告里显示 100.00%；不是字符串「100%」、也不是数字 100。'
      + '⚠️ 与 D32 的默认值相同，但**不是一个量**（两条各自独立的指标口径），刻意不走 alias'
      + '（H5 说的是"一个值写到多个地址"，这里只是两格今天都落在同一个默认值上）——'
      + '见 stats/metrics/protection.js 的头注。',
    compute: () => defaultProtectionRate(),
    verify: ''
  },
  {
    addr: 'D34',
    label: '高危漏洞防护率',
    mode: 'percent',
    desc: '**分子 ÷ 分母**（用户口径 2026-10-26，同日修订：分子只读内网）：'
      + '分母 = **两份漏洞表**（ctx.vulnRows = 内网 + 互联网）里「修复优先级」列'
      + '**整格精确等于**「急需修复」的行数'
      + '（用户说的「高」按表里实际取值「急需修复」算，与 D83 同一个取值）；'
      + '分子 = **只在内网漏洞表**（ctx.vulnInnerRows）里，同时满足「修复优先级」=「急需修复」、'
      + '「AF 防护规则」整格精确等于「有效」'
      + '且「处置状态」整格精确等于「处置完成（已缓解）」的行数'
      + '（用户说的「已处置（已缓解）」按表里实际写法算，与 D14 同一个取值）。'
      + '⚠️ 「AF 防护规则」只有内网表有（平台新增列），所以外网的高危漏洞只进分母、不进分子 ——'
      + '分母 > 0 时比率到不了 100% 是正常结果。'
      + '整格精确相等、只去首尾空白，不做包含 / 前缀 / 全半角归一；按行计数、不去重、'
      + '不按报告期过滤。落法：percent 模式写小数。'
      + '边界：表为空或分母为 0 -> 写「无高危漏洞，所以无防护率」（**不写 0**，'
      + '同 F83/F84/F85）；分母 > 0、分子为 0（含内网表 0 行）-> 写 0；'
      + '有行却缺「修复优先级」列（或分母 > 0 时内网那份缺「AF 防护规则」/「处置状态」列）'
      + '-> 不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 highVulnProtectionRate。',
    compute: (ctx) => highVulnProtectionRate(ctx),
    verify: ''
  },
  {
    addr: 'D35',
    label: '平均分析时间',
    desc: '事件表里「推送状态」**整格精确等于**「已推送」的那些事件行，取它们「识别时长」'
      + '列里**所有非空值**的平均数（单位：分钟）。用户口径 2026-10-13：「D35 是平均分析时间，'
      + '取值是精确查找『推送状态』列，如果值精确匹配『已推送』，算命中。然后精确查找这些事件的'
      + '『识别时长』列，算出所有非空的识别时长的平均值」。'
      + '判据是**整格精确相等**（比较前只去首尾空白）：`未推送` 不算、空格子不算、'
      + '平台的占位符 `-` 不算、带后缀的 `已推送（XX）` 也不算（不是同一个字符串）。'
      + '计数口径：一行一票，不去重、不按事件名称 / 事件 ID / 影响资产合并；'
      + '识别时长为空（或算不出来）的行**不进分母**（只对非空值求平均，不是按 0 参与）。'
      + '「识别时长」不是平台导出的列：它由表格预处理按「事件创建时间 − 组件检出时间」'
      + '算出来（分钟、2 位小数，负差值判为不合法、留空）追加进事件表下载件，'
      + '本格只读不算 —— 与 G7 的「遏制时长」、D36/E49 的「响应时长」/「处置时长」'
      + '同一处实现（stats/metrics/event.js 的 append_duration_columns 是 Python 侧，'
      + '见 scripts/report_preprocess.py）。'
      + '不按报告期过滤：事件表导出时已按 --start/--end 圈定。'
      + '没有可平均的样本时写 **0**、不记错误（用户口径 2026-10-13「没有就写0」，与 G9 同一条）——'
      + '这包括：事件表为空（0 行）、一行「已推送」都没有（全是不认的值 / 空）、'
      + '命中的行识别时长全为空。'
      + '只有缺列才不写值 + 记错误：缺「推送状态」，或缺预处理追加的「识别时长」'
      + '（后者意思是预处理那一步没算出这一列 —— 两个时间源列凑不齐）。'
      + '⚠️ 与 G9「事件平均响应时长」**不是同一个格**：G9 只在 G8 那批**已处置**事件里挑'
      + '「已推送」，本格一道处置状态的筛都没有 —— "推送了但还在待处置"的事件算本格、不算 G9，'
      + '所以两格会算出不同的数（也不能互相 alias）。'
      + '⚠️ 与同列的 G51「平均识别时长」**不是同一个数**：本格只数「推送状态」=「已推送」那批，'
      + 'G51 数**全表**（用户口径 2026-10-13 第二版「不用跟推送状态挂钩」）——'
      + '同一份表上两个数必须不一样。用户当天早些时候曾让 G51 复用本格，'
      + '那条已经撤掉，别再按「G51 = D35」去读。',
    compute: (ctx) => averagePushedDurationMinutes(ctx, RECOGNIZE_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'D36',
    label: '平均响应时间',
    desc: '与 D35 同一套口径，算的是另一列：事件表里「推送状态」**整格精确等于**「已推送」的'
      + '那些事件行，取它们「响应时长」列里**所有非空值**的平均数（单位：分钟）。'
      + '用户口径 2026-10-13：「D36 是平均响应时间同理，算的是『响应时长』列」——'
      + '两格只差一个时长列，共用 stats/metrics/event.js 的 averagePushedDurationMinutes（H4）。'
      + '判据、计数口径、报告期、边界全部同 D35：精确相等（`未推送` / 空 / `-` / 带后缀的都不算）、'
      + '一行一票不去重、空时长不进分母、不过滤报告期（事件表导出时已按 --start/--end 圈定）、'
      + '没有可平均的样本写 **0** 且不记错误、缺列才不写值 + 记错误'
      + '（缺「推送状态」/ 缺预处理追加的「响应时长」）。'
      + '「响应时长」不是平台导出的列：由表格预处理按「专家研判时间 − 组件检出时间」算出来'
      + '（分钟、2 位小数，负差值留空）追加进下载件，本格只读不算。'
      + '⚠️ 与 G9「事件平均响应时长」**读的是同一列、但不是同一个格**：G9 多一道'
      + '「已处置」（已遏制 / 处置完成 / 已忽略）的筛，本格不要求处置状态 ——'
      + '两个数会不一样，不能互相 alias。'
      + '⚠️ 与同列的 G52「平均响应时长」**不是同一个数**：本格只数「推送状态」=「已推送」那批，'
      + 'G52 数**全表**（用户口径 2026-10-13 第二版「不用跟推送状态挂钩」），'
      + 'G52 那条 alias 已撤掉。'
      + '⚠️ 本格**被 D49「事件平均响应时间」复用**（alias，用户口径 2026-10-13「复用D36」）：'
      + '改本格的口径等于同时改 D49，两格永远同值（D36 是主地址，算法只写在本条）。'
      + '⚠️ 五个时长列（遏制 / 识别 / 处置 / 响应 / 闭环）**逐列独立**：'
      + '「识别时长」算不出来时只停 D35，本格照常落值（用户口径 2026-10-12）；'
      + 'E49（处置时长）与本格读的是不同的列，E49 停不停都不影响本格，反之亦然。',
    compute: (ctx) => averagePushedDurationMinutes(ctx, RESPONSE_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'D37',
    label: '已闭环漏洞数量',
    desc: '同 D15 —— 本格与 D15「已修复漏洞数」是**同一个数**：'
      + '「漏洞表」总表中「处置状态」列的值**包含**「处置完成」的行数'
      + '（用户口径 2026-10-13：「精确查找漏洞表『处置状态』列，找值严格匹配『处置完成』的，'
      + '算命中，算总数」—— 与 D15 是同一个投喂；判据 2026-10-16 曾随 D15 改成前缀，'
      + '2026-10-22 又随 D15 改回整格精确相等，2026-10-26 再随 D15 改成包含，'
      + '两个地址始终同源）。'
      + 'D15 是主地址，算法只写在它那一条记录里（stats/metrics/vuln.js 的 settledVulnCount）；'
      + '本格走 alias，不重抄一遍、也不另起一条 compute（H5）——'
      + '这一对与 D68 = D12 / G102 = G8 / C49 = D38 / D49 = D36 是同一条规矩。'
      + '算法、口径边界、空表行为全部见 D15 的 desc，本格一个字都不重算：'
      + '包含判据（四种带括号的形态**都算**；「处置中」「待处置」不算；'
      + '带括号的「处置完成（误报）」判据会认它，它在下载层预处理时已整行删掉'
      + '（用户口径 2026-10-21，scripts/extract_vuln_report.py 的 drop_false_positive_rows）；'
      + '比较前只去首尾空白）、按行计数一行最多一条、'
      + '全表 = 内网 + 外网两份相加（与 IP 无关）、'
      + '不按报告期过滤、空表或一条都没命中写 0、缺「处置状态」列则不写值 + 记错误。'
      + '⚠️ 两条连带后果，看报告的人要知道：'
      + '① 本格与 D15 在报告上是**两个格子里的同一个数**（两个标题不一样，值一样）——'
      + '改 D15 的口径等于同时改本格，反之亦然；'
      + '② 本格因此**不读告警表、不读事件表**（登记表里别的 D37 候选口径牵涉不到它）。'
      + '⚠️ 用户口径 2026-10-13 先给的是「D37 = G14 + G5 的值」，随后**已改成本条**'
      + '（同一天、同一格），以本条为准 —— 别照旧口径去读 G14/G5。',
    alias: 'D15',
    verify: ''
  },
  {
    addr: 'D38',
    label: '威胁和事件数量',
    desc: '「事件表」总表的**事件行数** —— 整张表有多少行数据就是多少'
      + '（用户口径 2026-10-13：「D38 是威胁和事件数量，取事件表所有事件总行数，'
      + '可能其他单元格也算过这个，不要复用，重新查」）。'
      + '计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并；'
      + '也不看任何一列的内容（不看「处置状态」、不看「GPT定性标签」、不看「GPT研判结论」）。'
      + '⚠️ 这一格**一个列名都不读** —— 数的是下载件里有多少行，平台改了列名、多一列少一列'
      + '都影响不到它。所以它不会因为"列名对不上"而不写值，也没有缺列这一档'
      + '（读表的格子里只有它、G101「xdr事件数」、G100「xdr告警数」是这样）。'
      + '⚠️ 与 G101「xdr事件数」**口径逐字相同、同一份表上值必然相等，却刻意不走 alias**：'
      + '投喂的原话是「不要复用，重新查」—— 本格有自己的 compute（也调到'
      + 'stats/metrics/event.js 的 eventRowCount），不是 alias 指向 G101。'
      + '要的是"这一格自己也去数一遍"，不是"抄隔壁那一格的值"：所以**别**为了省一条 compute '
      + '把它改成 alias（H5 在这一格被这次投喂显式压过，与 D32/D33 那对"同值却刻意不互 alias"'
      + '是同一个形状）。C49「安全事件总数」才是复用方 —— 它 alias 本格。'
      + '⚠️ 与同表的 G8「处置安全事件总数」/ G102 / G106 / G107 **不是一回事**：'
      + '那几格要「处置状态」精确命中某个值，本格一行都不筛 —— 同一份事件表上本格是"全表行数"，'
      + '那几格各自只是它的一个子集（处置状态为空 / 占位符 `-` 的行只进本格）。'
      + '不按报告期过滤 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '边界：事件表为空（0 行）-> 写 **0**（0 是结论，不是缺数 —— 下载一定发生，'
      + '事件表下不到时 scripts/build_report.py 直接报「缺少事件表的下载结果」、整份报告不出）。'
      + '⚠️ 标题是「威胁和事件数量」、口径却只数事件表这一张表：本格**不读告警表**、'
      + '也不做任何"威胁 ＋ 事件"的相加 —— 按 R5，以这次投喂的口径为准。',
    compute: (ctx) => eventRowCount(ctx),
    verify: ''
  },
  u('D39', '两名高级安全工程师成本'),
  {
    addr: 'D49',
    label: '事件平均响应时间',
    desc: '同 D36 —— 本格与 D36「平均响应时间」是**同一个数**（用户口径 2026-10-13：'
      + '「D49 是事件平均响应时间，复用D36」）。'
      + 'D36 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界（事件表「推送状态」整格精确等于「已推送」的行、取「响应时长」列的'
      + '非空均值、没有可平均的样本写 0、只有缺列才不写值 + 记错误）全部见 D36 的 desc，'
      + '本格一个字都不重算。'
      + '⚠️ 复用带来的一条后果要记住：本格也因此与 G9「事件平均响应时长」**不是同一个数**'
      + '（D36 那道筛里**没有**处置状态，G9 只数已处置事件里已推送的，详见 D36 的 desc）——'
      + '别以为模板第 49 行这块的「事件平均响应时间」与 G9 是同一个口径。',
    alias: 'D36',
    verify: ''
  },
  categoryCell('D51', 0, 'count'),
  categoryCell('D52', 1, 'count'),
  categoryCell('D53', 2, 'count'),
  categoryCell('D54', 3, 'count'),
  categoryCell('D55', 4, 'count'),
  monthCell('D58', 1, 'label'),
  monthCell('D59', 1, 'mean'),
  {
    addr: 'D61',
    label: '外部攻击日志数量（XDR）',
    desc: '**报告期内从外部打进来的攻击日志条数**（用户口径 2026-10-17，浏览器抓包）。'
      + '数据来自**日志量接口**（不是六份总表里的任何一份：没有下载件、没有 parse 环节、'
      + '报告里也没有对应的 sheet）：与 G99「xdr日志数」/ D23「已拦截外联次数」'
      + '**是同一个端点上的第三种问法** —— '
      + 'POST /gateway/mss-mdr/web/api/mssw/mss-mdr/v1/logs-aggregations-count，'
      + '只问**网络安全日志一张表**（`tableName: ["network_security_log"]`，抓包里没有终端安全日志），'
      + '`searchString` 为 `filter srcIpTag=0 AND dstIpTag=1`，取 `data.total`'
      + '（调用见 mssw_client.js 的 fetchMsswExternalAttackLogCount）。'
      + '过滤串的方向：`srcIpTag=0` 是外、`dstIpTag=1` 是内，即「外→内」—— '
      + '与 D23 的「内→外」（`srcIpTag=1 AND dstIpTag=0`）**正好反方向**，'
      + '而且本格**不带**「已拦截」`action = 2`：数的是全部外部攻击日志，不是其中被拦下的那部分。'
      + ' ⚠️ 两个条件之间是 AND；`0` / `1` 是抓包原样的取值，别改成中文或写成包含匹配。'
      + '其余请求体字段与 G99/D23 完全一致：时间给 **epoch 秒**、「客户」靠请求体里那条'
      + '「客户 = 当前客户」的约束圈（请求头不带 `x-mssw-company-id`）。'
      + '计数口径：**按日志条数**，一行一票，不去重、不按源 IP / 攻击目标合并 —— '
      + '两条日志指向同一个源时算 2（与 G99/D23 同一条：平台怎么数，就照它数）。'
      + '报告期**就是命令行 --start/--end**（用户口径 2026-10-13，与 G99/D23 同一把尺子）：'
      + '起 = 起始日 00:00:00、止 = 结束日 23:59:59（本地时区）换算成秒；'
      + '⚠️ 抓包里那两个数差整 30 天，是浏览器前端的默认窗口，**不是口径**，不做任何收窄。'
      + '与 --business-systems 无关：日志量是整个租户的，不按业务系统圈。'
      + '边界：报告期内一条外部攻击日志都没有（接口答了、total 是 0）时本格写 **0**'
      + '（0 是结论，不是缺数）；**接口调不通**时写「**接口不通无值**」'
      + '（长期口径：接口不通**不拦整份报告**，这一格就写这六个字 —— 不是 0，也不是不写值；'
      + '真实原因在运行日志里）。⚠️ 本格与 G99 / D23 **各断各的**：'
      + '本格不通不影响另外两格落值，反之亦然（下载层是三次独立的问）；'
      + '接口**没给数量**（`data.total` 不是数字）-> 不写值 + 记错误（禁止静默当 0）。'
      + '显示格式：模板里 D61 单独用 `#,##0`（**直接显示条数**，用户口径 2026-10-17）；'
      + '模板原来那个 `0\\.0,"万"` 格式（一个逗号 = 除以 1000，154 会显示成 0.2万）不再用于本格 —— '
      + '取值层照旧落接口原数，格式只在显示层生效。',
    compute: (ctx) => externalAttackLogCount(ctx),
    verify: ''
  },
  {
    addr: 'D62',
    label: '实时威胁告警数量',
    desc: '**同 G5「威胁告警总」**（用户口径 2026-10-19：D62 是实时威胁告警数量，alias G5），'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 G5 那条 `desc`：告警表全表里「GPT研判结论」'
      + '整格精确等于「真实攻击未成功」的告警行数；空表写 0；'
      + `表里有行、却没有「GPT研判结论」列时写「${GPT_VERDICT_MISSING_TEXT}」。`
      + '⚠️ 缺数也**跟着 G5 走**：G5 没算出值时本格进 `errors`，报的是'
      + '「alias 目标 G5 没有算出值」，而不是「没读到告警表」—— 因为它根本不读表。',
    alias: 'G5',
    verify: ''
  },
  {
    addr: 'D63',
    label: 'MSS威胁工单数量',
    desc: '（用户口径 2026-10-19，投喂原话：「取值是精确查找事件表“GPT研判结论”列，'
      + '如果值精确匹配“真实攻击未成功”就加一」）'
      + '「事件表」里「GPT研判结论」**整格精确等于**「真实攻击未成功」的**行数**。'
      + '选行判据与 G5/G7/G14 是同一句（比较前只去首尾空白、不做全半角 / 括号归一：'
      + '「真实攻击成功」「真实攻击未成功（疑似）」「等待GPT研判」、占位符「-」都不算命中）。'
      + '与 G7 的选行范围逐字相同（整张事件表、不按 IP 圈行），只是 G7 取遏制时长均值、本格数行；'
      + '与 G14 的差别是本格**不按核心系统 IP 集合**圈行。'
      + '计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并。'
      + '不按报告期过滤 —— 事件表导出时已按 --start/--end 圈定，取值层不叠加第二道时间过滤。'
      + '事件表为空（0 行）、或表里有行但一行都没命中时，本格写 **0**（那是结论，不是缺数）。'
      + '表里有行、却缺「GPT研判结论」列时记入错误列表、不写值（缺列是唯一不落值的那一档）。',
    compute: (ctx) => gptVerdictEventCount(ctx),
    verify: ''
  },
  u('D64', '威胁工单平均响应时间'),
  u('D65', '安全设备策略检查次数'),
  u('D66', '已优化的策略风险数量'),
  {
    addr: 'D67',
    label: '最新威胁情报数量',
    desc: '（用户口径 2026-10-19，投喂原话：「精确查找两个漏洞表的『漏洞标签』列，'
      + '如果值包含『热点漏洞』，则加一」）'
      + '内网 + 外网两份漏洞表**全表**里「威胁标签」列含「热点漏洞」的**行数**。'
      + '按行计数、一行最多算一条、不按漏洞名称合并；全表 = 两份的行拼起来再数（见 D12）。'
      + '判据是**子串包含**（标签串是顿号 / 全角逗号拼的多值文本，`热点漏洞、勒索利用` 算），'
      + '只认「热点漏洞」这一个标签，只含「高可利用」不算（D10 是它的镜像）。'
      + '⚠️ 投喂写的是「漏洞标签」，平台导出件的实际表头是**「威胁标签」**'
      + '（`tmp/out/vuln_extract/漏洞表.xlsx` 两份 sheet 逐字命中，31 列里没有「漏洞标签」），'
      + '本仓按「威胁标签」读。'
      + '不按报告期过滤。漏洞表为空（0 行）、或一条热点漏洞都没有时写 **0**（是结论不是缺数）；'
      + '表头里没有「威胁标签」列（平台改了列名）时不写值、记入错误列表。',
    compute: (ctx) => hotVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D68',
    label: '最新威胁影响资产数',
    desc: '**同 D12「最新漏洞影响资产数」**（用户口径 2026-10-19：先给过一版独立口径'
      + '「上述值包含『热点漏洞』的行，精确查找『风险资产』列。去重统计里面的值，算总数」，'
      + '随后改成「D68 改成 alias D12」—— 以改后的为准）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D12 那条 `desc`：两份漏洞表全表里「威胁标签」'
      + '含「热点漏洞」的行，「风险资产」归一后去重数台数；空表 / 无命中写 0；'
      + '缺「威胁标签」或「风险资产」列时不写值 + 记错误。'
      + '⚠️ 缺数也**跟着 D12 走**：D12 没算出值时本格进 `errors`，报的是'
      + '「alias 目标 D12 没有算出值」，而不是「没读到漏洞表」—— 因为它根本不读表。',
    alias: 'D12',
    verify: ''
  },
  monthlyAttackCell('D71', 1, 'label'),
  monthlyAttackCell('D72', 1, 'count'),
  monthlyOutboundCell('D73', 1),
  monthlyAlarmCell('D75', 1),
  {
    addr: 'D80',
    label: '已闭环外网资产漏洞数',
    desc: '「互联网漏洞表」里「处置状态」列的取值**包含**「处置完成」的行数。'
      + '用户口径（2026-10-21）：「互联网漏洞表精确查找『处置状态』列的状态包含『处置完成』，'
      + '就加一」——「精确查找」指按列名逐字找到这一列，判据本身是**包含**：'
      + '`处置完成`、`处置完成（已修复）`、`处置完成（已缓解）` 这类带括号的都算，'
      + '`待处置` / `处置中` 不算。比较前只去首尾空白。'
      + '只数「互联网漏洞表」这一张 sheet，**内网那份不算** —— 数据源是 ctx.vulnOuterRows'
      + '（下载层单独读的那张表），不是内网 + 外网拼起来的 ctx.vulnRows。'
      + '按行计数，一行最多算一条；不去重、不按漏洞名称合并；'
      + '不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D15 同一条）。'
      + '互联网漏洞表为空（0 行）-> 写 0（结论，不是缺数）；'
      + '表里有行、却没有「处置状态」列 -> 不写值 + 记错误。'
      + '⚠️ 与 D15「已修复漏洞数」读同一列、判据相同（都含「处置完成」）：D15 是**全表**'
      + '（内网 + 外网）的行数，本格是**只看互联网漏洞表**的行数 —— 同一份数据上两个数'
      + '一般不相等（范围不同），谁把本格写成 D15 的 alias 就错在这一格。'
      + '口径见 stats/metrics/vuln.js 的 closedOuterVulnCount。',
    compute: (ctx) => closedOuterVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D83',
    label: '高危漏洞',
    desc: '（用户口径 2026-10-23，投喂原话：「D83 D84 D85分别是高危漏洞、中危漏洞和低危漏洞。'
      + '精确查找两个漏洞表『修复优先级』列。分别精确匹配值是『急需修复』、『尽快修复』和'
      + '『建议修复』，各自计数」）'
      + '读**漏洞表全表**（内网 + 互联网两份拼成 ctx.vulnRows），数「修复优先级」'
      + '**整格精确等于**「急需修复」的行数。'
      + '「精确匹配」= 整格相等（比较前只去首尾空白），不是包含、也不是前缀，'
      + '不做全半角归一。按行计数、一行一条；不去重、不按漏洞名称合并；'
      + '不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定）。'
      + '边界：漏洞表 0 行 / 一条都不命中 -> 写 0（是结论，不是缺数）；'
      + '有行但缺「修复优先级」列 -> 不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 highPriorityVulnCount。',
    compute: (ctx) => highPriorityVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D84',
    label: '中危漏洞',
    desc: '（用户口径 2026-10-23）同 D83，只把「修复优先级」的判据换成整格精确等于'
      + '「尽快修复」，读同一张漏洞表全表（ctx.vulnRows）。'
      + '三格（D83/D84/D85）判据逐字相同、只差一个取值，共用'
      + 'stats/metrics/vuln.js 的 fixPriorityVulnCount。'
      + '按行计数、不去重、不按报告期过滤；空表 / 无命中写 0；缺「修复优先级」列不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 mediumPriorityVulnCount。',
    compute: (ctx) => mediumPriorityVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D85',
    label: '低危漏洞',
    desc: '（用户口径 2026-10-23）同 D83，只把「修复优先级」的判据换成整格精确等于'
      + '「建议修复」，读同一张漏洞表全表（ctx.vulnRows）。'
      + '三格（D83/D84/D85）判据逐字相同、只差一个取值，共用'
      + 'stats/metrics/vuln.js 的 fixPriorityVulnCount。'
      + '按行计数、不去重、不按报告期过滤；空表 / 无命中写 0；缺「修复优先级」列不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 lowPriorityVulnCount。',
    compute: (ctx) => lowPriorityVulnCount(ctx),
    verify: ''
  },
  monthlyVulnCell('D86', 1, 'label'),
  monthlyVulnCell('D87', 1, 'count'),
  monthlyVulnCell('D88', 1, 'closed'),
  {
    addr: 'D90',
    label: '「重要时期值守次数」',
    desc: '用户传入的起止时间内**命中的节假日个数**'
      + '（用户口径 2026-10-26：「D90 是重要时期值守次数，计算的是用户传入的起止时间内，'
      + '命中的节假日的数量」）。'
      + '「重要时期」的唯一定义与 D27/D28/D29 同一个 —— 报告期 ∩ 中国法定节假日**放假整段**，'
      + '逐节日一条、每条裁到报告期内，见 stats/periods.js 的 importantPeriods 与 '
      + 'stats/holidays.js（数据 2025–2028，含调休连休；2025 国庆中秋按官方原文合并成一条）。'
      + '⚠️ **与 CLI 的 --protect-start/--protect-end 无关**（同 D27 那条：那是 M3「护网时间」）。'
      + '数的单位是**节假日条目**，不是一个一个数天数、也不是各段天数之和：'
      + '报告期 2026-09-24~2026-10-05 -> 中秋节 + 国庆节 = **2**（国庆右端被报告期裁短，仍算 1 次）；'
      + '2025-10-01~10-08 国庆中秋合并的那一段只算 **1** 次。'
      + '⚠️ **上限 7**（用户口径 2026-10-29）：法定节假日表一年最多 7 条，跨年报告期会命中'
      + '两年合起来的条目（如 2026-01-01~2027-12-31 共 14 条），但报告上只有 7 个槽位'
      + '（F91:F97 / L4:L10 取最晚 7 条），所以本格跟着封顶 7、不数出 14。'
      + '一个总表都不读、不调任何接口（数据源是中性的日期表）。'
      + '边界：报告期内与任何节假日都不相交 -> **0**（是结论，不是缺数）；'
      + '⚠️ 报告期越出节假日表覆盖范围（早于 2025-01-01 / 晚于 2028-12-31）时 '
      + 'importantPeriods 抛错、**整份报告停** —— 那是配置错（表不够用，要补 stats/holidays.js），'
      + '不是缺数，不静默当作"这段没有节假日"。'
      + '算法见 stats/metrics/important_period.js 的 importantPeriodDutyCount。',
    compute: (ctx) => importantPeriodDutyCount(ctx),
    verify: ''
  },
  {
    addr: 'D91',
    label: '「重要时期安全事件数」',
    desc: '「事件表」总表里，「事件创建时间」列**落在任一重要时期内**的行数'
      + '（用户口径 2026-10-26：「D91 是重要时期安全事件数，精确查找事件表『事件创建时间』列，'
      + '如果时间命中节假日的时间区间就加一」）。'
      + '⚠️ 判据与 D29「重要时期事件数」**逐字相同** —— 同一个「重要时期」定义'
      + '（报告期 ∩ 法定节假日放假整段，见 D27 那条与 stats/periods.js）、'
      + '同一列、同一套匹配口径，所以共用 stats/metrics/important_period.js 的 '
      + 'importantPeriodEventCount（H4），两格的值在任何输入下都必然相等；'
      + '但**各自登记、不走 alias**（与 D38/G101 同款：用户把口径直接投在这一格上，'
      + '缺「事件创建时间」列时本格自己报"找不到列"，而那正是平台改列名的现场）。'
      + '⚠️ 这一列实测是**真 datetime**，经 scripts/parse_table_rows.py 后是 **epoch 秒**，'
      + '经 stats/metrics/rows.js 的 cellDateOnly 归一成 `YYYY-MM-DD`（epoch 还原走 UTC）再比。'
      + '匹配按**日期**、不按时刻；段的**两端闭区间**都算（节假日首日、末日都数，末日次日不算）；'
      + '**一行一票**、不去重、不看别的列；'
      + '该列空值 / 占位符（`-`）/ 认不出 -> 跳过那一行。'
      + '边界：事件表为空（0 行）、或报告期内没有重要时期、或一条都不落在段内 -> **0**'
      + '（0 是结论，不是缺数）；'
      + '表头里没有「事件创建时间」列（平台改了列名）-> 不写值 + 记入错误列表'
      + '（禁止静默数出 0 —— 那与"一条都没有"长得一样）；'
      + '⚠️ 该列在、也有非空值，却**一个都解析不出**是日期 -> **抛错**（同上，不许静默 0）。'
      + '算法见 stats/metrics/important_period.js 的 importantPeriodEventCount。',
    compute: (ctx) => importantPeriodEventCount(ctx),
    verify: ''
  },
  u('D92', '业务可用性保障'),
  deviceCell('D100', 'SIP数量', SIP_DEVICE_TYPES,
    '`devType = 9`（SIP）'),
  deviceCell('D101', 'AF数量', AF_DEVICE_TYPES,
    '`devType = 3`（AF）'),
  deviceCell('D102', 'STA数量', STA_DEVICE_TYPES,
    '`devType = 25`（STA）—— ⚠️ **只有 25 这一个代号，没有 999**'
      + '（用户口径 2026-10-13；M1 骨架那条登记里写的"type=25+999"是当时猜的，已废弃）'),
  {
    addr: 'D103',
    label: '第三方数量',
    desc: '组件块（模板第 103 行，行名「第三方」）里接入的**第三方设备台数**。'
      + THIRD_PARTY_RULES
      + THIRD_PARTY_MISSING,
    compute: (ctx) => thirdPartyDeviceCount(ctx),
    verify: ''
  },
  deviceCell('D104', 'EDR数量', EDR_DEVICE_TYPES,
    '**EDR 家族的 6 个代号**：`12`（EDR 本体）、`37`（CWPP）、`100038`（SaaS-EDR-探针版）、'
      + '`50038`（EDR-探针版）、`100012`（SAAS EDR）、`69`（SaaS NGES）—— '
      + '⚠️ **整族都数**（用户口径 2026-10-13「数全部家族的 6 个」），别只认 12 这一个'),
  u('D110', '高危漏洞总数'),
  u('D111', '高危漏洞唯一IP数'),
  {
    addr: 'D112',
    label: '弱口令+账号安全',
    desc: '同 D11 —— 本格与 D11「管理员弱口令数量」同值（用户口径 2026-10-22：'
      + '「D112是管理员弱口令数量，alias D11」）。'
      + 'D11 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界（核心资产集合、弱密码表一段 + 事件表一段、按行计数不去重、'
      + '不按报告期过滤）、空表与缺列行为全部见 D11 的 desc，本格一个字都不重算。'
      + '⚠️ 本格因此不读表：D11 缺「重要级别」/「风险资产」等判据列时两格一起不写值 + 记错误。',
    alias: 'D11',
    verify: ''
  },
  {
    addr: 'D113',
    label: '受影响资产IP数',
    desc: '核心资产上的弱口令**去重资产数**（用户口径 2026-10-22：「D113是管理员弱口令'
      + '去重资产数，取值是D11的分两步取值的时候，对命中的事件/弱密码，对事件表的'
      + '『影响资产』列/两个弱密码表的风险资产列进行去重计数，求和」）。'
      + '范围与 D11 逐字相同：资产表里「重要级别」列**精确等于**「核心」的那些行，'
      + '取该行「IP地址」得到核心资产 IP 集合（精确相等，不是包含）。'
      + '第一段：弱密码表（内网 + 互联网两份，ctx 里已拼接成全表）里「风险资产」属于'
      + '核心资产集合的行，把「风险资产」经 normalizeIp 归一后**去重**，数集合大小'
      + '（两表之间也一起去重）。'
      + '第二段：事件表里「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」中任意一个、'
      + '**且**「影响资产」属于核心资产集合的行，把「影响资产」归一后**去重**，数集合大小。'
      + '两段分别去重后**相加**（不是跨两表并成一个集合：同一台资产既在弱密码表、'
      + '又在事件表命中时，两段各计 1 台，本格计 2）。'
      + '⚠️ 与 D11 的唯一区别是归总方式：D11 数行数（同一台资产两条就是 2），'
      + '本格数台数（同一台资产两条只算 1）；选行判据与 D11 是同一份（H4）。'
      + '不按报告期过滤（与 D11 同一条）。'
      + '边界：弱密码表（两份）或事件表为空（0 行）时，那一段就是 0、另一段照算；'
      + '资产表为空、核心资产一台都没有、或核心资产上确实没有弱口令时，本格为 0'
      + '（都是结论，不是缺数）；'
      + '资产表缺「重要级别」/「IP地址」、弱密码表缺「风险资产」、事件表缺「影响资产」/'
      + '「安全事件二级分类」列时不写值、记入错误列表。',
    compute: (ctx) => adminWeakPwdAssetCount(ctx),
    verify: ''
  },
  u('D114', '未公开威胁事件数'),
  {
    addr: 'D115',
    label: '未公开威胁去重资产数',
    desc: '**同 D12「最新漏洞影响资产数」**（用户口径 2026-10-22：「D115 是未公开威胁去重资产数，'
      + 'alias D12」）。走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D12 那条 `desc`：漏洞表全表里「威胁标签」含'
      + '「热点漏洞」的行，按「风险资产」归一后去重数台数；空表 / 无命中写 0；'
      + '缺「威胁标签」或「风险资产」列时不写值 + 记错误。'
      + '⚠️ 缺数也**跟着 D12 走**：D12 没算出值时本格进 `errors`，报的是'
      + '「alias 目标 D12 没有算出值」—— 因为它根本不读表。',
    alias: 'D12',
    verify: ''
  },
  {
    addr: 'D116',
    label: '已防护漏洞数',
    desc: '**同 D14「已防护漏洞数」**（用户口径 2026-10-22：「D116 是已防护漏洞数，alias D14」）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D14 那条 `desc`：内网漏洞表里「AF 防护规则」'
      + '整格等于「有效」且「处置状态」整格等于「处置完成（已缓解）」的行数；'
      + '空表 / 无命中写 0；缺这两列时 D14 不写值 + 记错误，本格跟着进 `errors`'
      + '（报「alias 目标 D14 没有算出值」）。',
    alias: 'D14',
    verify: ''
  },
  {
    addr: 'D117',
    label: '已修复漏洞数',
    desc: '**同 D15「已修复漏洞数」**（用户口径 2026-10-22：「D117 是已修复漏洞数，alias D15」）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D15 那条 `desc`：漏洞表全表（内网 + 互联网两份）里'
      + '「处置状态」**包含**「处置完成」的行数（带括号的四种形态都算）；'
      + '空表 / 无命中写 0；缺「处置状态」列时不写值 + 记错误，本格跟着进 `errors`。',
    alias: 'D15',
    verify: ''
  },
  {
    addr: 'D118',
    label: '已处置管理员弱口令数',
    desc: '**同 D16「已处置弱口令数量」**（用户口径 2026-10-22：「D118 是已处置管理员弱口令数，'
      + 'alias D16」；模板标题措辞不同，取的是同一个数）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D16 那条 `desc`：弱密码表（内网 + 互联网两份）里'
      + '「处置状态」整格等于「处置完成」的行数 + 事件表里二级分类含「弱口令」且'
      + '「处置状态」整格等于「处置完成」的行数，两段相加、不去重；'
      + '任一段空表 -> 那一段 0、另一段照算；缺列 -> 整格不写值 + 记错误，本格跟着进 `errors`。',
    alias: 'D16',
    verify: ''
  },
  u('D121', '漏洞通报数+15-3/15-4/15-5（冻结字面量）'),
  u('D122', '高危+最新漏洞影响资产'),
  u('D126', '网站篡改/黑链事件数'),
  {
    addr: 'D128',
    label: '暴露面数',
    desc: '（用户口径 2026-10-19，投喂原话：「D128是暴露面数，暴露面表的『文档说明sheet』，'
      + '找『根域名资产;子域名资产;IP资产;端口资产;WEB资产;非WEB资产;网络&安全设备;'
      + '云类资产;SSL证书;APP;高危端口&服务;重要组件;登录入口』这些文字，找对应单元格'
      + '右侧一个单元格，里面是数字，然后计算总和填入」）'
      + '读暴露面表下载件「文档说明」sheet：逐格找这 13 项**子类型文字**（整格精确相等、'
      + '只去首尾空白），取文字**右侧一格**的「总数」，13 项直接相加 = 本格。'
      + '⚠️ 投喂写「这12项文字」，但实际列出了 **13 项**（含「APP」）；'
      + '`暴露面成果清单_华能集团_2026-10-19.xlsx` 的「文档说明」sheet K16:K28 逐字命中'
      + '这 13 项，所以本格按 13 项求和。'
      + '边界：暴露面表 0 行 -> 写 0（空表口径，与其它计数格同一条）；'
      + '有行但缺任一项 / 同一项出现两次 / 右侧一格不是数字 -> 不写部分和，记入错误列表。'
      + '不叠加报告期：暴露面导出的是**当前**暴露面，接口不带时间范围（`--start/--end` 不参与）。'
      + '口径与 13 项清单的权威在 stats/metrics/exposed.js（H4）。',
    compute: (ctx) => exposedSurfaceTotal(ctx),
    verify: ''
  },
  {
    addr: 'D129',
    label: 'HW及前一周已加固中高危漏洞数',
    desc: 'HW（护网）开始时间前一周 + HW 起止时间范围内、状态为已修复或已防护的'
      + '中高危漏洞数量（用户口径 2026-10-26，投喂原话：「HW及前一周已加固中高危漏洞数，'
      + '取值是提示词输入的HW开始时间前一星期内以及HW起止时间范围内且状态为已修复和已防护的'
      + '漏洞数量」）。'
      + '窗口 = [--protect-start − 7 天, --protect-end]，两端闭区间；时间列 = 「发现时间（…）」'
  + '（2026-10-29 前的「首次发现时间」），'
      + '按**日期**比、不看时刻。'
      + '⚠️ **不按「修复优先级」筛**（用户口径 2026-10-26 追加：「不需要判断修复优先级」）——'
      + '窗口内凡是已修复 / 已防护的行都算，高 / 中 / 低危一视同仁；'
      + '所以本格不读「修复优先级」列、缺了这一列也不报错。'
      + '格名里的「中高危」按用户口径**不做筛选**，别照着格子标题自己加条件。'
      + '已修复 = D15 的判据（「处置状态」**包含**「处置完成」）；'
      + '已防护 = D14 的判据（「AF 防护规则」= 有效 且「处置状态」= 处置完成（已缓解））。'
      + '⚠️ 当前 D15 是包含判据，已防护是已修复的子集，所以并集 = 已修复那一支；'
      + '「AF 防护规则」这一列缺了也不影响计数、不抛错（内网那份目前通常还没有这一列）。'
      + '数据源 = 内网漏洞表 + 互联网漏洞表**两张各数各的再相加**（两张 sheet 行不重复，不会重复计数）。'
      + '一行一票、不去重；日期为空 / 认不出的行跳过。'
      + '边界：未传 --protect-start / --protect-end -> 写 0（可选参数，同 D130）；'
      + '两份表都 0 行 -> 写 0（结论，不是缺数）；'
      + '缺「发现时间（…）」/「处置状态」列 -> 不写值、记入错误（「修复优先级」缺了照常算）；'
      + '时间列有非空值却一个都解析不出日期 -> 不写值、记入错误。'
      + '口径见 stats/metrics/vuln.js 的 hwHardenedVulnCount。',
    compute: (ctx) => hwHardenedVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'D130',
    label: 'hw 时间事件总数',
    desc: 'HW（护网）起止时间范围内的事件数（用户口径 2026-10-21）：读事件表，'
      + '精确查找「事件创建时间」列，日期落在 --protect-start ~ --protect-end'
      + '（HW 起止时间，两端闭区间）内的**事件行数**。'
      + '按**日期**比、不看时刻（起始日 00:00 ~ 结束日 23:59:59 都算）；'
      + '一行一票、不去重、不按事件名称 / 事件 ID / 影响资产合并；'
      + '该列空值 / 占位符 / 认不出的时间跳过那一行。'
      + '⚠️ 事件表导出时已按 --start / --end 圈定，HW 窗口超出报告期的部分表里没有行 —— '
      + '本格实际数到的是「报告期 ∩ HW 窗口」里的行。'
      + '边界：事件表 0 行 -> 写 0（结论，不是缺数）；'
      + '未传 --protect-start / --protect-end -> 写 0（它是可选参数，不传 = 这次不按 HW 窗口统计，'
      + '用户口径 2026-10-21；只传一端属于参数错，下载层直接拦）；'
      + '「事件创建时间」列整根不存在 -> 不写值、记入错误；'
      + '列在、也有非空值，但一个都解析不出日期 -> 不写值、记入错误。'
      + '算法（与 D29 共用同一段数行逻辑）见 stats/metrics/important_period.js 的 hwEventCount。',
    compute: (ctx) => hwEventCount(ctx),
    verify: ''
  },
  {
    addr: 'D133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 2 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 2 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 1),
    verify: ''
  },
  {
    addr: 'D134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 2 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 2 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 1),
    verify: ''
  },
  eventCell('D135', 1, 'label'),
  eventCell('D136', 1, 'count'),
  eventCell('D137', 1, 'share'),
  {
    addr: 'E18',
    label: '核心系统相关资产已闭环的风险数量分布统计',
    desc: '第 3 个核心业务系统（与 D5 同名的那个）名下的已闭环风险总数，'
      + '算法与计数口径同 C18（D13 的四段按该系统 IP 集合圈定后相加，数行数、'
      + '保留 D14/D15 重叠、系统之间各算各的）。边界同 C18。',
    compute: (ctx) => coreSystemClosedRiskTotalAt(ctx, 2),
    verify: ''
  },
  {
    addr: 'E49',
    label: '事件平均处置时长',
    desc: '与 D35 / D36 同一套口径，算的是第三个时长列：事件表里「推送状态」**整格精确等于**'
      + '「已推送」的那些事件行，取它们「处置时长」列里**所有非空值**的平均数（单位：分钟）。'
      + '用户口径 2026-10-13：「E49 是事件平均处置时长，精确查找『推送状态』列，'
      + '如果值精确匹配『已推送』，算命中。然后精确查找这些事件的『处置时长』列，'
      + '算出所有非空的处置时长的平均值」。'
      + '三格只差一个时长列，共用 stats/metrics/event.js 的 averagePushedDurationMinutes（H4）；'
      + '本格与 D35 / D36 的区别**只有传入的列名不同**，其余一个字都不重写。'
      + '判据、计数口径、报告期、边界全部同 D35：整格精确相等（比较前只去首尾空白 ——'
      + '`未推送` / 空 / `-` / 带后缀的 `已推送（XX）` 都不算）、一行一票不去重、'
      + '空时长不进分母（不是按 0 参与）、不过滤报告期（事件表导出时已按 --start/--end 圈定）、'
      + '没有可平均的样本写 **0** 且不记错误、只有缺列才不写值 + 记错误'
      + '（缺「推送状态」/ 缺预处理追加的「处置时长」）。'
      + '「处置时长」不是平台导出的列：由表格预处理按「事件闭环时间 − 事件创建时间」算出来'
      + '（分钟、2 位小数，负差值留空）追加进下载件，本格只读不算。'
      + '⚠️ 五个时长列（遏制 / 识别 / 处置 / 响应 / 闭环）**逐列独立**，本格只认「处置时长」：'
      + '别的列算不出来都不影响本格（用户口径 2026-10-12）。'
      + '反过来，**本格有自己的独门依赖**：时长列里依赖「事件闭环时间」的只有两列 ——'
      + '本格与 2026-10-13 追加的「闭环时长」（同一个算式、现被 G55「平均闭环时长」直接读）。'
      + '少了闭环时间这两列一起停，而 D35 / D36 / G7 各算各的。'
      + '⚠️ 与「识别时长」共享一个被减数：「处置时长 = 事件闭环时间 − 事件创建时间」，'
      + '「识别时长 = 事件创建时间 − 组件检出时间」—— 两边都要「事件创建时间」。'
      + '事件创建时间这一列缺了，D35 与本格会**一起**停，而 D36 / G7 照常落值。'
      + '⚠️ 与 G9「事件平均响应时长」**读的是不同列**：G9 读「响应时长」且多一道'
      + '「已处置」（已遏制 / 处置完成 / 已忽略）的筛，本格读「处置时长」、不要求处置状态 ——'
      + '两个数会不一样，不能互相 alias。'
      + '⚠️ 模板里这一格的标题在第 48 行的 E48「事件平均处置时长」、值是第 49 行的 E49'
      + '（与 C48「安全事件总数」/ D48「事件平均响应时间」/ F48「事件闭环率」同一行）。'
      + '⚠️ 与同列的 G54「平均处置时长」**不是同一个数**：本格只数「推送状态」=「已推送」那批，'
      + 'G54 数**全表**（用户口径 2026-10-13 第二版「不用跟推送状态挂钩」）——'
      + 'G54 / G55 那两条 alias 已撤掉，本格现在只是同列的另一个口径，不是它们的主地址。'
      + '⚠️ 顺带记一笔免得后人踩：「闭环时长」与本格读的「处置时长」是两条**同式同源**的列'
      + '（都是「事件闭环时间 − 事件创建时间」，逐行恒等），所以 G54 与 G55 在全表口径下'
      + '永远同值 —— 但那是预处理那两列的关系，与本格无关。',
    compute: (ctx) => averagePushedDurationMinutes(ctx, DISPOSAL_DURATION_COLUMN),
    verify: ''
  },
  monthCell('E58', 2, 'label'),
  monthCell('E59', 2, 'mean'),
  monthlyAttackCell('E71', 2, 'label'),
  monthlyAttackCell('E72', 2, 'count'),
  monthlyOutboundCell('E73', 2),
  monthlyAlarmCell('E75', 2),
  {
    addr: 'E80',
    label: '管理员弱密码数',
    desc: '同 D11 —— 本格与 D11「管理员弱口令数量」同值（用户口径 2026-10-21：'
      + '「E80 是管理员弱密码数，alias D11」；两个标题只差「码 / 口令」这一个用词，'
      + '模板原文照旧，地址与算法都不动）。'
      + 'D11 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界（核心资产集合、弱密码表两段 + 事件表一段、不按报告期过滤）、'
      + '空表与缺列行为全部见 D11 的 desc，本格一个字都不重算。'
      + '⚠️ 本格因此不读表：D11 缺「重要级别」/「风险资产」等判据列时两格一起不写值 + 记错误。',
    alias: 'D11',
    verify: ''
  },
  {
    addr: 'E83',
    label: '已闭环数',
    desc: '（用户口径 2026-10-23，投喂原话：「E83 E84 E85分别是高中低漏洞分布已闭环数。'
      + '在刚刚高中低漏洞的基础上，额外检查对应命中漏洞的『处置状态』列，'
      + '如果包含『处置完成』，那么对应的单元格加一」）'
      + '在 D83 的判据上**再加一条**：读**漏洞表全表**（内网 + 互联网两份拼成 ctx.vulnRows），'
      + '数「修复优先级」**整格精确等于**「急需修复」**且**「处置状态」**包含**'
      + '「处置完成」的行数。'
      + '「包含」是 includes，与 D80 同一档：`处置完成（已修复）/（已缓解）/（接受风险）/'
      + '（忽略）`、裸「处置完成」、「闭环后处置完成」都算；`待处置` / `处置中` 不算。'
      + '按行计数、一行一条；不去重、不按报告期过滤。'
      + '边界：漏洞表 0 行 / 一条都不命中 -> 写 0（是结论，不是缺数）；'
      + '有行但缺「修复优先级」或「处置状态」列 -> 不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 highPriorityClosedVulnCount。',
    compute: (ctx) => highPriorityClosedVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'E84',
    label: '漏洞分布',
    desc: '（用户口径 2026-10-23）同 E83，只把「修复优先级」的判据换成整格精确等于'
      + '「尽快修复」（对应 D84「中危漏洞」），再要求「处置状态」**包含**「处置完成」。'
      + '读同一张漏洞表全表（ctx.vulnRows）；按行计数、不去重、不按报告期过滤；'
      + '空表 / 无命中写 0；缺「修复优先级」或「处置状态」列不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 mediumPriorityClosedVulnCount。',
    compute: (ctx) => mediumPriorityClosedVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'E85',
    label: '漏洞分布',
    desc: '（用户口径 2026-10-23）同 E83，只把「修复优先级」的判据换成整格精确等于'
      + '「建议修复」（对应 D85「低危漏洞」），再要求「处置状态」**包含**「处置完成」。'
      + '读同一张漏洞表全表（ctx.vulnRows）；按行计数、不去重、不按报告期过滤；'
      + '空表 / 无命中写 0；缺「修复优先级」或「处置状态」列不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 lowPriorityClosedVulnCount。',
    compute: (ctx) => lowPriorityClosedVulnCount(ctx),
    verify: ''
  },
  monthlyVulnCell('E86', 2, 'label'),
  monthlyVulnCell('E87', 2, 'count'),
  monthlyVulnCell('E88', 2, 'closed'),
  {
    addr: 'E133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 3 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 3 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 2),
    verify: ''
  },
  {
    addr: 'E134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 3 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 3 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 2),
    verify: ''
  },
  eventCell('E135', 2, 'label'),
  eventCell('E136', 2, 'count'),
  eventCell('E137', 2, 'share'),
  {
    addr: 'F49',
    label: '事件闭环率',
    mode: 'percent',
    desc: '事件表里「处置状态」**整格精确等于**「处置完成」的事件**行数**，除以 C49「安全事件总数」的值'
      + '（用户口径 2026-10-13：「精确查找事件表的『处置状态』列的值是『处置完成』的事件总数，除 C49 的值」）。'
      + 'C49 = alias 指向 D38「威胁和事件数量」= **事件表总行数**，所以分母就是事件表有多少行 —— '
      + '分子分母读的是同一张表的同一个报告期，不另加过滤。'
      + '分子计数口径：按行计数、一行一票，不去重、不按事件名称 / 事件 ID / 影响资产合并；'
      + '判据是**整格精确相等**（比较前只去首尾空白）：`处置完成` 算，带括号的 `处置完成（已修复）` 不算，'
      + '`已处置` / `已遏制` / `已忽略` / `处置中` / `待处置`、空值、占位符 `-` 也都不算'
      + '（⚠️「已处置」压根不是平台的取值 —— 这一列实测只有 `待处置` / `处置中` / `已遏制` / `处置完成` 四种词）。'
      + '⚠️ 与 G8「处置安全事件总数」刻意不同：G8 一次认「已遏制 / 处置完成 / 已忽略」三个状态，'
      + '本格只认「处置完成」这一个，两个数之间没有推导关系（别拿 G8 减 G106 减 G107 来反推本格的分子）。'
      + '不按报告期过滤 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '落法：percent 模式写**小数**（0.4 在报告里显示 40.00%）—— 不是整数 40、也不是字符串「40%」。'
      + '边界：事件表有行、却一条「处置完成」都没有 -> 写 **0**（0.00% 是结论，不是缺数）；'
      + '事件表**一行都没有**（分母为 0）-> 写字符串「无事件，所以无闭环率」'
      + '（用户口径 2026-10-13：**不写 0** —— 0% 会被读成"有事件、但一条都没闭环"，那是假结论；'
      + '这句话在 stats/metrics/event.js 的 `NO_EVENT_CLOSURE_RATE_TEXT` 定义，全仓只此一处）；'
      + '事件表有行、却读不出「处置状态」列（平台改了列名）-> 不写值 + 记错误（不填 0）。',
    compute: (ctx) => eventClosureRate(ctx),
    verify: ''
  },
  monthCell('F58', 3, 'label'),
  monthCell('F59', 3, 'mean'),
  topSrcGeoCell('F62', 0, 'label'),
  topSrcGeoCell('F63', 1, 'label'),
  topSrcGeoCell('F64', 2, 'label'),
  topSrcGeoCell('F65', 3, 'label'),
  topSrcGeoCell('F66', 4, 'label'),
  monthlyAttackCell('F71', 3, 'label'),
  monthlyAttackCell('F72', 3, 'count'),
  monthlyOutboundCell('F73', 3),
  monthlyAlarmCell('F75', 3),
  {
    addr: 'F80',
    label: '高危可利用漏洞闭环率',
    mode: 'percent',
    desc: '**（D14 + D15）÷ D10**（用户口径 2026-10-22：'
      + '「F80是高危可利用漏洞闭环率，取值是(D14+D15) / D10」）。'
      + '三个数都是有名字的格子 / 派生量，本格只做加法和除法、一个字都不重算（H4）：'
      + 'D14「已防护漏洞数」（内网漏洞表：「AF 防护规则」整格精确等于「有效」且'
      + '「处置状态」整格精确等于「处置完成（已缓解）」的行数）、'
      + 'D15「已修复漏洞数」（漏洞表全表：「处置状态」包含「处置完成」的行数）、'
      + 'D10「高危可利用漏洞数」（漏洞表全表：「威胁标签」含「高可利用」的行数）。'
      + '⚠️ **不交集、不去重、不截断**：D14 命中的行通常也会被 D15 计入，'
      + '分子里同一个数数了两遍，比率**可能超过 100%**（三个量的筛选条件本来就不同）——'
      + '用户给的就是这个式子，别自作主张改成集合运算或封顶到 100%。'
      + '不按报告期额外过滤 —— 三张表导出时已按报告期圈定，与 D10 / D14 / D15 同一条。'
      + '落法：percent 模式写**小数**（0.25 在报告里显示 25.00%）—— 不是整数 25、也不是字符串「25%」。'
      + '边界：漏洞表 0 行、或表里有行但没有一条「高可利用」（分母为 0）-> '
      + '写字符串「无高危可利用漏洞，所以无闭环率」（用户口径 2026-10-22：**不写 0** —— '
      + '0.00% 会被读成"有高危可利用漏洞、但一条都没闭环"，那是假结论；'
      + '这句话在 stats/metrics/vuln.js 的 `NO_HIGH_EXPLOITABLE_VULN_RATE_TEXT` 定义，全仓只此一处）；'
      + '分母 > 0、一条都没闭环 -> 写 **0**（0.00% 是结论）；'
      + '缺「威胁标签」/「AF 防护规则」/「处置状态」任一列（平台改了列名）-> 不写值 + 记错误（不填 0）。',
    compute: (ctx) => highExploitableClosureRate(ctx),
    verify: ''
  },
  {
    addr: 'F83',
    label: '闭环率',
    mode: 'percent',
    desc: '**E83 ÷ D83**（用户口径 2026-10-23：「F83=E83/D83 F84=E84/D84 F85=E85/D85，'
      + '分别是高中低漏洞分布闭环率」）。'
      + '分子 E83「已闭环数」（漏洞表全表：「修复优先级」整格精确等于「急需修复」**且**'
      + '「处置状态」含「处置完成」的行数）、'
      + '分母 D83「高危漏洞」（漏洞表全表：「修复优先级」整格精确等于「急需修复」的行数）。'
      + '两个数都是有名字的格子，本格只做除法、不重算判据（H4）。'
      + '⚠️ 不截断、不封顶：分子是分母的子集（E83 的判据就是 D83 的判据 + 一条），'
      + '所以结果天然落在 0–1 之间，但代码里不加 min/max。'
      + '不按报告期额外过滤 —— 与 D83 / E83 同一条，漏洞表导出时已按报告期圈定。'
      + '落法：percent 模式写**小数**（0.5 在报告里显示 50.00%）—— 不是整数 50、也不是字符串「50%」。'
      + '边界：分母为 0（表里没有一条「急需修复」；含漏洞表 0 行）-> '
      + '写字符串「无高危漏洞，所以无闭环率」（用户口径 2026-10-23，**不写 0** —— '
      + '0.00% 会被读成"有高危漏洞、但一条都没闭环"，那是假结论；'
      + '这句话在 stats/metrics/vuln.js 的 `NO_HIGH_VULN_RATE_TEXT` 定义，全仓只此一处）；'
      + '分母 > 0、分子为 0 -> 写 **0**（0.00% 是结论）；'
      + '缺「修复优先级」/「处置状态」列（平台改了列名）-> 不写值 + 记错误（不填 0）。',
    compute: (ctx) => highPriorityClosureRate(ctx),
    verify: ''
  },
  {
    addr: 'F84',
    label: '漏洞分布',
    mode: 'percent',
    desc: '**E84 ÷ D84**（用户口径 2026-10-23，同 F83）。'
      + '分子 E84（「修复优先级」整格精确等于「尽快修复」且「处置状态」含「处置完成」的行数）、'
      + '分母 D84（「修复优先级」整格精确等于「尽快修复」的行数）；只做除法、不重算判据。'
      + '落法：percent 模式写小数。'
      + '边界：分母为 0 -> 写字符串「无中危漏洞，所以无闭环率」'
      + '（`NO_MEDIUM_VULN_RATE_TEXT`，全仓只此一处；**不写 0**）；'
      + '分母 > 0、分子为 0 -> 写 0；缺「修复优先级」/「处置状态」列 -> 不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 mediumPriorityClosureRate。',
    compute: (ctx) => mediumPriorityClosureRate(ctx),
    verify: ''
  },
  {
    addr: 'F85',
    label: '漏洞分布',
    mode: 'percent',
    desc: '**E85 ÷ D85**（用户口径 2026-10-23，同 F83）。'
      + '分子 E85（「修复优先级」整格精确等于「建议修复」且「处置状态」含「处置完成」的行数）、'
      + '分母 D85（「修复优先级」整格精确等于「建议修复」的行数）；只做除法、不重算判据。'
      + '落法：percent 模式写小数。'
      + '边界：分母为 0 -> 写字符串「无低危漏洞，所以无闭环率」'
      + '（`NO_LOW_VULN_RATE_TEXT`，全仓只此一处；**不写 0**）；'
      + '分母 > 0、分子为 0 -> 写 0；缺「修复优先级」/「处置状态」列 -> 不写值 + 记错误。'
      + '口径见 stats/metrics/vuln.js 的 lowPriorityClosureRate。',
    compute: (ctx) => lowPriorityClosureRate(ctx),
    verify: ''
  },
  monthlyVulnCell('F86', 3, 'label'),
  monthlyVulnCell('F87', 3, 'count'),
  monthlyVulnCell('F88', 3, 'closed'),
  importantPeriodDistributionCell('F91', 0, 'label'),
  importantPeriodDistributionCell('F92', 1, 'label'),
  importantPeriodDistributionCell('F93', 2, 'label'),
  importantPeriodDistributionCell('F94', 3, 'label'),
  importantPeriodDistributionCell('F95', 4, 'label'),
  importantPeriodDistributionCell('F96', 5, 'label'),
  importantPeriodDistributionCell('F97', 6, 'label'),
  {
    addr: 'F133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 4 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 4 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 3),
    verify: ''
  },
  {
    addr: 'F134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 4 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 4 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 3),
    verify: ''
  },
  eventCell('F135', 3, 'label'),
  eventCell('F136', 3, 'count'),
  eventCell('F137', 3, 'share'),
  u('G4', '安全策略调优数量'),
  {
    addr: 'G5',
    label: '威胁告警总',
    desc: '「告警表」总表中「GPT研判结论」**整格精确等于**「真实攻击未成功」的告警**行数**'
      + '（按行计数、一行一票，不去重 —— 同一台机器上有多条这样的告警就算多条，'
      + '这一格是"总数"不是"资产台数"）。'
      + '比较前只去首尾空白，不做全半角 / 括号归一：「真实攻击成功」不算（那是另一条结论，'
      + '整格不相等）、「等待GPT研判」「主机失陷活动」、占位符「-」、'
      + '以及任何带后缀 / 前后缀的写法都不算命中。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内，本仓取值层不叠加第二道时间过滤。'
      + '告警表为空（0 行）时本格写 0（0 是结论，不是缺数）—— '
      + '下载一定发生，告警表下不到时 scripts/build_report.py 就拦下了、整份报告不出；'
      + `表里有行、却没有「GPT研判结论」列（有些客户的告警表本来就没有这一列）时，`
      + `本格写「${GPT_VERDICT_MISSING_TEXT}」（用户口径 2026-10-19：这是结论，`
      + '不是缺数 —— 不记错误、也不填 0）。D62「实时威胁告警数量」是 G5 的 alias，跟着落同一句。',
    compute: (ctx) => gptVerdictAlarmCount(ctx),
    verify: ''
  },
  threatAlarmCell('G6', 0, '核心系统威胁告警数量分布'),
  {
    addr: 'G7',
    label: '威胁平均遏制时间',
    desc: '「事件表」总表里「GPT研判结论」**整格精确等于**「真实攻击未成功」的行，'
      + '取这些行的「遏制时长」的**非空值的平均值**（单位：分钟）。'
      + '选行判据与 G5 是同一句（比较前只去首尾空白、不做全半角 / 括号归一：'
      + '「真实攻击成功」「等待GPT研判」「主机失陷活动」、占位符「-」都不算命中），'
      + '只是读的是事件表而不是告警表。'
      + '「遏制时长」= 事件遏制时间 − 专家研判时间（分钟、2 位小数；`0` 合法，'
      + '**负差值不合法、那一格留空** —— 用户口径 2026-10-12，所以这一列里不会有负数）。'
      + '⚠️ 这一列**不是平台导出的**：它是表格预处理（scripts/report_preprocess.py）在'
      + '「下载之后、解析之前」按上面那个差值追加到事件表下载件上的，取值层直接读它 ——'
      + '同一个口径全仓只有那一处实现，本格不自己再算一遍。'
      + '两个源格里有一个是空 / 占位符（-、－、—、–）/ 认不出的文本时，'
      + '预处理就给这一行留空，这一行不进分母、**不影响别的行**。'
      + '平均值只对"遏制时长非空"的行做。'
      + '⚠️ 平台改了那两个时间源列的名、或这份数据来自没有它们的旧版 25 列导出时，'
      + '预处理凑不齐就不追加这一列 —— 那时本格记入错误列表、不写值。'
      + '⚠️ 但那一列缺席**只停它自己**（用户口径 2026-10-12「不要因为一个影响别的时间计算」）：'
      + '预处理的五条时长列逐列独立，「事件遏制时间」没给时其余四条照算 ——'
      + '本格落空不代表 G9 也落空（它读的是另一条，与这一对源列无关）。'
      + '不过滤报告期 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '事件表为空（0 行）、或表里有行但没有一行命中 / 命中的行遏制时长全空时，'
      + '本格写 **0**（用户口径 2026-10-14「写 0，如果 G7 没写 0，也改过来」—— '
      + '本格从前写空串，那条口径已作废；现在与 G9 / D35 / D36 / E49 / G51:G55 同一落法）。'
      + '⚠️ 代价是「0 分钟的均值」与「没有可平均的样本」在报告上不再可分 —— '
      + '这是用户明确接受的取舍，不是漏改。这两种情形都不记错误（那是结论，不是缺数）。'
      + '均值本身**不再舍入**（逐行已是 2 位小数，直接相加再除，与在 Excel 里对那一列 =AVERAGE 对得上）；'
      + '表里有行、却缺「GPT研判结论」列或缺预处理的「遏制时长」列时，'
      + '记入错误列表、不写值（**缺列**是唯一不落值的那一档）。',
    compute: (ctx) => averageContainedMinutes(ctx),
    verify: ''
  },
  {
    addr: 'G8',
    label: '处置安全事件总数',
    desc: '「事件表」总表里「处置状态」**整格精确等于**「已遏制」「处置完成」「已忽略」'
      + '三者之一的**事件行数**（按行计数、一行一票，不去重 —— 同一台资产上有几条这样的事件'
      + '就算几条，这一格是"总数"不是"资产台数"；三个状态互斥，不会重复计）。'
      + '比较前只去首尾空白，不做全半角 / 括号归一：「待处置」「处置中」不算，'
      + '带后缀的「已遏制（XX）」「处置完成（已修复）」也不算（不是同一个字符串）。'
      + '不过滤报告期 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '事件表为空（0 行）时本格写 0（0 是结论，不是缺数）—— '
      + '下载一定发生，事件表下不到时 scripts/build_report.py 就拦下了、整份报告不出；'
      + '表里有行、却没有「处置状态」列（平台改了列名）时记入错误列表、不写值（不填 0）。',
    compute: (ctx) => disposedEventCount(ctx),
    verify: ''
  },
  {
    addr: 'G9',
    label: '事件平均响应时长',
    desc: '「事件表」总表里，**先**按 G8 同一批行（「处置状态」整格精确等于「已遏制」「处置完成」'
      + '「已忽略」三者之一）选出事件，**再**在这些行里精确匹配「推送状态」整格等于「已推送」的行，'
      + '取这些行的「响应时长」的**非空值的平均值**（单位：分钟）。'
      + '两道筛是"同时满足"：只看「推送状态」而不看处置状态的那批行**不算**本格 —— '
      + '本格是"已处置事件里已推送的那部分"，不是全表已推送。'
      + '「推送状态」比较前只去首尾空白、不做全半角 / 括号归一：「未推送」不算、空不算、'
      + '带后缀的「已推送（XX）」也不算（不是同一个字符串）。'
      + '「推送状态」是平台导出的真实列（请求体字段 push_status，事件表请求体长期带它），'
      + '不是预处理追加的。'
      + '「响应时长」= 专家研判时间 − 组件检出时间（分钟、2 位小数）。'
      + '⚠️ 这一列**不是平台导出的**：它是表格预处理（scripts/report_preprocess.py）在'
      + '「下载之后、解析之前」按上面那个差值追加到事件表下载件上的，取值层直接读它 ——'
      + '同一个口径全仓只有那一处实现（与 G7 的「遏制时长」同源同性质），本格不自己再算一遍。'
      + '两个源格里有一个是空 / 占位符（-、－、—、–）/ 认不出的文本时，预处理就给这一行留空，'
      + '这一行不进分母、**不影响别的行**；平均值只对"响应时长非空"的行做。'
      + '算出来是**负数的同样不合法、预处理给那一格留空**（用户口径 2026-10-12：时长不可能为负），'
      + '所以这一列里不会有负数 —— 那几行与"算不出时长"的行一样退出分母（与 G7 的「遏制时长」同一条）。'
      + '不过滤报告期 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '没有可平均的样本时本格写 **0**（用户口径原话"没有就写0"）—— 包括事件表为空（0 行）、'
      + 'G8 一行都没选出、选出的行里没有一行的推送状态是「已推送」、推送命中的行响应时长全空这几种情形；'
      + '这些都是结论、不是缺数、不记错误（0 在这里有含义：没有推送就没有响应时长可言）。'
      + '⚠️ 本格从前与 G7 的"没样本写空串"落法不同，但 G7 那条口径已于 2026-10-14 被用户'
      + '改成 0 —— 现在时长均值格一条落法，别再照旧注释引用那条分岔。'
      + '均值本身**不再舍入**（逐行已是 2 位小数，直接相加再除，与在 Excel 里对那一列 =AVERAGE 对得上）。'
      + '表里有行、却缺「处置状态」/「推送状态」/「响应时长」三列之一时，记入错误列表、不写值'
      + '（不填 0；缺「响应时长」= 预处理那一步没算出时长）。',
    compute: (ctx) => averageResponseMinutes(ctx),
    verify: ''
  },
  {
    addr: 'G10',
    label: '核心系统事件数量',
    desc: '「事件表」总表里「影响资产」**落在核心业务系统 IP 集合里**的事件**行数**'
      + '（按行计数、一行一票，不去重 —— 同一台机器上三条这样的事件就算三条）。'
      + '那个 IP 集合 = 把 `--business-systems` 传进来的**全部**系统名逐个去资产表按'
      + '「所属业务」整格子串包含圈 IP，再把结果**并成一个集合**（同一台机器属于两个系统只算一个 IP）。'
      + '「落在集合里」是**精确查找**：把「影响资产」归一（去首尾空白、剥掉 `(资产组名:xx)` '
      + '这类括号后缀、IPv6 转小写，与资产表 IP 同一把尺子）后做集合成员判断，不是子串包含 —— '
      + '集合里有 10.0.0.1 时 10.0.0.11 不算；「影响资产」为空的行不在任何集合里，不算。'
      + '⚠️ 与 D7/D8/D9 的「事件风险」那一段**是两回事**：那段逐系统各圈各的 IP 集合、'
      + '且要求「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」；本格用**全部系统的并集**、'
      + '**不看二级分类**，也不看「处置状态」「GPT定性标签」—— 用户口径只有「影响资产符合总 IP '
      + '集合就加一」这一句，落在这些 IP 上的每一行都算。'
      + '`--business-systems` 与 D3/D4/D5 同一批名字（本格不分槽位，全部一起用）。'
      + '不叠加报告期过滤：事件表导出时已按 --start/--end 圈定（与 D10/D12/D15/G5/G8/G7 同一条全表口径）。'
      + '边界：事件表为空（0 行）-> 写 0；资产表为空、或这些系统名下一台资产都没有 -> IP 集合是空集、'
      + '同样写 0（0 是结论，不是缺数）。'
      + '资产表有行却读不出「所属业务」/「IP地址」列、事件表有行却读不出「影响资产」列（平台改了列名）-> '
      + '不写值 + 记错误；**--business-systems 一个系统都没传 -> 写 0**（用户口径 2026-10-12：'
      + '这一格与 D6:D9 / G6/H6/I6 同一条 —— 没有系统就没有可数的范围，按 0 落值、不记错误；'
      + '这一格**连事件表都不打开**，所以列名对不上也不会让它单独报错）。',
    compute: (ctx) => coreSystemsEventCount(ctx),
    verify: ''
  },
  {
    addr: 'G12',
    label: '「核心系统风险总数」',
    desc: '三个核心业务系统的风险总数**合计** —— 用户口径 2026-10-22：**G12 = D7 + D8 + D9**，'
      + '只做加法、不重算：每个系统的数怎么来的（漏洞 + 弱密码 + 事件三段各按哪张表哪些行）'
      + '见 D7 的 desc，本格只是把算好的三个数加起来，不重新过滤、不另做一遍。'
      + '⇒ 与 D6「安全风险总数」**同一个加式**，也走同一个函数 coreSystemRiskGrandTotal'
      + '（H4：同一个量只算一次）—— 两格数值必定相等，但**刻意不互为 alias**：'
      + '用户投喂的是这一条加式，两格各自留一条记录，别顺手合并。'
      + '相加不去重：同一台机器挂在两个系统名下时，它在两个系统里各算一次，本格也照样各加一次。'
      + '三个槽位一个不落地加：--business-systems 只给了 2 个系统时，第 3 个槽位没有系统，'
      + '它对 D9 的贡献是 0，本格就是前两个数之和；一个都没给时三格全是 0，本格就是 0'
      + '（用户口径 2026-10-12：这个 0 是"没有系统"造成的，不记错误）。'
      + '不按报告期过滤（同 D7：四份总表导出时已按平台口径取数）。'
      + '边界：传了 4 个及以上系统时本格不写值、记入错误列表（模板里只有核心系统 1/2/3 '
      + '三个槽位）；资产表 / 漏洞表 / 弱密码表（内网 + 互联网两份）/ 事件表里有行、'
      + '但读不出要读的列（平台改了列名）时，对应的加数算不出来，本格不写值、记入错误列表；'
      + '某一份表这次是空的（0 行）时，那一段就是 0，本格跟着按 0 加（0 是结论，不是缺数）。',
    compute: (ctx) => coreSystemRiskGrandTotal(ctx),
    verify: ''
  },
  {
    addr: 'G13',
    label: '「核心系统闭环风险数」',
    desc: '三个核心业务系统的**已闭环风险总数合计** —— 用户口径 2026-10-22：'
      + '**G13 = C18 + D18 + E18**，只做加法、不重算：每个系统的已闭环风险数怎么来的'
      + '（D13 的 D14 + D15 + D16 + D17 四段，各自只数 IP 落在该系统 IP 集合里的行）'
      + '见 C18 的 desc，本格只是把算好的三个数加起来。'
      + '⇒ 与 G12（= D7 + D8 + D9）是**并行的两条加式**：G12 加的是「风险总数」'
      + '（漏洞 + 弱密码 + 事件三套判据），本格加的是「已闭环风险总数」（D13 那四段）—— '
      + '两格的数不是一回事，别互相顶替，也别顺手合并成一个函数。'
      + '相加不去重：同一台机器挂在两个系统名下时，它在两个系统里各算一次，本格也照样各加一次。'
      + '三个槽位一个不落地加：--business-systems 只给了 2 个系统时，第 3 个槽位没有系统，'
      + '它对 E18 的贡献是 0，本格就是前两个数之和；一个都没给时三格全是 0，本格就是 0'
      + '（用户口径 2026-10-12：这个 0 是"没有系统"造成的，不记错误）。'
      + '不按报告期过滤（同 C18 / D13：四份总表导出时已按平台口径取数）。'
      + '边界：传了 4 个及以上系统时本格不写值、记入错误列表（模板里只有核心系统 1/2/3 '
      + '三个槽位）；资产表 / 漏洞表（含内网漏洞表）/ 弱密码表（内网 + 互联网两份）/ '
      + '事件表里有行、但读不出要读的列（平台改了列名，例如内网漏洞表缺「风险资产」）时，'
      + '对应的加数算不出来，本格不写值、记入错误列表 —— 不拿 D13 的整表数冒充；'
      + '某一份表这次是空的（0 行）时，那一段就是 0，本格跟着按 0 加（0 是结论，不是缺数）。',
    compute: (ctx) => coreSystemClosedRiskGrandTotal(ctx),
    verify: ''
  },
  {
    addr: 'G14',
    label: '「核心系统威胁事件总数」',
    desc: '「事件表」总表里「影响资产」**落在核心业务系统 IP 集合里**、**且**「GPT研判结论」'
      + '**整格精确等于**「真实攻击未成功」的事件**行数**（按行计数、一行一票，不去重 —— '
      + '同一台机器上两条这样的行就算两条，不按事件名称 / 事件 ID 合并）。'
      + '前一段与 G10「核心系统事件数量」**逐字相同**：那个 IP 集合 = 把 `--business-systems` '
      + '传进来的**全部**系统名逐个去资产表按「所属业务」整格子串包含圈 IP，再把结果并成'
      + '一个集合（不分槽位；同一台机器属于两个系统只算一个 IP）。'
      + '本格比 G10 多的只有一道筛：命中的行还要「GPT研判结论」整格精确等于「真实攻击未成功」'
      + '（与 G5/G6/H6/I6/G7 同一句判据：比较前只去首尾空白；`真实攻击成功`、'
      + '`真实攻击未成功（疑似）`、`等待GPT研判`、占位符 `-` 都不算）。'
      + '⇒ 候选行是 G10 那批的**子集**，本格恒 ≤ G10 —— 两格是"多一道筛"的关系，'
      + '**不是 alias**（不像 D68 = D12）；两格数值偶尔相等是巧合，别顺手合并。'
      + '⚠️ 也别与 G6/H6/I6「核心系统威胁告警数量」混了：那三格读**告警表**的「主机IP」、'
      + '且逐系统各圈各的集合；本格读**事件表**的「影响资产」、且用全部系统并起来的一个集合。'
      + '⚠️ 本格**不看**「安全事件二级分类」「处置状态」「GPT定性标签」—— 除研判结论外不加任何筛。'
      + '「落在集合里」是**精确查找**：把「影响资产」归一（去首尾空白、剥掉 `(资产组名:xx)` '
      + '这类括号后缀、IPv6 转小写，与资产表 IP 同一把尺子）后做集合成员判断，不是子串包含 —— '
      + '集合里有 10.0.0.1 时 10.0.0.11 不算；「影响资产」为空的行不在任何集合里，不算。'
      + '不叠加报告期过滤：事件表导出时已按 --start/--end 圈定'
      + '（与 D10/D12/D15/G5/G8/G7/G10 同一条全表口径）。'
      + '边界：事件表为空（0 行）-> 写 0；资产表为空、或这些系统名下一台资产都没有 -> IP 集合是'
      + '空集、同样写 0；圈到行却没一行命中研判结论 -> 也是 0（三种 0 都是结论，不是缺数）。'
      + '资产表有行却读不出「所属业务」/「IP地址」列，或事件表有行却读不出「影响资产」/'
      + '「GPT研判结论」列（平台改了列名）-> 不写值 + 记错误（两列都缺时先报「影响资产」——'
      + '选行是第一步）；**--business-systems 一个系统都没传 -> 写 0**'
      + '（用户口径 2026-10-12：与 D6:D9 / G6/H6/I6 / G10 同一条 —— 没有系统就没有可数的范围，'
      + '按 0 落值、不记错误；这一格**连事件表都不打开**，所以列名对不上也不会让它单独报错）。',
    compute: (ctx) => coreSystemsThreatEventCount(ctx),
    verify: ''
  },
  {
    addr: 'G16',
    label: '业务系统数量',
    desc: '资产表「所属业务」列里**出现过多少种不同的内容** —— 把这一列的值逐个读出来，'
      + '去重成一个集合，数集合里有几个。'
      + '⚠️ 「精确」的含义：**整格内容**当作一个条目 —— 不做子串包含（这与 D7/D8/D9 那条'
      + '"业务名 -> IP"的模糊匹配刻意不同）、**不按逗号拆开**（加工脚本按逗号拆过再拼回来，'
      + '所以一格里是「财务系统, OA系统」时它是**一个**条目，不是两个）、不做分词。'
      + '比较前只去首尾空白、转小写（与 D7 同一把尺子），所以「  财务系统 」与「财务系统」算一个、'
      + '「OA系统」与「oa系统」算一个。'
      + '空的内容不算一种业务系统：空串、纯空白、以及平台的**横杠占位符**'
      + '（`-` / `－` / `—` / `–`）都跳过（用户口径 2026-10-12「- 不算」；判据直接用 '
      + 'stats/metrics/ranking.js 的 isBlankValue —— 与那 35 格名次格同一把尺子，'
      + '横杠在 mssw 导出里是列级的「无 / 不适用」标记，不是一种取值）。'
      + '与 --business-systems 无关：本格问的是"资产表里一共登记了几种业务"，'
      + '不是"传进来的那几个系统"，所以不拿 D3/D4/D5 过滤、也不做子串匹配（不传 / 少传它都不变）。'
      + '也不叠加报告期过滤：资产表导出的是当前台账，本仓不另加时间条件。'
      + '只读「所属业务」这一列：资产表缺「IP地址」列不影响本格（与 D7/D8/D9 那把钥匙不同）。'
      + '边界：资产表为空（0 行）-> 写 0；这一列整列为空、或全是空白 / 占位符 -> 写 0'
      + '（0 是结论 —— 那正是"一台资产都没登记过业务归属"；真实样本里这一列大面积为空，'
      + 'outputs/20261010_152149/一致性验收客户_report.xlsx 的「资产表」117 行里只有 1 行非空）；'
      + '资产表有行却读不出「所属业务」列（平台改了列名）-> 不写值 + 记错误（禁止填 0）。',
    compute: (ctx) => businessSystemCount(ctx),
    verify: ''
  },
  {
    addr: 'G17',
    label: '服务器资产数量',
    desc: '资产表里「资产类型(一级)」这一列**整格精确等于**「服务器」的资产**行数**'
      + '（一台资产一行，按行计数、不去重）。'
      + '⚠️「精确」的含义：整格内容必须就是「服务器」这三个字 —— 比较前只去首尾空白，'
      + '**不做**包含 / 前缀匹配（`服务器区`、`X86服务器` 都不算）、不做全半角归一、'
      + '也不读旁边那一列「资产类型(二级)」（它是另一列，本格不看）。'
      + '「网络设备」「终端」等别的类型值同样不计入本格。'
      + '与 --business-systems 无关：本格圈的是资产类型，不是业务系统，'
      + '所以不拿 D3/D4/D5 过滤、也不做子串匹配（不传 / 少传它都不变）。'
      + '也不叠加报告期过滤：资产表导出的是当前台账，本仓不另加时间条件。'
      + '只读「资产类型(一级)」这一列：资产表缺「IP地址」列不影响本格（与 D7/D8/D9 那把钥匙不同）。'
      + '边界：资产表为空（0 行）-> 写 0；这一列整列为空、或一台服务器都没有 -> 写 0'
      + '（0 是结论 —— 那正是"台账里没有这类资产"）；'
      + '资产表有行却读不出「资产类型(一级)」列（平台改了列名）-> 不写值 + 记错误（禁止填 0）。',
    compute: (ctx) => assetCountByPrimaryType(ctx, SERVER_ASSET_TYPE),
    verify: ''
  },
  {
    addr: 'G18',
    label: 'PC资产数量',
    desc: '资产表里「资产类型(一级)」这一列**整格精确等于**「终端」的资产**行数**'
      + '（一台资产一行，按行计数、不去重）。'
      + '⚠️ 平台这一列给的值就是**「终端」**（实测 117 行里 99 行），报告口径把它叫作 PC；'
      + '本格**只认「终端」这一个值**，不认「PC」「笔记本电脑」这类写法（一个都不是平台的值）。'
      + '⚠️「精确」的含义：整格内容必须就是「终端」这两个字 —— 比较前只去首尾空白，'
      + '**不做**包含 / 前缀匹配（`终端区`、`移动终端` 都不算）、不做全半角归一、'
      + '也不读旁边那一列「资产类型(二级)」（它是另一列，本格不看）。'
      + '「服务器」「网络设备」等别的类型值不计入本格（与 G17 互为镜像，两格的关键词互斥）。'
      + '与 --business-systems 无关：本格圈的是资产类型，不是业务系统，'
      + '所以不拿 D3/D4/D5 过滤、也不做子串匹配（不传 / 少传它都不变）。'
      + '也不叠加报告期过滤：资产表导出的是当前台账，本仓不另加时间条件。'
      + '只读「资产类型(一级)」这一列：资产表缺「IP地址」列不影响本格（与 D7/D8/D9 那把钥匙不同）。'
      + '边界：资产表为空（0 行）-> 写 0；这一列整列为空、或一台终端都没有 -> 写 0'
      + '（0 是结论 —— 那正是"台账里没有这类资产"）；'
      + '资产表有行却读不出「资产类型(一级)」列（平台改了列名）-> 不写值 + 记错误（禁止填 0）。',
    compute: (ctx) => assetCountByPrimaryType(ctx, PC_ASSET_TYPE),
    verify: ''
  },
  u('G21', '漏扫次数'),
  {
    addr: 'G22',
    label: '已闭环漏洞总数',
    desc: '**G23 + G24 两个数相加**（用户口径 2026-10-26：「G22=G23+G24」）。'
      + '两个加数各自都是**有名字的格子**，本格只做加法、一个字都不重算（H4）：'
      + 'G23「已防护漏洞数」= alias D14（内网漏洞表里「AF 防护规则」=「有效」且'
      + '「处置状态」=「处置完成（已缓解）」的行数）；'
      + 'G24「已修复漏洞数」= alias D15（漏洞表全表里「处置状态」含「处置完成」的行数）。'
      + '⇒ 数值上恒等 **D14 + D15**（G23 / G24 是那两个格子的 alias），'
      + '与 F80「高危可利用漏洞闭环率」的**分子是同一对加数**，所以两处共用'
      + 'stats/metrics/vuln.js 的 protectedPlusSettledVulnCount（H4），不各写一遍加法。'
      + '⚠️ 照抄加式、**不做交集 / 去重**：D14 命中的行本来就同时会被 D15 计入'
      + '（「处置完成（已缓解）」也含「处置完成」），这是用户给的加式，别改成集合运算。'
      + '与 --business-systems 无关（两个加数都不按业务系统圈）；'
      + '不按报告期过滤（漏洞表导出时已圈定，同 D14/D15）。'
      + '边界：两个加数都是 0 -> 写 **0**（结论，不是缺数）；'
      + '任一加数缺列 / 读不到（例如内网漏洞表缺「AF 防护规则」列）-> 本格整格不写值 +'
      + '记错误，错误文案就是那个加数自己的 —— 少了一个加数却看上去"算完了"，'
      + '比明说"没取到数"更容易被当成结论。'
      + '口径见 stats/metrics/vuln.js 的 protectedPlusSettledVulnCount。',
    compute: (ctx) => protectedPlusSettledVulnCount(ctx),
    verify: ''
  },
  {
    addr: 'G23',
    label: '已防护漏洞数',
    desc: '**同 D14「已防护漏洞数」**（用户口径 2026-10-26：「G23 alias D14」）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D14 那条 `desc`：内网漏洞表里「AF 防护规则」'
      + '整格等于「有效」且「处置状态」整格等于「处置完成（已缓解）」的行数；'
      + '空表 / 无命中写 0；缺这两列时 D14 不写值 + 记错误，本格跟着进 `errors`'
      + '（报「alias 目标 D14 没有算出值」）。'
      + '⚠️ G22 = G23 + G24 把它们当加数用 —— 改本格的指向（别再 alias D14）时，'
      + 'G22 的式子也得跟着看，别只改一头。',
    alias: 'D14',
    verify: ''
  },
  {
    addr: 'G24',
    label: '已修复漏洞数',
    desc: '同 D15 —— 本格与 D15「已修复漏洞数」是同一个标题、也是**同一个数**'
      + '（用户口径 2026-10-14：「G24 是已修复漏洞数，取值 alias D15」）。'
      + 'D15 是主地址，算法只写在它那一条记录里（「漏洞表」总表中「处置状态」列的值'
      + '包含「处置完成」的行数）；本格走 alias，不重抄一遍（H5）。'
      + '算法、判据边界（包含判据，四种带括号的形态都算，「处置中」不算）、空表行为全部见 D15 的 desc，'
      + '本格一个字都不重算。'
      + '⚠️ 两条连带后果，看报告的人要知道：'
      + '① 报告上这是**两个格子里的同一个数**，改 D15 的口径等于同时改本格，反之亦然；'
      + '② 本格因此**不读盘、没有自己的列白名单条目**（漏洞表的列白名单里不需要为它加东西），'
      + '缺「处置状态」列时两格一起不写值 + 记错误。',
    alias: 'D15',
    verify: ''
  },
  {
    addr: 'G51',
    label: '平均识别时长',
    desc: '事件表里**所有**行的「识别时长」列的**非空值**平均数（单位：分钟）—— '
      + '用户口径 2026-10-13 第二版：「这五个单元格的时间，不用跟推送状态挂钩」。'
      + '**一道筛都没有**：不分推送状态、不分处置状态、不看任何别的列，'
      + '事件表导出进来多少行就是多少行，只由「识别时长」列本身有没有值决定进不进分母'
      + '（空 / 占位符 `-` / 负差值 —— 后两种在预处理那一步就已经留空了，本格只读不算）。'
      + '不按报告期过滤（事件表导出时已按 --start/--end 圈定，与 G8/G9/D35 同一条）。'
      + '「识别时长」不是平台导出的列：由表格预处理按「事件创建时间 − 组件检出时间」算出来'
      + '（分钟、2 位小数）追加进事件表下载件，见 scripts/report_preprocess.py；'
      + '本格读的那一列若不在表头里（= 预处理没算出这一列）-> 不写值 + 记错误（R10 缺数不静默）；'
      + '没有可平均的样本（事件表 0 行 / 有行但这一列整列为空）-> 写 **0** 且不记错误'
      + '（0 是结论，不是缺数）。'
      + '⚠️ 本格与 D35「平均分析时间」**读的是同一列、却不是同一个数**：D35 只数'
      + '「推送状态」=「已推送」的那批行，本格数全表 —— 所以本格**不是** D35 的 alias'
      + '（用户口径 2026-10-13 第二版推翻了同日第一版「复用」的说法，四条 alias 已全部撤掉）。'
      + '⚠️ 本仓的时长均值格共九处，分两组，别再混：'
      + 'G9（已处置 ∩ 已推送，响应时长）、D35/D36/E49（已推送，三列）是一组；'
      + '本格与 G52 / G53 / G54 / G55（全表，五列）是另一组。'
      + '算法见 stats/metrics/event.js 的 averageEventDurationMinutes。',
    compute: (ctx) => averageEventDurationMinutes(ctx, RECOGNIZE_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'G52',
    label: '平均响应时长',
    desc: '与 G51 同一套口径，算的是「响应时长」那一列：事件表里**所有**行的'
      + '「响应时长」列的非空值平均数（单位：分钟）—— 用户口径 2026-10-13 第二版'
      + '「不用跟推送状态挂钩」，**一道筛都没有**。两格只差传入的列名，'
      + '共用 stats/metrics/event.js 的 averageEventDurationMinutes（H4）。'
      + '「响应时长」不是平台导出的列：由表格预处理按「专家研判时间 − 组件检出时间」算出来'
      + '（分钟、2 位小数）追加进事件表下载件，本格只读不算；'
      + '缺这一列 -> 不写值 + 记错误；没有可平均的样本 -> 写 **0** 且不记错误。'
      + '⚠️ 与 G9「事件平均响应时长」**读的是同一列、却不是同一个数**：G9 只数'
      + '「处置状态」已处置 ∩「推送状态」=「已推送」的**交集**，本格数全表 —— '
      + '同一份表上两个数必须不一样，不能互相 alias。'
      + '⚠️ 与 D36「平均响应时间」同理（D36 只数已推送那批）：本格不是它的 alias。',
    compute: (ctx) => averageEventDurationMinutes(ctx, RESPONSE_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'G53',
    label: '平均遏制时长',
    desc: '与 G51 同一套口径，算的是「遏制时长」那一列：事件表里**所有**行的'
      + '「遏制时长」列的非空值平均数（单位：分钟）—— 用户口径 2026-10-13 第二版'
      + '「不用跟推送状态挂钩」，**一道筛都没有**。四格只差传入的列名，'
      + '共用 stats/metrics/event.js 的 averageEventDurationMinutes（H4）。'
      + '「遏制时长」不是平台导出的列：由表格预处理按「事件遏制时间 − 专家研判时间」算出来'
      + '（分钟、2 位小数，负差值判为不合法、留空）追加进事件表下载件，本格只读不算；'
      + '缺这一列 -> 不写值 + 记错误；没有可平均的样本 -> 写 **0** 且不记错误。'
      + '⚠️ 与 G7「威胁平均遏制时间」**读的是同一列、却不是同一个数**：G7 只数'
      + '「GPT研判结论」整格精确等于「真实攻击未成功」的那批行'
      + '（stats/metrics/event.js 的 averageContainedMinutes），本格数全表 ——'
      + '同一份表上两个数必须不一样，谁把本格写成 G7 的 alias（或反过来）这里立刻露红。'
      + '⚠️ 五个时长列**逐列独立**（用户口径 2026-10-12）：「事件遏制时间」缺席时'
      + '预处理压根不建「遏制时长」这一列，只停本格与 G7，G51 / G52 / G54 / G55 照常落值。',
    compute: (ctx) => averageEventDurationMinutes(ctx, CONTAINED_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'G54',
    label: '平均处置时长',
    desc: '与 G51 同一套口径，算的是「处置时长」那一列：事件表里**所有**行的'
      + '「处置时长」列的非空值平均数（单位：分钟）—— 用户口径 2026-10-13 第二版'
      + '「不用跟推送状态挂钩」，**一道筛都没有**。四格只差传入的列名，'
      + '共用 stats/metrics/event.js 的 averageEventDurationMinutes（H4）。'
      + '「处置时长」不是平台导出的列：由表格预处理按「事件闭环时间 − 事件创建时间」算出来'
      + '（分钟、2 位小数）追加进事件表下载件，本格只读不算；'
      + '缺这一列 -> 不写值 + 记错误；没有可平均的样本 -> 写 **0** 且不记错误。'
      + '⚠️ 与 E49「事件平均处置时长」**读的是同一列、却不是同一个数**：E49 只数'
      + '「推送状态」=「已推送」的那批行，本格数全表 —— 本格**不是** E49 的 alias'
      + '（第二版口径把第一版的「复用」撤掉了）。'
      + '⚠️ 与同批的 G55「平均闭环时长」**在任何输入上都同值，却刻意不互为 alias**：'
      + '两格读的是两列（「处置时长」与「闭环时长」），今天的相等是'
      + '"预处理把这两列造成同式同源"这个事实，不是"一格复用了另一格"。'
      + '各写各的 compute，哪天预处理把其中一列的算式改掉，两格各自跟上、接线一个字都不用动'
      + '（与 D32/D33、D38/G101 那两对同一条安排）。',
    compute: (ctx) => averageEventDurationMinutes(ctx, DISPOSAL_DURATION_COLUMN),
    verify: ''
  },
  {
    addr: 'G55',
    label: '平均闭环时长',
    desc: '与 G51 同一套口径，算的是「闭环时长」那一列：事件表里**所有**行的'
      + '「闭环时长」列的非空值平均数（单位：分钟）—— 用户口径 2026-10-13 第二版'
      + '「不用跟推送状态挂钩」，**一道筛都没有**。四格只差传入的列名，'
      + '共用 stats/metrics/event.js 的 averageEventDurationMinutes（H4）。'
      + '「闭环时长」不是平台导出的列：由表格预处理按「事件闭环时间 − 事件创建时间」算出来'
      + '（分钟、2 位小数）追加进事件表下载件，本格只读不算；'
      + '缺这一列 -> 不写值 + 记错误；没有可平均的样本 -> 写 **0** 且不记错误。'
      + '⚠️ 本格与 G54「平均处置时长」**在任何输入上都同值**：预处理给这两列用的是'
      + '同一条算式、同一对源列（都是「事件闭环时间 − 事件创建时间」，用户 2026-10-13 点名要的'
      + '冗余列，见 scripts/report_preprocess.py 的 DURATION_COLUMNS），逐行恒等。'
      + '但两格**刻意不互为 alias**、也**都不指向 E49**（E49 只数已推送那批、与本格口径不同）：'
      + '各自读自己那一列、各写各的 compute —— 哪天其中一列的算式与另一列分开，'
      + '两格各自跟着自己那一列走。'
      + '⚠️ 本列直到本格立项才**有了第一个读者**：2026-10-13 预处理刚追加它时'
      + '它对谁都没用，因此起初不在 stats/metrics/event.js 的 EVENT_TABLE_COLUMNS 里，'
      + '随本格一起补进去的（白名单是"各处需要的并集"，不是"表里有的列"）。',
    compute: (ctx) => averageEventDurationMinutes(ctx, CLOSURE_DURATION_COLUMN),
    verify: ''
  },
  monthCell('G58', 4, 'label'),
  monthCell('G59', 4, 'mean'),
  topSrcGeoCell('G62', 0, 'count'),
  topSrcGeoCell('G63', 1, 'count'),
  topSrcGeoCell('G64', 2, 'count'),
  topSrcGeoCell('G65', 3, 'count'),
  topSrcGeoCell('G66', 4, 'count'),
  monthlyAttackCell('G71', 4, 'label'),
  monthlyAttackCell('G72', 4, 'count'),
  monthlyOutboundCell('G73', 4),
  monthlyAlarmCell('G75', 4),
  monthlyVulnCell('G86', 4, 'label'),
  monthlyVulnCell('G87', 4, 'count'),
  monthlyVulnCell('G88', 4, 'closed'),
  importantPeriodDailyCell('G91', 0),
  importantPeriodDailyCell('G92', 1),
  importantPeriodDailyCell('G93', 2),
  importantPeriodDailyCell('G94', 3),
  importantPeriodDailyCell('G95', 4),
  importantPeriodDailyCell('G96', 5),
  importantPeriodDailyCell('G97', 6),
  {
    addr: 'G99',
    label: 'xdr日志数',
    desc: '模板第 99 行「xdr日志数」的值格：**报告期内 XDR 平台接收到的安全日志条数**'
      + '（用户口径 2026-10-13）。'
      + '数据来自**日志量接口**（不是六份总表里的任何一份：没有下载件、没有 parse 环节、'
      + '报告里也没有对应的 sheet）：同一端点 POST /gateway/mss-mdr/web/api/mssw/mss-mdr/v1/logs-aggregations-count'
      + '问两次，`tableName` 分别给 `network_security_log`（网络安全日志）与 '
      + '`endpoint_security_log`（终端安全日志）；每次取 `data.total`，'
      + '**两张表相加、不去重** —— 相加这一步在 mssw_client.js 的 fetchMsswSecurityLogCount 里。'
      + '请求体里的 `fromDate` / `toDate` 是 **epoch 秒**；「客户」靠请求体里那条'
      + '「客户 = 当前客户」的约束圈（请求头不带 `x-mssw-company-id`）。'
      + '报告期**就是命令行 --start/--end**（用户口径 2026-10-13）：'
      + '起 = 起始日 00:00:00、止 = 结束日 23:59:59（本地时区，与事件/告警表同一把尺子）换算成秒；'
      + '⚠️ 不做"近 30 天"之类的收窄 —— 抓包里那两个数差整 30 天，那是浏览器前端的默认窗口，不是口径。'
      + '与 --business-systems 无关：日志量是整个租户的，不按业务系统圈。'
      + '边界：报告期内一条日志都没有（接口答了、两张表都是 0）时本格写 **0**'
      + '（0 是结论，不是缺数）；**接口调不通**时本格写「**接口不通无值**」'
      + '（长期口径，用户口径 2026-10-13：接口不通**不拦整份报告**，这一格就写这六个字 —— '
      + '不是 0，也不是不写值；真实原因在运行日志里）；'
      + '接口**没给数量**（`data.total` 不是数字）-> 不写值 + 记错误'
      + '（禁止静默当 0）。',
    compute: (ctx) => securityLogCount(ctx),
    verify: ''
  },
  {
    addr: 'G100',
    label: 'xdr告警数',
    desc: '「告警表」总表的**告警行数** —— 整张表有多少行数据就是多少（用户口径 2026-10-13'
      + '「G100 是告警数，取告警表的告警行数」）。'
      + '计数口径：**按行计数，一行一票**，不去重、不按告警 ID / 主机IP 合并；'
      + '也不看任何一列的内容（不看「告警定性」、不看「GPT研判结论」、不看「处置状态」）。'
      + '⚠️ 这一格**一个列名都不读** —— 数的是下载件里有多少行，平台改了列名、多一列少一列'
      + '都影响不到它。所以它不会因为"列名对不上"而不写值，也没有缺列这一档'
      + '（全仓只有本格与 G101「xdr事件数」这两格是这样）。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内（--start/--end 在下载层用掉），'
      + '本仓取值层不叠加第二道时间过滤（与告警定性那 14 格、G5 同一条）。'
      + '边界：告警表为空（0 行）-> 写 **0**（0 是结论，不是缺数 —— 下载一定发生，'
      + '告警表下不到时 scripts/build_report.py 直接报「缺少告警表的下载结果」、整份报告不出）。',
    compute: (ctx) => alarmRowCount(ctx),
    verify: ''
  },
  {
    addr: 'G101',
    label: 'xdr事件数',
    desc: '「事件表」总表的**事件行数** —— 整张表有多少行数据就是多少（用户口径 2026-10-13'
      + '「G101 是事件数，取事件表事件行数」）。'
      + '计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并；'
      + '也不看任何一列的内容（不看「处置状态」、不看「GPT定性标签」、不看「GPT研判结论」）。'
      + '⚠️ 这一格**一个列名都不读** —— 数的是下载件里有多少行，平台改了列名、多一列少一列'
      + '都影响不到它。所以它不会因为"列名对不上"而不写值，也没有缺列这一档'
      + '（全仓只有本格与 G100「xdr告警数」这两格是这样）。'
      + '⚠️ 与同表的 G8「处置安全事件总数」/ G106「处置中事件数」/ G107「待处置事件数」'
      + '**不是一回事**：那三格要「处置状态」精确命中某个值，本格一行都不筛 —— '
      + '同一份事件表上本格是"全表行数"，那三格各自只是它的一个子集，三个数相加通常小于它'
      + '（处置状态为空 / 占位符 `-` 的行只进本格，不进那三格）。'
      + '不过滤报告期 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '边界：事件表为空（0 行）-> 写 **0**（0 是结论，不是缺数 —— 下载一定发生，'
      + '事件表下不到时 scripts/build_report.py 直接报「缺少事件表的下载结果」、整份报告不出）。',
    compute: (ctx) => eventRowCount(ctx),
    verify: ''
  },
  {
    addr: 'G102',
    label: '已处置事件数',
    desc: '同 G8 —— 本格与 G8「处置安全事件总数」是**同一个数**（用户口径 2026-10-13：'
      + '「精确匹配事件表『处置状态』列的值，如果精确等于『已遏制』或者『已忽略』或者'
      + '『处置完成』，就加一」—— 与 G8 那三个状态逐字相同）。'
      + 'G8 是主地址，算法只写在它那一条记录里；本格走 alias，不重抄一遍（H5）。'
      + '算法、口径边界、空表行为全部见 G8 的 desc，本格一个字都不重算。'
      + '⚠️ 不要与隔壁几格混了：G106「处置中事件数」/ G107「待处置事件数」读的是**另外两个'
      + '状态值**（各自一格）；G103 / G104 / G105 是**按处置来源**的另一套拆法'
      + '（模板那三行写的是「本地处置事件数」「mss处置事件数」「自动处置事件数」），'
      + '口径未定、仍未接 —— 与本格没有加减关系，别拿它们互相推算。',
    alias: 'G8',
    verify: ''
  },
  u('G103', '已处置非白名单事件'),
  u('G104', '差异数（g102 - g103）'),
  u('G105', '已处置（非白名单）'),
  {
    addr: 'G106',
    label: '处置中事件数',
    desc: '「事件表」总表里「处置状态」**整格精确等于**「处置中」的事件**行数**'
      + '（用户口径 2026-10-13）。'
      + '计数口径：按行计数、一行一票，不去重 —— 同一台机器上有几条这样的事件就算几条。'
      + '比较前只去首尾空白，不做全半角 / 括号归一：带后缀的「处置中（人工）」不算，'
      + '空值、平台的占位符「-」、「待处置」「已遏制」「处置完成」「已忽略」也都不算'
      + '（不是同一个字符串）—— 本格问的是"有几条事件正处在处置中"，'
      + '不是"有几条事件没写处置状态"。'
      + '⚠️ 与隔壁 G102「已处置事件数」（= G8，已遏制 / 处置完成 / 已忽略三个状态）'
      + '不是一回事，两格数的是两批互斥的行；G107「待处置事件数」同理。'
      + '数的是**整张事件表**、不经 --business-systems 圈定（与 G8 同一条）。'
      + '不过滤报告期 —— 事件表导出时已按 --start/--end 圈定，本仓取值层不叠加第二道时间过滤。'
      + '边界：事件表为空（0 行）、或表里有行但一条「处置中」都没有 -> 写 **0**'
      + '（0 是结论，不是缺数 —— 下载一定发生，事件表下不到时 scripts/build_report.py '
      + '直接报「缺少事件表的下载结果」、整份报告不出）；'
      + '表里有行、却读不出「处置状态」列（平台改了列名）-> 记入错误列表、不写值（不填 0）。',
    compute: (ctx) => eventCountByDisposition(ctx, IN_PROGRESS_EVENT_STATUS),
    verify: ''
  },
  {
    addr: 'G107',
    label: '待处置事件数',
    desc: '「事件表」总表里「处置状态」**整格精确等于**「待处置」的事件**行数**'
      + '（用户口径 2026-10-13）。'
      + '除了待匹配的那个状态值，「计数口径 / 比较前只去首尾空白 / 不看别的列 / '
      + '数整张表 / 不过滤报告期 / 空表写 0 / 缺列不写值 + 记错误」逐字同 G106 —— '
      + '两格只差一个状态值，算法共用 stats/metrics/event.js 的 eventCountByDisposition（H4），'
      + '本格不重抄一遍过滤条件。'
      + '比较前只去首尾空白，不做全半角 / 括号归一：带后缀的「待处置（待确认）」不算，'
      + '空值、平台的占位符「-」、「处置中」「已遏制」「处置完成」「已忽略」也都不算。'
      + '⚠️ 与 G102「已处置事件数」（= G8 那三个状态）不是一回事：两格数的是两批互斥的行，'
      + '同一份事件表上这两个数没有任何加减关系；处置状态为空 / 占位符的行两格都不进'
      + '（只进 G101「xdr事件数」那个全表行数）。',
    compute: (ctx) => eventCountByDisposition(ctx, PENDING_EVENT_STATUS),
    verify: ''
  },
  {
    addr: 'G110',
    label: '未公开威胁去重资产数',
    desc: '**同 D12「最新漏洞影响资产数」**（用户口径 2026-10-22：「G110 是未公开威胁去重资产数，'
      + 'alias D12」）。走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D12 那条 `desc`：漏洞表全表里「威胁标签」含'
      + '「热点漏洞」的行，按「风险资产」归一后去重数台数；空表 / 无命中写 0；'
      + '缺「威胁标签」或「风险资产」列时不写值 + 记错误。'
      + '⚠️ 缺数也**跟着 D12 走**：D12 没算出值时本格进 `errors`，报的是'
      + '「alias 目标 D12 没有算出值」—— 因为它根本不读表。'
      + '（G110 与 D115 是同一个数，两个地址各自 alias D12，不是链式 alias。）',
    alias: 'D12',
    verify: ''
  },
  u('G111', '核心系统闭环统计（系统1）'),
  u('G112', '核心系统闭环统计（系统2）'),
  u('G113', '核心系统闭环率（系统1）'),
  u('G114', '核心系统闭环统计（系统3）'),
  u('G115', '核心系统闭环统计（系统1·续）'),
  u('G116', '核心系统闭环率（系统2）'),
  u('G117', '核心系统闭环统计（系统2·续）'),
  u('G118', '核心系统闭环统计（系统3·续）'),
  u('G119', '核心系统闭环率（系统3）'),
  u('G122', '高危漏洞总数（= D110）'),
  u('G123', '最新漏洞影响资产数（= D12）'),
  u('G124', '已修复漏洞数（= D15）'),
  u('G125', '弱口令总数（全量）'),
  u('G126', '漏洞表含「弱口令」工单数'),
  {
    addr: 'G133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 5 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 5 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 4),
    verify: ''
  },
  {
    addr: 'G134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 5 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 5 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 4),
    verify: ''
  },
  eventCell('G135', 4, 'label'),
  eventCell('G136', 4, 'count'),
  eventCell('G137', 4, 'share'),
  threatAlarmCell('H6', 1, '核心系统威胁告警数量分布'),
  monthCell('H58', 5, 'label'),
  monthCell('H59', 5, 'mean'),
  monthlyAttackCell('H71', 5, 'label'),
  monthlyAttackCell('H72', 5, 'count'),
  monthlyOutboundCell('H73', 5),
  monthlyAlarmCell('H75', 5),
  monthlyVulnCell('H86', 5, 'label'),
  monthlyVulnCell('H87', 5, 'count'),
  monthlyVulnCell('H88', 5, 'closed'),
  importantPeriodDistributionCell('H91', 0, 'rate'),
  importantPeriodDistributionCell('H92', 1, 'rate'),
  importantPeriodDistributionCell('H93', 2, 'rate'),
  importantPeriodDistributionCell('H94', 3, 'rate'),
  importantPeriodDistributionCell('H95', 4, 'rate'),
  importantPeriodDistributionCell('H96', 5, 'rate'),
  importantPeriodDistributionCell('H97', 6, 'rate'),
  {
    addr: 'H133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 6 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 6 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 5),
    verify: ''
  },
  {
    addr: 'H134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 6 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 6 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 5),
    verify: ''
  },
  eventCell('H135', 5, 'label'),
  eventCell('H136', 5, 'count'),
  eventCell('H137', 5, 'share'),
  threatAlarmCell('I6', 2, '核心系统威胁告警数分布（系统3）'),
  monthCell('I58', 6, 'label'),
  monthCell('I59', 6, 'mean'),
  threatTypeCell('I62', 0, 'label'),
  threatTypeCell('I63', 1, 'label'),
  threatTypeCell('I64', 2, 'label'),
  threatTypeCell('I65', 3, 'label'),
  threatTypeCell('I66', 4, 'label'),
  monthlyAttackCell('I71', 6, 'label'),
  monthlyAttackCell('I72', 6, 'count'),
  monthlyOutboundCell('I73', 6),
  monthlyAlarmCell('I75', 6),
  {
    addr: 'I79',
    label: '互联网IP数量',
    desc: '（用户口径 2026-10-21，投喂原话：「I79是互联网IP数量，暴露面表高危端口&服务'
      + ' sheet，找包含『IP资产』的单元格右侧一个单元格的值」）'
      + '读暴露面表下载件「文档说明」sheet 的汇总表：逐格找**包含**「IP资产」的单元格，'
      + '取它**右侧一格**的值（数字），原样落这一格。'
      + '⚠️ 投喂原话写的 sheet 名与实际不符：三份真实下载件里「IP资产」只在「文档说明」'
      + '汇总表（K18/L18），「高危端口&服务」是纯数据表、没有汇总行 —— 本仓按真实结构读'
      + '（核对说明见 stats/metrics/exposed.js 的 EXPOSED_INTERNET_ASSET_LABELS）。'
      + '计数单位是**那个单元格里的数**，不是数行数、不求和；只有一项，不涉及去重。'
      + '与 D128 读同一张汇总表、但不是同一个数：D128 是 13 项**精确匹配**求和，'
      + '本格是**包含匹配**只取这一项；D128 缺别的项不影响本格。'
      + '不叠加报告期：暴露面导出的是当前状态，接口不带时间参数。'
      + '没有汇总行 -> 写 0；有汇总行却找不到含「IP资产」的格子 / 右侧不是数字 -> '
      + '不写值 + 记错误。口径见 stats/metrics/exposed.js 的 internetIpAssetCount。',
    compute: (ctx) => internetIpAssetCount(ctx),
    verify: ''
  },
  {
    addr: 'I80',
    label: '互联网端口数量',
    desc: '（用户口径 2026-10-21，投喂原话：「I80是互联网端口数量，同sheet，'
      + '找包含『端口资产』的单元格右侧一个单元格的值」）'
      + '与 I79 **逐字同一套口径**，只把定位文字换成「端口资产」：在暴露面表下载件'
      + '「文档说明」汇总表里找**包含**「端口资产」的单元格，取右侧一格的值。'
      + '计数单位是单元格里的数（真实件 2026-10-21 是 2945，不是端口数据表的行数）；'
      + '不去重、不叠加报告期。没有汇总行 -> 写 0；缺这一项 / 右侧不是数字 -> '
      + '不写值 + 记错误。口径见 stats/metrics/exposed.js 的 internetPortAssetCount。',
    compute: (ctx) => internetPortAssetCount(ctx),
    verify: ''
  },
  {
    addr: 'I81',
    label: '暴露面风险端口数量',
    desc: '（用户口径 2026-10-19，投喂原话：「i81是暴露面风险端口数量，取暴露面表的'
      + '高危端口&服务sheet，统计除了表头的行数」）'
      + '读暴露面表下载件的「高危端口&服务」sheet，数**除表头行以外**的数据行数：'
      + '一行一条，不按列筛选、不去重；整行没值的空行不算（读取层与报告 sheet 的行集合同源，'
      + '见 scripts/parse_table_rows.py 的 rowCount）。'
      + '只有表头、0 行数据 -> 写 0（"这一版暴露面没有高危端口"是结论，与其它计数格同一条）。'
      + 'sheet 不存在 / 下载件读不了 -> 读取层当场抛错（R10），整份报告不出。'
      + '不叠加报告期：暴露面导出的是**当前**暴露面，接口不带时间范围（`--start/--end` 不参与）。'
      + '口径与 sheet 名的权威在 stats/metrics/exposed.js（H4）。',
    compute: (ctx) => exposedHighRiskPortCount(ctx),
    verify: ''
  },
  {
    addr: 'I82',
    label: '外网资产漏洞数量',
    desc: '（用户口径 2026-10-21，投喂原话：「I82是外网资产漏洞数量，取值是互联网漏洞表，'
      + '找有效行的数量。注意所有的漏洞操作都是等预处理后才做的，预处理包含删除处置完成误判的行」）'
      + '读**互联网漏洞表**（只外网那一张 sheet，ctx.vulnOuterRows，不是内网 + 外网拼接的'
      + 'ctx.vulnRows），数**有效数据行数**：表头不算；整行都没值的空行在解析层就丢掉了'
      + '（scripts/parse_table_rows.py 的 collect_source_rows），所以数出来的就是报告里'
      + '那张 sheet 肉眼看到的行数。'
      + '⚠️ 预处理在前：「处置状态」=「处置完成（误报）」的整行在下载层解包时'
      + '（scripts/extract_vuln_report.py）就已删除，本格与所有漏洞格读到的都是删过的行集合。'
      + '一行一条：不按资产 / 漏洞名称去重、不按处置状态筛选（「有效行」= 不是空行，'
      + '不是"已处置"或"未误报"这类筛选）。'
      + '不按报告期过滤 —— 漏洞表导出时已按「首次发现时间」圈定（同 D10/D12/D15/D80）。'
      + '边界：互联网漏洞表为空（0 行）-> 写 0（结论，不是缺数）。'
      + '口径见 stats/metrics/vuln.js 的 internetVulnRowCount。',
    compute: (ctx) => internetVulnRowCount(ctx),
    verify: ''
  },
  monthlyVulnCell('I86', 6, 'label'),
  monthlyVulnCell('I87', 6, 'count'),
  monthlyVulnCell('I88', 6, 'closed'),
  u('I122', '已处置弱口令数'),
  u('I123', '业务系统IP已处置弱口令合计'),
  u('I124', '木马/病毒已闭环事件数'),
  {
    addr: 'I133',
    label: '告警威胁定义名称',
    desc: '「告警表」总表中「告警定性」出现次数第 7 多的定性名称。按行计数，一行一票；'
      + '一行只有一个定性，不拆分、不去重。不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 7 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationLabelAt(ctx, 6),
    verify: ''
  },
  {
    addr: 'I134',
    label: '告警威胁定义占比',
    mode: 'percent',
    desc: '「告警表」总表中出现次数第 7 多的那个「告警定性」的占比 = 该项的出现行数 ÷ 全部定性的出现总次数。'
      + '分母是全量，不是前几名之和，所以第 133 行 7 个名称的占比加起来通常小于 100%。'
      + '按行计数，一行一票；一行只有一个定性，不拆分、不去重；空值、以及平台的占位符「-」（列级的「无」标记）都不算一种定性、也不进分母。'
      + '不过滤报告期 —— 告警表导出时已按首次发生时间落在报告期内。'
      + '出现次数相同时，在该表中首次出现行序靠前的排在前。'
      + '表中不同定性不足 7 个时，本格写空串；告警表为空、或所有行的定性都为空 / 都是占位符时，本格写空串（那是结论，不是缺数）。',
    compute: (ctx) => qualificationShareAt(ctx, 6),
    verify: ''
  },
  eventCell('I135', 6, 'label'),
  eventCell('I136', 6, 'count'),
  eventCell('I137', 6, 'share'),
  // 报告参数格。模板此格空白，label 是手写的（不是从模板抽的）。
  {
    addr: 'J1',
    label: '客户名称',
    desc: '本次报告的客户名，直接取 CLI 的 --customer，不参与统计、不随总表数据变化。' +
          '只传 --customer-id 而没传 --customer 时写空串。',
    compute: (ctx) => ctx.customer,
    verify: ''
  },
  monthCell('J58', 7, 'label'),
  monthCell('J59', 7, 'mean'),
  threatTypeCell('J62', 0, 'count'),
  threatTypeCell('J63', 1, 'count'),
  threatTypeCell('J64', 2, 'count'),
  threatTypeCell('J65', 3, 'count'),
  threatTypeCell('J66', 4, 'count'),
  monthlyAttackCell('J71', 7, 'label'),
  monthlyAttackCell('J72', 7, 'count'),
  monthlyOutboundCell('J73', 7),
  monthlyAlarmCell('J75', 7),
  monthlyVulnCell('J86', 7, 'label'),
  monthlyVulnCell('J87', 7, 'count'),
  monthlyVulnCell('J88', 7, 'closed'),
  monthCell('K58', 8, 'label'),
  monthCell('K59', 8, 'mean'),
  monthlyAttackCell('K71', 8, 'label'),
  monthlyAttackCell('K72', 8, 'count'),
  monthlyOutboundCell('K73', 8),
  monthlyAlarmCell('K75', 8),
  {
    addr: 'K79',
    label: '内网服务器资产数量',
    desc: '（用户口径 2026-10-21，投喂原话：「K79是内网服务器资产数量，资产表精确查找'
      + '『互联网暴露』列，精确匹配值是『未暴露』且精确查找『资产类型(一级)』列，'
      + '精确匹配值是『服务器』的总数」）'
      + '读资产表，数**同时满足**两个条件的行数：'
      + '「互联网暴露」整格精确等于「未暴露」**且**「资产类型(一级)」整格精确等于「服务器」。'
      + '两个判据都是精确相等（比较前只去首尾空白），不做包含 / 前缀 / 全半角归一 —— '
      + '`已暴露`、`服务器区`、`X86服务器` 都不算。'
      + '计数单位是**资产行数**（一台一行），不按 IP 去重：同一台机器出现两行就是 2。'
      + '不读「托管状态」，与 --business-systems 无关，也不叠加报告期过滤（资产表是当前台账）。'
      + '边界：资产表 0 行、或一台都不命中 -> 写 0（是结论，不是缺数）；'
      + '表头里没有「互联网暴露」或「资产类型(一级)」列 -> 不写值、记错误。'
      + '口径见 stats/metrics/asset.js 的 intranetServerCount。',
    compute: (ctx) => intranetServerCount(ctx),
    verify: ''
  },
  {
    addr: 'K80',
    label: '内网MSS服务资产数',
    desc: '（用户口径 2026-10-21，投喂原话：「K80是内网MSS服务资产数，在前面的基础上，'
      + '同时满足资产表「托管状态」列的值是『基础托管』或『深度托管』的总数」）'
      + '在 K79 的两个条件上**再加一条**：资产表「托管状态」整格精确等于「基础托管」'
      + '或「深度托管」（二选一，任一即算）。三条同时满足才计数。'
      + '「托管状态」的比较同样只去首尾空白、精确相等；空值、别的托管档位都不算。'
      + '计数单位、不去重、不按报告期过滤等口径与 K79 **逐字相同**'
      + '（两格共用 stats/metrics/asset.js 的 intranetServerAssetCount）。'
      + '边界：资产表 0 行、或一台都不命中 -> 写 0；'
      + '缺「互联网暴露」「资产类型(一级)」「托管状态」任一列 -> 不写值、记错误'
      + '（K79 不读「托管状态」，这一列只影响本格）。',
    compute: (ctx) => intranetMssAssetCount(ctx),
    verify: ''
  },
  {
    addr: 'K81',
    label: '内网MSS资产安全漏洞总数',
    desc: '（用户口径 2026-10-23，投喂原话：「K81是内网MSS资产安全漏洞总数，'
      + '取内网漏洞表的有效行数」）'
      + '读**内网漏洞表**（ctx.vulnInnerRows，下载层单独读的那一张 sheet），'
      + '数**有效数据行数**：表头不算；整行都没值的空行在解析层就被丢了'
      + '（scripts/parse_table_rows.py 的 collect_source_rows），所以直接数数组长度，'
      + '与报告里「内网漏洞表」sheet 肉眼看到的行数同源。'
      + '**预处理之后**才数：解包层（scripts/extract_vuln_report.py）已删掉'
      + '「处置状态」=「处置完成（误报）」的整行，那些行不在这里、也不在任何漏洞格里。'
      + '按行计数，一行一条；不按资产 / 漏洞名称去重、不按任何列筛选；'
      + '不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定）。'
      + '边界：内网漏洞表 0 行 -> 写 0（是结论，不是缺数）。'
      + '口径见 stats/metrics/vuln.js 的 intranetVulnRowCount。',
    compute: (ctx) => intranetVulnRowCount(ctx),
    verify: ''
  },
  {
    addr: 'K82',
    label: '已防护漏洞数',
    desc: '**同 D14「已防护漏洞数」**（用户口径 2026-10-23：「K82是内网已防护漏洞数，alias D14」）。'
      + '走 `alias`、本格不自己读表、没有自己的 `compute`（H5）。'
      + '算法、口径边界、缺数行为全部见 D14 那条 `desc`：内网漏洞表里「AF 防护规则」'
      + '整格等于「有效」且「处置状态」整格等于「处置完成（已缓解）」的行数；'
      + '空表 / 无命中写 0；缺这两列时 D14 不写值 + 记错误，本格跟着进 `errors`'
      + '（报「alias 目标 D14 没有算出值」）。',
    alias: 'D14',
    verify: ''
  },
  {
    addr: 'K83',
    label: '已修复漏洞数',
    desc: '（用户口径 2026-10-23，投喂原话：「K83是内网已修复漏洞数，只取内网漏洞表'
      + '『处置状态』列里面精确匹配处置完成（已修复）或处置完成（已缓解）或'
      + '处置完成（接受风险）或处置完成（忽略）的总数」）'
      + '读**内网漏洞表**（ctx.vulnInnerRows），数「处置状态」**整格精确等于**'
      + '那四种带括号形态之一的行数。'
      + '「精确匹配」= 整格相等（比较前只去首尾空白），不是包含、也不是前缀；'
      + '`待处置` / `处置中` / 不带括号的 `处置完成` / `处置完成（误报）` 都不算。'
      + '与 D14 的差别：本格**不读**「AF 防护规则」列，四种形态任一即计数。'
      + '按行计数，一行最多算一条；不去重、不按漏洞名称合并；'
      + '不按报告期过滤（同 D10/D14/D15/D80）。'
      + '边界：内网漏洞表 0 行 -> 写 0（是结论，不是缺数）；'
      + '有行数据但缺「处置状态」列 -> 不写值、记错误。'
      + '口径见 stats/metrics/vuln.js 的 fixedInnerVulnCount。',
    compute: (ctx) => fixedInnerVulnCount(ctx),
    verify: ''
  },
  monthlyVulnCell('K86', 8, 'label'),
  monthlyVulnCell('K87', 8, 'count'),
  monthlyVulnCell('K88', 8, 'closed'),
  // 报告参数格。模板此格空白，label 是手写的。
  {
    addr: 'L1',
    label: '统计周期起始日',
    desc: '报告期起始日，直接取 CLI 的 --start，按 YYYY/MM/DD（斜杠）写入 —— ' +
          '与 PPT 封面的 YYYY-MM-DD 刻意不同，见 stats/periods.js。' +
          '不参与统计。起始日含在报告期内（闭区间）。',
    compute: (ctx) => formatReportDate(ctx.range.start),
    verify: ''
  },
  importantPeriodListCell('L4', 0, 'name'),
  importantPeriodListCell('L5', 1, 'name'),
  importantPeriodListCell('L6', 2, 'name'),
  importantPeriodListCell('L7', 3, 'name'),
  importantPeriodListCell('L8', 4, 'name'),
  importantPeriodListCell('L9', 5, 'name'),
  importantPeriodListCell('L10', 6, 'name'),
  monthCell('L58', 9, 'label'),
  monthCell('L59', 9, 'mean'),
  dstIpCell('L62', 0, 'label'),
  dstIpCell('L63', 1, 'label'),
  dstIpCell('L64', 2, 'label'),
  dstIpCell('L65', 3, 'label'),
  dstIpCell('L66', 4, 'label'),
  monthlyAttackCell('L71', 9, 'label'),
  monthlyAttackCell('L72', 9, 'count'),
  monthlyOutboundCell('L73', 9),
  monthlyAlarmCell('L75', 9),
  monthlyVulnCell('L86', 9, 'label'),
  monthlyVulnCell('L87', 9, 'count'),
  monthlyVulnCell('L88', 9, 'closed'),
  // 报告参数格。模板此格空白（模板里它是 K1 那格的值落下来的位置），label 是手写的。
  {
    addr: 'M1',
    label: '统计周期结束日',
    desc: '报告期结束日，直接取 CLI 的 --end，按 YYYY/MM/DD（斜杠）写入。' +
          '不参与统计。结束日含在报告期内（闭区间）。',
    compute: (ctx) => formatReportDate(ctx.range.end),
    verify: ''
  },
  // 护网时间展示格（原「重保时间周期」，用户口径 2026-10-27 改名：这两个参数的语义
  // 从此就是**护网时间**，与重保（= 重要节假日）概念脱离）。与 D130 用同一对入参，
  // 但本格只印范围、不参与统计；可选参数，没传就留空（空串），不写占位文字。
  {
    addr: 'M3',
    label: '护网时间',
    desc: '护网（HW）起止时间的展示格，形如 2026/05/01-2026/05/07。'
      + '直接取 CLI 的 --protect-start / --protect-end：每个日期按 YYYY/MM/DD（斜杠）写'
      + '（与 M1 / L1 同一种格式），中间用短横连接。不参与统计 —— 同一对入参参与统计的'
      + '那一格是 D130「hw 时间事件总数」。'
      + '⚠️ 与「重保周期清单」（L4:M10）/「重要时期」（D27/D28/D29 等）**无关**：'
      + '重保 = 重要节假日，只看报告期与法定节假日表（用户口径 2026-10-27）。'
      + '可选参数：两端都没传 -> 写空串（留空，不写占位文字，用户口径 2026-10-21）；'
      + '只传一端属于参数错，在下载层就被拦住，走不到这里。',
    compute: (ctx) => (ctx.protectRange
      ? formatReportDateRange(ctx.protectRange.start, ctx.protectRange.end)
      : ''),
    verify: ''
  },
  importantPeriodListCell('M4', 0, 'range'),
  importantPeriodListCell('M5', 1, 'range'),
  importantPeriodListCell('M6', 2, 'range'),
  importantPeriodListCell('M7', 3, 'range'),
  importantPeriodListCell('M8', 4, 'range'),
  importantPeriodListCell('M9', 5, 'range'),
  importantPeriodListCell('M10', 6, 'range'),
  monthCell('M58', 10, 'label'),
  monthCell('M59', 10, 'mean'),
  u('M61', '遭受外部攻击的主机'),
  dstIpCell('M62', 0, 'count'),
  dstIpCell('M63', 1, 'count'),
  dstIpCell('M64', 2, 'count'),
  dstIpCell('M65', 3, 'count'),
  dstIpCell('M66', 4, 'count'),
  monthlyAttackCell('M71', 10, 'label'),
  monthlyAttackCell('M72', 10, 'count'),
  monthlyOutboundCell('M73', 10),
  monthlyAlarmCell('M75', 10),
  monthlyVulnCell('M86', 10, 'label'),
  monthlyVulnCell('M87', 10, 'count'),
  monthlyVulnCell('M88', 10, 'closed'),
  monthCell('N58', 11, 'label'),
  monthCell('N59', 11, 'mean'),
  monthlyAttackCell('N71', 11, 'label'),
  monthlyAttackCell('N72', 11, 'count'),
  monthlyOutboundCell('N73', 11),
  monthlyAlarmCell('N75', 11),
  u('N79', 'P26'),
  monthlyVulnCell('N86', 11, 'label'),
  monthlyVulnCell('N87', 11, 'count'),
  monthlyVulnCell('N88', 11, 'closed')
];
