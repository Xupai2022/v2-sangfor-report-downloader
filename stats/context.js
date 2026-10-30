'use strict';

/**
 * 计算层输入契约 —— 「数据统计」sheet 取值层的**唯一入口**。
 * 约束见 CELL_REGISTRY.md §7（C1–C3）与 §2。
 *
 *   C1  ctx 只能在这里拼装，别处不得自行构造
 *   C2  六份总表各对应一个字段，字段名与总表一一对应，不起别名
 *   C3  ctx 只放只读数据与报告参数，不放函数、不放中间计算结果
 *
 * M1 阶段：只定义形状与校验。真实表数据要到 M2/M3 由 mssw_client 产出后才有。
 *
 * 六份表字段一律归一成数组：**表一定在，只是可能 0 行**。不存在「整份没下到」这种
 * 取值层看得见的状态 —— 某份表下不到时 scripts/build_report.py 会直接报
 * 「缺少 X 的下载结果」、整份报告不出（用户口径 2026-10-10），流程根本走不到这里。
 * 所以 0 行是正常数据：计数格写 0、名次格写空串，都不进错误列表。
 */

const { monthRange } = require('./periods');

/**
 * 六份总表 -> ctx 字段名。
 * compute 里靠这些名字认数据源（CELL_REGISTRY.md §2），不要另起别名。
 */
const TABLE_FIELDS = [
  'assetRows',    // 资产表总表
  'eventRows',    // 事件表总表
  'alarmRows',    // 告警表总表
  'vulnRows',     // 漏洞表总表
  'weakPwdRows',  // 弱密码表总表
  'exposedRows'   // 暴露面表「文档说明」sheet 的汇总行（{子类型, 总数}，D128 的口径源）
                  // —— 不是普通的数据行表：表头不在第 1 行，读取层是
                  // mssw_parser.js 的 parseExposedSummary（见 stats/metrics/exposed.js）
];

/**
 * 总表里的**单张 sheet 切片** -> ctx 字段名。
 *
 * 漏洞表 2026-10-16 起是一个工作簿里两张 sheet（「内网漏洞表」+「互联网漏洞表」），
 * `ctx.vulnRows` 按「全表 = 两份相加」拼在一起。**只看其中一张**的格子不能从
 * `vulnRows` 里拆（拼完的行对象不带来源标记），所以下载层按同一份列白名单把
 * 那一张 sheet 单独再读一次，放这里：
 *
 *   vulnOuterRows  「互联网漏洞表」的数据行（D80「已闭环外网资产漏洞数」的口径源）
 *   vulnInnerRows  「内网漏洞表」的数据行（D14「已防护漏洞数」的口径源）
 *
 * 暴露面表同理有第二档读法：它的主字段 `exposedRows` 是「文档说明」汇总表里
 * **13 项精确匹配**的结果（D128 用）；I79/I80 要的是同一张汇总表里**包含匹配**的
 * 另外两项，判据不同、也不能从那 13 项里拆（D128 一项缺失就整格报错，不该牵连这两格），
 * 所以按同一份下载件单独再读一次：
 *
 *   exposedAssetCountRows
 *                  「文档说明」汇总表里按 contains 抽出的 `{子类型, 总数}` 行
 *                  （I79「互联网IP数量」= 含「IP资产」那一项的右侧值，
 *                   I80「互联网端口数量」= 含「端口资产」那一项的右侧值；
 *                   口径见 stats/metrics/exposed.js 的 exposedInternetAssetCount）
 *
 * 归一方式与 TABLE_FIELDS 相同（没传 / 空表都成 `[]` = 0 行）：它们都不是接口类数据源，
 * 没有「接口不通」那一档 —— 文件/sheet 读不出来时读取层当场抛错、整份报告不出。
 */
const TABLE_SHEET_FIELDS = [
  'vulnOuterRows',
  'vulnInnerRows',
  'exposedAssetCountRows'
];

/**
 * 非总表的数据源 -> ctx 字段名。
 *
 * 与 TABLE_FIELDS 分开列，是因为 C2 那一句「六份总表各对应一个字段」说的是**总表**：
 * 设备列表**不是表** —— 它没有下载件、没有 parse* 环节、报告里也没有对应的 sheet，
 * 是下载层直接把接口返回的行对象数组交给 ctx（见 stats/metrics/device.js 头注）。
 * topn 源 IP 地域 / 威胁类型 / 目的 IP 三个接口同理（见 stats/metrics/top_src_geo.js、
 * stats/metrics/threat_type.js、stats/metrics/dst_ip.js 头注）。
 *
 * 归一方式与表字段一样（一律是冻结的数组），但**多一档状态**，见下面
 * UNAVAILABLE / UNAVAILABLE_TEXT。
 */
