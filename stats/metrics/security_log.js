'use strict';

/**
 * XDR 日志量域的取值（CELL_REGISTRY.md §8 F1）——
 * 「数据统计」F 列那几格的源：G99「xdr日志数」、D23「已拦截外联次数」、
 * D21「外联通报风险次数」（用户口径 2026-10-13；换接口 + 加 D23/D21 2026-10-14）。
 *
 * ⚠️ **本域没有总表，也没有行集合**：值来自日志量接口报的总数
 * （ctx.securityLogCount / ctx.interceptedOutboundCount）。
 *
 *   同一端点问两次（`fetchMsswSecurityLogCount` / `fetchMsswInterceptedOutboundCount`）：
 *     POST /gateway/mss-mdr/web/api/mssw/mss-mdr/v1/logs-aggregations-count
 *     body {fromDate, toDate,                       // **epoch 秒**，不是日期字符串
 *           tableName: ['network_security_log'],    // 另一问给 'endpoint_security_log'
 *           searchString: '', constrains: [{客户 = <companyId>}],
 *           pageNo: 1, pageSize: 60, fieldList: []}
 *     -> data.total
 *   两张表各问一次，**相加** = 一个 ctx 标量（相加这一步在 mssw_client.js 里）。
 *   ⚠️ 表名直接给标识符 —— 换接口前那套「先 ckTableQuery 按中文表名取表 id」的两跳没了。
 *
 *   ⭐ G99 与 D23 是**同一个端点上的两次问**（第三次问是 D61，见下），差别**只在 `searchString`**：
 *     · G99「xdr日志数」  ：不筛（`searchString: ''`，抓包原样）—— 这段时间收到多少日志
 *     · D23「已拦截外联次数」：逐张表照抓包带过滤串（网络「内→外 且已拦截」、
 *       终端「已拦截」）—— 其中多少是**外联**且**已拦截**
 *     · 两格的数一般不等（G99 恒 ≥ D23）；接口不通时**各自独立地**变成「接口不通无值」，
 *       一次失败不牵连另一格（下载层对两格各问一次，见 mssw_downloader.js）
 *
 *   ⭐ D61「外部攻击日志数量（XDR）」是**同一个端点上的第三种问法**（用户口径 2026-10-17）：
 *     只问**网络安全日志一张表**，`searchString` 为 `filter srcIpTag=0 AND dstIpTag=1`
 *     （外→内 —— 与 D23 的「内→外」正好反方向，且**不带** `action = 2`）——
 *     ctx.externalAttackLogCount，同样自己断、不牵连 G99/D23（下载层问第三次）。
 *
 *   ⭐ 同一个问法再**逐月各问一次**（用户口径 2026-10-20）：C71:N72「外部攻击数」那一块 ——
 *     报告期切成月、首尾月裁到报告期，每个月独立地问、独立的数，进
 *     ctx.monthlyExternalAttackCounts（与 monthRange 等长同序的数组）。
 *     它与 D61 是**两个不同的问题**（整段 vs 逐月），不互相推算。
 *
 *   ⭐ C73:N73「恶意外联数」是**同一套逐月问法、反方向的过滤串**（用户口径 2026-10-20
 *     「请求体条件是 srcIpTag=1 AND dstIpTag=0」，内→外）—— 进
 *     ctx.monthlyMaliciousOutboundCounts。⚠️ 与 D23「已拦截外联次数」不是同一条口径：
 *     D23 的抓包串还带 `action = 2`，这一条没有 —— 数的是全部内→外日志。
 *     C71:N71 那一行月份标签**两组共用**（同一条月份轴），C73:N73 只有值。
 *
 * 报告期（用户口径 2026-10-13）：**命令行 --start/--end 直传** ——
 * 起 = 起始日 00:00:00、止 = 结束日 23:59:59（本地时区，与事件/告警表同一把尺子），
 * 两个日界各自换算成 epoch 秒发出去。
 * ⚠️ 抓包里的起止（两个数差整 30 天）是浏览器"近 30 天"默认值，**不算口径** ——
 * 报告期只由命令行输入定（用户原话「传入时间就是命令行输入的时间」）。
 *
 * 口径边界（写进 desc 的几件事）：
 *   · 两张日志表**相加、不去重**（网络安全 + 终端安全，各自的条数由平台算好）
 *   · 范围内**没有日志**时是 **0**（0 是结论："这段时间平台没收到日志"，不是缺数）
 *   · **接口不通时写「接口不通无值」**（长期口径，用户口径 2026-10-13）——
 *     下载层把失败收成 `null`（ctx 里「读不到」那一档），本函数返回 `UNAVAILABLE_TEXT`
 *   · 与 `--business-systems` 无关（日志量是整个租户的，不按业务系统圈）
 */

