'use strict';

/**
 * 「核心业务系统」域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 与其他 metrics 文件不同：这一份**不绑定单一份总表**，它把四份串起来 ——
 * 资产表（业务系统 -> IP）→ 漏洞表 / 弱密码表 / 事件表（IP -> 风险数）。
 * §8 列的域文件是按数据源分的（event / alarm / vuln / weakpwd / asset / …），
 * 跨源的这一个没有现成的家，所以单独放一份，不往任何一个源文件里塞 ——
 * 塞进去就等于让「找一格先按域定位文件」失效。
 *
 * 三格系统名（D3/D4/D5）与三格风险总数（D7/D8/D9）都读同一个 --business-systems，
 * 只有槽位不同；风险总数的算法三格共用一份，正是 H4 说的「被两个及以上地址用到的
 * 派生量必须提到 metrics 并具名导出」。
 */

const { assetIpsOfBusinessSystem } = require('./asset');
const { exploitableVulnCount } = require('./vuln');
const { weakPwdRiskCount } = require('./weakpwd');
const { accountRiskEventCount } = require('./event');

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
 * 第 rank 个（从 0 起）核心业务系统名 —— D3/D4/D5 各取一个槽位。
 *
 * 不参与统计，CLI 传什么就是什么（与 J1 客户名同一类：报告参数直传）。
 *
 * @returns {string}
 * @throws {Error} 这个槽位没传（只传了一个/两个系统）时抛错，**本格不写值、模板原样保留**。
 *   刻意不与「传了名但算不出数」混为一谈：这里连系统都没有，没有任何数可算，
 *   留空是唯一说得通的落法（填 0 会被读成「这个系统的风险数是 0」）。
 */
function coreSystemNameAt(ctx, rank) {
  const names = coreSystemNames(ctx);
  const name = names[rank];
  if (!name) {
    throw new Error(
      `${BUSINESS_SYSTEMS_OPTION} 只给了 ${names.length} 个系统，没有第 ${rank + 1} 个：`
      + '本格不写值、模板原样保留'
    );
  }
  return name;
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
 * @returns {number} 三段之和。**某一份表这次没下到（或下到的是空表）时，那一段按 0 计，
 *   其余段照算** —— 用户口径：缺一份表不让整格作废。
 *   代价说在明处：报告上看不出少算了一段。补偿不放在这一层（H3：compute 是纯函数，
 *   不记日志），由 mssw_downloader.js 在拼 ctx 时把「哪几份表没下到」写进运行日志。
 * @throws {Error} **资产表**没读到 —— 它是「业务归属 -> IP」的钥匙，缺了它，另外三份表
 *   一个 IP 都对不上，本格整格不写值、记入错误列表（R10/H6）。
 *   列名对不上（表在、但读不出某一列）同样抛错，文案由各段自己给（带表名与列名）：
 *   表在却读不出列，说明平台动了表头，这时按 0 算等于拿一份没读到的数据当没有。
 */
function coreSystemRiskTotalAt(ctx, rank) {
  const name = coreSystemNameAt(ctx, rank);

  const ips = assetIpsOfBusinessSystem(ctx, name);
  if (ips === undefined) {
    // 走到这里系统名一定不是空串（coreSystemNameAt 已经拦过没传槽位的情况），
    // 所以 undefined 只剩「资产表没读到」一种，缺的是业务归属 -> IP 这一步
    throw new Error(
      `第 ${rank + 1} 个系统「${name}」的风险总数算不出来：资产表没读到`
      + '（这次没下到，或下到的是空表）—— 没有资产表就做不出「业务归属 -> IP」这一步'
    );
  }

  let total = 0;
  for (const segment of RISK_SEGMENTS) {
    const count = segment.count(ctx, ips);
    // 这一段的总表没下到 -> 按 0 计，其余段照算（用户口径）。日志在拼 ctx 那边打，
    // 见 mssw_downloader.js 里 coreSystemTables 那一段。
    if (count === undefined) continue;
    total += count;
  }
  return total;
}

module.exports = {
  MAX_CORE_SYSTEMS,
  BUSINESS_SYSTEMS_OPTION,
  coreSystemNames,
  coreSystemNameAt,
  coreSystemRiskTotalAt
};
