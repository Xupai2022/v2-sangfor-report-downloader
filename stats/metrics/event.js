'use strict';

/**
 * 事件表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 本文件供八处用：
 *   · 核心业务系统的风险总数（D7/D8/D9）里「事件风险（账号安全类）」那一段；
 *   · D11「管理员弱口令数量」的第二段（同一段的候选行，但按核心资产 IP 圈定）；
 *   · 事件定性那 21 格（C135:I137，读「GPT定性标签」的频次排行）；
 *   · G8「处置安全事件总数」（读「处置状态」精确匹配三个状态的行数）；
 *   · G9「事件平均响应时长」（在 G8 选出的行之上再匹配「推送状态」=「已推送」，
 *     取「响应时长」非空均值 —— 选行复用 disposedEventRows，两格一条判据）；
 *   · D16「已处置弱口令数量」的**第二段**（「安全事件二级分类」含「弱口令」
 *     且「处置状态」精确等于「处置完成」的行数）；
 *   · G7「威胁平均遏制时间」（「GPT研判结论」命中后，取预处理追加的「遏制时长」列求非空均值）；
 *   · G10「核心系统事件数量」（「影响资产」落在**全部核心业务系统**的 IP 并集里的行数 ——
 *     本文件只出「按 IP 集合数行」这一步，IP 并集由 stats/metrics/core_system.js 给）
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');
const { buildRanking, labelAt, countAt, shareAt } = require('./ranking');
// 「GPT研判结论」列与命中值「真实攻击未成功」的唯一出处是 stats/metrics/alarm.js
// （G5 的口径）：G5 / G6/H6/I6 已经这么引用了，G7 是第三个消费者，照同一条走 ——
// 常量只写一遍，哪天平台改了这句话，改一处三处一起跟上。
const { GPT_VERDICT_COLUMN, GPT_VERDICT_HIT } = require('./alarm');

/**
 * 「影响资产」的表头文字（要拿去和资产表的 IP 比对）。
 *
 * 依据：`tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx`
 * （平台导出的事件表，2348 行）表头行逐字命中「影响资产」；同一列名也出现在
 * `outputs/20261008_143946/一致性验收客户_report.xlsx` 的「事件表」sheet 表头。
 *
 * ⚠️ 事件表**不是**下载件原样：`scripts/report_preprocess.py` 的 `preprocess_event_file`
 * 会在**下载之后、解析之前**给它追加「内网外网资产」列与四个时长列（原地改写下载件，
 * 见 mssw_preprocess.js）。所以 ctx 的行对象里**有**那几列 —— 但本文件的其它格子一律不读
 * 它们（要读早就读了），只有 G7 读「遏制时长」。同表「目的IP」列带 `IP(资产组名:xx)` 后缀，
 * 取值一律走 stats/metrics/rows.js 的 normalizeIp（与预处理同一把尺子）。
 */
const IMPACT_ASSET_COLUMN = '影响资产';

/**
 * 「安全事件二级分类」的表头文字。
 *
 * 依据：同上两份样本的表头。「事件表」26 列里含「分类」的有两列，这里是**二级**分类，
 * 与「安全事件一级分类」（后门攻击事件 / 僵木蠕事件 …）不是一回事，别取错。
 */
const CATEGORY_COLUMN = '安全事件二级分类';

/**
 * 算一条有效事件风险的二级分类关键词（用户口径）：分类里出现其中**任意一个**即可。
 *
 * 判据是子串包含，不是整段相等 —— 实测平台的二级分类是 `Telnet弱口令`、`Web弱口令`、
 * `SSH账号暴力破解` 这种复合词，等值比较会一条都匹配不上；而 `SSH账号暴力破解`
 * 虽然含「账号」，却不含「账号安全」，所以它**不算**（这正是「账号安全」四个字要
 * 整块出现、而不是匹配「账号」的原因）。
 */
const ACCOUNT_RISK_KEYWORDS = ['弱口令', '弱密码', '账号安全'];

