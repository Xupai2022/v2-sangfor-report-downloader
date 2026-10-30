'use strict';

/**
 * 漏洞表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 四处落在本文件：
 *   · 核心业务系统的风险总数（D7/D8/D9）里，「漏洞风险」那一段 = exploitableVulnCount
 *   · D10「高危可利用漏洞数」= highExploitableVulnCount（全表、只认「高可利用」）
 *   · D12「最新漏洞影响资产数」= hotVulnAssetCount（全表、只认「热点漏洞」，按「风险资产」去重）
 *   · D67「最新威胁情报数量」= hotVulnCount（全表、只认「热点漏洞」，数行数）
 *   · D17「受影响的最新漏洞数」= hotVulnCount（**与 D67 同一个派生量**：数行数；
 *     用户口径 2026-10-22 由 alias D12 纠正 —— 格名是「漏洞数」，不是资产台数）
 *   · D68「最新威胁影响资产数」= alias D12（用户口径 2026-10-19：先给过独立口径、
 *     随后改成 alias，不重算）
 *   · D15「已修复漏洞数」= settledVulnCount（全表、只认「处置状态」**包含**「处置完成」的行）
 *   · D83/D84/D85「高危/中危/低危漏洞」= high/medium/lowPriorityVulnCount
 *     （全表、只认「修复优先级」**整格精确等于**「急需修复」/「尽快修复」/「建议修复」的行）
 *   · E83/E84/E85「高中低漏洞分布已闭环数」= high/medium/lowPriorityClosedVulnCount
 *     （同一判据上再加「处置状态」**包含**「处置完成」—— includes，与 D80 同一档）
 *   · F83/F84/F85「高中低漏洞分布闭环率」= high/medium/lowPriorityClosureRate
 *     （只做除法：E83÷D83 / E84÷D84 / E85÷D85；分母为 0 时各写一句话，不写 0）
 *   · D34「高危漏洞防护率」= highVulnProtectionRate
 *     （分母 = 两份表里「修复优先级」=「急需修复」的行数；分子 = **只在内网表**里
 *     同时满足「修复优先级」=「急需修复」、「AF 防护规则」=「有效」、
 *     「处置状态」=「处置完成（已缓解）」的行数 —— 外网表没有「AF 防护规则」列；
 *     分母为 0 时写一句话，不写 0）
 *   · D80「已闭环外网资产漏洞数」= closedOuterVulnCount（**只读互联网漏洞表**、
 *     「处置状态」含「处置完成」的行数）
 *   · D129「HW及前一周已加固中高危漏洞数」= hwHardenedVulnCount
 *     （HW 开始前 7 天 ~ HW 结束的窗口内、**不按「修复优先级」筛**、
 *     只要「处置状态」含「处置完成」（已修复）或满足 D14（已防护）的行数；
 *     内网 + 外网两张表各数各的再相加；没传 HW 时间写 0）
 *   · D14「已防护漏洞数」= protectedVulnCount（**只读内网漏洞表**、两列同时精确匹配）
 *   · G22「已闭环漏洞总数」= protectedPlusSettledVulnCount（= G23 + G24，数值上就是 D14 + D15；
 *     G23 = alias D14、G24 = alias D15 —— 用户口径 2026-10-26）
 *   · K82「已防护漏洞数」= alias D14（本文件不另算）
 *   · K81「内网MSS资产安全漏洞总数」= intranetVulnRowCount（**只读内网漏洞表**、数有效数据行）
 *   · K83「内网已修复漏洞数」= fixedInnerVulnCount（**只读内网漏洞表**、
 *     「处置状态」整格精确等于四种「处置完成（…）」形态之一的行数）
 *   · I82「外网资产漏洞数量」= internetVulnRowCount（**只读互联网漏洞表**、数有效数据行）
 *   · F80「高危可利用漏洞闭环率」= highExploitableClosureRate
 *     （分子 = D14 + D15 两个具名派生量，分母 = D10）
 * D10 与 D12 只差一个关键词、只差归总方式（数行 vs 去重数台），共用 taggedVulnRows；
 * 判据都走下面的 hasAnyTag —— 同一个「标签串包含」动作只写一处（H4）。
 *
 * D10 / D12 / D15 三格读的是**同一张表**、走的是同一套「选哪些行」的骨架 ——
 * 那几步提到 vulnRowsWhere（H4），三格共用，免得三处各写一遍、改一处漏两处。
 *
 * ⚠️ 这里说的「全表」= ctx.vulnRows 整个数组。2026-10-16 起平台把漏洞表按内网/外网拆成
 * **两份**工作簿（zip 里的「内网漏洞报告」「外网漏洞报告」），报告上也是两张 sheet
 * （「内网漏洞表」「互联网漏洞表」）。这两份在下载层拼进同一个 ctx.vulnRows
 * （用户口径：全表 = 两份相加，等价于老接口那张单一导出的表），所以本文件的判据
 * 一格都不用按内外网分开写 —— 它们天然看到的就是两份之和。
 * 拼接发生在 scripts/parse_table_rows.py（按同一份列白名单逐个 sheet 读、行顺序拼接）。
 *
 * ⚠️ 「相加」说的是**行**：各项判据看到的是一份拼起来的行数组，不是「两份各自算完再求和」。
 * 对 D10 / D15 这种数行数的两格，两种做法结果一样；**D12 不一样**（它按「风险资产」去重）——
 * 同一台资产在两份里各有一条热点漏洞时，份内去重是 87 + 77 = 164、两份合起来去重是 **163**
 * （2026-10-16 那份真实数据就是这个例子）。163 才是老接口那张单一导出会给出的数，
 * 也正是「全表」的口径；所以别把 D12 改成"两份相加"。
 */

const { requireColumnInEveryRow, cellText, normalizeIp, cellDateOnly } = require('./rows');
const { monthPeriods, shiftDays, toDateOnly } = require('../periods');

/**
 * 「风险资产」的表头文字（要拿去和资产表的 IP 比对）。
 *
 * 依据：`tmp/probe_vuln/vuln_raw.xlsx`（平台导出的漏洞表，13301 行）表头行逐字命中
 * 「风险资产」；同一列名也出现在 `outputs/20261008_143946/一致性验收客户_report.xlsx`
 * 的「资产漏洞表」sheet 表头（当时报告里那张 sheet 就是这张表原样搬进去的 ——
 * 2026-10-16 起那张 sheet 拆成「内网漏洞表」「互联网漏洞表」两张，列名照旧）。
 */
const RISK_ASSET_COLUMN = '风险资产';

/**
 * 「威胁标签」的表头文字。
 *
 * 依据：同上两份样本的表头（那时报告上那张 sheet 还叫「资产漏洞表」，列没变）。
 * 那一版 31 列里只有这一列含「标签」，不会误撞。
 * 取值形态是**顿号分隔的若干标签**，例如 `勒索利用、APT利用、病毒利用、高可利用`，
 * 也可能是空的（实测 13301 行里有 2430 行是空）。
 * ⚠️ 2026-10-16 那份新下载件里还有**全角逗号**拼的（外网那 108 行用 `，`）——
 * 判据是 `includes()`，分隔符是什么都不影响，别看到两种分隔符就去改判据。
 */
const THREAT_TAG_COLUMN = '威胁标签';

/**
 * 算一条有效漏洞风险的标签（用户口径）：标签里出现其中**任意一个**即可。
 *
 * 判据是「标签串里包含这四个字」，不是「某一整段标签等于它」—— 标签串是顿号拼起来的
 * 一整格文本，`活跃漏洞、高可利用` 里含「高可利用」，就算一条。
 *
 * 「一行只算一条」这条不是空话：实测 `tmp/probe_vuln/vuln_raw.xlsx` 的 13301 行里，
 * 含「高可利用」429 行、含「热点漏洞」79 行，其中 **77 行两者都含** ——
 * 按标签个数算会多算 77 条。
 */
const HIGH_EXPLOITABLE_TAG = '高可利用';
const HOT_VULN_TAG = '热点漏洞';
const EXPLOITABLE_TAGS = [HIGH_EXPLOITABLE_TAG, HOT_VULN_TAG];

/** D10「高危可利用漏洞数」的判据：只要「高可利用」这一个标签，**不含**「热点漏洞」。 */
const HIGH_EXPLOITABLE_ONLY = [HIGH_EXPLOITABLE_TAG];

/** D12「最新漏洞影响资产数」的判据：只要「热点漏洞」这一个标签，**不含**「高可利用」。 */
const HOT_VULN_ONLY = [HOT_VULN_TAG];

/**
 * 「处置状态」的表头文字（D15 要读它）。
 *
 * 依据：`outputs/<各次时间戳>/一致性验收客户_report.xlsx` 的「资产漏洞表」sheet（2026-10-16 起
 * 是那两张「内网漏洞表」「互联网漏洞表」）表头里逐字命中这一列
 * （4 份产物都有；同一张表还有一列叫「处置标签」，是另一码事，本格不读它）。
 */
