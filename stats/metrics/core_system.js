'use strict';

/**
 * 「核心业务系统」域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 与其他 metrics 文件不同：这一份**不绑定单一份总表**，它把几份串起来 ——
 * 资产表（业务系统 -> IP）→ 漏洞表 / 弱密码表 / 事件表（IP -> 风险数），
 * 以及资产表（业务系统 -> IP）→ 告警表（IP -> 「真实攻击未成功」的行数）。
 * §8 列的域文件是按数据源分的（event / alarm / vuln / weakpwd / asset / …），
 * 跨源的这几个没有现成的家，所以单独放一份，不往任何一个源文件里塞 ——
 * 塞进去就等于让「找一格先按域定位文件」失效。
 *
 * 三格系统名（D3/D4/D5）与三格风险总数（D7/D8/D9）都读同一个 --business-systems，
 * 只有槽位不同；风险总数的算法三格共用一份，正是 H4 说的「被两个及以上地址用到的
 * 派生量必须提到 metrics 并具名导出」。G6/H6/I6（核心系统威胁告警数量）同理：
 * 三格共用 coreSystemThreatAlarmTotalAt，只是槽位不同。
 *
 * 两条「合计」加式也在这里，彼此并行、互不顶替：
 *   · G12 = D7 + D8 + D9 —— coreSystemRiskGrandTotal（「风险总数」那套判据）
 *   · G13 = C18 + D18 + E18 —— coreSystemClosedRiskGrandTotal（D13 的「已闭环」四段）
 *
 * ⭐ --business-systems 是**可选参数**（用户口径 2026-10-12），于是本域只有两条落法：
 *   · 写**系统名本身**的 D3/D4/D5：槽位空着就没东西可写 -> 不写值 + 记错误（coreSystemNameAt）。
 *   · 写**算出来的数**的 D6 合计 / D7:D9 / G6/H6/I6 / G10 / G14：槽位空着那个数就是 0，
 *     不记错误（coreSystemSlotName；G10 与 G14 走 noCoreSystems 提前落 0）。
 *   "一个系统都没传"只是"三个槽位同时空着"的那一档，不另立一条口径。
 *
 * G10「核心系统事件数量」也住在这里：它同样从「系统名 -> 资产表 -> IP」起手，
 * 只是把**全部传入系统**的 IP 并成一个集合（不按槽位分），再去事件表数行
 * —— 与 D7/D8/D9 的事件那一段（逐系统 + 分类关键词）刻意不同，见 coreSystemsEventCount。
 *
 * G14「核心系统威胁事件总数」也在这里，它**就在 G10 那一步之上**：
 * 同一个 IP 并集、同一份事件表，只多一道「GPT研判结论」精确等于「真实攻击未成功」的筛
 * （用户口径 2026-10-12）—— 两格的关系是"G14 是 G10 的子集"，不是两条各算各的口径，
 * 所以它们**共用 coreSystemsIpsUnion**，本文件一个字都不重算（H4）。
 */

const { assetIpsOfBusinessSystem } = require('./asset');
const { closedRiskTotalOnIps } = require('./closed_risk');
const { exploitableVulnCount } = require('./vuln');
const { weakPwdRiskCount } = require('./weakpwd');
const { accountRiskEventCount, eventCountOnIps, threatEventCountOnIps } = require('./event');
const { gptVerdictAlarmCountOnIps } = require('./alarm');

/**
 * 模板里只有三个核心系统槽位（D3/D4/D5 系统名、D7/D8/D9 风险总数），
 * 对应 PPT 的 core_system_1/2/3。第三个之外的名字没有地方放。
 */
const MAX_CORE_SYSTEMS = 3;

/** CLI 参数名，报错文案里要用（与 pipeline.js 的 --business-systems 逐字一致）。 */
const BUSINESS_SYSTEMS_OPTION = '--business-systems';

/**
 * 本次运行传入的核心业务系统名（按 CLI 顺序）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {string[]}
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个时 —— 多的名字无处可放，**静默丢掉**
 *   会让报告与用户传的东西对不上（pipeline 那条路上的 pptgen 也会就同一件事报参数错）
 */