const SOURCE_FIELDS = [
  'deviceRows',   // 设备列表接口（D100/D101/D102/D104 四格：接入组件数量）
  'topSrcGeoRows', // topn 源 IP 地域接口（F62:G66 十格：攻击来源地域分布top5 / 攻击数量）
                  // 接口返回 data.list 原样给这里：[{ src_ip_geo, attack_count, ... }]，
                  // 行序即名次；接口不通时传 null。口径见 stats/metrics/top_src_geo.js。
  'threatTypeRows', // topn 威胁类型接口（I62:J66 十格：攻击类型top5 / 攻击数量）
                  // 接口返回 data.list 原样给这里：[{ threat_type, attack_count, ... }]，
                  // 行序即名次；接口不通时传 null。口径见 stats/metrics/threat_type.js。
  'dstIpRows',    // topn 目的 IP 接口（L62:M66 十格：遭受外部攻击的主机 / 日志数量）
                  // 接口返回 data.list 原样给这里：[{ dst_ip, attack_count, ... }]，
                  // 行序即名次；接口不通时传 null。口径见 stats/metrics/dst_ip.js。
  'exposedHighRiskPortRows'
                  // 暴露面下载件里**第二张 sheet**「高危端口&服务」的数据行
                  // （I81 暴露面风险端口数量 = 行数，不含表头）。它不是六份总表之一，
                  // 所以不进 TABLE_FIELDS；读取层是通用 parseTableRows，
                  // sheet 名与口径见 stats/metrics/exposed.js。
                  // 空数组 = 只有表头（写 0）；sheet 不存在时读取层当场抛错，
                  // 不会让取值层看到 null。
];

/**
 * 非总表数据源里的**标量** -> ctx 字段名 —— 接口直接报一个数，没有"行"这回事。
 *
 * 与 SOURCE_FIELDS 分开列，是因为它们连"行"都没有：取值层拿到的就是一个数字
 * （或者 UNAVAILABLE 那一档的 `null`），没有可数的行、也没有列名可按（C4 不适用）。
 *
 *   thirdPartyCount  第三方设备列表接口的 `data.count`
 *                    （D103 第三方数量；接口见 mssw_client.js 的 fetchMsswThirdPartyDeviceCount）
 *   securityLogCount 日志量：网络安全日志 + 终端安全日志两张表的条数之和
 *                    （G99 xdr日志数；接口见 mssw_client.js 的 fetchMsswSecurityLogCount）
 *   interceptedOutboundCount
 *                    已拦截外联：**同一个日志量端点、同一批表**，每张表多一条 `searchString`
 *                    过滤串，两张表的条数之和（D23 已拦截外联次数；接口见 mssw_client.js 的
 *                    fetchMsswInterceptedOutboundCount）
 *   externalAttackLogCount
 *                    外部攻击日志量：**同一个日志量端点**的**第三问**，只问网络安全日志
 *                    一张表、带一条「外→内」过滤串（`filter srcIpTag=0 AND dstIpTag=1`）
 *                    （D61 外部攻击日志数量（XDR）；接口见 mssw_client.js 的
 *                    fetchMsswExternalAttackLogCount）
 *   importantPeriodLogCount
 *                    重要时期安全日志数：报告期先切成**重要时期段**（= 报告期 ∩ 法定节假日
 *                    放假整段，见 stats/periods.js 的 importantPeriods），再逐段问「网络安全
 *                    日志 + 终端安全日志」的条数、**各段相加**（D27；接口见 mssw_client.js 的
 *                    fetchMsswImportantPeriodLogCount；切段与调用在 mssw_downloader.js 的
 *                    readImportantPeriodLogCount）
 *
 * securityLogCount 与 interceptedOutboundCount 是**同一个端点上的两次各自独立的问**
 * （差别只在筛不筛），所以下载层**问两次**、两个字段各自有自己的一份三档：
 * 一次失败只让读它的那格写「接口不通无值」，不会牵连另一格 ——
 * 别把两个字段合成一个"日志量对象"再在取值层里拆（那会让两格同生共死）。
 *
 * externalAttackLogCount 是**同一个端点上的第三种问法**（只问网络安全日志一张表、
 * 带「外→内」过滤串，用户口径 2026-10-17）：同样是**自己的字段、自己的一份三档** ——
 * G99 / D23 / D61 谁断了都不牵连谁。
 *
 * importantPeriodLogCount 是**同一个端点上的第三种问法**（不筛，但报告期切成多段）：
 * 任一段不通就整格不通（下载层收成 `null`），**不写"已通的那几段之和"** ——
 * 那会把"少算了几段"伪装成"算完了"。与 G99 也是各问各的、互不牵连。
 *
 * 归一方式与 SOURCE_FIELDS 同一套三档（见下），只是"空"的形态从空数组变成一个 0：
 * 生产里下载层一定传（接口答了就是数、不通就是 `null`）。
 */