const DISPOSITION_COLUMN = '处置状态';

/**
 * 漏洞时间是哪一列表头（C86:N88 按月份分桶、D129 的 HW 窗口、D14/D34 的圈定都要读它）。
 *
 * 依据：`outputs/20261029_102354/Clearnroom演示客户_report.xlsx` 的「内网漏洞表」
 * 「互联网漏洞表」两张 sheet，表头第 18 列逐字就是下面这一串 ——
 * **中间有一个换行**，括号里那句粉色说明也是表头文字的一部分，不是批注。
 *
 * 用户口径 2026-10-29：平台已经把原来的「首次发现时间」列改名成这一列
 * （两张漏洞表都没有「首次发现时间」了，按旧名精确查找会让 C86:N88 / D129 / D14-D34
 * 一大片格子全部按「缺列」留空）。这一格按**整名相等**匹配，不做包含 / 前缀 ——
 * 同一张表还有「最近发现时间」，按前缀取会静默改成另一条时间轴。
 * ⚠️ 平台要是再动括号里的文案，这里要跟着改（缺列会当场报错留空，不会静默数 0）。
 */
const FIRST_FOUND_COLUMN = '发现时间\n（填充此单元格为粉红色代表最近扫描新增漏洞）';

/**
 * 「修复优先级」的表头文字（D83 / D84 / D85 要读它）。
 *
 * 用户口径（2026-10-23）：「精确查找两个漏洞表『修复优先级』列」——
 * 两个漏洞表 = 内网 + 互联网两份，也就是拼接后的全表 ctx.vulnRows。
 * 判据是**整格精确相等**（比较前只去首尾空白），不做包含 / 前缀 / 全半角归一。
 */
const FIX_PRIORITY_COLUMN = '修复优先级';

/**
 * D83「高危漏洞」认的「修复优先级」取值 —— **整格精确相等**（用户口径 2026-10-23）。
 */
const HIGH_PRIORITY_VALUE = '急需修复';

/**
 * D84「中危漏洞」认的「修复优先级」取值 —— **整格精确相等**（用户口径 2026-10-23）。
 */
const MEDIUM_PRIORITY_VALUE = '尽快修复';

/**
 * D85「低危漏洞」认的「修复优先级」取值 —— **整格精确相等**（用户口径 2026-10-23）。
 */
const LOW_PRIORITY_VALUE = '建议修复';

/**
 * D129 **不按「修复优先级」筛**（用户口径 2026-10-26 追加：「不需要判断修复优先级」）——
 * 窗口内凡是已修复 / 已防护的行都算，高 / 中 / 低危一视同仁。
 * 所以本格不读 `FIX_PRIORITY_COLUMN`、也不要求它有这一列（缺了不报错）。
 * 格名里的「中高危」按用户口径**不做筛选**，别照着格子标题自己加条件。
 */

/**
 * 「AF 防护规则」的表头文字（D14 要读它）。
 *
 * 用户口径（2026-10-22）：精确查找内网漏洞表的「AF 防护规则」列。
 * ⚠️ 列名里**有一个空格**（`AF 防护规则`），不能写成 `AF防护规则` ——
 * 走的是 requireColumnInEveryRow 的逐字比对，差一个空格就是缺列。
 * ⚠️ 现有产物样本（outputs/<时间戳>/<客户>_report.xlsx 的内网漏洞表 30 列）里还没有这一列，
 * 是平台侧新增的列；缺列时按本仓规矩不写值 + 记错误，别把它当成 0。
 */
const AF_RULE_COLUMN = 'AF 防护规则';

/** D14 认的「AF 防护规则」取值 —— **整格精确相等**（用户口径 2026-10-22）。 */
const AF_RULE_ACTIVE_VALUE = '有效';

/**
 * D14 认的「处置状态」取值 —— **整格精确相等**（用户口径 2026-10-22）。
 *
 * 与 D15 的**包含**判据、D80 的包含判据都不同：D14 只认这一种带括号的形态，
 * `处置完成（已修复）` / `处置完成（接受风险）` / `处置完成（忽略）` / `处置完成` 都**不算**。
 * 比较前用 cellText 去掉首尾空白，不做全半角归一。
 */
const PROTECTED_DISPOSITION_VALUE = '处置完成（已缓解）';

/**
 * K83「内网已修复漏洞数」认的四种「处置状态」—— **整格精确相等**（用户口径 2026-10-23）。
 *
 * 用户投喂原话：「只取内网漏洞表『处置状态』列里面精确匹配处置完成（已修复）
 * 或处置完成（已缓解）或处置完成（接受风险）或处置完成（忽略）的总数」。
 * 于是四种带括号的形态**都算**，`待处置` / `处置中` / 不带括号的 `处置完成` 都**不算**；
 * `处置完成（误报）` 既不在本表里，又在预处理阶段整行删掉了（见 SETTLED_DISPOSITION_VALUE
 * 上面那段）。
 * ⚠️ 与 D14 的 PROTECTED_DISPOSITION_VALUE 只重合「已缓解」一种：D14 还要同时
 * 「AF 防护规则」= 有效；本格不看那一列，四种形态任一即计数。
 * 比较前用 cellText 去掉首尾空白，不做全半角 / 括号归一。
 */
const FIXED_INNER_DISPOSITION_VALUES = [
  '处置完成（已修复）',
  '处置完成（已缓解）',
  '处置完成（接受风险）',
  '处置完成（忽略）'
];

/**
 * D15「已修复漏洞数」认的处置状态 —— 单元格文本里**包含**「处置完成」。
 *
 * 口径变过四次，四个版本都记在这，免得回头看见旧数据对不上：
 *
 *   第一版（2026-10-08 起）：**整格精确等于**「处置完成」。依据是当时实测发现四种「已处置」
 *     形态（已修复 / 已缓解 / 接受风险 / 忽略）在漏洞表里**一律记成同一个值**、不带括号 ——
 *     `tmp/probe_vuln/vuln_raw.xlsx` 13301 行只有「待处置」与「处置完成」两种取值。
 *
 *   第二版（2026-10-16 起，**已作废**）：平台把当初合并掉的值**拆开了**。当日那份 zip 里
 *     `4-漏洞清单+跟踪记录` 实测取值：待处置 / 处置中 /
 *     处置完成（已修复）/（已缓解）/（接受风险）/（忽略）。精确匹配会数出 0
 *     （实际 43 行 = 内网 33 + 外网 10），于是改成了「以『处置完成』开头都算」的前缀判据。
 *
 *   第三版（2026-10-22 起，**已作废**）：用户重新改定 **整格精确等于**「处置完成」。
 *     于是四种带括号的形态 —— `处置完成（已修复）` / `（已缓解）` / `（接受风险）` / `（忽略）`
 *     —— **一条都不算**，`待处置` / `处置中` 当然也不算。
 *
 *   第四版（2026-10-26 起，当前）：用户原话「D15改一下，改成包含『处置完成』就算」。
 *     判据改成 **includes** —— 四种带括号的形态与裸「处置完成」**都算**，
 *     `待处置` / `处置中` 不算。这与 D80 / E83 / C88 那一档（CLOSED_DISPOSITION_KEYWORD
 *     的包含判据）终于对齐了；D129 也按本格同一把尺子取「已修复」。
 *
 * ⚠️ **误报行在下载层就被删掉了**（用户口径 2026-10-21）：漏洞表解包时（
 *   scripts/extract_vuln_report.py 的 `drop_false_positive_rows`）先删「处置状态」
 *   = 「处置完成（误报）」的整行，再搬表、再解析。⚠️ 包含判据**会**认
 *   `处置完成（误报）`，所以这条删行现在是本格数得对的前提之一（判据本身不再挡它）。
 *   删行是为了报告上的漏洞表本身不含误报行，与本格口径各管一头。
 *
 * 比较前用 cellText 去掉首尾空白（` 处置完成 ` 仍算）；不做全半角归一 ——
 * 半角括号的 `处置完成(已修复)` 里同样有这四个字，照算。
 */
const SETTLED_DISPOSITION_VALUE = '处置完成';

/**
 * D80「已闭环外网资产漏洞数」认的处置状态 —— 单元格文本里**包含**这四个字。
 *
 * 与 D15 的 SETTLED_DISPOSITION_VALUE 是同一个字面量、**同一个判据**（D15 自 2026-10-26
 * 起也改成了包含，见上面那段）。仍刻意留两个常量名：两格的**范围**不同 ——
 *   · D15：全表（内网 + 外网两份拼接）
 *   · D80：**只**互联网漏洞表
 * 以后只改其中一格的范围 / 判据时，不会顺手把另一格也改了。
 *
 * 「包含」是用户口径（2026-10-21 投喂原话：「状态包含『处置完成』，就加一」）：
 * `处置完成（已修复）` 这类带括号的算，`待处置` / `处置中` 不算。
 * 比较前用 cellText 去掉首尾空白。
 */