function coreSystemNames(ctx) {
  const names = Array.isArray(ctx.businessSystems) ? ctx.businessSystems : [];
  if (names.length > MAX_CORE_SYSTEMS) {
    throw new Error(
      `${BUSINESS_SYSTEMS_OPTION} 最多 ${MAX_CORE_SYSTEMS} 个（模板里只有核心系统1/2/3 三个槽位），`
      + `收到 ${names.length} 个`
    );
  }
  return names;
}

/**
 * 第 rank 个（从 0 起）槽位上的核心业务系统名；**这个槽位没传时返回 undefined，不抛**。
 *
 * 与 coreSystemNameAt 只差"没传"那一下，而这一下正是两条口径的分界：
 *   · D3/D4/D5 写的就是这个名字本身 -> 没名字就没东西可写（coreSystemNameAt，抛）。
 *   · D6:D9 / G6/H6/I6 / G10 写的是**算出来的数** -> 槽位空着就没有可数的范围，
 *     那个数就是 0（用户口径 2026-10-12：--business-systems 本来就是可选参数，
 *     "这次没有第 2 个系统"="第 2 个系统的风险数是 0"，不是"取不到数"）。
 */
function coreSystemSlotName(ctx, rank) {
  return coreSystemNames(ctx)[rank] || undefined;
}

/**
 * 第 rank 个（从 0 起）核心业务系统名 —— D3/D4/D5 各取一个槽位。
 *
 * 不参与统计，CLI 传什么就是什么（与 J1 客户名同一类：报告参数直传）。
 *
 * @returns {string}
 * @throws {Error} 这个槽位没传（只传了一个/两个系统、或一个都没传）时抛错，
 *   **本格不写值、模板原样保留**。刻意不与「传了名但算不出数」混为一谈：
 *   这里连系统名都没有，没有任何东西可填，留空是唯一说得通的落法
 *   （填 0 会被读成「这个系统的名字叫 0」）。
 *   注意：同一次跑里，**算出来的**格子（D6:D9 / G6/H6/I6 / G10）在槽位空着时
 *   一律写 0，不跟着抛 —— 见 coreSystemSlotName 与 noCoreSystems。
 */
function coreSystemNameAt(ctx, rank) {
  const name = coreSystemSlotName(ctx, rank);
  if (!name) {
    const count = coreSystemNames(ctx).length;
    throw new Error(
      `${BUSINESS_SYSTEMS_OPTION} 只给了 ${count} 个系统，没有第 ${rank + 1} 个：`
      + '本格不写值、模板原样保留（本格写的是系统名本身；'
      + 'D6:D9 / G6/H6/I6 / G10 那些算出来的格这时写 0）'
    );
  }
  return name;
}

/**
 * 本次是不是**一个核心业务系统都没传**（用户口径 2026-10-12）。
 *
 * 就是"三个槽位全空"那一种，判据只有一处。凡是**算出来的**格在这个输入下都写 0：
 * D6 合计、D7/D8/D9 风险总数、G6/H6/I6 威胁告警数量、G10 事件数量
 * —— 其实它们的共同口径更宽一点：「**槽位空着就写 0**」，一个都没传只是三个槽位
 * 同时空着的那一档（见 coreSystemSlotName）。本函数是给 G10 用的：它不吃槽位、
 * 吃的是全部系统名的并集，空集要在**打开资产表/事件表之前**就认出来，
 * 这样列名对不上也不会让这一格单独报错 —— 那个答案本来就不需要这些表。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {boolean}
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个（coreSystemNames 抛出）—— 那是另一个口径
 *   （「最多 3 个」），不归这条管
 */
function noCoreSystems(ctx) {
  return coreSystemNames(ctx).length === 0;
}

/**
 * 三段风险各自的来源表与算法。顺序 = 报错时先点谁；label 与 ctx 字段一一对应
 * （vulnRows / weakPwdRows / eventRows），报错文案里直接说人话的那张表名。
 */