const SCALAR_SOURCE_FIELDS = [
  'thirdPartyCount',
  'securityLogCount',
  'interceptedOutboundCount',
  'externalAttackLogCount',
  'importantPeriodLogCount'
];

/**
 * 非总表数据源里的**按月序列** -> ctx 字段名 —— 与报告期的月份桶**等长、同序**的数组，
 * 一个元素就是那个月的接口数（C71:N72「外部攻击数（按月）」要用）。
 *
 *   monthlyExternalAttackCounts
 *       D61 那条接口（日志量端点：只问网络安全日志一张表、带「外→内」过滤串
 *       `filter srcIpTag=0 AND dstIpTag=1`）**逐月各问一次**报的数 —— 第 i 个元素对应
 *       `stats/periods.js` 的 `monthRange` 切出来的第 i 个月；首月 / 末月问的是**裁到报告期**
 *       的那一段（`monthPeriods`，用户口径 2026-10-20「首尾月要限定在输入的时间范围里」）。
 *
 *   monthlyMaliciousOutboundCounts
 *       同一套逐月各问一次，只换过滤串：「内→外」`filter srcIpTag=1 AND dstIpTag=0`
 *       （C73:N73 恶意外联数，用户口径 2026-10-20）。⚠️ 与 D23 不是同一条口径 ——
 *       D23 的串还带 `action = 2`（只要已拦截的），本字段的条件里没有那一条。
 *
 * 三档与标量字段同一套语义，只是"空"的形态是**一个等长的数组**：
 *   · 数字的数组 -> 就是它（数组里**允许 `null` 元素**：那个月的接口独立地不通）
 *   · `null`     -> 整段接口不通（序列里每个元素都按不通处理）
 *   · 没传        -> 每个月都是 0（= 接口答了、那些月一条都没有）
 * ⚠️ 长度必须与报告期的月份数**逐字相等** —— 短一格会让后面所有月份整体错位
 * （2026-08 的数被当成 2026-09 的落进报告），所以长度不对**当场抛**，不静默截断/补零。
 * ⚠️ 元素只认数字或 `null`；字符串 `'7'`、NaN 一律抛（H6：不许静默落成 0）。
 */
const SERIES_SOURCE_FIELDS = [
  'monthlyExternalAttackCounts',
  'monthlyMaliciousOutboundCounts'
];

/**
 * 重要时期**逐段**日志量 -> ctx 字段名。
 *
 * `importantPeriodLogCounts` 与 `importantPeriodLogCount` 来自**同一次逐段问**
 * （下载层 mssw_downloader.js 的 readImportantPeriodLogCount）：那个标量是各段之和（D27），
 * 这个数组是逐段原值（G91:G97「日均攻击数」= 该段原值 ÷ 该段天数）。
 *
 * 三档：
 *   · 数字数组 -> 就是它（长度 = 报告期内重要时期段数；元素是数字）
 *   · `null`    -> 任一段接口不通（与标量同生共死）
 *   · 没传      -> `[]`（= 没有逐段数据；生产里下载层一定会传，测试 fixture 可以不给）
 *
 * ⚠️ 数组比显示槽位短时由取值层抛错（H6），这里只做元素类型校验 —— 段数是
 * 「报告期 × 节假日表」算出来的，与月份数那种由报告期直接决定的长度不是一回事。
 */
const IMPORTANT_PERIOD_SOURCE_FIELDS = [
  'importantPeriodLogCounts'
];