const CLOSED_DISPOSITION_KEYWORD = '处置完成';

/**
 * 这一行的「威胁标签」里有没有出现给定标签中的任意一个（H4：判据只写这一处）。
 *
 * @param {Object} row 行对象（键是表头文字，见 CELL_REGISTRY.md §7）
 * @param {string[]} tags 关键词
 */
function hasAnyTag(row, tags) {
  const text = cellText(row[THREAT_TAG_COLUMN]);
  return tags.some((tag) => text.includes(tag));
}

/**
 * 指定 IP 集合上、标签含「高可利用 / 热点漏洞」的漏洞**行数**。
 *
 * 计数口径：按行计数，一行最多算一条（同一行里既含高可利用又含热点漏洞不重复算）；
 * 不去重、不按漏洞名称合并 —— 同一台机器上的同一个漏洞被导出多次就是多行。
 * 不按报告期过滤：漏洞表导出时已按平台口径取数（本仓取值层不叠加时间过滤，
 * 与 stats/metrics/alarm.js 的告警定性统计同一口径）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 行数；漏洞表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「风险资产」或「威胁标签」列
 */
function exploitableVulnCount(ctx, ips) {
  const rows = ctx.vulnRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumnInEveryRow(rows, RISK_ASSET_COLUMN, '漏洞表');
  requireColumnInEveryRow(rows, THREAT_TAG_COLUMN, '漏洞表');

  let count = 0;
  for (const row of rows) {
    if (!ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) continue;
    if (hasAnyTag(row, EXPLOITABLE_TAGS)) count += 1;
  }
  return count;
}

/**
 * 漏洞表的**选行骨架** —— D10 / D12 / D15 共用的那几步（H4）。
 *
 * 三格读的是同一张表、同一套取法，只有「选哪些行」不同：
 *   · 数整张表（与 --business-systems 传没传无关，不按 IP 集合圈定）
 *   · 不叠加报告期过滤（漏洞表导出时已按「首次发现时间」落在报告期内，同 D7）
 *   · 表为空（0 行）就是「这段时间一条漏洞都没有」-> 返回**空数组**，各格自己归总成 0
 *     （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *     scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出；所以取值层
 *     见到的表一定在，0 行是正常数据，不是缺数）
 *   · 列名对不上（平台改了列名）时 requireColumnInEveryRow 抛错 —— 按 0 算等于拿一份没读到的数据
 *     当没有（C5/R10）。这是本函数唯一还会抛的情况。
 *
 * ⚠️ 缺列用的是**逐行**判据（requireColumnInEveryRow），不是 rows.js 里那条通用的
 * `requireColumn`：漏洞表是内网 / 外网**两份 sheet 拼成的一个数组**，两份列集不同。
 * 「至少有一行带这一列」在拼接表上会让"某一份缺列"漏网 —— 那一份的行会被安静地筛掉，
 * 数与没缺列时长得一模一样。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} column 选行所依据的那一列的表头文字（不存在就抛错）
 * @param {(row: Object) => boolean} matches 选行判据
 * @param {string} what 报错文案里的量名（各格自己说的话）
 * @param {Set<string>} [ips] 已归一的 IP 集合（来自 stats/metrics/asset.js）——
 *   给了就只留「风险资产」落在集合里的行（C18/D18/E18 用，见 closed_risk.js）；
 *   不给（undefined / null）时行为与从前逐字相同，D10/D15/D17 走的就是这一档。
 *   ⚠️ 空集合是**给了**（筛完是 0 行），不是"没给" —— 别用 `ips.size` 判。
 * @returns {Object[]} 选中的行；表为空时是空数组
 * @throws {Error} 表头里没有 column 那一列（给 ips 时还要有「风险资产」列）
 */
function vulnRowsWhere(ctx, column, matches, what, ips) {
  const rows = Array.isArray(ctx.vulnRows) ? ctx.vulnRows : [];
  if (rows.length === 0) return [];

  requireColumnInEveryRow(rows, column, '漏洞表');
  if (ips) {
    requireColumnInEveryRow(rows, RISK_ASSET_COLUMN, '漏洞表');
    return rows.filter(
      (row) => ips.has(normalizeIp(row[RISK_ASSET_COLUMN])) && matches(row)
    );
  }

  return rows.filter(matches);
}

/**
 * 漏洞表**全表**里、标签含给定关键词的**行** —— D10 / D12 共用的那一步筛选（H4）。
 *
 * 两格的关键词不同（D10 认「高可利用」、D12 认「热点漏洞」），选行的规矩逐字相同 ——
 * 都在 vulnRowsWhere 里；两格的差别只在选中之后**怎么归总**：D10 数行数、
 * D12 数去重后的资产台数（见 highExploitableVulnCount / hotVulnAssetCount）。
 *
 * @param {string[]} tags 关键词，标签串里出现其中一个即选中
 * @param {Set<string>} [ips] 已归一的 IP 集合；给了就只留「风险资产」落在里面的行
 *   （C18/D18/E18 用 —— 那是 D13 四段里属于漏洞表的两段）
 */
function taggedVulnRows(ctx, tags, ips) {
  return vulnRowsWhere(ctx, THREAT_TAG_COLUMN, (row) => hasAnyTag(row, tags), '', ips);
}

/**
 * D10「高危可利用漏洞数」：全表里标签含「高可利用」的**行数**
 * （**不含**只含「热点漏洞」的）。
 *
 * 按行计数、一行最多算一条、不按资产去重 —— label 说的是「漏洞数」，
 * 同一台机器上的同一个漏洞被导出多次就是多条（D12 才是按资产去重，两格刻意不同）。
 */
function highExploitableVulnCount(ctx) {
  return taggedVulnRows(ctx, HIGH_EXPLOITABLE_ONLY).length;
}

/**
 * D67「最新威胁情报数量」：全表里标签含「热点漏洞」的**行数**
 * （**不含**只含「高可利用」的）。
 *
 * 用户口径（2026-10-19）：精确查找两个漏洞表的「漏洞标签」列，值包含「热点漏洞」就加一。
 * ⚠️ 平台导出件的实际表头是**「威胁标签」**（`tmp/out/vuln_extract/漏洞表.xlsx` 的
 * 「内网漏洞表」「互联网漏洞表」两份 sheet 逐字命中；全表 31 列里没有叫「漏洞标签」的列）。
 * 本仓按既有 D10 / D12 同一个列名读「威胁标签」，不另造一个列名。
 *
 * 与 D12 的选行逐字相同（taggedVulnRows + HOT_VULN_ONLY），差别只在归总：
 * 本格数**行数**、D12 数按「风险资产」去重后的**资产台数**。
 * D17「受影响的最新漏洞数」与本格是**同一个数**（用户口径 2026-10-22：格名是「漏洞数」，
 * 取条数）—— 两格共用本函数，不另起一份算法。
 * 按行计数、一行最多算一条、不按漏洞名称合并；全表 = 内网 + 外网两份行拼起来再数
 * （见文件头注）；不按报告期过滤。
 */
function hotVulnCount(ctx, ips) {
  return taggedVulnRows(ctx, HOT_VULN_ONLY, ips).length;
}

/**
 * D12「最新漏洞影响资产数」：全表里标签含「热点漏洞」的漏洞**影响到的资产台数**
 * （**不含**只含「高可利用」的）。
 *
 * 归总是**按「风险资产」列去重**，不是数行数（用户口径）——
 * 同一台资产上有三条热点漏洞只算 1 台，与 label 里的「资产数」一致。
 *
 * 去重前先用 normalizeIp 归一（与 D7 那一段、与 report_preprocess.py 同一把尺子），
 * 于是 `10.0.0.4` 与 `10.0.0.4(未归类组)` 算同一台。
 * **「风险资产」为空的行不计入**（归一后是空串）：那一行指不到任何一台资产上，
 * 把空串当成一台资产会让台数虚增 1。
 */
function hotVulnAssetCount(ctx) {
  const rows = taggedVulnRows(ctx, HOT_VULN_ONLY);
  if (rows.length > 0) requireColumnInEveryRow(ctx.vulnRows, RISK_ASSET_COLUMN, '漏洞表');

  const assets = new Set();
  for (const row of rows) {
    const ip = normalizeIp(row[RISK_ASSET_COLUMN]);
    if (ip) assets.add(ip);
  }
  return assets.size;
}

/**
 * 这一行的「处置状态」算不算**已修复** —— D15 / D80 / D129 共用的那一把尺子（H4）。
 *
 * 判据是 **includes**「处置完成」（用户口径 2026-10-26，见 SETTLED_DISPOSITION_VALUE
 * 上面那段）。三种消费方的**范围**不同，判据相同，所以只写这一处：
 *   · D15：漏洞表全表
 *   · D80：只互联网漏洞表
 *   · D129：内网 + 外网两张表
 *
 * @param {Object} row 行对象（键是表头文字）
 * @returns {boolean}
 */