/**
 * 指定 IP 集合上「影响资产」命中的事件**行** —— 本文件里按 IP 选行的那件事，只写一遍（H4）。
 *
 * 判据是**精确查找**：把「影响资产」归一到与资产表同一把尺子（normalizeIp 去首尾空白、
 * 剥掉 `(资产组名:xx)` 这类括号后缀、IPv6 转小写），再做**集合成员判断** —— 不是子串包含：
 * 集合里有 `10.0.0.1` 时，`10.0.0.11` **不算**命中（多一个字符就是另一个 IP）。
 * 这一列实测是单值（一个 IP + 可选括号说明），所以不拆多值、也不按顿号分。
 *
 * 空 IP（整格空 / 整格只是个括号说明）归一后是空串，空串不在任何资产 IP 集合里（集合里
 * 的 IP 都非空），所以那些行天然不命中，不必单独剔。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {Array<Object>} 命中的行对象（顺序 = 表内原序）；事件表为空（0 行）时是空数组
 * @throws {Error} 有行数据但表头里没有「影响资产」列（列名对不上，不许静默数出 0）
 */
function eventRowsOnIps(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  requireColumn(rows, IMPACT_ASSET_COLUMN, '事件表');

  return rows.filter((row) => ips.has(normalizeIp(row[IMPACT_ASSET_COLUMN])));
}

/**
 * 指定 IP 集合上、二级分类属账号安全类的事件**行数**（D7/D8/D9 的事件那一段、D11 的第二段）。
 *
 * 选行来自 eventRowsOnIps（同一个「影响资产」精确查找，一个字都不重抄）；本函数只多一道
 * 二级分类的筛。
 *
 * 计数口径：按行计数，一行最多算一条（分类里同时含「弱口令」和「账号安全」不重复算）；
 * 不去重、不按事件名称合并 —— 同一台机器上的同类事件有多少行就是多少条。
 * 不按报告期过滤：事件表导出时已按 --start/--end 取数（见 mssw_downloader.js 的
 * TIME_RANGE_TYPES），本仓取值层不叠加第二道时间过滤。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「影响资产」或「安全事件二级分类」列
 */
function accountRiskEventCount(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 两步的顺序与从前逐字一致：先按「影响资产」选行（eventRowsOnIps 里含这一列的
  // 存在性检查），再查「安全事件二级分类」列 —— 两列都缺时抛出来的是「影响资产」
  // （选行是第一步），验收（缺列那几条）按这个顺序断言。
  const matched = eventRowsOnIps(ctx, ips);
  requireColumn(rows, CATEGORY_COLUMN, '事件表');

  let count = 0;
  for (const row of matched) {
    const category = cellText(row[CATEGORY_COLUMN]);
    if (ACCOUNT_RISK_KEYWORDS.some((keyword) => category.includes(keyword))) count += 1;
  }
  return count;
}

/**
 * 指定 IP 集合上的事件**行数**（不看任何别的列）—— G10「核心系统事件数量」的第二段。
 *
 * 与 accountRiskEventCount 的差别**只有一件事**：那道二级分类的筛在这里不存在。
 * 用户口径就一句：「影响资产」符合总 IP 集合就加一 —— 所以落在这些 IP 上的**每一行**
 * 都算一条，不看二级分类、不看处置状态、不看定性、不按事件名称 / 事件 ID 去重。
 * （一个 IP 上三行事件就是 3，不是 1；这与 D12「按资产去重数台数」是两套口径，别顺手统一。）
 * 不按报告期过滤 —— 与同表其它格子同一条：事件表导出时已按 --start/--end 圈定。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「影响资产」列（列名对不上，不许静默数出 0）
 */
function eventCountOnIps(ctx, ips) {
  return eventRowsOnIps(ctx, ips).length;
}

// ---------------------------------------------------------------------------
// 事件定性（C135:I137：第 135 行 7 格名称 / 136 行 7 格数量 / 137 行 7 格占比）
// ---------------------------------------------------------------------------

/**
 * 「GPT定性标签」的表头文字 —— 事件定性那 21 格要读的列。
 *
 * 依据（两处独立样本逐字命中，前后无空格，全表唯一）：
 *   · `outputs/20261008_143946/一致性验收客户_report.xlsx` 的「事件表」sheet，26 列表头；
 *   · `tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx` 的
 *     「事件表」sheet，25 列表头（差的那一列是报告预处理追加的「内网外网资产」）。
 * 同一张表另有「GPT研判结论」列，不会误撞。
 *
 * 该列实测是**单值**：两处样本的每一格都不含顿号 / 逗号 / 分号之类的分隔符，
 * 所以「按行计数」就是「按定性计数」，不需要像「威胁标签」那样拆多值。
 *
 * 列名一律按表头文字找，不得按列下标取 —— 事件表的列集同样是数据相关的。
 */