/**
 * 「接口不通」这一档（长期口径，用户口径 2026-10-13）：
 *
 *   `SOURCE_FIELDS` / `SCALAR_SOURCE_FIELDS` 里的字段**取不到数**时，下载层放 `null`
 *   （不是空数组、不是 0，也不是不传）；读它的格子就地写 **`UNAVAILABLE_TEXT`** 这几个字。
 *   **不是 0、也不是不写值** —— 0 是「接口答了、确实是 0」这个结论。
 *
 * ⚠️ **这是本仓对"调接口取数"这一类数据源的统一口径**：往后凡是有格子要从接口取数，
 * 接通时照这一档办 —— 下载层把失败收成 `null`（日志里留真实原因），
 * 取值层 `if (ctx.<field> === null) return UNAVAILABLE_TEXT;`。
 *
 * 与它分得开的两档（别混，混了报告上就分不出"没接设备"和"没读到"）：
 *   · 空数组 `[]` / 数字 `0` —— 接口**答了**、答案是"一个都没有"，那是结论 -> 写 0
 *   · 没传（`undefined`）—— 归一成上一档（生产里下载层一定会传）
 */
const UNAVAILABLE_TEXT = '接口不通无值';

/** 非表字段：报告参数 */
const PARAM_FIELDS = ['customer', 'customerId', 'range', 'protectRange', 'businessSystems'];

/**
 * 必填的只有报告参数。六份总表**刻意不设必填** ——
 * 下载行为一定发生，这里见到的表要么有数据行、要么 0 行，两者都是正常数据；
 * 真的没下到时流程在 scripts/build_report.py 就被拦了，走不到构造 ctx 这一步。
 */
const REQUIRED_FIELDS = ['customer', 'range'];

/** 报告期/护网期统一用 { start, end } 两个 Date 表示，闭区间。 */
function normalizeRange(value, fieldName) {
  if (value === null || value === undefined) return null;
  const start = value.start instanceof Date ? value.start : new Date(value.start);
  const end = value.end instanceof Date ? value.end : new Date(value.end);
  if (Number.isNaN(start.getTime())) throw new Error(`ctx.${fieldName}.start 非法: ${value.start}`);
  if (Number.isNaN(end.getTime())) throw new Error(`ctx.${fieldName}.end 非法: ${value.end}`);
  if (start.getTime() > end.getTime()) throw new Error(`ctx.${fieldName} 起止倒置: ${start} > ${end}`);
  return Object.freeze({ start, end });
}