const RISK_SEGMENTS = [
  { field: 'vulnRows', label: '漏洞表', count: exploitableVulnCount },
  { field: 'weakPwdRows', label: '弱密码表', count: weakPwdRiskCount },
  { field: 'eventRows', label: '事件表', count: accountRiskEventCount }
];

/**
 * 第 rank 个核心业务系统的风险总数 —— D7/D8/D9 各取一个槽位。
 *
 * 三段相加，互不重叠、不去重（用户口径）：
 *   ① 漏洞风险：该系统 IP 上、威胁标签含「高可利用 / 热点漏洞」的漏洞行数
 *   ② 弱密码风险：该系统 IP 上的弱密码行数
 *   ③ 事件风险：该系统 IP 上、二级分类含「弱口令 / 弱密码 / 账号安全」的事件行数
 *
 * @returns {number} 三段之和。某一份表这次是空的（0 行）时，那一段就是 0，其余段照算
 *   —— 0 是结论，不是缺数（用户口径 2026-10-10：下载一定发生，下不到的表
 *   在 scripts/build_report.py 就被拦下了，流程根本走不到取值层）。
 *   资产表为空时「业务归属 -> IP」得到空集，三段一起是 0（那正是「这些系统名下
 *   一台资产都没有」）。**这个槽位没有系统时本格写 0**（用户口径 2026-10-12：
 *   --business-systems 是可选参数，槽位空着就是 0，见 coreSystemSlotName）。
 * @throws {Error} 列名对不上（表在、但读不出某一列）—— 文案由各段自己给（带表名与列名）：
 *   表在却读不出列，说明平台动了表头，这时按 0 算等于拿一份没读到的数据当没有（R10/C5）。
 *   多于 MAX_CORE_SYSTEMS 个系统时由 coreSystemNames 抛出（那是「最多 3 个」那条口径）。
 */
function coreSystemRiskTotalAt(ctx, rank) {
  const name = coreSystemSlotName(ctx, rank);
  if (!name) return 0;

  const ips = assetIpsOfBusinessSystem(ctx, name);

  let total = 0;
  for (const segment of RISK_SEGMENTS) {
    total += segment.count(ctx, ips);
  }
  return total;
}

/**
 * 第 rank 个核心业务系统的**威胁告警数量** —— G6/H6/I6 各取一个槽位。
 *
 * 两步，与风险总数同一套"资产表是钥匙"的思路，只是第二段读的是告警表：
 *   ① 资产表：「所属业务」整格子串包含该系统名的资产 -> IP 集合（assetIpsOfBusinessSystem）
 *   ② 告警表：该集合的 IP 上、「GPT研判结论」精确等于「真实攻击未成功」的告警行数
 *
 * 「精确等于」与「按行计数」的口径见 stats/metrics/alarm.js 的 GPT_VERDICT_HIT 与
 * countGptVerdictHits（本函数一个字都不重算，H4）。
 *
 * @returns {number} 行数。该系统名下确实没有告警时是 0（0 是结论，不是缺数）；
 *   资产表为空、或该系统名下没有资产时 IP 集合是空集，同样是 0。
 *   **这个槽位没有系统时本格写 0**（用户口径 2026-10-12，见 coreSystemSlotName）。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个系统（coreSystemNames 抛出）；
 *   资产表 / 告警表有行、但读不出要读的列时由 asset.js / alarm.js 抛出
 *   （报的是那张表自己的事，本函数不替它改写文案）。
 */
function coreSystemThreatAlarmTotalAt(ctx, rank) {
  const name = coreSystemSlotName(ctx, rank);
  if (!name) return 0;

  const ips = assetIpsOfBusinessSystem(ctx, name);

  return gptVerdictAlarmCountOnIps(ctx, ips);
}