function isSettledRow(row) {
  return cellText(row[DISPOSITION_COLUMN]).includes(SETTLED_DISPOSITION_VALUE);
}

/**
 * 这一行算不算**已防护** —— D14 / D129 共用（H4）。
 *
 * 判据（用户口径 2026-10-22）：「AF 防护规则」整格精确等于「有效」**且**
 * 「处置状态」整格精确等于「处置完成（已缓解）」。
 *
 * ⚠️ 本函数默认调用方已经确认行里**有**「AF 防护规则」这一列 —— 拼出来的漏洞表里
 * 不是每一份都带它（互联网漏洞表没有这一列），所以「这一列在不在」由调用方判，
 * 本函数只判值。内网那份目前通常也还没有这一列（见 mssw_downloader.js 的
 * VULN_INNER_TABLE_SPEC），调用方照样要先判在不在。
 *
 * @param {Object} row 行对象（键是表头文字）
 * @returns {boolean}
 */
function isProtectedRow(row) {
  return cellText(row[AF_RULE_COLUMN]) === AF_RULE_ACTIVE_VALUE
    && cellText(row[DISPOSITION_COLUMN]) === PROTECTED_DISPOSITION_VALUE;
}

/**
 * D15「已修复漏洞数」：全表里「处置状态」**包含**「处置完成」的**行数**。
 *
 * 判据是 **includes**（用户口径 2026-10-26，修订 2026-10-22 的精确判据）：
 * `处置完成` 算；带括号的 `处置完成（已修复）` / `（已缓解）` / `（接受风险）` / `（忽略）`
 * **都算**；`处置中` / `待处置` 不算。与 D80 / E83 / C88 同一个包含判据
 * （CLOSED_DISPOSITION_KEYWORD），本格与它们只差**范围**（全表 vs 只外网 / 只某个优先级）。
 *
 * ⚠️ `处置完成（误报）` 也含这四个字、判据本身会认它 —— 它在**预处理**里已被整行删掉
 * （用户口径 2026-10-21，见 scripts/extract_vuln_report.py 与
 * SETTLED_DISPOSITION_VALUE 上面那段），所以走不到本函数。删行是本格数得对的前提，
 * 不能单独去掉。
 *
 * 比较前用 cellText 去掉首尾空白（单元格里多打一个空格不算另一种处置状态）；
 * 不做全半角括号归一 —— 半角括号的形态照样含这四个字，照样算。
 *
 * 按行计数，一行最多算一条；不去重、不按漏洞名称合并。数的是**全表**（= 内网 + 外网两份相加，
 * 见文件头注）、不按报告期过滤（三条口径同 D10 / D12，见 vulnRowsWhere）。
 *
 * label 写的是「已修复」，口径却是「处置完成」这个状态的小计 ——
 * 这是用户投喂的口径，本格照它实现；label 是模板原文，按 R1/R2 一个字节都不改。
 */
function settledVulnCount(ctx, ips) {
  return vulnRowsWhere(
    ctx,
    DISPOSITION_COLUMN,
    isSettledRow,
    '',
    ips
  ).length;
}

/**
 * D83 / D84 / D85「高危 / 中危 / 低危漏洞」：**两个漏洞表**（内网 + 互联网，
 * 即拼接后的 ctx.vulnRows）里「修复优先级」列**整格精确等于**给定取值的行数。
 *
 * 用户口径（2026-10-23）：「精确查找两个漏洞表『修复优先级』列。分别精确匹配值是
 * 『急需修复』、『尽快修复』和『建议修复』，各自计数」。
 * 三格只差一个取值，判据逐字相同 —— 所以选行这一步写成一处（H4）：
 *   · D83 高危漏洞 = `急需修复`
 *   · D84 中危漏洞 = `尽快修复`
 *   · D85 低危漏洞 = `建议修复`
 * 「精确匹配」= 整格相等（比较前只去首尾空白），不是包含、也不是前缀；
 * 不做全半角归一。按行计数、一行一条；不去重、不按漏洞名称合并；
 * 全表 = 内网 + 外网两份行拼起来再数（见文件头注），不按报告期过滤。
 * 空表（0 行）-> 写 0（结论，不是缺数）；
 * 有行数据但缺「修复优先级」列 -> 抛错（不写值，别按 0 算）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {string} value 「修复优先级」的取值（三格各自的常量）
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 有行数据但表头里没有「修复优先级」列
 */
function fixPriorityVulnCount(ctx, value) {
  return vulnRowsWhere(
    ctx,
    FIX_PRIORITY_COLUMN,
    (row) => cellText(row[FIX_PRIORITY_COLUMN]) === value,
    ''
  ).length;
}

/** D83「高危漏洞」：全表「修复优先级」整格精确等于「急需修复」的行数。 */
function highPriorityVulnCount(ctx) {
  return fixPriorityVulnCount(ctx, HIGH_PRIORITY_VALUE);
}

/** D84「中危漏洞」：全表「修复优先级」整格精确等于「尽快修复」的行数。 */
function mediumPriorityVulnCount(ctx) {
  return fixPriorityVulnCount(ctx, MEDIUM_PRIORITY_VALUE);
}

/** D85「低危漏洞」：全表「修复优先级」整格精确等于「建议修复」的行数。 */
function lowPriorityVulnCount(ctx) {
  return fixPriorityVulnCount(ctx, LOW_PRIORITY_VALUE);
}

/**
 * E83 / E84 / E85「高中低漏洞分布已闭环数」：在 D83 / D84 / D85 的判据上
 * **再加一条** —— 对应命中漏洞的「处置状态」列**包含**「处置完成」。
 *
 * 用户口径（2026-10-23）：「E83 E84 E85分别是高中低漏洞分布已闭环数。在刚刚高中低漏洞
 * 的基础上，额外检查对应命中漏洞的『处置状态』列，如果包含『处置完成』，那么对应的
 * 单元格加一」。
 * 于是选行 = 「修复优先级」**整格精确等于**给定取值 **且** 「处置状态」**包含**
 * 「处置完成」（includes，与 D80 同一个判据：`处置完成（已修复）/（已缓解）/（接受风险）/
 * （忽略）` 以及裸「处置完成」「闭环后处置完成」都算；`待处置` / `处置中` 不算）。
 * 数据源同 D83/D84/D85：**漏洞表全表** = 内网 + 外网两份拼起来的 ctx.vulnRows。
 * 按行计数、不去重、不按报告期过滤。空表（0 行）-> 写 0（结论，不是缺数）；
 * 有行数据但缺「修复优先级」或「处置状态」列 -> 抛错（不写值，别按 0 算）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {string} value 「修复优先级」的取值（三格各自的常量）
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 有行数据但表头里没有「修复优先级」或「处置状态」列
 */
function fixPriorityClosedVulnCount(ctx, value) {
  const rows = Array.isArray(ctx.vulnRows) ? ctx.vulnRows : [];
  if (rows.length === 0) return 0;

  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, '漏洞表');
  return vulnRowsWhere(
    ctx,
    FIX_PRIORITY_COLUMN,
    (row) => cellText(row[FIX_PRIORITY_COLUMN]) === value
      && cellText(row[DISPOSITION_COLUMN]).includes(CLOSED_DISPOSITION_KEYWORD),
    ''
  ).length;
}

/** E83「已闭环数」：D83 的判据上再加「处置状态」包含「处置完成」。 */
function highPriorityClosedVulnCount(ctx) {
  return fixPriorityClosedVulnCount(ctx, HIGH_PRIORITY_VALUE);
}

/** E84：D84 的判据上再加「处置状态」包含「处置完成」。 */
function mediumPriorityClosedVulnCount(ctx) {
  return fixPriorityClosedVulnCount(ctx, MEDIUM_PRIORITY_VALUE);
}

/** E85：D85 的判据上再加「处置状态」包含「处置完成」。 */
function lowPriorityClosedVulnCount(ctx) {
  return fixPriorityClosedVulnCount(ctx, LOW_PRIORITY_VALUE);
}

/**
 * F83 / F84 / F85 在**分母为 0**（对应等级的漏洞一条都没有）时落的那句话
 * （用户口径 2026-10-23：三格是高中低漏洞分布闭环率，式子只给了 E÷D）。
 *
 * 落法与 F80 / F49 同一条：**不写 0** —— 0.00% 会被读成「有这个等级的漏洞、
 * 但一条都没闭环」，那是假结论。三句话各自独立定义（口径来源不同），不互相引用。
 */
const NO_HIGH_VULN_RATE_TEXT = '无高危漏洞，所以无闭环率';
const NO_MEDIUM_VULN_RATE_TEXT = '无中危漏洞，所以无闭环率';
const NO_LOW_VULN_RATE_TEXT = '无低危漏洞，所以无闭环率';

