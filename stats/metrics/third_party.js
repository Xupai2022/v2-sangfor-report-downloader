'use strict';

/**
 * 第三方设备域的取值（CELL_REGISTRY.md §8 F1）——
 * 「数据统计」P9 那个组件块里的 D103「第三方数量」一格（用户口径 2026-10-13）。
 *
 * ⚠️ **本域没有总表，也没有自己的行集合。** 与 D100/D101/D102/D104（stats/metrics/device.js）
 * 同属「接入组件数量」块，但**不是同一把尺子**：
 *   · 那 4 格数的是**深信服设备列表**接口里 `devType` 命中代号集合的**行数**；
 *   · 本格取的是**另一个接口**报的**总数** —— 非深信服（第三方）应用实例的台账。
 * 两个集合互不相交，也不相加（D6 那种"合计"在模板里另有格子）。
 *
 *   接口：POST /api/apex/thirdparty/v1/app/instance/list?viewRegionId=…&onlySelfPlatform=false
 *         body {name:'', appIds:[], hostIp:'', statusList:[], abilityTypeList:[], enableList:[],
 *               appInstanceId:'', pageIndex:1, pageSize:20}
 *         取 **data.count**（第三方应用实例总数）
 *         见 mssw_client.js 的 fetchMsswThirdPartyDeviceCount
 *
 * 口径边界（写进 desc 的几件事）：
 *   · 取的是**接口自己报的总数**（`data.count`），不翻页、不按行重算 ——
 *     参考实现（health-checkup-report 的 collectMsswDeviceCategoryCounts）就是这么取的，
 *     用户口径「复用」它
 *   · **不叠加报告期过滤**：第三方台账是"当前的接入情况"，接口不带时间参数
 *     （与 D100/D101/D102/D104 同一条）
 *   · 与 `--business-systems` 无关（问的是"接进来多少个第三方实例"，不是"某个业务系统名下几个"）
 *   · **接口不通时写「接口不通无值」**（长期口径，用户口径 2026-10-13）——
 *     下载层把失败收成 `null`（ctx 里「读不到」那一档），本函数返回 `UNAVAILABLE_TEXT`，
 *     **不是 0、也不是不写值**。0 留给"接口答了、一个第三方都没接"这一档
 */

const { UNAVAILABLE_TEXT } = require('../context');

/**
 * D103「第三方数量」的取值。
 *
 * 这里不做任何计算 —— 值就是接口报的那个数。函数存在的意义是把**这一格的口径**
 * 落成一个唯一入口（F1/H4）：往后这个数要是改成"按行重算"或加别的筛子，
 * 改的只有这里一处，而且 desc 与实现仍然在同一份文件里对着看。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number|string} 第三方应用实例总数；
 *   **接口不通（`ctx.thirdPartyCount === null`）时是 `UNAVAILABLE_TEXT`**
 */
function thirdPartyDeviceCount(ctx) {
  const count = ctx.thirdPartyCount;

  // 接口不通：这一档与「0 个」刻意分开（见 stats/context.js 的 UNAVAILABLE_TEXT）
  if (count === null) return UNAVAILABLE_TEXT;

  return count;
}

module.exports = { thirdPartyDeviceCount };