const GPT_LABEL_COLUMN = 'GPT定性标签';

// ---------------------------------------------------------------------------
// G8「处置安全事件总数」：按「处置状态」小计已处置的事件行数
// ---------------------------------------------------------------------------

/**
 * 「处置状态」的表头文字 —— G8 要读的列。
 *
 * 依据（两处独立样本逐字命中，前后无空格，全表唯一，且**两处的列序一致**）：
 *   · `outputs/20261010_152149/一致性验收客户_report.xlsx` 的「事件表」sheet，
 *     29 列表头（含报告预处理追加的「内网外网资产」）；
 *   · `tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx` 的
 *     「事件表」sheet，25 列表头（这是平台导出的原始总表，取值层读的就是它）。
 * 同一张表另有「托管状态」「状态说明」两列，不会误撞。
 *
 * 实测取值形态（华能集团样本 2347 行的分布）：`待处置` / `处置中` / `已遏制` / `处置完成`
 * —— 是**单值枚举**，不含顿号 / 逗号之类的分隔符；本样本里没有 `已忽略`。
 */
const DISPOSITION_COLUMN = '处置状态';

/**
 * 计入「已处置」的三个处置状态（用户口径）。
 *
 * 判据是**整格精确相等**（与 D15 的 `settledVulnCount` 同一把尺子），不是包含：
 * `已遏制` / `处置完成` / `已忽略` 算，`待处置` / `处置中` 不算，
 * 带后缀的 `已遏制（XX）`、`处置完成（已修复）` 也**都不算**（不是同一个字符串）；
 * 比较前只去首尾空白，不做全半角 / 括号归一。
 */
const DISPOSED_EVENT_STATUSES = ['已遏制', '处置完成', '已忽略'];

/**
 * 「遏制时长」的表头文字 —— G7 要读的事件表那一列。
 *
 * 依据：`tmp/duration-check/real-event.xlsx`（平台导出的原始事件表，6050 行、28 列）
 * 经表格预处理后末尾多了这一列；同表另有「事件创建时间」「组件检出时间」「事件闭环时间」，
 * 不会误撞。
 *
 * ⚠️ **这一列不是平台导出的**：它是 `scripts/report_preprocess.py` 的
 * `append_duration_columns` 按「事件遏制时间 − 专家研判时间」算出来的（分钟、2 位小数），
 * 由 `preprocess_event_file` 在**下载之后、解析之前**写进下载件 —— 用户口径 2026-10-12
 * 「取值层必须在预处理之后」说的就是这件事。所以本格读得到它，也**不必**自己再算一遍：
 * 同一个口径只有 report_preprocess.py 一处实现（从前那份"两份实现交叉钉住"的做法已删除）。
 *
 * ⚠️ **这一列不在表头里 = 预处理那一步没算出时长**（凑不齐「事件遏制时间」「专家研判时间」
 * 两个源列 —— 平台改了列名，或这份数据来自没有那两列的旧版 25 列导出）。那时本格按缺列
 * 报错、不写值（R10 缺数不静默），别的格子照常算。
 */
const CONTAINED_DURATION_COLUMN = '遏制时长';

/**
 * 「推送状态」的表头文字 —— G9 要读的事件表那一列。
 *
 * 依据：`outputs/20261012_121436/一致性验收客户_report.xlsx` 的「事件表」sheet，
 * 34 列表头（其中「推送状态」在第 29 列、前后无空格、全表唯一）。这一列是**平台导出**的
 * 真实列，不是预处理追加的：请求体字段就是 `push_status`，见 mssw_client.js 里那条
 * 「事件表请求体永远带 push_status」的长期约定（抓包样例里没有也要自己补）。
 * ⚠️ 较早的样本（如 `tmp/duration-check/real-event.xlsx`，28 列 / 预处理后 33 列）
 * 没有这一列 —— 那是 2026-10-12 之前导出的，不属于本格要覆盖的形态。
 *
 * 实测取值形态（同一份样本 6065 行）：本仓现有数据里**只有 `未推送` 一种值**，
 * 没有出现过 `已推送`；判据仍按用户口径写成整格精确相等，不因样本没出现过就放宽。
 */