/**
 * F83 / F84 / F85「高中低漏洞分布闭环率」= 对应的 E（已闭环数）÷ D（漏洞数）。
 *
 * 用户口径（2026-10-23）：「F83=E83/D83 F84=E84/D84 F85=E85/D85，分别是高中低漏洞
 * 分布闭环率」。
 * 六个数都是有名字的格子，本格只做除法、一个数都不重算（H4）：
 *   · F83 = E83 ÷ D83（高危：`急需修复`）
 *   · F84 = E84 ÷ D84（中危：`尽快修复`）
 *   · F85 = E85 ÷ D85（低危：`建议修复`）
 * 分子 E 的判据是在分母 D 的判据上**再加**「处置状态」包含「处置完成」，
 * 所以 E ⊆ D、比率天然落在 0–100% 之间（不需要封顶；分母 > 0 时不会超过 1）。
 *
 * 边界：
 *   · 分母为 0（这个等级一条漏洞都没有）-> 写对应那句话（**不写 0**，同 F80 / F49）；
 *     先判分母，空表本来也没有列可查，别让分子的 requireColumn 先炸；
 *   · 分母 > 0、一条都没闭环 -> 写 0（0.00% 是结论）；
 *   · 有行、却缺「修复优先级」或「处置状态」列 -> 抛错，整格不写值。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number|string} **小数**（写层按 '0.00%' 落格式）；分母为 0 时是那句话
 * @throws {Error} 有行数据但缺本格要读的列
 */
function fixPriorityClosureRate(ctx, numerator, denominator, emptyText) {
  const d = denominator(ctx);
  if (d === 0) return emptyText;
  return numerator(ctx) / d;
}

/** F83「闭环率」= E83 ÷ D83（高危、`急需修复`）。 */
function highPriorityClosureRate(ctx) {
  return fixPriorityClosureRate(
    ctx, highPriorityClosedVulnCount, highPriorityVulnCount, NO_HIGH_VULN_RATE_TEXT
  );
}

/** F84 = E84 ÷ D84（中危、`尽快修复`）。 */
function mediumPriorityClosureRate(ctx) {
  return fixPriorityClosureRate(
    ctx, mediumPriorityClosedVulnCount, mediumPriorityVulnCount, NO_MEDIUM_VULN_RATE_TEXT
  );
}

/** F85 = E85 ÷ D85（低危、`建议修复`）。 */
function lowPriorityClosureRate(ctx) {
  return fixPriorityClosureRate(
    ctx, lowPriorityClosedVulnCount, lowPriorityVulnCount, NO_LOW_VULN_RATE_TEXT
  );
}

/**
 * D34 分母为 0（两个漏洞表里一条「急需修复」都没有）时落的那句话。
 *
 * 与 F83/F84/F85、F80、F49 同一条落法：**不写 0** —— 0.00% 会被读成
 * 「有高危漏洞、但一条都没被防护」，那是假结论（本仓所有"率"的分母为 0 都不落 0）。
 */
const NO_HIGH_VULN_PROTECTION_RATE_TEXT = '无高危漏洞，所以无防护率';

/**
 * D34「高危漏洞防护率」= 分子 ÷ 分母。
 *
 * 用户口径 2026-10-26，**2026-10-26 当天又改过一次分母/分子的数据源**
 * （投喂原话：「D34只需要读内网的，确实只有内网漏洞表有这一列，所以语义改一下，
 * 分子只取内网就行了，分母正常」）：
 *   · 分母 = **两份漏洞表**（ctx.vulnRows = 内网 + 互联网）里「修复优先级」列
 *     **整格精确等于**「急需修复」的行数
 *     （用户说的「高」= 表里实际的「急需修复」，与 D83 高危漏洞同一个取值）
 *   · 分子 = **只在内网漏洞表**（ctx.vulnInnerRows）里，同时满足
 *     「修复优先级」=「急需修复」、「AF 防护规则」整格精确等于「有效」、
 *     「处置状态」整格精确等于「处置完成（已缓解）」的行数
 *     （用户说的「已处置（已缓解）」= 表里实际的「处置完成（已缓解）」，
 *     与 D14 已防护漏洞数同一个取值）
 *
 * ⚠️ 分子只看内网是一句**数据事实**，不是取舍：「AF 防护规则」这一列只有内网漏洞表有
 * （见 `AF_RULE_COLUMN` 的头注 —— 平台新增的列，现有导出件里内网那张也还没有），
 * 外网那份表根本没有这一列，无从判断"防没防护"。
 * 所以外网的高危漏洞**只进分母、永远不进分子**，分母 > 0 时比率到不了 100%
 * 是正常结果，不是 bug。
 *
 * 判定口径与同仓其它漏洞格逐字相同：整格精确相等（比较前用 cellText 去首尾空白）、
 * 不做包含 / 前缀 / 全半角归一；按行计数、一行一条；不去重、不按漏洞名称合并；
 * 不按报告期过滤。内网那批「急需修复」行本来就在分母里，所以分子 ≤ 分母。
 *
 * 边界：
 *   · 表为空（0 行）或分母为 0 -> 写 `NO_HIGH_VULN_PROTECTION_RATE_TEXT`（**不写 0**）；
 *     先判分母再要分子的三列 —— 没有高危漏洞时答案与那几列长什么样无关，
 *     不必为一个用不上的列名把整份报告拦下来（同 D28 对判据列的先后口径）；
 *   · 分母 > 0、分子为 0（含内网漏洞表 0 行）-> 写 0（0.00% 是结论）；
 *   · 有行、却缺「修复优先级」列（或分母 > 0 时内网那份缺「AF 防护规则」/「处置状态」列）
 *     -> 抛错，整格不写值（C5 / R10：平台改列名不许静默数出 0）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number|string} **小数**（写层按 `0.00%` 落格式）；分母为 0 时是那句话
 * @throws {Error} 有行数据但缺本格要读的列
 */
function highVulnProtectionRate(ctx) {
  const rows = Array.isArray(ctx.vulnRows) ? ctx.vulnRows : [];
  if (rows.length === 0) return NO_HIGH_VULN_PROTECTION_RATE_TEXT;

  requireColumnInEveryRow(rows, FIX_PRIORITY_COLUMN, '漏洞表');
  const highRows = rows.filter(
    (row) => cellText(row[FIX_PRIORITY_COLUMN]) === HIGH_PRIORITY_VALUE
  );
  if (highRows.length === 0) return NO_HIGH_VULN_PROTECTION_RATE_TEXT;

  const innerRows = Array.isArray(ctx.vulnInnerRows) ? ctx.vulnInnerRows : [];
  if (innerRows.length === 0) return 0;

  requireColumnInEveryRow(innerRows, FIX_PRIORITY_COLUMN, '内网漏洞表');
  requireColumnInEveryRow(innerRows, AF_RULE_COLUMN, '内网漏洞表');
  requireColumnInEveryRow(innerRows, DISPOSITION_COLUMN, '内网漏洞表');
  const protectedRows = innerRows.filter(
    (row) => cellText(row[FIX_PRIORITY_COLUMN]) === HIGH_PRIORITY_VALUE
      && cellText(row[AF_RULE_COLUMN]) === AF_RULE_ACTIVE_VALUE
      && cellText(row[DISPOSITION_COLUMN]) === PROTECTED_DISPOSITION_VALUE
  ).length;

  return protectedRows / highRows.length;
}

/**
 * D14「已防护漏洞数」：**内网漏洞表**里「AF 防护规则」列**整格精确等于**「有效」
 * **且**「处置状态」列**整格精确等于**「处置完成（已缓解）」的行数。
 *
 * 用户口径（2026-10-22）：「精确查找内网漏洞表的『AF 防护规则』列，值精确匹配『有效』，
 * 且精确查找『处置状态』列的值精确匹配『处置完成（已缓解）』，则加一」。
 * 「精确查找」= 按列名逐字找到这一列；「精确匹配」= 整格相等（只去首尾空白），
 * 不是包含、也不是前缀。
 *
 * 数据源是 ctx.vulnInnerRows（下载层单独读的「内网漏洞表」那一张 sheet），
 * **不是** ctx.vulnRows：后者是内网 + 外网两份拼起来的，分不出这一行来自哪一份。
 * 这是本仓唯一一格只看内网漏洞表的格子（D80 / I82 看的都是外网那张）。
 *
 * 按行计数，一行最多算一条；不去重、不按漏洞名称合并。
 * 不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D15/D80 同一条）。
 * 内网漏洞表为空（0 行）-> 写 0（结论，不是缺数）；
 * 有行数据但缺「AF 防护规则」或「处置状态」列 -> 抛错（不写值）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @param {Set<string>} [ips] 已归一的 IP 集合；给了就只留「风险资产」落在里面的行
 *   （C18/D18/E18 用 —— 那是 D13 四段里唯一只读内网漏洞表的那一段）。
 *   这一档多要一列「风险资产」：内网那张 sheet 的列白名单见
 *   mssw_downloader.js 的 VULN_INNER_TABLE_SPEC。
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 有行数据但表头里没有「AF 防护规则」或「处置状态」列
 *   （给了 ips 时还要有「风险资产」列）
 */