/**
 * 第 rank 个核心业务系统的**已闭环风险总数** —— C18/D18/E18 各取一个槽位
 * （用户口径 2026-10-22：D13 那四段，各自只数「IP 落在该系统集合里」的行）。
 *
 * 两步，与 D7/D8/D9 同一套「资产表是钥匙」的思路：
 *   ① 资产表：「所属业务」子串包含该系统名 -> IP 集合（assetIpsOfBusinessSystem）
 *   ② D13 的四项加数各自只留 IP 落在集合里的行再相加（closedRiskTotalOnIps）——
 *      四段的判据、表来源、加式一个字都不重写（H4），本格只负责取 IP 集合。
 *
 * ⚠️ 与 D7/D8/D9 的风险总数**不是同一个数**：那三格是「漏洞 × 弱密码 × 事件」三套
 * 判据（D10/D12 那一族），本格是 D13 的「已闭环」四段（D14/D15/D16/D17）。
 * 别拿 coreSystemRiskTotalAt 来顶。
 * ⚠️ 数行数、保留 D14/D15 的重叠、系统之间各算各的（一台资产同属两个系统时
 * 那一行在两个槽位各计一次）—— 三条都是用户口径 2026-10-22 明确过的。
 *
 * @returns {number} 行数。该系统名下一条已闭环风险都没有时是 0（0 是结论，不是缺数）；
 *   资产表为空、或该系统名下没有资产时 IP 集合是空集，同样是 0。
 *   **这个槽位没有系统时本格写 0**（与 D6:D9 / G6/H6/I6 / G10 同一条，
 *   见 coreSystemSlotName）。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个系统（coreSystemNames 抛出）；
 *   资产表读不出「所属业务」/「IP地址」列，或四段里任何一段缺列
 *   （各表自己的文案，本函数不替它们改写）
 */
function coreSystemClosedRiskTotalAt(ctx, rank) {
  const name = coreSystemSlotName(ctx, rank);
  if (!name) return 0;

  return closedRiskTotalOnIps(ctx, assetIpsOfBusinessSystem(ctx, name));
}

/**
 * 几个核心业务系统的**已闭环风险总数合计** —— G13「核心系统闭环风险数」。
 *
 * 就是 C18 + D18 + E18 三格的值相加（用户口径 2026-10-22「取值是 C18 + D18 + E18」），
 * 不另起口径：每个系统的数怎么来的见 coreSystemClosedRiskTotalAt，本函数一个字都不重算
 * （H4：同一个量只算一次）。与 G12（= D7 + D8 + D9）是并行的两条加式 ——
 * 一条加「风险总数」，一条加「已闭环风险总数」，**不是同一个数**。
 * 三个槽位一个不落地加 —— 空着的槽位贡献 0（用户口径 2026-10-12），
 * 于是"只传了 2 个系统"时本格就是那两个数之和；一个都没传时是 0。
 * ⚠️ 三个槽位之间**不去重**：一台资产同属两个系统时，它在两个槽位各计一次，
 * 本格也照样各加一次（与 C18/D18/E18 的口径逐字一致）。
 *
 * @returns {number} 三个槽位已闭环风险总数之和。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个系统时由 coreSystemNames 抛出；
 *   资产表 / 漏洞表 / 弱密码表 / 事件表里有行却读不出要读的列时由
 *   coreSystemClosedRiskTotalAt 抛出，本函数不吞 —— 本格同样不写值。
 */
function coreSystemClosedRiskGrandTotal(ctx) {
  let total = 0;
  for (let rank = 0; rank < MAX_CORE_SYSTEMS; rank += 1) {
    total += coreSystemClosedRiskTotalAt(ctx, rank);
  }
  return total;
}