const PUSH_STATUS_COLUMN = '推送状态';

/**
 * G9 认的推送状态 —— **整格精确相等**（与 G8 的三个处置状态同一把尺子）。
 *
 * 只认这一个值：`未推送` 不算，空不算，带后缀的 `已推送（XX）` 也不算（不是同一个字符串）；
 * 比较前只去首尾空白，不做全半角 / 括号归一。
 */
const PUSHED_STATUS = '已推送';

/**
 * 「响应时长」的表头文字 —— G9 要读的事件表那一列。
 *
 * ⚠️ 与「遏制时长」同源：这一列**不是平台导出的**，而是
 * `scripts/report_preprocess.py` 的 `append_duration_columns` 按
 * 「专家研判时间 − 组件检出时间」算出来（分钟、2 位小数）后写进下载件的，
 * 由 `preprocess_event_file` 在**下载之后、解析之前**原地追加（见 mssw_preprocess.js）。
 * 所以本格读得到它，也**不必**自己再算一遍 —— 同一个口径全仓只有那一处实现。
 *
 * ⚠️ **这一列不在表头里 = 预处理那一步没算出时长**（凑不齐「专家研判时间」「组件检出时间」
 * 两个源列）。那时本格按缺列报错、不写值（R10 缺数不静默），别的格子照常算。
 */
const RESPONSE_DURATION_COLUMN = '响应时长';

/**
 * 事件表要读进 ctx 的列白名单：**各处需要的并集**。
 *
 * 读事件表的有八处：事件定性那 21 格（要「GPT定性标签」）、核心业务系统的风险总数
 * D7/D8/D9 与 D11 的第二段（要「影响资产」「安全事件二级分类」）、G10（只要「影响资产」——
 * 同一列的另一套圈法：并集 + 不看分类）、G8 与 G9（要「处置状态」；G9 另外还要
 * 「推送状态」「响应时长」）、D16 的第二段（要「安全事件二级分类」+「处置状态」）、
 * G7（要「GPT研判结论」+「遏制时长」—— 时长那一列是**表格预处理追加的**，所以读事件表
 * 必须发生在预处理之后，见 mssw_preprocess.js；G9 的「响应时长」同理）。
 * 并成一次读，见 mssw_downloader.js 的 EVENT_TABLE_SPEC —— 读两遍不只是白解析 6000 行，
 * 后一遍还会把前一遍的行对象盖掉。
 */
const EVENT_TABLE_COLUMNS = [
  GPT_LABEL_COLUMN,
  IMPACT_ASSET_COLUMN,
  CATEGORY_COLUMN,
  DISPOSITION_COLUMN,
  GPT_VERDICT_COLUMN,
  CONTAINED_DURATION_COLUMN,
  PUSH_STATUS_COLUMN,
  RESPONSE_DURATION_COLUMN
];

/**
 * G8「处置安全事件总数」：事件表里「处置状态」精确等于「已遏制 / 处置完成 / 已忽略」
 * 三者之一的**行数**。
 *
 * 计数口径：按行计数、一行最多算一条（三个状态互斥，不会重复计）；
 * 不去重、不按事件名称 / 事件 ID / 影响资产合并 —— 同一台机器上有几条这样的事件就是几条。
 * 数的是**整张事件表**、取值层不按报告期过滤：事件表导出时已按 --start/--end 圈定
 * （mssw_downloader.js 的 TIME_RANGE_TYPES 含 'event'，见 G5 那条同款说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 事件表有行、但没有任何一行带「处置状态」列（平台改了列名）
 */
function disposedEventCount(ctx) {
  return disposedEventRows(ctx).length;
}

/**
 * 事件表里属于「已处置」的**行** —— G8 与 G9 共用的那一次选行（H4：同一个量只算一次）。
 *
 * 判据是「处置状态」**整格精确相等**于 DISPOSED_EVENT_STATUSES 三者之一（见上面那条常量
 * 的说明）。G9 是在这一批行**之上**再加一道「推送状态」的筛，所以两格必须选同一批行 ——
 * 一旦这里的口径改了（比如用户又加一个状态），G8 和 G9 一起跟上，不会各写一份。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {Array<Object>} 命中的行对象（顺序 = 表内原序）；事件表为空（0 行）时是空数组
 * @throws {Error} 事件表有行、但没有任何一行带「处置状态」列（列名对不上，不许静默数出 0）
 */
