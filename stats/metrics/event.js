'use strict';

/**
 * 事件表域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 本文件供十三处用：
 *   · 核心业务系统的风险总数（D7/D8/D9）里「事件风险（账号安全类）」那一段；
 *   · D11「管理员弱口令数量」的第二段（同一段的候选行，但按核心资产 IP 圈定）；
 *   · 事件定性那 21 格（C135:I137，读「GPT定性标签」的频次排行）；
 *   · 事件类型 TOP5 那 10 格（C51:C55 分类名 / D51:D55 对应次数，读「安全事件二级分类」
 *     的频次排行 —— 与上面那 21 格同一套算法、换一列，共用 buildRanking，见 categoryRanking）；
 *   · G8「处置安全事件总数」（读「处置状态」精确匹配三个状态的行数）；
 *   · G9「事件平均响应时长」（在 G8 选出的行之上再匹配「推送状态」=「已推送」，
 *     取「响应时长」非空均值 —— 选行复用 disposedEventRows，两格一条判据）；
 *   · D16「已处置弱口令数量」的**第二段**（「安全事件二级分类」含「弱口令」
 *     且「处置状态」精确等于「处置完成」的行数）；
 *   · G7「威胁平均遏制时间」（「GPT研判结论」命中后，取预处理追加的「遏制时长」列求非空均值）；
 *   · G10「核心系统事件数量」（「影响资产」落在**全部核心业务系统**的 IP 并集里的行数 ——
 *     本文件只出「按 IP 集合数行」这一步，IP 并集由 stats/metrics/core_system.js 给）；
 *   · G14「核心系统威胁事件总数」（在 G10 那一步之上**再多一道**「GPT研判结论」精确等于
 *     「真实攻击未成功」—— 两格同起手、同 IP 并集，差的就是这一列，见 threatEventCountOnIps）
 *   · G101「xdr事件数」/ D38「威胁和事件数量」（整张事件表的**行数** —— 一个列名都不读，
 *     见 eventRowCount。两格同一个口径、却**各算各的**：用户口径 2026-10-13 给 D38 的
 *     原话是「不要复用，重新查」，所以 D38 自己那一条 compute 也走 eventRowCount，
 *     不写成 G101 的 alias（H5 在这一格被显式压过，见 D38 那条记录）；
 *     ⚠️ C49「安全事件总数」= D38（用户口径「可以复用D38」），它才走 alias、不重算）；
 *   · G106「处置中事件数」/ G107「待处置事件数」（「处置状态」整格精确等于「处置中」/
 *     「待处置」的行数 —— 两格只差一个状态值，共用 eventCountByDisposition，见 H4）；
 *   · D35「平均分析时间」/ D36「平均响应时间」/ E49「事件平均处置时长」（事件表
 *     「推送状态」精确等于「已推送」的行，其**预处理追加的**「识别时长」/「响应时长」/
 *     「处置时长」列的非空均值 —— 三格只差一个时长列，
 *     共用 averagePushedDurationMinutes 与内核 meanFiniteMinutes，见 H4）。
 *     ⚠️ 这三格与 G9 **不是同一批行**：G9 多一道「已处置」的筛（用户口径 2026-10-13），
 *     所以 D36 ≠ G9、也不能走 alias（见 averagePushedDurationMinutes 的头注）。
 *     ⚠️ D49「事件平均响应时间」**不在本文件的消费者之列**：它与 D36 同值
 *     （用户口径 2026-10-13「复用D36」），走 alias 指向 D36，一个字都不重算（H5）。
 *   · G51「平均识别时长」/ G52「平均响应时长」/ G53「平均遏制时长」/ G54「平均处置时长」/
 *     G55「平均闭环时长」（**整张事件表**里那一列时长的非空均值 —— 用户口径 2026-10-13
 *     第二版「不用跟推送状态挂钩」，五格只差一个时长列，共用 averageEventDurationMinutes）。
 *     ⚠️ 这一组与上面 D35/D36/E49 **不是同一批行**：那三格按「推送状态」选行、本组一道筛
 *     都没有 —— 所以五格**各有各的 compute、一格都不能 alias 到那三个主地址**。
 *     ⚠️ G54 与 G55 在任何输入上都同值（两列同式同源），但**刻意不互为 alias**。
 *     ⚠️ G102「已处置事件数」**同样不在本文件的消费者之列**：它与 G8 是同一个值
 *     （同样那三个状态），走 alias 指向 G8，一个字都不重算（H5）。
 */

const { requireColumn, cellText, normalizeIp } = require('./rows');
const { buildRanking, labelAt, countAt, shareAt } = require('./ranking');
// 报告期 -> 月份桶键（`['2026-07', ...]`）。用户口径 2026-10-14，口径本身写在
// stats/periods.js 的 monthRange 上；这里只取那一个量（H4：切分逻辑不在这抄第二份）。
// ⚠️ MAX_MONTHS 是从那边引过来的：槽位数就是切分时用的那个上限，
// 在本地再写一个 12 会变成两个能各自漂走的事实。
const { monthRange, MAX_MONTHS } = require('../periods');
// 「GPT研判结论」列与命中值「真实攻击未成功」的唯一出处是 stats/metrics/alarm.js
// （G5 的口径）：G5 / G6/H6/I6 已经这么引用了，G7 / G14 是后两个消费者，照同一条走 ——
// 常量只写一遍，哪天平台改了这句话，改一处几处一起跟上。
const { GPT_VERDICT_COLUMN, GPT_VERDICT_HIT } = require('./alarm');

/**
 * 「影响资产」的表头文字（要拿去和资产表的 IP 比对）。
 *
 * 依据：`tmp/verify_vuln/cli_downloads/华能集团_事件跟踪表2026-10-08 12_36_42.xlsx`
 * （平台导出的事件表，2348 行）表头行逐字命中「影响资产」；同一列名也出现在
 * `outputs/20261008_143946/一致性验收客户_report.xlsx` 的「事件表」sheet 表头。
 *
 * ⚠️ 事件表**不是**下载件原样：`scripts/report_preprocess.py` 的 `preprocess_event_file`
 * 会在**下载之后、解析之前**给它追加「内网外网资产」列与五个时长列（原地改写下载件，
 * 见 mssw_preprocess.js）。所以 ctx 的行对象里**有**那几列 —— 但本文件的其它格子一律不读
 * 它们（要读早就读了），只有 G7 读「遏制时长」。同表「目的IP」列带 `IP(资产组名:xx)` 后缀，
 * 取值一律走 stats/metrics/rows.js 的 normalizeIp（与预处理同一把尺子）。
 */
const IMPACT_ASSET_COLUMN = '影响资产';

/**
 * 「安全事件二级分类」的表头文字 —— 四个消费者要读的列。
 *
 * 依据：同上两份样本的表头。「事件表」26 列里含「分类」的有两列，这里是**二级**分类，
 * 与「安全事件一级分类」（后门攻击事件 / 僵木蠕事件 …）不是一回事，别取错。
 *
 * ⚠️ 同一列上两把不同的尺子（各读各的，互不牵连）：
 *   · 子串**包含**（ACCOUNT_RISK_KEYWORDS）：D7/D8/D9 的「事件风险」那一段、
 *     D11 的第二段、D16 的第二段 —— 判据是分类里出现「弱口令 / 弱密码 / 账号安全」
 *     其中任意一个（`Telnet弱口令` 这种复词才算得上）；
 *   · 整格**取值**后做频次排行：C51:C55 / D51:D55「安全事件类型 TOP5」——
 *     不看关键词，`Telnet弱口令` 与 `Web弱口令` 是两个不同的分类各占一项。
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
 * 事件表的**事件行数**（整张表有多少行）—— G101「xdr事件数」与 D38「威胁和事件数量」
 * （用户口径 2026-10-13：「G101 是事件数，取事件表事件行数」；
 * 「D38 是威胁和事件数量，取事件表所有事件总行数，可能其他单元格也算过这个，
 * **不要复用，重新查**」）。
 *
 * ⚠️ 两格**同一个口径、却不是 alias**（H5 在本对格子上被显式压过）：D38 自己有
 * 一条 compute（也调到本函数），不是 `alias: 'G101'`。同一份事件表上两格的值必然相等
 * —— 这正是投喂时要的那件事：它要的是"这一格自己也去数一遍"，不是"抄隔壁那一格的值"。
 * 所以**别为了"省一条 compute"把 D38 改成 alias**：那会改掉一条投喂明说要独立的连线
 * （与 D32/D33 那对"今天同值、却刻意不互 alias"是同一个形状）。
 *
 * ⚠️ 与同表的其它格子不同，本函数**一个列名都不读**：数的是下载件里有多少行数据，
 * 「影响资产」「处置状态」「GPT定性标签」那些列在不在、写成什么样都跟它无关
 * （C5 的缺列防线在这里无从谈起 —— 没有要读的列，也就没有列名可对不上）。
 * 所以读事件表的格子里**只有这两格**（以及 G100「xdr告警数」在告警表那边）**不会**
 * 因为平台改列名而不写值：它们没有"缺列"这一档。
 *
 * 计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并；
 * 也不看任何一列的内容（不看处置状态、不看定性、不看研判结论）。
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明），
 * 本仓取值层不叠加第二道时间过滤 —— 与同表其它格子同一条。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （用户口径 2026-10-10：下载一定发生，下不到的表现在流程根本走不到取值层 ——
 *   scripts/build_report.py 会直接报「缺少 X 的下载结果」、整份报告不出）
 */