/**
 * 本次传入的**全部**核心业务系统名下的资产 IP 集合（并集）—— G10 的第一步。
 *
 * 「资产表 -> IP」这一步一个字都不重写（H4）：逐个系统调 assetIpsOfBusinessSystem，
 * 再把结果并成一个集合。同一台机器属于两个系统时（资产表「所属业务」是多段值，
 * 两个系统名的子串都能命中）在这里只留一个 IP —— 这正是「总的 IP 集合」里那个"总"字：
 * 后面的数按**行**计，并集只影响「这一行算不算」，不会把同一行算两遍
 * （与 G6/H6/I6 那种"一行可以同时算进两个系统"的逐系统口径刻意不同）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {Set<string>} 并集（**可能是空集**：资产表 0 行、这些系统名下没有资产、
 *   或这一列整个是空的 —— 三种都按 0 算，不是缺数，见 assetIpsOfBusinessSystem）。
 *   **一个系统都没传时也是空集**（用户口径 2026-10-12：依赖系统名的计算格写 0，
 *   见 noCoreSystems）—— 于是 G10 那格落 0。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个（coreSystemNames 抛出）；
 *   资产表有行、但读不出「所属业务」/「IP地址」列（assetIpsOfBusinessSystem 抛出）
 */
function coreSystemsIpsUnion(ctx) {
  const names = coreSystemNames(ctx);

  const ips = new Set();
  for (const name of names) {
    for (const ip of assetIpsOfBusinessSystem(ctx, name)) ips.add(ip);
  }
  return ips;
}

/**
 * 本次传入的全部核心业务系统名下的事件**行数** —— G10「核心系统事件数量」。
 *
 * 两步，与这一域别的格子同一套「资产表是钥匙」的思路，只是第二段读的是事件表
 * 且**不再加任何筛**：
 *   ① 资产表：各系统名 -> 「所属业务」子串包含 -> IP，**并成一个集合**（coreSystemsIpsUnion）
 *   ② 事件表：「影响资产」**精确**落在该集合里的行数（eventCountOnIps —— 归一后做集合
 *      成员判断，不是子串包含：集合里有 `10.0.0.1` 时 `10.0.0.11` 不算）
 *
 * ⚠️ 与 D7/D8/D9 的「事件风险」那一段**是两回事**，别顺手统一：
 *   · 那段逐个系统各圈各的 IP 集合，本格用**全部传入系统并起来**的一个集合；
 *   · 那段还要「安全事件二级分类」含「弱口令 / 弱密码 / 账号安全」，本格**不看分类** ——
 *     用户口径只有一句「影响资产符合总 IP 集合就加一」，同一条也意味着不看处置状态、
 *     不看事件定性：事件表上落在这些 IP 上的**每一行**都算一条（一台机器上三行就是 3）。
 *
 * @returns {number} 行数。这些系统名下一行事件都没有时是 0（0 是结论，不是缺数）；
 *   资产表为空、或这些系统名下没有资产时集合是空集，同样是 0。
 *   **一个系统都没传时也写 0**（用户口径 2026-10-12，见 noCoreSystems）。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个（coreSystemsIpsUnion 抛出）；
 *   资产表读不出要读的那两列、或事件表读不出「影响资产」列（各表自己的文案，
 *   本函数不替它们改写）
 */
function coreSystemsEventCount(ctx) {
  // 与 D6:D9 / G6/H6/I6 同一条（用户口径 2026-10-12）：没有系统就没有可数的范围，
  // 本格直接落 0，**连事件表都不打开** —— 八格同一个输入就得同一个落法。
  // 这也是为什么这一格不会因为事件表列名对不上而单独报错：那个答案本来就不需要这张表。
  if (noCoreSystems(ctx)) return 0;

  return eventCountOnIps(ctx, coreSystemsIpsUnion(ctx));
}