function disposedEventRows(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  requireColumn(rows, DISPOSITION_COLUMN, '事件表');

  return rows.filter((row) => DISPOSED_EVENT_STATUSES.includes(cellText(row[DISPOSITION_COLUMN])));
}

// ---------------------------------------------------------------------------
// G9「事件平均响应时长」：已处置事件里「已推送」那批，其响应时长的非空均值
// ---------------------------------------------------------------------------

/**
 * G9「事件平均响应时长」：在 G8 选出的那批事件（「处置状态」精确等于 已遏制 / 处置完成 /
 * 已忽略）**之上**，再精确匹配「推送状态」整格等于「已推送」的行，取其「响应时长」
 * **非空值的平均**（单位：分钟）。
 *
 * 两道筛是「同时满足」：先 G8 的处置状态（选行复用 disposedEventRows，一条判据不写两遍），
 * 再「推送状态」。只看推送状态、不看处置状态的那批行**不算**本格 —— 本格是"已处置事件里
 * 已推送的那部分"，不是全表已推送。
 *
 * 平均只对**响应时长非空**的行做，空的行**不进分母**（用户口径：「对所有非空的值计算平均值」）。
 * 响应时长本身**不在本文件里算**：它是表格预处理（`scripts/report_preprocess.py`）按
 * 「专家研判时间 − 组件检出时间」写进下载件的列（分钟、2 位小数），本格只是那一列的读者。
 * **负差值在那一步就被判为不合法、留空**（用户口径 2026-10-12：时长不可能为负），
 * 所以这里见不到负数；负值那几行与「算不出时长」的行一样退出分母。
 * 读表层读到的空格子是 `''`，数字是 JS number（见 parse_table_rows.py 的
 * format_cell_value），所以「非空」的判据就是 `Number.isFinite`。
 *
 * 空 / 缺数的口径（注意与 G7 的分岔）：
 *   · 没有可平均的样本 -> 写 **0**（用户口径原话：「没有就写0」）。这包括三种情形：
 *     事件表为空（0 行）、G8 一行都没选出、选出的行里没有一行的推送状态是「已推送」、
 *     推送命中的行其响应时长全为空。
 *   · 上面这些都**不记错误**（那是结论，不是缺数）。0 在这里是有含义的：没有推送就没有
 *     响应时长可言；这与 G7 写空串不是一条口径，别顺手统一。
 *   · 只有**缺列**才不写值 + 记错误，按顺序查三列：先「处置状态」（选行是第一步，
 *     与 G8 同一个错误现场），再「推送状态」，最后「响应时长」（预处理追加的，缺它就
 *     等于预处理那一步没算出时长 —— 平台改了「专家研判时间」「组件检出时间」两个源列的名）。
 *
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 平均值（分钟）；没有可平均的样本时是 0
 * @throws {Error} 事件表有行数据、但缺「处置状态」/「推送状态」/「响应时长」之一
 */
function averageResponseMinutes(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 三列的存在性检查顺序 = 本格的实际计算顺序：选行（处置状态）-> 筛推送状态 -> 读时长列。
  // 三列都缺时（旧版导出）报出来的是「处置状态」，验收的期望错误集合依赖这个顺序。
  const disposed = disposedEventRows(ctx);
  requireColumn(rows, PUSH_STATUS_COLUMN, '事件表');
  requireColumn(rows, RESPONSE_DURATION_COLUMN, '事件表');

  let sum = 0;
  let count = 0;
  for (const row of disposed) {
    if (cellText(row[PUSH_STATUS_COLUMN]) !== PUSHED_STATUS) continue;
    const minutes = row[RESPONSE_DURATION_COLUMN];
    if (!Number.isFinite(minutes)) continue;
    sum += minutes;
    count += 1;
  }
  // 均值**不再舍入** —— 与 G7 同一条理由：逐行已是那一列的 2 位小数，直接相加再除，
  // 才和在 Excel 里对「响应时长」拉一个 =AVERAGE 对得上。
  return count === 0 ? 0 : sum / count;
}