function eventRowCount(ctx) {
  const rows = ctx && ctx.eventRows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * 整张事件表里「GPT研判结论」精确等于「真实攻击未成功」的事件**行数** —— D63「MSS威胁工单数量」。
 *
 * 用户口径（2026-10-19）：精确查找事件表「GPT研判结论」列，值精确匹配「真实攻击未成功」就加一。
 * 判据与 G7 / G14 / G5 是同一句（同一个常量 `GPT_VERDICT_HIT`）：整格精确相等、
 * 比较前只去首尾空白；`真实攻击成功`、`真实攻击未成功（疑似）`、`等待GPT研判`、
 * 占位符 `-` 一个都不算。
 *
 * 与 threatEventCountOnIps 的差别**只有一件事**：这里不按 IP 圈行，数的是**整张事件表**
 * （与 G7 的选行范围逐字相同，只是 G7 取时长均值、本函数数行）。
 * 计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并；
 * 不按报告期过滤（事件表导出时已按 --start/--end 圈定）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 行数；事件表为空（0 行）、或没有一行命中时是 0 —— 那是结论，不是缺数
 * @throws {Error} 有行数据但表头里没有「GPT研判结论」列（列名对不上，不许静默数出 0）
 */
function gptVerdictEventCount(ctx) {
  const rows = ctx && ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, GPT_VERDICT_COLUMN, '事件表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[GPT_VERDICT_COLUMN]) !== GPT_VERDICT_HIT) continue;
    count += 1;
  }
  return count;
}

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
 * 指定 IP 集合上、二级分类属账号安全类的事件**行** —— D7/D8/D9 / D11 的那一段，
 * 以及 D113 的事件那一段，都从这一批行上归总（H4：判据只写一遍）。
 *
 * 选行来自 eventRowsOnIps（同一个「影响资产」精确查找，一个字都不重抄）；本函数只多一道
 * 二级分类的筛。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {Array<Object>} 命中的行对象（顺序 = 表内原序）；事件表为空（0 行）时是空数组
 * @throws {Error} 有行数据但表头里没有「影响资产」或「安全事件二级分类」列
 */
function accountRiskEventRows(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // 两步的顺序与从前逐字一致：先按「影响资产」选行（eventRowsOnIps 里含这一列的
  // 存在性检查），再查「安全事件二级分类」列 —— 两列都缺时抛出来的是「影响资产」
  // （选行是第一步），验收（缺列那几条）按这个顺序断言。
  const matched = eventRowsOnIps(ctx, ips);
  requireColumn(rows, CATEGORY_COLUMN, '事件表');

  return matched.filter((row) => {
    const category = cellText(row[CATEGORY_COLUMN]);
    return ACCOUNT_RISK_KEYWORDS.some((keyword) => category.includes(keyword));
  });
}

/**
 * 指定 IP 集合上、二级分类属账号安全类的事件**行数**（D7/D8/D9 的事件那一段、D11 的第二段）。
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
  return accountRiskEventRows(ctx, ips).length;
}

/**
 * 指定 IP 集合上、命中的账号安全类事件涉及**多少台不同的资产**（按「影响资产」去重）——
 * D113「管理员弱口令去重资产数」的第二段。
 *
 * 选行与 accountRiskEventCount 逐字相同（同一批行，H4）；本函数只在归总时换成去重：
 * 「影响资产」经 normalizeIp 归一后进集合，最后数集合大小。所以同一台资产上三条
 * 账号安全事件只算 1 台（D11 数的是 3 条 —— 两格刻意不同）。
 * 空值行不可能进集合（集合里的 IP 都非空），不必单独剔。
 * 不按报告期过滤（与 accountRiskEventCount 同一条）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {Set<string>} 去重后的资产 IP 集合（可能是空集 —— 没有命中行时，
 *   那是结论，不是缺数）
 * @throws {Error} 有行数据但表头里没有「影响资产」或「安全事件二级分类」列
 */