/**
 * 本次传入的全部核心业务系统名下、**「GPT研判结论」命中「真实攻击未成功」**的事件**行数**
 * —— G14「核心系统威胁事件总数」。
 *
 * 与 G10 是**同起手、多一道筛**的两格（用户口径 2026-10-12：「之前统计的所有核心系统的
 * 集合」—— 就是 G10 用的那个 IP 并集，一个字不重算 ——「然后事件表精确查找『GPT研判结论』
 * 列，精确匹配值是『真实攻击未成功』的行，命中的话再精确查找『影响资产』列的值，
 * 如果命中集合的资产就加 1」）：
 *   ① 资产表：各系统名 -> 「所属业务」子串包含 -> IP，**并成一个集合**（coreSystemsIpsUnion，
 *      与 G10 同一份，H4）
 *   ② 事件表：「影响资产」精确落在该集合里、**且**「GPT研判结论」整格精确等于
 *      「真实攻击未成功」的行数（threatEventCountOnIps —— 判据与 G5/G6/H6/I6/G7 同一句）
 *
 * ⚠️ 两格的关系只能读成一个方向：**G14 的候选行是 G10 那批的子集**（G10 不看研判结论，
 * 落在这些 IP 上的每一行都算）。所以 G14 恒 ≤ G10，同一份数据上两格相等时是巧合、
 * 不是"两格本来就同值"——它们没有 alias 关系，各自的 desc 各写各的，别顺手合并成一格。
 * 也**别**把它当成 G6/H6/I6（那三格读的是**告警表**的「主机IP」、且逐系统各圈各的集合）。
 *
 * @returns {number} 行数。这些系统名下一行都没命中时是 0（0 是结论，不是缺数）；
 *   资产表为空、或这些系统名下没有资产时集合是空集，同样是 0。
 *   **一个系统都没传时也写 0**（与 G10 / D6:D9 / G6/H6/I6 同一条：没有系统就没有可数的
 *   范围，按 0 落值、不记错误 —— 这一格**连事件表都不打开**，所以列名对不上也不会让它
 *   单独报错）。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个（coreSystemsIpsUnion 抛出）；
 *   资产表读不出要读的那两列，或事件表读不出「影响资产」/「GPT研判结论」列
 *   （各表自己的文案，本函数不替它们改写）
 */
function coreSystemsThreatEventCount(ctx) {
  // 与 G10 逐字同一条短路（用户口径 2026-10-12）：没有系统就没有可数的范围，
  // 连事件表都不打开 —— 八格同一个输入就得同一个落法。
  if (noCoreSystems(ctx)) return 0;

  return threatEventCountOnIps(ctx, coreSystemsIpsUnion(ctx));
}

/**
 * 几个核心业务系统的风险总数**合计** —— D6「安全风险总数」。
 *
 * 就是 D7/D8/D9 三格的值相加，不另起口径：每个系统的数怎么来的（三段各按哪张表、
 * 哪些行）见 coreSystemRiskTotalAt，本函数一个字都不重算（H4：同一个量只算一次）。
 * 三个槽位一个不落地加 —— 空着的槽位贡献 0（用户口径 2026-10-12），
 * 于是"只传了 2 个系统"时本格就是那两个数之和，**与逐槽位相等的写法逐字对应**。
 * 这也跟「缺一份表不让整格作废」是同一条思路：没有的东西就是 0，不是作废。
 *
 * @returns {number} 三个槽位风险总数之和。某一个系统名下一条风险都没有时那一段是 0，
 *   照加（0 是结论，不是缺数）；某个槽位没传系统时整个槽位是 0，照加。
 * @throws {Error} 多于 MAX_CORE_SYSTEMS 个系统时由 coreSystemNames 抛出；
 *   列名对不上（表在、但读不出列）时由 coreSystemRiskTotalAt 抛出，本函数不吞，
 *   于是本格同样不写值。
 */
function coreSystemRiskGrandTotal(ctx) {
  let total = 0;
  for (let rank = 0; rank < MAX_CORE_SYSTEMS; rank += 1) {
    total += coreSystemRiskTotalAt(ctx, rank);
  }
  return total;
}

module.exports = {
  MAX_CORE_SYSTEMS,
  BUSINESS_SYSTEMS_OPTION,
  coreSystemNames,
  noCoreSystems,
  coreSystemSlotName,
  coreSystemNameAt,
  coreSystemRiskTotalAt,
  coreSystemRiskGrandTotal,
  coreSystemClosedRiskTotalAt,
  coreSystemClosedRiskGrandTotal,
  coreSystemThreatAlarmTotalAt,
  coreSystemsIpsUnion,
  coreSystemsEventCount,
  coreSystemsThreatEventCount
};