/**
 * D16 第二段认的二级分类关键词（用户口径）：分类里**出现「弱口令」这三个字**即可。
 *
 * 判据同样是子串包含、不是整段相等 —— 实测平台的二级分类写成 `Telnet弱口令`、
 * `Web弱口令` 这种复合词（华能集团样本 2347 行里 2 行命中，两个取值就是这两个），
 * 等值比较会一条都匹配不上。
 *
 * ⚠️ 只认「弱口令」这三个字，**不**跟着 D11 的 ACCOUNT_RISK_KEYWORDS 一起放宽到
 * 「弱密码 / 账号安全」：那一组是 D11 投喂的口径，本格是另一次投喂，各写各的。
 */
const WEAKPWD_CATEGORY_KEYWORD = '弱口令';

/**
 * D16 第二段认的处置状态 —— 同样是**整格精确相等**。
 *
 * 与 G8 三个状态里的「处置完成」是同一个字符串，但两格口径来源不同
 * （G8 一次认三个状态，本格只认这一个），所以各写各的常量，不互相引用 ——
 * 哪天其中一个口径改了，不至于被另一格悄悄带跑。
 */
const DISPOSED_EVENT_STATUS = '处置完成';

/**
 * D16 第二段：事件表里「安全事件二级分类」含「弱口令」**且**「处置状态」精确等于
 * 「处置完成」的**行数**（两个条件是"同时满足"，不是二选一）。
 *
 * 计数口径：按行计数、一行一票，不去重、不按事件名称 / 事件 ID / 影响资产合并。
 * 数的是**全表**：不看 IP、与 --business-systems 传没传、传了什么都无关。
 * 不按报告期过滤 —— 事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 事件表有行数据、但没有任何一行带「安全事件二级分类」或
 *   「处置状态」列（平台改了列名）
 */