function accountRiskEventAssetIps(ctx, ips) {
  const assets = new Set();
  for (const row of accountRiskEventRows(ctx, ips)) {
    const ip = normalizeIp(row[IMPACT_ASSET_COLUMN]);
    if (ip) assets.add(ip);
  }
  return assets;
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

/**
 * 指定 IP 集合上、「GPT研判结论」精确等于「真实攻击未成功」的事件**行数** ——
 * G14「核心系统威胁事件总数」的第二段。
 *
 * 与 eventCountOnIps 的差别**只有一件事**：多一道「GPT研判结论」的筛（用户口径：
 * 先按核心系统的 IP 集合圈行，命中的行里再看研判结论，是「真实攻击未成功」才加一）。
 * 那道筛的判据与 G5/G6/H6/I6/G7 是同一句（同一个常量 `GPT_VERDICT_HIT`）——
 * 整格精确相等、比较前只去首尾空白；`真实攻击成功`、`真实攻击未成功（疑似）`、
 * `等待GPT研判`、占位符 `-` 一个都不算。
 * 计数口径与 eventCountOnIps 逐字相同：**按行计数，一行一票**，不去重、不按事件
 * 名称 / 事件 ID 合并（一台机器上三条这样的行就是 3）；也不看二级分类、处置状态、
 * 定性标签；不按报告期过滤（事件表导出时已按 --start/--end 圈定）。
 *
 * 查列顺序与 accountRiskEventCount 逐字相同：**先**按「影响资产」选行
 * （eventRowsOnIps 里含这一列的存在性检查）、**再**查「GPT研判结论」——
 * 两列都缺时抛出来的是「影响资产」，选行是第一步。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {Set<string>} ips 已归一的 IP 集合（来自 stats/metrics/asset.js）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 *   （IP 集合为空、或圈到的行没一行命中研判结论，同样是 0，都是结论）
 * @throws {Error} 有行数据但表头里没有「影响资产」列（先抛这一条），
 *   或没有「GPT研判结论」列（列名对不上，不许静默数出 0）
 */
function threatEventCountOnIps(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const matched = eventRowsOnIps(ctx, ips);
  requireColumn(rows, GPT_VERDICT_COLUMN, '事件表');

  let count = 0;
  for (const row of matched) {
    if (cellText(row[GPT_VERDICT_COLUMN]) !== GPT_VERDICT_HIT) continue;
    count += 1;
  }
  return count;
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
 * 判据是**整格精确相等**（**不是** D15 那一把尺子 —— D15 自 2026-10-26 起是包含
 * 「处置完成」，见 stats/metrics/vuln.js 的 SETTLED_DISPOSITION_VALUE），不是包含：
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
 * ⚠️ **那一列缺席只停这一列**（用户口径 2026-10-12「不要因为一个影响别的时间计算」）：
 * 预处理追加时长列时是**逐列独立**的（`append_duration_columns`）——
 * 「事件遏制时间」没给时「识别时长 / 处置时长 / 响应时长」照建照算，`RESPONSE_DURATION_COLUMN`
 * 的读者（G9 / D36）与 `RECOGNIZE_DURATION_COLUMN` 的读者（D35）因此照常落值。
 * 所以本格报缺列**不代表**别的时长也没算出来。
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
 * ⚠️ **本列与「遏制时长」互不牵连**（用户口径 2026-10-12）：那一对源列里不含「事件遏制时间」,
 * 所以「事件遏制时间」缺席时本列照常算出来、G9 照常落值（那一列缺席只让 G7 落空）。
 * 预处理那边是逐列独立的，见 `append_duration_columns` 头注第 6 条。
 */
const RESPONSE_DURATION_COLUMN = '响应时长';

/**
 * 「识别时长」的表头文字 —— D35「平均分析时间」要读的事件表那一列。
 *
 * ⚠️ 与「遏制时长」「响应时长」同源：这一列**不是平台导出的**，而是
 * `scripts/report_preprocess.py` 的 `append_duration_columns` 按
 * 「事件创建时间 − 组件检出时间」算出来（分钟、2 位小数）后写进下载件的，
 * 由 `preprocess_event_file` 在**下载之后、解析之前**原地追加（见 mssw_preprocess.js）。
 * 所以本格读得到它，也**不必**自己再算一遍 —— 同一个口径全仓只有那一处实现。
 *
 * ⚠️ **这一列不在表头里 = 预处理那一步没算出时长**（凑不齐「事件创建时间」「组件检出时间」
 * 两个源列）。那时本格按缺列报错、不写值（R10 缺数不静默），别的格子照常算。
 * ⚠️ **本列与「遏制时长」「响应时长」互不牵连**（用户口径 2026-10-12）：预处理是**逐列独立**的，
 * 「事件创建时间」缺席只让本列算不出来 —— D36 读的「响应时长」照常算、照常落值
 * （那一列的源列是「专家研判时间」「组件检出时间」，与本列只共用后者）。
 * 见 `append_duration_columns` 头注第 6 条。
 */
const RECOGNIZE_DURATION_COLUMN = '识别时长';

/**
 * 「处置时长」的表头文字 —— E49「事件平均处置时长」要读的事件表那一列。
 *
 * ⚠️ 与「遏制时长」「响应时长」「识别时长」同源：这一列**不是平台导出的**，而是
 * `scripts/report_preprocess.py` 的 `append_duration_columns` 按
 * 「事件闭环时间 − 事件创建时间」算出来（分钟、2 位小数）后写进下载件的，
 * 由 `preprocess_event_file` 在**下载之后、解析之前**原地追加（见 mssw_preprocess.js）。
 * 所以本格读得到它，也**不必**自己再算一遍 —— 同一个口径全仓只有那一处实现。
 *
 * ⚠️ **这一列不在表头里 = 预处理那一步没算出时长**（凑不齐「事件闭环时间」
 * 「事件创建时间」两个源列 —— 平台改了列名，或这份数据来自没有那两列的旧版导出）。
 * 那时 E49 按缺列报错、不写值（R10 缺数不静默），别的格子照常算。
 * ⚠️ **本列与另外三列互不牵连**（用户口径 2026-10-12「不要因为一个影响别的时间计算」）：
 * 预处理追加时长列时是**逐列独立**的（`append_duration_columns`）——
 * 「事件创建时间」缺席时「识别时长」与「处置时长」一起留空（两列共用这个被减数），
 * 而「响应时长」「遏制时长」照算；「事件闭环时间」缺席则只停本列。
 * 所以本格报缺列**不代表**别的时长也没算出来。
 *
 * 它是时长列里**最晚有读者**的一列：D35 要「识别时长」时它还空着，
 * 直到 E49 立项（用户口径 2026-10-13）才被加进 EVENT_TABLE_COLUMNS。
 * ⚠️ 同日（2026-10-13）预处理又追加了第五条「闭环时长」—— 那一列与本列同式，
 * 起初**没有任何读者**，所以当时不在 EVENT_TABLE_COLUMNS 里（白名单是"各处需要的并集"，
 * 不是"表里有的列"）；G55「平均闭环时长」立项后它才有了读者、随之进了白名单，
 * 见 CLOSURE_DURATION_COLUMN。
 */
const DISPOSAL_DURATION_COLUMN = '处置时长';

/**
 * 「闭环时长」的表头文字 —— G55「平均闭环时长」要读的事件表那一列。
 *
 * ⚠️ 与「处置时长」**同式同源**：`scripts/report_preprocess.py` 的 `append_duration_columns`
 * 对这两列用的是同一条算式、同一对源列（「事件闭环时间」−「事件创建时间」），
 * 所以在本仓造得出来的**任何**事件表上两列逐行相等。用户 2026-10-13 点名要的冗余列。
 *
 * ⚠️ 正因为同式同源，G54（读「处置时长」）与 G55（读本列）在**任何**输入上都同值 ——
 * 但两格是**两条各自独立的 compute**、刻意不互为 alias（见 averageEventDurationMinutes
 * 的头注）：各自跟着自己那一列走。哪天预处理把其中一列的算式改掉，
 * 两格各自跟上、接线一个字都不用动；若改成 alias，这种分离会变成"看得见却查不出的错"。
 *
 * ⚠️ **这一列是本组唯一"新加进白名单"的列**：2026-10-13 预处理刚追加它时没有任何读者，
 * 所以一开始刻意不进 EVENT_TABLE_COLUMNS（见那张表的说明）；G55 立项后才补进来。
 */
const CLOSURE_DURATION_COLUMN = '闭环时长';

/**
 * 「事件创建月份」的表头文字 —— C58:N59「按月平均响应时长」要读的事件表那一列。
 *
 * ⚠️ 与那几个时长列**同性质、不同源**：它也**不是平台导出的**，由
 * `scripts/report_preprocess.py` 的 `append_month_column`（用户口径 2026-10-14）
 * 按「事件创建时间」取年月（`2026-07` 形态的**文本**）写进下载件，由
 * `preprocess_event_file` 在**下载之后、解析之前**原地追加（见 mssw_preprocess.js）。
 *
 * ⚠️ **为什么年月不在取值层解析**：平台的时间格有三种形态（文本 / 真 datetime /
 * 带日期格式的裸序列号），只有预处理那一步的 `parse_time_cell` 三种全认 ——
 * 这里再解析一遍就是第二份实现，而且本层连日期解析器都没有。
 * 所以本列只做**字符串相等**的桶键比较，形态必须与 `stats/periods.js` 的 `monthRange`
 * 输出逐字相等（都是短横 `2026-07`）。
 *
 * ⚠️ **它不进交付物**：`scripts/build_report.py` 把事件表搬进报告时会把它剔掉
 * （取值层要读、报告「事件表」sheet 上不要，用户口径 2026-10-14）。所以「报告里没有这一列」
 * 与「预处理没算出这一列」是两件不同的事：前者是设计，后者是这一列缺席、C58:N59 记错误。
 */
const CREATE_MONTH_COLUMN = '事件创建月份';

/**
 * 「事件创建时间」的表头文字 —— D29「重要时期事件数」的那根判据列（用户口径 2026-10-14）。
 *
 * ⚠️ **这是平台导出的真列，不是预处理追加的**（别与上面那个 `CREATE_MONTH_COLUMN`
 * 「事件创建月份」搞混 —— 那个是预处理按这一列算出来的派生列，月份桶用）。
 *
 * ⚠️ **与 `scripts/report_preprocess.py` 的 `CREATED_HEADER = '事件创建时间'`（其 :104）
 * 是同一列**。预处理那一步正是读这一列来追加「事件创建月份」。跨语言两处必须**逐字相同**
 * —— 谁改了平台列名（或这边的常量），两边要一起改（同 normalizeIp / normalize_ip 那条镜像约定）。
 *
 * 实测形态是**真 datetime**（openpyxl `data_type='d'`，`yyyy-mm-dd h:mm:ss`），经
 * `scripts/parse_table_rows.py` 后拿到的是 **epoch 秒（数字）** —— 与告警表「最早发生时间」
 * 那列（文本）**形态不同**。D29 按日期比较，还原走 UTC，见 stats/metrics/rows.js 的 cellDateOnly。
 */
const CREATED_TIME_COLUMN = '事件创建时间';

/**
 * 事件表要读进 ctx 的列白名单：**各处需要的并集**。
 *
 * 读事件表的有十三处：事件定性那 21 格（要「GPT定性标签」）、事件类型 TOP5 那 10 格
 * （要「安全事件二级分类」）、核心业务系统的风险总数
 * D7/D8/D9 与 D11 的第二段（要「影响资产」「安全事件二级分类」）、G10（只要「影响资产」——
 * 同一列的另一套圈法：并集 + 不看分类）、G8 与 G9（要「处置状态」；G9 另外还要
 * 「推送状态」「响应时长」）、D35/D36/E49（要「推送状态」+ 预处理追加的
 * 「识别时长」/「响应时长」/「处置时长」）、D16 的第二段（要「安全事件二级分类」+「处置状态」）、
 * G7（要「GPT研判结论」+「遏制时长」—— 时长那一列是**表格预处理追加的**，所以读事件表
 * 必须发生在预处理之后，见 mssw_preprocess.js；G9 的「响应时长」、D35 的「识别时长」、
 * E49 的「处置时长」同理）、C58:N59 那 24 格（要「事件创建月份」+「响应时长」——
 * 月份那一列同样是预处理追加的，见 buildMonthSeries）。
 * 并成一次读，见 mssw_downloader.js 的 EVENT_TABLE_SPEC —— 读两遍不只是白解析 6000 行，
 * 后一遍还会把前一遍的行对象盖掉。
 *
 * ⚠️ 读事件表的还有 G101 / G106 / G107 / D38（用户口径 2026-10-13）：
 * G101 与 D38 数**整张表的行数**（一个列名都不读，本白名单对它们没有意义），
 * G106 / G107 读的是**已经在表里的**「处置状态」列（与 G8/G9/D16 同一列，
 * 不必为它们再加列）。所以这四格没有让本白名单变长 —— 它们不是"新要一列"，
 * 是"新的消费者"。
 * ⚠️ 因为新格子**加长**白名单的有三次：D35 要「识别时长」、E49 要「处置时长」、
 * G55 要「闭环时长」—— 这三列此前都没有读者。有读者要读的时长列到此**就都有了**，
 * 白名单也就到齐了（G51 的「识别时长」、G52 的「响应时长」、G53 的「遏制时长」、
 * G54 的「处置时长」都只是"新的消费者"，用的是已经在名单里的列；
 * 2026-10-13 追加的第五条「闭环时长」起初没有读者、刻意不进这张名单，
 * G55 立项后才补进来）。
 * ⚠️ **2026-10-14 又加长了一次**：C58:N59 要读**两个新列** ——
 * 「事件创建月份」（预处理 2026-10-14 才追加、此前没有读者）与「响应时长」
 * （已有的列，那 24 格只是它的新消费者，它本来就在名单里）。
 * 至此平台导出的列与预处理追加的列**都有读者了**。
 * ⚠️ **2026-10-15 再加长一次**：D29「重要时期事件数」要读「事件创建时间」
 * —— 平台导出的老列，此前没有取值层的读者（预处理的 append_month_column 读过它，
 * 但那不在本白名单的管辖范围里）。上面那句"都有读者了"到此作废，
 * 往后读事件表的格子还会多读平台已经导出的老列。
 */
const EVENT_TABLE_COLUMNS = [
  GPT_LABEL_COLUMN,
  IMPACT_ASSET_COLUMN,
  CATEGORY_COLUMN,
  DISPOSITION_COLUMN,
  GPT_VERDICT_COLUMN,
  CONTAINED_DURATION_COLUMN,
  RECOGNIZE_DURATION_COLUMN,
  DISPOSAL_DURATION_COLUMN,
  CLOSURE_DURATION_COLUMN,
  PUSH_STATUS_COLUMN,
  RESPONSE_DURATION_COLUMN,
  CREATE_MONTH_COLUMN,
  CREATED_TIME_COLUMN
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

/**
 * G106「处置中事件数」认的处置状态（用户口径 2026-10-13）—— 同样是**整格精确相等**。
 *
 * ⚠️ 与 G8 那三个已处置状态是**另一批**取值，但**同一把尺子**（比较前只去首尾空白、
 * 不做全半角 / 括号归一）：`处置中（人工）` 这种带后缀的不算，`处置中` 前后带空白的算。
 * 平台的占位符 `-` 与空格子**不是**这个值，一行都不进本格。
 */
const IN_PROGRESS_EVENT_STATUS = '处置中';

/**
 * G107「待处置事件数」认的处置状态（用户口径 2026-10-13）—— 与上面那条同一把尺子。
 *
 * 实测事件表「处置状态」这一列是**单值枚举**（华能集团样本 2347 行里只出现
 * `待处置` / `处置中` / `已遏制` / `处置完成` 四种），所以三个状态格
 * （G8 / G106 / G107）互斥、加起来就是全表里"有处置状态"的那些行。
 * 但本文件**不**按那个恒等式写代码（不做"总数减去另外两格"）：每格只认自己那一个值，
 * 平台哪天多出一个状态，三格各数各的、谁都不会被悄悄带偏。
 */
const PENDING_EVENT_STATUS = '待处置';

/**
 * 事件表里「处置状态」**整格精确等于**给定状态的行数 —— G106 / G107 共用的那一次计数（H4）。
 *
 * 只差一个待匹配的状态值（G106 传「处置中」、G107 传「待处置」），过滤条件一模一样，
 * 所以只写这一份；与 G17/G18 共用 assetCountByPrimaryType 是同一个形状。
 *
 * 计数口径：**按行计数，一行一票**，不去重、不按事件名称 / 事件 ID / 影响资产合并 ——
 * 同一台机器上有几条这样的事件就是几条。数的是**整张事件表**、不经 --business-systems 圈定；
 * 也不按报告期过滤（事件表导出时已按 --start/--end 圈定，见 disposedEventCount 的说明）。
 *
 * ⚠️ 判据是「整格精确相等」，所以**空值 / 平台占位符 `-` / 带后缀的值一行都不算**：
 * 那两格问的是"有几条事件正处在处置中 / 待处置"，不是"有几条事件没写处置状态"。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} status 待匹配的处置状态（传本文件的 IN_PROGRESS_EVENT_STATUS /
 *   PENDING_EVENT_STATUS 两个常量，别在 cells/ 里手打字符串）
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} status 不是非空字符串时（空串会命中所有"处置状态为空"的行，
 *   那是静默错数，必须当场炸）；或事件表有行、却读不出「处置状态」列
 *   （平台改了列名，禁止静默数出 0）
 */
function eventCountByDisposition(ctx, status) {
  if (typeof status !== 'string' || status.trim() === '') {
    throw new Error(`eventCountByDisposition 的状态值必须是非空字符串，收到: ${JSON.stringify(status)}`);
  }

  const rows = ctx && ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, DISPOSITION_COLUMN, '事件表');

  let count = 0;
  for (const row of rows) {
    if (cellText(row[DISPOSITION_COLUMN]) === status) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 时长列的非空均值 —— 本文件里"取均值"这件事只写一遍（H4）
// ---------------------------------------------------------------------------

/**
 * 一组行上、给定时长列的**非空均值**（分钟）—— 本文件里"取非空均值"这件事的唯一实现（H4）。
 *
 * 三个读者共用它：G9「事件平均响应时长」、D35「平均分析时间」、D36「平均响应时间」
 * （还有 G7「威胁平均遏制时间」—— 它也是同一段加法）。
 * 从前这段循环在这几格各自的函数里抄了三份，改口径要改三处，正是 H4 要消灭的状态。
 *
 * 只对**时长非空**的行做平均，空的行**不进分母**（用户口径：「对所有非空的值计算平均值」）。
 * 时长本身**不在本文件里算**：四列都是表格预处理（`scripts/report_preprocess.py`）按两个时间源列
 * 相减写进下载件的列（分钟、2 位小数）。**负差值在那一步就被判为不合法、留空**
 * （用户口径 2026-10-12：时长不可能为负），所以这里见不到负数；负值那几行与「算不出时长」
 * 的行一样退出分母。读表层读到的空格子是 `''`，数字是 JS number（见 parse_table_rows.py 的
 * format_cell_value），所以「非空」的判据就是 `Number.isFinite`。
 *
 * ⚠️ **没有可平均的样本时返回 `null`，不是 0、也不是空串** —— 那是**口径**、
 * 不是算术，由各自的调用方自己翻译。本文件的调用方（G7 / G9 / D35 / D36 / E49 /
 * G51:G55）**现在都翻成 0** —— 但**仍然由调用方翻**、内核里不写死默认值：从前 G7 翻的是
 * 空串，那条口径 2026-10-14 才被用户改成 0（见 averageContainedMinutes 的头注）。
 * 内核里挑一个当默认，就等于把某一条口径偷偷焊进另外几条 —— 哪天再有格子要别的落法，
 * 这里仍然是那个能分开的地方。
 *
 * 均值**不再舍入**（用户口径）：逐行已是那一列的 2 位小数，直接相加再除，
 * 才和在 Excel 里对那一列拉一个 `=AVERAGE` 对得上（再舍一次反而会差一个尾数）。
 *
 * @param {Array<Object>} rows 已经选好的行（本函数不再筛任何列）
 * @param {string} column 时长列的表头文字（本文件的 *_DURATION_COLUMN 常量之一）
 * @returns {number|null} 平均值（分钟）；没有一行带得出非空时长时是 null
 */
function meanFiniteMinutes(rows, column) {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const minutes = row[column];
    if (!Number.isFinite(minutes)) continue;
    sum += minutes;
    count += 1;
  }
  return count === 0 ? null : sum / count;
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
 * ⚠️ 那批"推送了但还没处置"的行**是** D36 / E49 的候选行（见 averagePushedDurationMinutes）——
 * 两格差的就是处置状态这一道筛，所以**本格与 D36 不是同一个值、不能互相 alias**：
 * 用户口径 2026-10-13 给 G9 的是「已处置事件里已推送的那部分」，给 D36 的是
 * 「已推送的事件」那一批，两句话不同。
 *
 * 平均那一步走 meanFiniteMinutes（与 D35/D36/E49 同一段加法），空的行**不进分母**
 * （用户口径：「对所有非空的值计算平均值」）。
 *
 * 空 / 缺数的口径：
 *   · 没有可平均的样本 -> 写 **0**（用户口径原话：「没有就写0」）。这包括三种情形：
 *     事件表为空（0 行）、G8 一行都没选出、选出的行里没有一行的推送状态是「已推送」、
 *     推送命中的行其响应时长全为空。
 *   · 上面这些都**不记错误**（那是结论，不是缺数）。0 在这里是有含义的：没有推送就没有
 *     响应时长可言。本格与 G7 从前**落法不同**（G7 写空串），但 G7 那条口径已于
 *     2026-10-14 被用户改成 0 —— 现在全仓时长均值格一条落法，本格不再特殊。
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

  const pushed = disposed.filter(
    (row) => cellText(row[PUSH_STATUS_COLUMN]) === PUSHED_STATUS
  );
  const mean = meanFiniteMinutes(pushed, RESPONSE_DURATION_COLUMN);
  return mean === null ? 0 : mean;
}

// ---------------------------------------------------------------------------
// D35「平均分析时间」/ D36「平均响应时间」/ E49「事件平均处置时长」：
// 已推送事件里，那一列时长的非空均值
// ---------------------------------------------------------------------------

/**
 * 事件表里「推送状态」**整格精确等于**「已推送」的行 —— D35 / D36 / E49 共用的那一次选行（H4）。
 *
 * 判据与 G9 里那道筛**逐字相同**（同一个 PUSHED_STATUS 常量、同一把尺子：
 * 比较前只去首尾空白、整格精确相等）—— 所以那段判断写在下面这个函数里，
 * G9 那边也读的是同一个常量。两格的差别**不在这一列上**，而在要不要处置状态（见下一段）。
 *
 * ⚠️ 与 disposedEventRows 不是一回事：那一批是"已处置的"，本批是"推送了的"。
 * 两批**互相不包含**：处置了但没推送的行只在 G8 那边，推送了但还在待处置的行只在本批。
 * 唯一重合的是「既已处置、又已推送」那一小批 —— 那是 G9 的候选行。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {Array<Object>} 命中的行对象（顺序 = 表内原序）；事件表为空（0 行）时是空数组
 * @throws {Error} 事件表有行、但表头里没有任何一行带「推送状态」列（列名对不上，不许静默数出 0）
 */
function pushedEventRows(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  requireColumn(rows, PUSH_STATUS_COLUMN, '事件表');

  return rows.filter((row) => cellText(row[PUSH_STATUS_COLUMN]) === PUSHED_STATUS);
}

/**
 * D35「平均分析时间」/ D36「平均响应时间」/ E49「事件平均处置时长」：事件表里
 * 「推送状态」**整格精确等于**「已推送」的行，其给定那一列（D35 传「识别时长」、
 * D36 传「响应时长」、E49 传「处置时长」）的**非空均值**（单位：分钟）。
 *
 * 用户口径 2026-10-13：「D35 是平均分析时间，取值是精确查找『推送状态』列，如果值精确匹配
 * 『已推送』，算命中。然后精确查找这些事件的『识别时长』列，算出所有非空的识别时长的平均值。
 * D36 是平均响应时间同理，算的是『响应时长』列」；「E49 是事件平均处置时长，精确查找
 * 『推送状态』列，如果值精确匹配『已推送』，算命中。然后精确查找这些事件的『处置时长』列，
 * 算出所有非空的处置时长的平均值」。三格只差一个时长列，所以**共用本函数**
 * （H4）—— 与 G17/G18 共用 assetCountByPrimaryType 是同一个形状，时长列由 cells/ 那边
 * 传常量进来，不在这里硬编码。
 *
 * ⚠️ 选行**只看「推送状态」这一列**，一道处置状态的筛都没有 —— 所以本组与 G9
 * （「已处置」那批之上再筛已推送）**不是同一个值，不能走 alias（H5）**：
 * "推送了但还没处置"的事件在 D36/E49 里算、在 G9 里不算。同一个 fixture 上两组算出不同的数，
 * 验收（【22】【23】）专门钉了这一条。
 * ⚠️ D49「事件平均响应时间」与 D36 同值（用户口径「复用D36」），但它**不走本函数** ——
 * 它是一条 alias 记录（H5），一个字都不重算。
 *
 * 平均那一步走 meanFiniteMinutes（与 G7/G9 同一段加法）；时长列为空的行**不进分母**。
 * 那三个时长列都**不是平台导出的**：由表格预处理按两个时间源列相减追加进下载件
 * （「识别时长」= 事件创建时间 − 组件检出时间；「响应时长」= 专家研判时间 − 组件检出时间；
 * 「处置时长」= 事件闭环时间 − 事件创建时间），本格只读不算。它们**逐列独立**：
 * 某一列缺席只让读它的那一格落空 —— 比如「事件创建时间」没给时 D35 与 E49 报缺列、
 * D36 照常落值（「识别时长」与「处置时长」共用这个被减数，所以那两格同步停，
 * 用户口径 2026-10-12）。
 *
 * 空 / 缺数的口径（与 G9 同一条，用户口径 2026-10-13「没有就写0」）：
 *   · 没有可平均的样本 -> 写 **0**，不记错误。三种情形同 G9：事件表为空（0 行）、
 *     一行「已推送」都没有（全是 `未推送` / 空 / 带后缀的 `已推送（XX）`）、
 *     命中的行其那一列时长全为空。
 *   · 只有**缺列**才不写值 + 记错误，按顺序查两列：先「推送状态」（选行是第一步），
 *     再那一个时长列（缺它就等于预处理那一步没算出这一列）。
 *
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} durationColumn 时长列的表头文字（传本文件的 RECOGNIZE_DURATION_COLUMN /
 *   RESPONSE_DURATION_COLUMN / DISPOSAL_DURATION_COLUMN，别在 cells/ 里手打字符串）
 * @returns {number} 平均值（分钟）；没有可平均的样本时是 0
 * @throws {Error} durationColumn 不是非空字符串（空列名会让 requireColumn 报一个看不出所以然的错）；
 *   或事件表有行数据、但缺「推送状态」/ 该时长列之一
 */
function averagePushedDurationMinutes(ctx, durationColumn) {
  if (typeof durationColumn !== 'string' || durationColumn.trim() === '') {
    throw new Error(`averagePushedDurationMinutes 的时长列名必须是非空字符串，收到: ${JSON.stringify(durationColumn)}`);
  }

  const rows = ctx && ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 两列的存在性检查顺序 = 实际计算顺序：先按「推送状态」选行，再读那一个时长列。
  // 两列都缺时报出来的是「推送状态」—— 与 G9 那边"选行是第一步"是同一条安排。
  const pushed = pushedEventRows(ctx);
  requireColumn(rows, durationColumn, '事件表');

  const mean = meanFiniteMinutes(pushed, durationColumn);
  return mean === null ? 0 : mean;
}

// ---------------------------------------------------------------------------
// G51:G55「平均时长五连」：整张事件表里，那一列时长的非空均值
// ---------------------------------------------------------------------------

/**
 * G51「平均识别时长」/ G52「平均响应时长」/ G53「平均遏制时长」/ G54「平均处置时长」/
 * G55「平均闭环时长」：**整张事件表**里，给定那一列时长的**非空均值**（单位：分钟）。
 *
 * 用户口径 2026-10-13，**第二版**（推翻了当天早些时候那一版）：这五格的时长
 * **不与「推送状态」挂钩**。早先按「推送状态」整格精确等于「已推送」选行算过一版，
 * 用户随后明确「这五个单元格的时间，不用跟推送状态挂钩」——于是改成**一道筛都没有**：
 * 事件表里每一行都是候选行，只由时长列本身有没有值决定进不进分母。
 *
 * ⚠️ 这一改让五格与 D35 / D36 / E49 **彻底分家**：那三格仍然按「已推送」选行。
 * 所以五格**各有各的 compute，一格都不能再 alias 到那三个主地址**（也正因为如此，
 * 从前那四条 alias 已经全部撤掉）—— 同一份事件表上两组的数不一样，
 * 验收【26】把这条分界单独钉了一遍。
 *
 * ⚠️ G54 与 G55 在**任何**输入上都同值（「处置时长」与「闭环时长」在
 * scripts/report_preprocess.py 里同式同源，都是「事件闭环时间」−「事件创建时间」，
 * 逐行恒等），但两格是**两条各自独立的 compute**、**刻意不互为 alias**：
 * 它们读的是两个不同的列（本函数由 cells/ 传列名进来），今天的相等是"两列恰好同式"
 * 这个事实、不是"一格复用了另一格"。这与 D32/D33、D38/G101 那两对是同一条安排；
 * 哪天预处理把其中一列的算式改掉，两格各自跟着自己那一列走、不用改接线。
 *
 * 平均那一步走 meanFiniteMinutes（与 G7/G9/D35 同一段加法），时长为空的行**不进分母**。
 * 这五个时长列都**不是平台导出的**：由表格预处理按两个时间源列相减追加进下载件
 * （「识别时长」= 事件创建时间 − 组件检出时间；「响应时长」= 专家研判时间 − 组件检出时间；
 * 「遏制时长」= 事件遏制时间 − 专家研判时间；「处置时长」= 事件闭环时间 − 事件创建时间；
 * 「闭环时长」= 事件闭环时间 − 事件创建时间），本组只读不算。它们**逐列独立**：
 * 某一列缺席只让读它的那一格落空 —— 比如「事件创建时间」没给时 G51 / G54 / G55 三格
 * 报缺列、G52 / G53 照常落值（用户口径 2026-10-12）。
 *
 * 空 / 缺数的口径（沿用本组 2026-10-13 那一版，用户口径「没有就写0」）：
 *   · 没有可平均的样本 -> 写 **0**，不记错误。两种情形：事件表为空（0 行）、
 *     有行但那一列时长整列为空 / 全是占位符。
 *   · 只有**缺列**才不写值 + 记错误（缺预处理追加的那一个时长列 ——
 *     等于预处理那一步没算出这一列）。
 *
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} durationColumn 时长列的表头文字（传本文件的 RECOGNIZE_DURATION_COLUMN /
 *   RESPONSE_DURATION_COLUMN / CONTAINED_DURATION_COLUMN / DISPOSAL_DURATION_COLUMN /
 *   CLOSURE_DURATION_COLUMN，别在 cells/ 里手打字符串）
 * @returns {number} 平均值（分钟）；没有可平均的样本时是 0
 * @throws {Error} durationColumn 不是非空字符串（空列名会让 requireColumn 报一个看不出所以然的错）；
 *   或事件表有行数据、但缺该时长列
 */
function averageEventDurationMinutes(ctx, durationColumn) {
  if (typeof durationColumn !== 'string' || durationColumn.trim() === '') {
    throw new Error(`averageEventDurationMinutes 的时长列名必须是非空字符串，收到: ${JSON.stringify(durationColumn)}`);
  }

  const rows = ctx && ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 只有一列要查：本组不选行，时长列既是"读什么"也是"缺什么才报错"。
  requireColumn(rows, durationColumn, '事件表');

  const mean = meanFiniteMinutes(rows, durationColumn);
  return mean === null ? 0 : mean;
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
 * @param {Set<string>} [ips] 已归一的 IP 集合；给了就只留「影响资产」落在里面的行
 *   （C18/D18/E18 用 —— D16 的第二段要跟着核心系统的 IP 圈定走）。
 *   不给（undefined / null）时行为与从前逐字相同：D16 数全表、不看 IP。
 * @returns {number} 行数；事件表为空（0 行）时是 0 —— 那是结论，不是缺数
 * @throws {Error} 事件表有行数据、但没有任何一行带「安全事件二级分类」或
 *   「处置状态」列（平台改了列名）；给了 ips 时还要求有「影响资产」列
 */
function disposedWeakPwdEventCount(ctx, ips) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, CATEGORY_COLUMN, '事件表');
  requireColumn(rows, DISPOSITION_COLUMN, '事件表');
  // 先按 IP 圈行（eventRowsOnIps 里含「影响资产」列的存在性检查），再走同一套判据 ——
  // 与 D7:D9 / G10 / G14 的「先圈 IP 再筛」顺序一致。
  const candidates = ips ? eventRowsOnIps(ctx, ips) : rows;

  let count = 0;
  for (const row of candidates) {
    if (!cellText(row[CATEGORY_COLUMN]).includes(WEAKPWD_CATEGORY_KEYWORD)) continue;
    if (cellText(row[DISPOSITION_COLUMN]) === DISPOSED_EVENT_STATUS) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// F49「事件闭环率」：事件表里「处置完成」的行数 ÷ 事件表总行数
// ---------------------------------------------------------------------------

/**
 * F49「事件闭环率」分子认的处置状态（用户口径 2026-10-13：「精确查找事件表的
 * 『处置状态』列的值是『处置完成』的事件总数，除 C49 的值」—— 整格精确相等，不是包含）。
 *
 * 与 G8 三个状态里的「处置完成」、与 D16 第二段的 DISPOSED_EVENT_STATUS 是同一个字符串，
 * 但三格的口径来源不同（G8 一次认三个状态、本格只认这一个、D16 第二段还额外要求
 * 「安全事件二级分类」含「弱口令」），所以各写各的常量、不互相引用 ——
 * 哪天其中一个口径改了，不至于把另几格悄悄带跑。
 *
 * ⚠️ 别拿它去比「已处置」：实测事件表这一列只有 `待处置` / `处置中` / `已遏制` /
 * `处置完成` 四种取值（见 DISPOSED_EVENT_STATUSES 上面那条取证），「已处置」不是
 * 平台会写出口的词；验收里专有一行反例钉这件事（G8 那一段与 F49 那一段各一次）。
 */
const CLOSED_EVENT_STATUS = '处置完成';

/**
 * 事件表**一行都没有**时 F49 落的那句话（用户口径 2026-10-13）。
 *
 * 分母（= 事件表总行数，C49 -> D38）为 0 时闭环率**不是 0%**：写 0 会被读成
 * 「有事件、但一条都没闭环」—— 那是个假结论，和 G7「没有可平均的样本」不写 0
 * 是同一条思路。这句是**字面量**，由写层原样落格。
 */
const NO_EVENT_CLOSURE_RATE_TEXT = '无事件，所以无闭环率';

/**
 * F49「事件闭环率」：事件表里「处置状态」**整格精确等于**「处置完成」的**行数**，
 * 除以 C49 的值。
 *
 * C49 = alias 指向 D38「威胁和事件数量」= **事件表总行数**（D38 与 G101「xdr事件数」
 * 口径逐字相同，它自己有一条 compute，刻意不复用 G101）—— 所以分母就是
 * eventRowCount(ctx)，与 C49 读的是同一个量，这里不另数一遍（H4）。
 *
 * 分子口径：按行计数、一行一票，不去重、不按事件名称 / 事件 ID / 影响资产合并；
 * 判据是**整格精确相等**（比较前只去首尾空白）：`处置完成` 算，带括号的
 * `处置完成（已修复）` 不算，`已处置` / `已遏制` / `已忽略` / `处置中` / `待处置`
 * 与空值、占位符 `-` 都不算 —— 本格只认「处置完成」这一个状态值（用户口径）。
 * 数的是**整张事件表**、不经 --business-systems 圈定；也不按报告期过滤
 * （事件表导出时已按 --start/--end 圈定，见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number|string} **小数**（写层按 '0.00%' 落格式），不是 0–100 的数、
 *   也不是字符串「40%」。事件表有行、一条「处置完成」都没有 -> 0（那是结论）；
 *   事件表一行都没有（分母为 0）-> NO_EVENT_CLOSURE_RATE_TEXT 那句话
 * @throws {Error} 事件表有行、却读不出「处置状态」列（平台改了列名，禁止静默算出 0）
 */
function eventClosureRate(ctx) {
  const total = eventRowCount(ctx);
  // 分母为 0 先判：空表本来也没有「处置状态」列可查（C5），别让 requireColumn 先炸。
  if (total === 0) return NO_EVENT_CLOSURE_RATE_TEXT;

  return eventCountByDisposition(ctx, CLOSED_EVENT_STATUS) / total;
}

// ---------------------------------------------------------------------------
// G7「威胁平均遏制时间」：命中「真实攻击未成功」的事件，其遏制时长的非空均值
// ---------------------------------------------------------------------------

/**
 * G7「威胁平均遏制时间」：事件表里「GPT研判结论」**整格精确等于**「真实攻击未成功」的行，
 * 其「遏制时长」**非空值的平均**（单位：分钟）。
 *
 * 选行判据与 G5/G6/H6/I6 是同一句（同一个常量 `GPT_VERDICT_HIT`），只是读的是**事件表**；
 * 平均那一步走 meanFiniteMinutes（与 G9 / D35 / D36 同一段加法）—— 空的行**不进分母**
 * （用户口径：「如果有不是空值，就计算所有非空的平均值」）。
 *
 * 遏制时长本身**不在本文件里算**：它是表格预处理（`scripts/report_preprocess.py`）按
 * 「事件遏制时间 − 专家研判时间」写进下载件的列（分钟、2 位小数）。**负差值在那一步就被
 * 判为不合法、留空**（用户口径 2026-10-12：时长不可能为负，负值说明源列取错了），
 * 所以本格读到的这一列里不会有负数 —— 负值那几行与「空值 / 解析失败」一样退出分母，
 * 只是预处理那边记的是另一个计数。本格只是那一列的读者，同一个口径全仓只有一份实现。
 *
 * 空 / 缺数的口径（⚠️ **2026-10-14 口径反转**，用户原话「写 0，如果 G7 没写 0，也改过来」）：
 *   · 事件表为空（0 行）-> 写 **0**。
 *   · 表里有行、但没有一行命中 / 命中的行遏制时长全空 -> 同样写 0。
 *     这两种都是 meanFiniteMinutes 返回 null 的情形，本格把它翻成 0
 *     （与 G9 / D35 / D36 / E49 / G51:G55 现在是**同一条**落法）。
 *   · 上面的两种都**不记错误**（那是结论，不是缺数）。
 *   · 只有**缺列**才不写值 + 记错误：缺「GPT研判结论」列，或缺预处理追加的「遏制时长」列
 *     （后者意思是预处理那一步没算出时长 —— 平台改了那两个时间源列的名，或这份数据来自
 *     没有它们的旧版导出）。
 *
 * ⚠️ **这条反转推翻了本格从前的做法与理由。** 从前写空串的论据是「0 分钟是一个真实可能的
 * 均值（遏制与研判落在同一分钟），会和『一行都没有可平均的样本』混成一个数」—— 那个事实
 * **仍然成立**，用户是**明确接受这个取舍**才改成 0 的（全仓时长均值格从此一个落法，不再有
 * 一个与众不同的例外）。所以这不是"论证错了"，是口径改了 —— 别再照旧注释或从前的文档
 * 把「G7 写空串」当既有事实引用。
 *
 * 不按报告期过滤：事件表导出时已按 --start/--end 圈定（见 disposedEventCount 的说明）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 平均值（分钟）；没有可平均的样本时是 0
 * @throws {Error} 事件表有行数据、但缺「GPT研判结论」列，或缺「遏制时长」列
 */
function averageContainedMinutes(ctx) {
  const rows = ctx.eventRows;
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  // 先查选行那一列，再查时长列 —— 顺序有讲究：两个都缺时（旧版 25 列导出就是
  // 两边都没有），报出来的应该是「GPT研判结论」这一条（选行是第一步，
  // 与 G5 同一个错误现场）。验收【1】/【3】/【6】/【7】/【8】的期望错误集合依赖这个顺序。
  requireColumn(rows, GPT_VERDICT_COLUMN, '事件表');
  requireColumn(rows, CONTAINED_DURATION_COLUMN, '事件表');

  const hit = rows.filter((row) => cellText(row[GPT_VERDICT_COLUMN]) === GPT_VERDICT_HIT);
  const mean = meanFiniteMinutes(hit, CONTAINED_DURATION_COLUMN);
  return mean === null ? 0 : mean;
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

// ---------------------------------------------------------------------------
// 事件类型 TOP5（C51:C55 名称 / D51:D55 数量）
// ---------------------------------------------------------------------------

/**
 * 「安全事件二级分类」的频次排行 —— C51:C55 与 D51:D55 两列共用的那个量（H4）。
 *
 * 用户口径 2026-10-13：「C 列是精确查找事件表『安全事件二级分类』列，统计每个非空值的
 * 分类出现的次数，按照大到小排列，从 C51 到 C55 填这个分类的类别，最多取 5 个，
 * 有几个取几个。一个都没有为空。D51:D55 就是对应的类型的次数。」
 *
 * 与「GPT定性标签」的排行（gptRanking）是**同一套算法、换一列**：排序、计数、缺值、
 * 缺列防线的口径一律见 stats/metrics/ranking.js 的头注（H4），本函数只负责把列名
 * 与数据源指过去。所以两处共用同一个 buildRanking，第 1 名的判定、
 * 「占位符 `-` 不算一类」这条尺度都只有一份实现。
 *
 * ⚠️ 与 D11 / D16 读的是**同一列**、但取的是完全不同的量：那两格按「二级分类**包含**
 * 弱口令 / 弱密码 / 账号安全」（子串判定）数行数，本函数是**整格取值 + 频次排行**
 * （`Telnet弱口令` 与 `Web弱口令` 是**两个**不同的分类各占一项，不会被并成一类）。
 * 同一份事件表上两处的数一般不等。
 *
 * @returns {{items: Array<{label: string, count: number}>, total: number}}
 *   事件表为空、或所有行的分类都为空 / 都是占位符时 items 为空、total 为 0
 *   —— 没有分类就是没有分类，5 个名次槽位跟着写空串，不记错误
 * @throws 事件表有数据、但没有任何一行带「安全事件二级分类」这一列时抛错（猜错列名的防线）。
 */
function categoryRanking(ctx) {
  return buildRanking(ctx && ctx.eventRows, CATEGORY_COLUMN, '事件表');
}

/** 排行第 rank 名（从 0 起）的分类名称；名次不存在（含事件表为空）时空串。 */
function categoryLabelAt(ctx, rank) {
  return labelAt(categoryRanking(ctx), rank);
}

/** 排行第 rank 名（从 0 起）的出现行数；名次不存在（含事件表为空）时空串。 */
function categoryCountAt(ctx, rank) {
  return countAt(categoryRanking(ctx), rank);
}

// ---------------------------------------------------------------------------
// C58:N59「按月平均响应时长」：报告期切月份桶，逐月取响应时长的非空均值
// ---------------------------------------------------------------------------

/** C58:N59 的槽位数 —— 与 stats/periods.js 的 MAX_MONTHS 是同一个 12（月份桶由它截断）。 */
const MONTH_SLOT_COUNT = MAX_MONTHS;

/**
 * 报告期切出的月份桶 + 逐月的响应时长均值 —— C58:N59 那 24 格共用的那个量（H4）。
 *
 * 用户口径 2026-10-14：「C58:N59 是按传入时间起止划分月份，然后统计事件表『事件创建时间』列，
 * 如果在对应的月份，就统计他的『响应时长』列的非空平均值」—— 58 行是月份标签、59 行是均值。
 *
 * 三步：
 *   ① 月份桶 = `monthRange(ctx.range.start, ctx.range.end)`：**连续**、含首尾月、
 *      超过 12 个月取最晚的 12 个（都是用户口径）。桶只由报告期决定，与表里有没有那个月无关。
 *   ② 分桶 = 把每一行按预处理追加的「事件创建月份」列**整格字符串相等**丢进对应的桶。
 *      读取层已经把那一列读成 `'2026-07'` 形态的字符串（`parse_table_rows.py` 的
 *      `format_cell_value` 对文本原样透传），所以这里只做字符串比较、**不再解析日期**。
 *      空值 / 认不出的月份 / 落在报告期之外的月份**不落进任何桶**（用户口径：「『事件创建时间』
 *      不可能为空」——真为空时它自然落不进桶，不是把它算进某个月）。
 *   ③ 逐月求均值 = 复用 `meanFiniteMinutes`（与 G7/G9/D35/D36/E49/G51:G55 同一段加法，
 *      H4），空的行不进分母；**没有可平均的样本时写 0**（用户口径 2026-10-14「写 0」，
 *      与全仓时长均值格同一条落法）。
 *
 * ⚠️ **槽位超出报告期时是空串**（用户口径：「报告期不足 12 个月时，标签和值都留空」）——
 * 那与「落在范围内、但那个月没有样本」（写 0）是**两件事**：前者是"这个槽位根本没有对应的月份"，
 * 后者是"有月份、那个月没数"。本函数用**两个等长数组**表达这件事：`labels[i]` 为空串
 * ⇔ `means[i]` 也一定是空串，取值层两侧都用同一套越界判据（见 monthLabelAt / monthMeanAt）。
 *
 * ⚠️ 不按报告期**二次过滤行**：事件表导出时已按 --start/--end 圈定（与全表其它格同一条
 * 既有约定）。落在范围内的那些月份就是全部候选，分桶这一步本身不吃掉任何一行。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {{labels: string[], means: (number|'')[]}} 两个等长数组，长度 1..12，
 *   按时间升序；越界槽位两边都是 `''`，范围内无样本的槽位 `means` 是 `0`
 * @throws {Error} 事件表有行数据、却读不出「事件创建月份」或「响应时长」列
 *   （平台改了列名，或预处理那一步没算出月份 / 时长 —— 缺列不静默，R10）。
 *   事件表 0 行时**不抛**：每个在范围内的月份都是"没有样本"，一律写 0
 */
function buildMonthSeries(ctx) {
  const labels = monthRange(ctx.range.start, ctx.range.end);
  const rows = ctx.eventRows;

  if (!Array.isArray(rows) || rows.length === 0) {
    // 空表不是缺数：报告期里那几个月确实一条事件都没有，逐个写 0
    return { labels, means: labels.map(() => 0) };
  }

  requireColumn(rows, CREATE_MONTH_COLUMN, '事件表');
  requireColumn(rows, RESPONSE_DURATION_COLUMN, '事件表');

  const buckets = new Map(labels.map((label) => [label, []]));
  for (const row of rows) {
    const bucket = buckets.get(cellText(row[CREATE_MONTH_COLUMN]));
    // 空值 / 认不出的月份 / 报告期之外的月份：落不进任何桶，直接跳过
    if (bucket) bucket.push(row);
  }

  return {
    labels,
    means: labels.map((label) => {
      const mean = meanFiniteMinutes(buckets.get(label), RESPONSE_DURATION_COLUMN);
      return mean === null ? 0 : mean;
    })
  };
}

/**
 * 第 index 个槽位（从 0 起）的月份标签；槽位越界（报告期不足 12 个月时空出来的那几格）
 * 时是**空串** —— 那个槽位没有对应的月份，不是取不到数。与 `labelAt` 同一形状。
 */
function monthLabelAt(series, index) {
  const label = series.labels[index];
  return label === undefined ? '' : label;
}

/**
 * 第 index 个槽位（从 0 起）的平均响应时长（分钟）；槽位越界时空串（与标签同步，
 * 见 buildMonthSeries 的说明）。周期内那个月没有样本时是 0，**不是**空串。
 */
function monthMeanAt(series, index) {
  const mean = series.means[index];
  return mean === undefined ? '' : mean;
}

module.exports = {
  IMPACT_ASSET_COLUMN,
  CATEGORY_COLUMN,
  ACCOUNT_RISK_KEYWORDS,
  eventRowCount,
  gptVerdictEventCount,
  eventRowsOnIps,
  accountRiskEventCount,
  accountRiskEventRows,
  accountRiskEventAssetIps,
  eventCountOnIps,
  threatEventCountOnIps,
  GPT_LABEL_COLUMN,
  DISPOSITION_COLUMN,
  DISPOSED_EVENT_STATUSES,
  EVENT_TABLE_COLUMNS,
  CREATED_TIME_COLUMN,
  disposedEventRows,
  disposedEventCount,
  IN_PROGRESS_EVENT_STATUS,
  PENDING_EVENT_STATUS,
  eventCountByDisposition,
  WEAKPWD_CATEGORY_KEYWORD,
  DISPOSED_EVENT_STATUS,
  disposedWeakPwdEventCount,
  CLOSED_EVENT_STATUS,
  NO_EVENT_CLOSURE_RATE_TEXT,
  eventClosureRate,
  CONTAINED_DURATION_COLUMN,
  averageContainedMinutes,
  meanFiniteMinutes,
  PUSH_STATUS_COLUMN,
  PUSHED_STATUS,
  RESPONSE_DURATION_COLUMN,
  averageResponseMinutes,
  RECOGNIZE_DURATION_COLUMN,
  DISPOSAL_DURATION_COLUMN,
  CLOSURE_DURATION_COLUMN,
  pushedEventRows,
  averagePushedDurationMinutes,
  averageEventDurationMinutes,
  gptRanking,
  gptLabelAt,
  gptCountAt,
  gptShareAt,
  categoryRanking,
  categoryLabelAt,
  categoryCountAt,
  CREATE_MONTH_COLUMN,
  MONTH_SLOT_COUNT,
  buildMonthSeries,
  monthLabelAt,
  monthMeanAt
};