/**
 * 构造 ctx。C1：这是唯一允许拼装 ctx 的地方。
 *
 * @param {Object} input
 * @param {string} input.customer
 * @param {string} [input.customerId]
 * @param {{start: Date|string, end: Date|string}} input.range        报告期，闭区间
 * @param {{start: Date|string, end: Date|string}|null} [input.protectRange]  --protect-start/--protect-end，未传为 null
 * @param {string[]} [input.businessSystems]
 * @param {Array} [input.assetRows] ... 六份总表
 * @param {Array} [input.vulnOuterRows] 漏洞表工作簿里「互联网漏洞表」那一张 sheet 的数据行
 *   （D80「已闭环外网资产漏洞数」只数这一张）；没传 / 空表都归一成 `[]` = 0 行。
 *   ⚠️ 与 `vulnRows` 不是一回事：那是内网 + 外网两份拼起来的全表。
 * @param {Array} [input.vulnInnerRows] 漏洞表工作簿里「内网漏洞表」那一张 sheet 的数据行
 *   （D14「已防护漏洞数」只数这一张）；没传 / 空表都归一成 `[]` = 0 行。
 *   ⚠️ 与 `vulnRows` 不是一回事：那是内网 + 外网两份拼起来的全表。
 * @param {Array} [input.exposedAssetCountRows] 暴露面表「文档说明」汇总表里按 contains
 *   抽出的 `{子类型, 总数}` 行（I79「互联网IP数量」/ I80「互联网端口数量」）；
 *   没传 / 空表都归一成 `[]` = 0 行。⚠️ 与 `exposedRows` 不是一回事：那是 D128 的
 *   13 项精确匹配结果。
 * @param {Array|null} [input.deviceRows] 设备列表接口返回的行对象；**接口不通时传 `null`**
 *   （那一档叫「读不到」，见 SOURCE_FIELDS 下面的说明）
 * @param {Array|null} [input.topSrcGeoRows] topn 源 IP 地域接口返回的 `data.list`
 *   （`[{ src_ip_geo, attack_count }]`，行序即名次）；接口不通时传 `null`。
 *   少于 5 行是正常结论（剩下的格子留空），口径见 stats/metrics/top_src_geo.js
 * @param {Array|null} [input.threatTypeRows] topn 威胁类型接口返回的 `data.list`
 *   （`[{ threat_type, attack_count }]`，行序即名次）；接口不通时传 `null`。
 *   少于 5 行是正常结论（剩下的格子留空），口径见 stats/metrics/threat_type.js
 * @param {Array|null} [input.dstIpRows] topn 目的 IP 接口返回的 `data.list`
 *   （`[{ dst_ip, attack_count }]`，行序即名次）；接口不通时传 `null`。
 *   少于 5 行是正常结论（剩下的格子留空），口径见 stats/metrics/dst_ip.js
 * @param {Array} [input.exposedHighRiskPortRows] 暴露面下载件「高危端口&服务」sheet 的数据行
 *   （I81 数行数，不含表头）；空数组 = 只有表头。口径见 stats/metrics/exposed.js
 * @param {number|null} [input.thirdPartyCount] 第三方设备列表接口的 `data.count`；接口不通传 `null`
 * @param {number|null} [input.securityLogCount] 日志量（两张表之和，不筛）；接口不通传 `null`
 * @param {number|null} [input.interceptedOutboundCount] 已拦截外联（两张表之和，各带过滤串）；接口不通传 `null`
 * @param {number|null} [input.externalAttackLogCount] 外部攻击日志量（网络安全日志一张表，带「外→内」过滤串）；
 *   接口不通传 `null`
 * @param {Array<number|null>|null} [input.monthlyExternalAttackCounts] 外部攻击日志量的**按月序列**
 *   （同一个端点、同一条过滤串，报告期逐月各问一次，首尾月裁到报告期，C71:N72）：
 *   与 `monthRange` 等长、同序；元素 `null` = 那个月的接口不通；整个字段 `null` = 整段接口不通；
 *   没传 = 每个月 0（= 接口答了、一条都没有）。长度与报告期月份数不符**当场抛**
 * @param {Array<number|null>|null} [input.monthlyMaliciousOutboundCounts] 恶意外联日志量的
 *   **按月序列**（同端点、过滤串 `filter srcIpTag=1 AND dstIpTag=0`，C73:N73）：
 *   长度 / 元素 / 空值三档与 `monthlyExternalAttackCounts` 逐字相同
 * @param {number|null} [input.importantPeriodLogCount] 重要时期安全日志数（报告期切成重要时期段、
 *   逐段问两张表、各段之和）；接口不通传 `null`，**报告期内无重要时期时传 `0`**（那是结论）
 * @param {Array<number>|null} [input.importantPeriodLogCounts] 重要时期**逐段**日志量
 *   （同一次逐段问的逐段原值，G91:G97「日均攻击数」用：该段原值 ÷ 该段天数）；
 *   接口不通传 `null`（与标量同生共死），报告期内无重要时期传 `[]`；
 *   没传归一成 `[]`（测试 fixture 可以不给，生产里下载层一定传）
 */