function disposedWeakPwdEventCount(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, CATEGORY_COLUMN, '事件表');
  requireColumn(rows, DISPOSITION_COLUMN, '事件表');

  let count = 0;
  for (const row of rows) {
    if (!cellText(row[CATEGORY_COLUMN]).includes(WEAKPWD_CATEGORY_KEYWORD)) continue;
    if (cellText(row[DISPOSITION_COLUMN]) === DISPOSED_EVENT_STATUS) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// G7「威胁平均遏制时间」：命中「真实攻击未成功」的事件，其遏制时长的非空均值
// ---------------------------------------------------------------------------

/**
 * G7「威胁平均遏制时间」：事件表里「GPT研判结论」**整格精确等于**「真实攻击未成功」的行，
 * 其「遏制时长」**非空值的平均**（单位：分钟）。
 *
 * 选行判据与 G5/G6/H6/I6 是同一句（同一个常量 `GPT_VERDICT_HIT`），只是读的是**事件表**；
 * 平均只对**遏制时长非空**的行做，空的行**不进分母**（用户口径：
 * 「如果有不是空值，就计算所有非空的平均值」）。
 *
 * 遏制时长本身**不在本文件里算**：它是表格预处理（`scripts/report_preprocess.py`）按
 * 「事件遏制时间 − 专家研判时间」写进下载件的列（分钟、2 位小数）。**负差值在那一步就被
 * 判为不合法、留空**（用户口径 2026-10-12：时长不可能为负，负值说明源列取错了），
 * 所以本格读到的这一列里不会有负数 —— 负值那几行与「空值 / 解析失败」一样退出分母，
 * 只是预处理那边记的是另一个计数。本格只是那一列的读者，同一个口径全仓只有一份实现。
 * 读表层读到的空格子是 `''`，数字是 JS number（见 parse_table_rows.py 的 format_cell_value），
 * 所以「非空」的判据就是 `Number.isFinite`。
 *
 * 空 / 缺数的口径：
 *   · 事件表为空（0 行）-> 写**空串**（不是 0）。这不是计数格：0 分钟是一个真实可能的均值
 *     （遏制与研判同一分钟），会和「一行都没有可平均的样本」混成一个数。
 *   · 表里有行、但没有一行命中 / 命中的行遏制时长全空 -> 同样写空串。
 *   · 上面的两种都**不记错误**（那是结论，不是缺数 —— 与名次格写空串同一条）。
 *   · 只有**缺列**才不写值 + 记错误：缺「GPT研判结论」列，或缺预处理追加的「遏制时长」列
 *     （后者意思是预处理那一步没算出时长 —— 平台改了那两个时间源列的名，或这份数据来自
 *     没有它们的旧版导出）。
 *
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number|string} 平均值（分钟）；没有可平均的样本时空串
 * @throws {Error} 事件表有行数据、但缺「GPT研判结论」列，或缺「遏制时长」列
 */
function averageContainedMinutes(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return '';

  // 先查选行那一列，再查时长列 —— 顺序有讲究：两个都缺时（旧版 25 列导出就是
  // 两边都没有），报出来的应该是「GPT研判结论」这一条（选行是第一步，
  // 与 G5 同一个错误现场）。验收【1】/【3】/【6】/【7】/【8】的期望错误集合依赖这个顺序。
  requireColumn(rows, GPT_VERDICT_COLUMN, '事件表');
  requireColumn(rows, CONTAINED_DURATION_COLUMN, '事件表');

  let sum = 0;
  let count = 0;
  for (const row of rows) {
    if (cellText(row[GPT_VERDICT_COLUMN]) !== GPT_VERDICT_HIT) continue;
    const minutes = row[CONTAINED_DURATION_COLUMN];
    if (!Number.isFinite(minutes)) continue;
    sum += minutes;
    count += 1;
  }
  // 均值**不再舍入**：逐行已是那一列的 2 位小数，直接相加再除 —— 这样与在 Excel 里
  // 对「遏制时长」那一列拉一个 =AVERAGE 是对得上的（再舍一次反而会差一个尾数）。
  return count === 0 ? '' : sum / count;
}

/**
 * 「GPT定性标签」的频次排行 —— 第 135 / 136 / 137 三行共用的那个量（H4）。
 *
 * 排序、计数、缺值、缺列防线的口径一律见 stats/metrics/ranking.js 的头注。关键是
 * **占位符 `-` 不算一种定性、也不进分母**：真实事件表里那一列绝大多数行都是 `-`
 * （华能集团样本 2347 行里 2290 行），当成定性的话报告的第 1 名就会是一个横杠。
 *
 * @returns {{items: Array<{label: string, count: number}>, total: number}}
 *   事件表为空、或所有行都没有定性（空 / 占位符）时 items 为空、total 为 0
 *   —— 没有定性就是没有定性，名次槽位跟着写空串，不记错误
 * @throws 事件表有数据、但没有任何一行带「GPT定性标签」这一列时抛错（猜错列名的防线）。
 */
function gptRanking(ctx) {
  return buildRanking(ctx && ctx.eventRows, GPT_LABEL_COLUMN, '事件表');
}

/** 排行第 rank 名（从 0 起）的定性名称；名次不存在（含事件表为空）时空串。 */
function gptLabelAt(ctx, rank) {
  return labelAt(gptRanking(ctx), rank);
}

/** 排行第 rank 名（从 0 起）的出现行数；名次不存在（含事件表为空）时空串。 */
function gptCountAt(ctx, rank) {
  return countAt(gptRanking(ctx), rank);
}

/**
 * 排行第 rank 名（从 0 起）的占比，小数形式（写层按 '0.00%' 落格式）。
 * 分母是全部定性的出现总次数，不是前几名之和；名次不存在（含事件表为空）时空串。
 */
function gptShareAt(ctx, rank) {
  return shareAt(gptRanking(ctx), rank);
}

module.exports = {
  IMPACT_ASSET_COLUMN,
  CATEGORY_COLUMN,
  ACCOUNT_RISK_KEYWORDS,
  eventRowsOnIps,
  accountRiskEventCount,
  eventCountOnIps,
  GPT_LABEL_COLUMN,
  DISPOSITION_COLUMN,
  DISPOSED_EVENT_STATUSES,
  EVENT_TABLE_COLUMNS,
  disposedEventRows,
  disposedEventCount,
  WEAKPWD_CATEGORY_KEYWORD,
  DISPOSED_EVENT_STATUS,
  disposedWeakPwdEventCount,
  CONTAINED_DURATION_COLUMN,
  averageContainedMinutes,
  PUSH_STATUS_COLUMN,
  PUSHED_STATUS,
  RESPONSE_DURATION_COLUMN,
  averageResponseMinutes,
  gptRanking,
  gptLabelAt,
  gptCountAt,
  gptShareAt
};