function protectedVulnCount(ctx, ips) {
  const rows = Array.isArray(ctx.vulnInnerRows) ? ctx.vulnInnerRows : [];
  if (rows.length === 0) return 0;

  requireColumnInEveryRow(rows, AF_RULE_COLUMN, '内网漏洞表');
  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, '内网漏洞表');
  if (ips) requireColumnInEveryRow(rows, RISK_ASSET_COLUMN, '内网漏洞表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[AF_RULE_COLUMN]) !== AF_RULE_ACTIVE_VALUE) continue;
    if (cellText(row[DISPOSITION_COLUMN]) !== PROTECTED_DISPOSITION_VALUE) continue;
    if (ips && !ips.has(normalizeIp(row[RISK_ASSET_COLUMN]))) continue;
    count += 1;
  }
  return count;
}

/**
 * K83「内网已修复漏洞数」：**内网漏洞表**里「处置状态」列**整格精确等于**
 * 四种「处置完成（…）」形态之一的行数。
 *
 * 用户口径（2026-10-23）：「只取内网漏洞表『处置状态』列里面精确匹配
 * 处置完成（已修复）或处置完成（已缓解）或处置完成（接受风险）或处置完成（忽略）的总数」。
 * 四种取值都是**整格精确相等**（比较前只去首尾空白），不做包含 / 前缀；
 * `待处置` / `处置中` / 不带括号的 `处置完成` / `处置完成（误报）` 都不算。
 *
 * 数据源是 ctx.vulnInnerRows（下载层单独读的「内网漏洞表」那一张 sheet），
 * **不是** ctx.vulnRows（内网 + 外网拼接，分不出这一行来自哪一份）。
 * 与 D14 的差别：本格不读「AF 防护规则」列 —— 四种形态任一即计数。
 *
 * 按行计数，一行最多算一条；不去重、不按漏洞名称合并。
 * 不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D14/D15/D80 同一条）。
 * 内网漏洞表为空（0 行）-> 写 0（结论，不是缺数）；
 * 有行数据但缺「处置状态」列 -> 抛错（不写值）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 有行数据但表头里没有「处置状态」列
 */
function fixedInnerVulnCount(ctx) {
  const rows = Array.isArray(ctx.vulnInnerRows) ? ctx.vulnInnerRows : [];
  if (rows.length === 0) return 0;

  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, '内网漏洞表');

  let count = 0;
  for (const row of rows) {
    if (FIXED_INNER_DISPOSITION_VALUES.includes(cellText(row[DISPOSITION_COLUMN]))) {
      count += 1;
    }
  }
  return count;
}

/**
 * **D14 + D15 两个格子相加**的共用派生量（H4）—— G22「已闭环漏洞总数」= G23 + G24，
 * 而 G23 = alias D14、G24 = alias D15（用户口径 2026-10-26：「G23 alias D14。G22=G23+G24」），
 * 所以数值上就是 D14 + D15。
 *
 * 同一对加数还被 F80「高危可利用漏洞闭环率」的分子用着，所以只写这一份，
 * 两处都调它 —— 别各写一遍加法（改了一处忘另一处，两格就会静默对不上）。
 *
 * 只做加法、不重算：两个加数的判据、数据源、缺列行为全在
 * protectedVulnCount / settledVulnCount 里，本函数一个字都不筛。
 * 任一加数抛错（例如内网漏洞表缺「AF 防护规则」列）-> 原样抛出，整格不写值。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 两个行数之和；两份表都为空时是 0（结论，不是缺数）
 * @throws {Error} 任一加数缺列 / 读不到时原样抛出
 */
function protectedPlusSettledVulnCount(ctx) {
  return protectedVulnCount(ctx) + settledVulnCount(ctx);
}

/**
 * F80「高危可利用漏洞闭环率」在**分母为 0**（D10 = 0）时落的那句话
 * （用户口径 2026-10-22：这句是选定的落法，不是 0）。
 *
 * 与 F49 的 `NO_EVENT_CLOSURE_RATE_TEXT` 同一条思路：写 0.00% 会被读成
 * 「有高危可利用漏洞、但一条都没闭环」—— 那是假结论。两句话各自独立定义
 * （口径来源不同，见 event.js 那条常量的说明），不互相引用。
 */
const NO_HIGH_EXPLOITABLE_VULN_RATE_TEXT = '无高危可利用漏洞，所以无闭环率';

/**
 * F80「高危可利用漏洞闭环率」= (D14 + D15) / D10
 * （用户口径 2026-10-22：「F80是高危可利用漏洞闭环率，取值是(D14+D15) / D10」）。
 *
 * 三个数都是**有名字的格子 / 派生量**，本格只做加法和除法，一个字都不重算（H4）：
 *   · 分子第一项 = D14「已防护漏洞数」= protectedVulnCount（内网漏洞表，
 *     「AF 防护规则」= 有效 且「处置状态」= 处置完成（已缓解）的行数）
 *   · 分子第二项 = D15「已修复漏洞数」= settledVulnCount（漏洞表全表，
 *     「处置状态」包含「处置完成」的行数）
 *   · 分母 = D10「高危可利用漏洞数」= highExploitableVulnCount（漏洞表全表，
 *     「威胁标签」含「高可利用」的行数）
 *
 * ⚠️ **不交集、不去重、不截断**：D14 命中的行通常也会被 D15 计入，所以分子里同一个数
 * 数了两遍，这个比率也可能超过 100%（D14 + D15 与 D10 的量纲 / 筛选条件本来就不同）。
 * 用户给的就是这个式子，别看到「怎么超过 100%」就自作主张改成集合运算。
 *
 * 不按报告期额外过滤（三张表都由下载层按报告期导出，与 D10/D14/D15 同一条）。
 *
 * 边界：
 *   · 漏洞表 0 行（分母 = 0）-> 写 NO_HIGH_EXPLOITABLE_VULN_RATE_TEXT 那句话
 *     （**不写 0**；先判分母，空表本来也没有列可查，别让 requireColumn 先炸 —— 同 F49）；
 *   · 漏洞表有行、但没有一条「高可利用」-> 分母为 0，同样写那句话；
 *   · 有行、却缺「威胁标签」/「AF 防护规则」/「处置状态」任一列（平台改列名）
 *     -> 抛错，整格不写值（不按 0 算）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number|string} **小数**（写层按 '0.00%' 落格式），不是 0–100 的数、
 *   也不是字符串带百分号；分母为 0 时是那句话
 * @throws {Error} 有行数据但缺本格要读的列
 */
function highExploitableClosureRate(ctx) {
  const denominator = highExploitableVulnCount(ctx);
  // 分母为 0 先判：空表本来也没有「AF 防护规则」「处置状态」列可查（C5），
  // 别让 protectedVulnCount 的 requireColumn 先炸。
  if (denominator === 0) return NO_HIGH_EXPLOITABLE_VULN_RATE_TEXT;

  return protectedPlusSettledVulnCount(ctx) / denominator;
}

/**
 * D80「已闭环外网资产漏洞数」：**互联网漏洞表**（不含内网那份）里
 * 「处置状态」列的值**包含**「处置完成」的**行数**。
 *
 * 用户口径（2026-10-21）：「互联网漏洞表精确查找『处置状态』列的状态包含『处置完成』，
 * 就加一」。「精确查找」说的是**按列名**找这一列（表头逐字要对上），
 * 不是「整格精确等于」—— 判据是 includes（见 CLOSED_DISPOSITION_KEYWORD）。
 *
 * 数据源是 ctx.vulnOuterRows（下载层单独读的「互联网漏洞表」那一张 sheet），
 * **不是** ctx.vulnRows：后者是内网 + 外网两份拼起来的，分不出这一行来自哪一份。
 * 本格是本仓唯一一格只看外网漏洞表的格子。
 *
 * 按行计数，一行最多算一条；不去重、不按漏洞名称合并。
 * 不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D15 同一条）。
 * 互联网漏洞表为空（0 行）-> 写 0（结论，不是缺数）；缺「处置状态」列 -> 抛错。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 有行数据但表头里没有「处置状态」列
 */
function closedOuterVulnCount(ctx) {
  const rows = Array.isArray(ctx.vulnOuterRows) ? ctx.vulnOuterRows : [];
  if (rows.length === 0) return 0;

  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, '互联网漏洞表');

  let count = 0;
  for (const row of rows) {
    if (isSettledRow(row)) count += 1;
  }
  return count;
}