const { UNAVAILABLE_TEXT } = require('../context');
const { monthRange } = require('../periods');
const { outboundAlarmCount } = require('./alarm');

/**
 * G99「xdr日志数」的取值。
 *
 * 与 D103 同一形状：值就是接口报的数，本函数只负责把「接口不通」那一档翻成
 * `UNAVAILABLE_TEXT`（F1/H4：这一格的口径只有这一处入口）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number|string} 报告期内两张日志表的条数之和（**不筛**）；
 *   **接口不通（`ctx.securityLogCount === null`）时是 `UNAVAILABLE_TEXT`**
 */
function securityLogCount(ctx) {
  const total = ctx.securityLogCount;

  // 接口不通：这一档与「0 条」刻意分开（见 stats/context.js 的 UNAVAILABLE_TEXT）
  if (total === null) return UNAVAILABLE_TEXT;

  return total;
}

/**
 * D23「已拦截外联次数」的取值。
 *
 * 与 `securityLogCount` 是**同一个端点的多次问之一**（另一问是 D61；差别只在 `searchString`），
 * 所以形状完全一样：接口报的数直接落格，接口不通写「接口不通无值」。
 * 报告期同为 CLI 的 --start/--end 直传，不做任何收窄。
 *
 * 计数单位是**日志条数**（不是告警条数、也不是去重后的外联事件数）：
 * 两条日志指向同一个外联目标时算 2（与 G99 一样的口径 —— 平台怎么数，就照它数）。
 *
 * @param {Object} ctx
 * @returns {number|string} 报告期内两张日志表里「已拦截的外联」条数之和；
 *   **接口不通（`ctx.interceptedOutboundCount === null`）时是 `UNAVAILABLE_TEXT`**
 */
function interceptedOutboundLogCount(ctx) {
  const total = ctx.interceptedOutboundCount;

  if (total === null) return UNAVAILABLE_TEXT;

  return total;
}

/**
 * D61「外部攻击日志数量（XDR）」的取值（用户口径 2026-10-17）。
 *
 * 数据源与 G99/D23 **是同一个日志量端点**，但问法三者都不同：
 * 本格只问**网络安全日志一张表**，`searchString` 为
 * `filter srcIpTag=0 AND dstIpTag=1`（外→内，即从外部打进来的攻击），取 `data.total`。
 * 与 G99/D23 的关系是「同端点、各问各的」：在 ctx 里是**自己的字段**
 * （`externalAttackLogCount`），一次失败只让本格写「接口不通无值」，不牵连另外两格。
 *
 * 计数口径是**日志条数**：平台报多少就写多少，不按源 IP / 攻击目标合并、不去重。
 * 报告期与 G99/D23 同一把尺子（CLI 的 --start/--end 直传，在下载层就用掉）。
 *
 * @param {Object} ctx
 * @returns {number|string} 报告期内网络安全日志中「外→内」的条数；
 *   **接口不通（`ctx.externalAttackLogCount === null`）时是 `UNAVAILABLE_TEXT`**
 */