function createContext(input = {}) {
  const missing = REQUIRED_FIELDS.filter((field) => input[field] === undefined || input[field] === null);
  if (missing.length) {
    throw new Error(`ctx 缺少必填字段: ${missing.join(', ')}（CELL_REGISTRY.md §7）`);
  }

  const ctx = {
    customer: String(input.customer),
    customerId: input.customerId === undefined || input.customerId === null ? '' : String(input.customerId),
    range: normalizeRange(input.range, 'range'),
    protectRange: normalizeRange(input.protectRange, 'protectRange'),
    businessSystems: Object.freeze(Array.isArray(input.businessSystems) ? [...input.businessSystems] : [])
  };

  // 表字段一律存在且是数组：没传 / 传了空表都归一成 []（= 0 行 = 「这段时间没有数据」，
  // 那是结论，不是缺数）。compute 里不用再判 Array，也没有「这份表没下到」这种状态可判。
  for (const field of TABLE_FIELDS) {
    ctx[field] = Object.freeze(Array.isArray(input[field]) ? input[field] : []);
  }

  // 总表里的单张 sheet 切片（vulnOuterRows / exposedAssetCountRows）同一套归一：
  // 没传 / 空表都是 []。
  for (const field of TABLE_SHEET_FIELDS) {
    ctx[field] = Object.freeze(Array.isArray(input[field]) ? input[field] : []);
  }

  // 非总表的数据源（deviceRows）**多一档**：`null` = 接口不通 -> 那一格写
  // UNAVAILABLE_TEXT（下载层放这个值，**不是空数组**：空数组是"一台都没有"这个结论）。
  // 其余的非数组（含没传 / undefined）仍旧归一成 [] —— 生产里下载层一定传，
  // 见 mssw_downloader.js 的 readDeviceRows。
  for (const field of SOURCE_FIELDS) {
    const value = input[field];
    ctx[field] = Object.freeze(Array.isArray(value) ? value : (value === null ? null : []));
  }

  // 标量数据源（thirdPartyCount / securityLogCount / interceptedOutboundCount /
  // externalAttackLogCount / importantPeriodLogCount）同一套三档，"空"的形态是 `0`：
  //   null -> 「接口不通无值」那一档 / 数字 -> 就是它 / 没传 -> 0（= 接口答了、0 个）
  // ⚠️ 数字以外的值**当场抛**：把 `'123'` 这种字符串悄悄落成 0，正是 H6 要挡的那种静默。
  for (const field of SCALAR_SOURCE_FIELDS) {
    const value = input[field];
    if (value === null) {
      ctx[field] = null;
      continue;
    }
    if (value === undefined) {
      ctx[field] = 0;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`ctx.${field} 必须是数字或 null（接口不通那一档），收到: ${JSON.stringify(value)}`);
    }
    ctx[field] = value;
  }

  // 按月序列（C71:N72「外部攻击数」）：与报告期的月份桶**等长、同序**。
  // 三档：没传 -> 每个月 0 / null -> 每个月都不通 / 数组 -> 逐月（元素允许 null）。
  // 长度由报告期当场算一次（monthRange 就是取值层切槽位的同一把尺子），
  // 对不上就抛 —— 短一格会让后面所有月份整体错位，那在报告上完全看不出来。
  for (const field of SERIES_SOURCE_FIELDS) {
    const monthCount = monthRange(ctx.range.start, ctx.range.end).length;
    const value = input[field];

    if (value === undefined) {
      ctx[field] = Object.freeze(new Array(monthCount).fill(0));
      continue;
    }
    if (value === null) {
      ctx[field] = Object.freeze(new Array(monthCount).fill(null));
      continue;
    }
    if (!Array.isArray(value) || value.length !== monthCount) {
      throw new Error(
        `ctx.${field} 必须是与报告期月份数等长的数组（${monthCount} 个，元素是数字或 null），`
        + `收到: ${JSON.stringify(value)}`
      );
    }
    for (const item of value) {
      if (item !== null && (typeof item !== 'number' || !Number.isFinite(item))) {
        throw new Error(
          `ctx.${field} 的元素必须是数字或 null（那个月接口不通），收到: ${JSON.stringify(item)}`
        );
      }
    }
    ctx[field] = Object.freeze([...value]);
  }

  // 重要时期逐段日志量（G91:G97「日均攻击数」）：三档同上，只是没有"按月等长"这条长度约束
  // —— 段数由 `importantPeriods(报告期)` 决定，取值层按同一份段清单取槽位。
  for (const field of IMPORTANT_PERIOD_SOURCE_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      ctx[field] = Object.freeze([]);
      continue;
    }
    if (value === null) {
      ctx[field] = null;
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(
        `ctx.${field} 必须是数字数组或 null（接口不通那一档），收到: ${JSON.stringify(value)}`
      );
    }
    for (const item of value) {
      if (typeof item !== 'number' || !Number.isFinite(item)) {
        throw new Error(
          `ctx.${field} 的元素必须是数字（那一段的日志量），收到: ${JSON.stringify(item)}`
        );
      }
    }
    ctx[field] = Object.freeze([...value]);
  }

  return Object.freeze(ctx);
}

module.exports = { createContext, TABLE_FIELDS, TABLE_SHEET_FIELDS, SOURCE_FIELDS,
                   SCALAR_SOURCE_FIELDS, SERIES_SOURCE_FIELDS, IMPORTANT_PERIOD_SOURCE_FIELDS,
                   PARAM_FIELDS, REQUIRED_FIELDS, UNAVAILABLE_TEXT };