/**
 * D129「HW及前一周已加固中高危漏洞数」：**HW 开始时间前一周 + HW 起止时间范围内**
 * 「处置状态」算已修复（或已防护）的漏洞行数。
 *
 * 用户口径（2026-10-26 投喂原话）：「HW及前一周已加固中高危漏洞数，取值是提示词输入的
 * HW 开始时间前一星期内以及 HW 起止时间范围内且状态为已修复和已防护的漏洞数量」。
 * 当天追问确认的几条：
 *   · **时间窗** = `[protectRange.start − 7 天, protectRange.end]`，两端闭区间；
 *     时间列 = FIRST_FOUND_COLUMN（表头是「发现时间（填充此单元格为粉红色…）」，
 *     见本文件头那个常量的口径记录；与 C86:N88 同一条时间轴，经 cellDateOnly 归一后按**日期**比）
 *   · **已修复** = D15 的判据（「处置状态」**包含**「处置完成」，includes）
 *   · **已防护** = D14 的判据（「AF 防护规则」= 有效 **且** 处置状态 = 处置完成（已缓解））
 *   · 没传 `--protect-start` / `--protect-end` -> 写 0，不报错（HW 窗口是可选参数，
 *     与 D130 同一条落法，不是静默缺数）
 * ⚠️ **不按「修复优先级」筛**（用户口径 2026-10-26 追加：「不需要判断修复优先级」）：
 * 格名里的「中高危」不做筛选，高 / 中 / 低危一视同仁；本格也不要求表里有那一列。
 *
 * 数据源是**两张表各自数完再相加**：ctx.vulnInnerRows + ctx.vulnOuterRows（不用
 * ctx.vulnRows 拼接数组），因为外网那份没有「AF 防护规则」列，要分开决定"能不能判已防护"。
 * 两张 sheet 的行互不重复，所以相加不会重复计数（不同于 D15 在拼接数组上数行，两种做法结果一样）。
 *
 * ⚠️ **「已防护」在当前口径下是「已修复」的子集**：已防护要求处置状态 = 处置完成（已缓解），
 * 这个值本身就含「处置完成」。所以并集实际 = 已修复那一支，AF 列缺不缺都不改变计数 ——
 * 内网那份目前通常还没有「AF 防护规则」列，本格因此**在缺这一列时不抛错**，照常按已修复判。
 * 两个判据仍都写着：D15 若再收紧（比如改回精确匹配），已防护那一支会自动补上，不会悄悄少数。
 * 其它列（FIRST_FOUND_COLUMN / 处置状态）任一份缺 -> 抛错，不写值。
 *
 * 边界：
 *   · 没传 HW 窗口 -> 0（不检查列、不读表）；
 *   · 两份表都 0 行 -> 0（结论，不是缺数）；
 *   · 日期为空 / 认不出 -> 跳过那一行；某一份有非空日期但一个都解析不出 -> 抛错
 *     （与 monthlyVulnSeries 同一条防线：否则会静默数出 0，和"窗口里真没有"长得一样）；
 *   · 窗口外的行不计数（这是本格唯一的范围筛，不另按报告期裁 —— 漏洞表导出时已按
 *     「首次发现时间」圈过一道）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 行数；没传 HW 窗口 / 两份表都为空时是 0
 * @throws {Error} 有行数据但缺 FIRST_FOUND_COLUMN（表头「发现时间（…）」）/「处置状态」列，
 *   或该列有非空值却一个日期都认不出
 */
function hwHardenedVulnCount(ctx) {
  const range = ctx && ctx.protectRange;
  // 没传 HW 时间 -> 0（用户口径 2026-10-26，与 D130 同一条）：可选参数不传 =
  // 这次不按 HW 窗口统计，不是缺数。
  if (!range) return 0;

  // 窗口起点 = HW 开始时间往前推 7 天（D129 的"前一周"）。日期都是 YYYY-MM-DD，
  // 字典序就是时间序，可以直接比。
  const start = shiftDays(toDateOnly(range.start, 'ctx.protectRange.start'), -7);
  const end = toDateOnly(range.end, 'ctx.protectRange.end');

  return hardenedCountInSlice(ctx.vulnInnerRows, '内网漏洞表', start, end)
    + hardenedCountInSlice(ctx.vulnOuterRows, '互联网漏洞表', start, end);
}

/**
 * D129 在**一张**漏洞表上的计数（内网 / 外网各调一次）。
 *
 * @param {Object[]|undefined} rows 那一张 sheet 的行数组
 * @param {string} tableLabel 报错文案里的表名（「内网漏洞表」/「互联网漏洞表」）
 * @param {string} start 窗口起（YYYY-MM-DD，含）
 * @param {string} end 窗口止（YYYY-MM-DD，含）
 * @returns {number} 行数；表为空时是 0
 * @throws {Error} 缺列、或时间列有非空值却一个都认不出
 */
function hardenedCountInSlice(rows, tableLabel, start, end) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumnInEveryRow(rows, FIRST_FOUND_COLUMN, tableLabel);
  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, tableLabel);

  // 「AF 防护规则」只有内网那份可能有（互联网漏洞表没有这一列），所以逐行判键在不在；
  // 缺这一列时不抛错 —— 已防护在当前判据下是已修复的子集（见 hwHardenedVulnCount 头注）。
  const canJudgeProtection = rows.every(
    (row) => row && Object.prototype.hasOwnProperty.call(row, AF_RULE_COLUMN)
  );

  let count = 0;
  let nonEmpty = 0;
  let parsed = 0;

  for (const row of rows) {
    const raw = row[FIRST_FOUND_COLUMN];
    if (cellText(raw) !== '') nonEmpty += 1;

    const date = cellDateOnly(raw);
    if (!date) continue;
    parsed += 1;
    if (date < start || date > end) continue;

    if (isSettledRow(row) || (canJudgeProtection && isProtectedRow(row))) count += 1;
  }

  if (nonEmpty > 0 && parsed === 0) {
    throw new Error(
      `${tableLabel}的「${FIRST_FOUND_COLUMN}」列有时间值（${nonEmpty} 行非空），`
      + '但一个都认不出是日期 —— 平台可能改了时间的格式（取值层只认「日期文本」与'
      + '「epoch 秒」两种形态，见 stats/metrics/rows.js 的 cellDateOnly）；'
      + '这里不能静默数出 0，那与"HW 窗口里一条都没有"长得一模一样'
    );
  }

  return count;
}

/**
 * K81「内网MSS资产安全漏洞总数」：**内网漏洞表**的有效数据行数。
 *
 * 用户口径（2026-10-23）：「K81是内网MSS资产安全漏洞总数，取内网漏洞表的有效行数」。
 * 与 I82「外网资产漏洞数量」是同一套读法，只是换了一张 sheet：
 * · 数据源是 ctx.vulnInnerRows（**只**「内网漏洞表」那一张 sheet），不是 ctx.vulnRows。
 * · 「有效行」= 解析层交过来的数据行：表头不算；整行都没值的空行在解析层就被丢了
 *   （scripts/parse_table_rows.py 的 `collect_source_rows`），所以直接数数组长度。
 * · **预处理之后**才数：下载层解包时已删掉「处置状态」=「处置完成（误报）」的整行
 *   （scripts/extract_vuln_report.py），那些行不在这里，也不在任何漏洞格里。
 * · 按行计数，一行一条；不按资产 / 漏洞名称去重、不按任何列筛选
 *   （label 说的是「漏洞总数」= 这张表给出的内网漏洞条目数）。
 * · 不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，同 D10/D14/D15）。
 * · 内网漏洞表为空（0 行）-> 写 0（结论，不是缺数）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 有效数据行数；表为空时是 0
 */
function intranetVulnRowCount(ctx) {
  const rows = Array.isArray(ctx.vulnInnerRows) ? ctx.vulnInnerRows : [];
  return rows.length;
}

/**
 * I82「外网资产漏洞数量」：**互联网漏洞表**的有效数据行数。
 *
 * 用户口径（2026-10-21）：「I82是外网资产漏洞数量，取值是互联网漏洞表，找有效行的数量。
 * 注意所有的漏洞操作都是等预处理后才做的，预处理包含删除处置完成误判的行」。
 *
 * · 数据源是 ctx.vulnOuterRows（**只**「互联网漏洞表」那一张 sheet），不是
 *   ctx.vulnRows（内网 + 外网拼接，分不出这一行来自哪一份）。
 * · 「有效行」= 解析层交过来的数据行：表头不算；整行都没值的空行在解析层就被丢了
 *   （scripts/parse_table_rows.py 的 `collect_source_rows`），所以这里直接数数组长度，
 *   与报告里那张 sheet 肉眼看到的行数同源。
 * · **预处理之后**才数：下载层（scripts/extract_vuln_report.py）在建中间件时已删掉
 *   「处置状态」=「处置完成（误报）」的整行 —— 那些行不在这里，也不在任何漏洞格里。
 * · 按行计数，一行一条；不按资产 / 漏洞名称去重、不按任何列筛选
 *   （label 说的是「漏洞数量」= 这个接口给出的外网漏洞条目数）。
 * · 不按报告期过滤（漏洞表导出时已按「首次发现时间」圈定，与 D10/D12/D15/D80 同一条）。
 * · 互联网漏洞表为空（0 行）-> 写 0（结论，不是缺数）。
 *
 * @param {Object} ctx 由 stats/context.js 构造
 * @returns {number} 有效数据行数；表为空时是 0
 */