function externalAttackLogCount(ctx) {
  const total = ctx.externalAttackLogCount;

  // 接口不通：这一档与「0 条」刻意分开（见 stats/context.js 的 UNAVAILABLE_TEXT）
  if (total === null) return UNAVAILABLE_TEXT;

  return total;
}

/**
 * C71:N72「威胁运营趋势 / 外部攻击数」共用的那个量 —— 月份标签 + 逐月的外部攻击日志条数（H4）。
 *
 * 用户口径 2026-10-20：C71:N71 写月份标签（`2026-01` 形态）、C72:N72 写那个月的
 * 「外部攻击数」。这个数**就是 D61 那条口径按月各问一次的结果**：
 * 同一个日志量端点、只问网络安全日志一张表、`searchString` 与 D61 逐字相同
 * （`filter srcIpTag=0 AND dstIpTag=1`，外→内），逐月各取一次 `data.total`。
 * 首尾月问的是**裁到报告期**的那一段（2026-01-15 起的报告期，2026-01 那段从 01-15 算起），
 * 中间各月是整月 —— 切段在 `stats/periods.js` 的 `monthPeriods` 里做，
 * 与这里的 `monthRange` 共用同一条月份轴（所以第 i 格永远是同一个月）。
 *
 * ⚠️ 它与 D61「外部攻击日志数量」是**同一个接口的口径、两个不同的问题**：
 * D61 只问报告期一整段、落一个总数；本块把报告期切成月、逐月问。
 * 两者**没有恒等关系**（各月之和一般等于整段总数，但那是接口侧的事，本仓不拿 D61 去反推、
 * 也不把 D61 均摊到各月）。
 *
 * 三档与接口类数据源同一条（见 stats/context.js 的 UNAVAILABLE_TEXT）：
 *   · 那个月接口答了 -> 写它报的数（0 也是结论："那个月一条外部攻击日志都没有"）
 *   · **那个月接口不通** -> 本格写「接口不通无值」（`null` 元素；各月各自独立地断，
 *     一个月的失败不牵连另外几个月）
 *   · 槽位越过报告期的月份数 -> 写**空串**（那与"那个月接口不通"、"那个月是 0" 都不同：
 *     这个槽位根本没有对应的月份，与 C58:N59 同一条落法）
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {{labels: string[], counts: Array<number|null>}} 两个等长数组，长度 1..12，升序
 * @throws {Error} ctx.monthlyExternalAttackCounts 与报告期月份数不等长
 *   （ctx 构造时已经拦过一道，这里是防守：错位落值在报告上看不出来，R10）
 */
function monthlyExternalAttackSeries(ctx) {
  return monthlySeriesOf(ctx, 'monthlyExternalAttackCounts');
}

/**
 * C73:N73「恶意外联数（按月）」的那份序列 —— 与上面**逐字同一套形状**，
 * 只换 ctx 字段（`monthlyMaliciousOutboundCounts`）与业务叫法。
 *
 * 用户口径 2026-10-20：「C73:N73是每个月的恶意外联数，一样切分月份，拿日志接口，
 * 请求体条件是 srcIpTag=1 AND dstIpTag=0」。所以月份轴、首尾月裁剪、三档失败语义
 * 与 C71:N72 完全一致（`monthPeriods` 切、`monthRange` 对齐），差别只在过滤串方向。
 * ⚠️ 它与 D23 不是同一条：D23 还带 `action = 2`（已拦截），本组数全部内→外日志。
 *
 * @param {Object} ctx
 * @returns {{labels: string[], counts: Array<number|null>}}
 * @throws {Error} 序列长度与报告期月份数不等长
 */
function monthlyMaliciousOutboundSeries(ctx) {
  return monthlySeriesOf(ctx, 'monthlyMaliciousOutboundCounts');
}