function internetVulnRowCount(ctx) {
  const rows = Array.isArray(ctx.vulnOuterRows) ? ctx.vulnOuterRows : [];
  return rows.length;
}

/**
 * C86:N88「漏洞趋势 / 剩余漏洞数量 / 已闭环漏洞数」共用的按月序列（H4）。
 *
 * 用户口径 2026-10-23：「86 行是按照输入的事件范围按月划分，得到的对应的月份，
 * 如 2026-06。87 行是两张漏洞表精确查找『首次发现时间』列……每个漏洞对应的时间划分到
 * 对应的月份，就加一……最多取 12 个月，少于 12 个月就后面的留空，多于 12 个月就取最近的
 * 12 个月。88 行是每个月已闭环漏洞数，精确查找两个漏洞表的『处置状态』列，
 * 如果值包含『处置完成』，就算命中，然后看他们的『首次发现时间』所在的月份然后加一」。
 * ⚠️ 平台 2026-10-29 起把这一列改名成「发现时间（填充此单元格为粉红色…）」（表头带换行），
 * 上面这句原话里的旧列名照旧保留；实际匹配看 FIRST_FOUND_COLUMN。
 *
 * 口径：
 *   · 月份桶 = `monthPeriods(ctx.range.start, ctx.range.end)` —— 与 C58:N59 / C71:N72 /
 *     C75:N75 **同一条月份轴**（报告期切月、含首尾两端所在的两个月、最多 12 个月取最晚的
 *     12 个、**首尾月裁到报告期**）。标签就是各桶的 `YYYY-MM`。
 *   · 数据源 = **漏洞表全表** ctx.vulnRows（内网 + 互联网两张 sheet 拼起来的数组）。
 *   · 时间列 = FIRST_FOUND_COLUMN（整名相等；表头是「发现时间（…）」），经 `cellDateOnly`
 *     归一成 `YYYY-MM-DD` 后按**日期**与每个桶的 `[start, end]`（两端闭区间）比 ——
 *     时刻不影响归属，报告期之外的日期不进任何桶。
 *   · 87 行（counts）：每个漏洞一行一票、不去重，日期落进哪个桶那个桶 +1。
 *   · 88 行（closedCounts）：在 87 行的同一批漏洞里，若该行「处置状态」**包含**
 *     「处置完成」（includes，与 D80 / E83 同一个判据：`处置完成（已修复）/（已缓解）/
 *     （接受风险）/（忽略）` 与裸「处置完成」都算，`待处置` / `处置中` 不算），
 *     则**它 FIRST_FOUND_COLUMN 所在的月份**再 +1 —— 不是按处置时间分桶。
 *   · 漏洞表空（0 行）-> 报告期内每个月都是 **0**（结论，不是缺数；不检查列）。
 *   · 空值 / 认不出的时间 -> 跳过那一行；该列在、也有非空值、但一个都解析不出 -> **抛错**
 *     （与 C75:N75 同一条防线：否则会静默数出 0）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {{labels: string[], counts: number[], closedCounts: number[]}}
 *   三个等长数组，长度 1..12，升序
 * @throws {Error} 漏洞表有行、却缺 FIRST_FOUND_COLUMN 或「处置状态」列；或时间列整列都认不出
 */
function monthlyVulnSeries(ctx) {
  const periods = monthPeriods(ctx.range.start, ctx.range.end);
  const labels = periods.map((period) => period.label);
  const rows = Array.isArray(ctx && ctx.vulnRows) ? ctx.vulnRows : [];

  // 空表不是缺数：报告期里那几个月确实一条漏洞都没有，逐个写 0（不读列）
  if (rows.length === 0) {
    return {
      labels,
      counts: labels.map(() => 0),
      closedCounts: labels.map(() => 0)
    };
  }

  requireColumnInEveryRow(rows, FIRST_FOUND_COLUMN, '漏洞表');
  requireColumnInEveryRow(rows, DISPOSITION_COLUMN, '漏洞表');

  const counts = labels.map(() => 0);
  const closedCounts = labels.map(() => 0);
  let nonEmpty = 0;
  let parsed = 0;

  for (const row of rows) {
    const raw = row ? row[FIRST_FOUND_COLUMN] : null;
    if (cellText(raw) !== '') nonEmpty += 1;

    const date = cellDateOnly(raw);
    if (!date) continue;
    parsed += 1;

    const index = periods.findIndex((period) => date >= period.start && date <= period.end);
    // 报告期之外的日期不进任何桶（漏洞表导出时已按首次发现时间圈定，这里只是防守）
    if (index < 0) continue;

    counts[index] += 1;
    if (isSettledRow(row)) {
      closedCounts[index] += 1;
    }
  }

  if (nonEmpty > 0 && parsed === 0) {
    throw new Error(
      `漏洞表的「${FIRST_FOUND_COLUMN}」列有时间值（${nonEmpty} 行非空），`
      + '但一个都认不出是日期 —— 平台可能改了时间的格式（取值层只认「日期文本」与'
      + '「epoch 秒」两种形态，见 stats/metrics/rows.js 的 cellDateOnly）；'
      + '这里不能静默数出 0，那与"一条都没有"长得一模一样（CELL_REGISTRY.md H6 / MIGRATION.md R10）'
    );
  }

  return { labels, counts, closedCounts };
}

/**
 * 第 index 个槽位（从 0 起）的「剩余漏洞数量」= 首次发现时间落在该月桶内的漏洞行数
 * （C86:N87）；槽位越界（报告期不足 12 个月时空出来的那几格）时是**空串**。
 */
function monthlyVulnCountAt(ctx, index) {
  const series = monthlyVulnSeries(ctx);
  if (index >= series.labels.length) return '';

  return series.counts[index];
}

/**
 * 第 index 个槽位（从 0 起）的「已闭环漏洞数」= 首次发现时间落在该月桶内、
 * 且「处置状态」包含「处置完成」的漏洞行数（C88:N88）；槽位越界时是**空串**。
 */
function monthlyClosedVulnCountAt(ctx, index) {
  const series = monthlyVulnSeries(ctx);
  if (index >= series.labels.length) return '';

  return series.closedCounts[index];
}

/**
 * 第 index 个槽位（从 0 起）的月份标签（`2026-06` 形态，C86:N86）；
 * 槽位越界时是**空串**（那个槽位没有对应的月份）。
 */
function monthlyVulnLabelAt(ctx, index) {
  const series = monthlyVulnSeries(ctx);
  if (index >= series.labels.length) return '';

  return series.labels[index];
}

module.exports = {
  RISK_ASSET_COLUMN,
  THREAT_TAG_COLUMN,
  DISPOSITION_COLUMN,
  FIRST_FOUND_COLUMN,
  FIX_PRIORITY_COLUMN,
  HIGH_PRIORITY_VALUE,
  MEDIUM_PRIORITY_VALUE,
  LOW_PRIORITY_VALUE,
  AF_RULE_COLUMN,
  AF_RULE_ACTIVE_VALUE,
  PROTECTED_DISPOSITION_VALUE,
  FIXED_INNER_DISPOSITION_VALUES,
  HIGH_EXPLOITABLE_TAG,
  HOT_VULN_TAG,
  EXPLOITABLE_TAGS,
  HIGH_EXPLOITABLE_ONLY,
  HOT_VULN_ONLY,
  SETTLED_DISPOSITION_VALUE,
  CLOSED_DISPOSITION_KEYWORD,
  NO_HIGH_EXPLOITABLE_VULN_RATE_TEXT,
  exploitableVulnCount,
  taggedVulnRows,
  highExploitableVulnCount,
  hotVulnCount,
  hotVulnAssetCount,
  settledVulnCount,
  isSettledRow,
  isProtectedRow,
  protectedVulnCount,
  protectedPlusSettledVulnCount,
  fixPriorityVulnCount,
  highPriorityVulnCount,
  mediumPriorityVulnCount,
  lowPriorityVulnCount,
  fixPriorityClosedVulnCount,
  highPriorityClosedVulnCount,
  mediumPriorityClosedVulnCount,
  lowPriorityClosedVulnCount,
  NO_HIGH_VULN_RATE_TEXT,
  NO_MEDIUM_VULN_RATE_TEXT,
  NO_LOW_VULN_RATE_TEXT,
  NO_HIGH_VULN_PROTECTION_RATE_TEXT,
  highPriorityClosureRate,
  mediumPriorityClosureRate,
  lowPriorityClosureRate,
  highVulnProtectionRate,
  fixedInnerVulnCount,
  intranetVulnRowCount,
  highExploitableClosureRate,
  closedOuterVulnCount,
  hwHardenedVulnCount,
  internetVulnRowCount,
  monthlyVulnSeries,
  monthlyVulnCountAt,
  monthlyClosedVulnCountAt,
  monthlyVulnLabelAt
};