/**
 * 两份逐月序列共用的读取与长度校验（H4：月份轴与"等长"这条判据只有这一处）。
 * @param {Object} ctx
 * @param {'monthlyExternalAttackCounts'|'monthlyMaliciousOutboundCounts'} field
 * @returns {{labels: string[], counts: Array<number|null>}}
 */
function monthlySeriesOf(ctx, field) {
  const labels = monthRange(ctx.range.start, ctx.range.end);
  const counts = ctx[field];

  if (!Array.isArray(counts) || counts.length !== labels.length) {
    throw new Error(
      `${field} 与报告期月份数对不上（月份 ${labels.length} 个，`
      + `序列 ${Array.isArray(counts) ? counts.length : typeof counts} 个）`
    );
  }
  return { labels, counts };
}

/**
 * 第 index 个槽位（从 0 起）的月份标签；槽位越界（报告期不足 12 个月时空出来的那几格）
 * 时是**空串** —— 那个槽位没有对应的月份。与 `monthLabelAt` 同一形状。
 */
function monthlyExternalAttackLabelAt(ctx, index) {
  const label = monthlyExternalAttackSeries(ctx).labels[index];
  return label === undefined ? '' : label;
}

/**
 * 第 index 个槽位（从 0 起）的外部攻击日志条数；槽位越界时空串，
 * 那个月接口不通时是 `UNAVAILABLE_TEXT`（与 0 刻意分开，见上面的说明）。
 */
function monthlyExternalAttackCountAt(ctx, index) {
  const series = monthlyExternalAttackSeries(ctx);
  if (index >= series.labels.length) return '';

  const count = series.counts[index];
  return count === null ? UNAVAILABLE_TEXT : count;
}

/**
 * 第 index 个槽位（从 0 起）的恶意外联日志条数（C73:N73）；槽位越界时空串，
 * 那个月接口不通时是 `UNAVAILABLE_TEXT`。形状与 `monthlyExternalAttackCountAt` 逐字相同。
 *
 * 月份标签不在这里读 —— C73:N73 上面没有自己的标签行，用的是 C71:N71 那一行
 * （`monthlyExternalAttackLabelAt`），同一条月份轴。
 */
function monthlyMaliciousOutboundCountAt(ctx, index) {
  const series = monthlyMaliciousOutboundSeries(ctx);
  if (index >= series.labels.length) return '';

  const count = series.counts[index];
  return count === null ? UNAVAILABLE_TEXT : count;
}

/**
 * D21「外联通报风险次数」的取值 = D23 + D24（用户口径 2026-10-14）。
 *
 * 两个加数各自都是**有名字的口径**，所以这里只做加法、不重写任何一边的取数逻辑
 * （H4）：`interceptedOutboundLogCount`（D23，日志接口）+ `outboundAlarmCount`（D24，告警表）。
 *
 * ⚠️ 「接口不通」必须**穿透**这一格：D23 那一半取不到数时，本格也写
 * 「接口不通无值」—— 不能把 `UNAVAILABLE_TEXT` 当字符串去加、也不能当 0 只加出
 * D24 那一半（后者会在报告上把"少算了一半"伪装成"算完了"）。
 * D24 那一半来自总表、不会有"不通"这一档（表 0 行就是 0，那是结论）。
 *
 * @param {Object} ctx
 * @returns {number|string} D23 + D24；**D23 接口不通时是 `UNAVAILABLE_TEXT`**
 */
function outboundReportRiskCount(ctx) {
  const intercepted = interceptedOutboundLogCount(ctx);

  if (intercepted === UNAVAILABLE_TEXT) return UNAVAILABLE_TEXT;

  return intercepted + outboundAlarmCount(ctx);
}

module.exports = { securityLogCount, interceptedOutboundLogCount,
                   externalAttackLogCount, outboundReportRiskCount,
                   monthlyExternalAttackSeries, monthlyExternalAttackLabelAt,
                   monthlyExternalAttackCountAt,
                   monthlyMaliciousOutboundSeries, monthlyMaliciousOutboundCountAt };
