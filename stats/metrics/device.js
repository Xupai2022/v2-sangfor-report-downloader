'use strict';

/**
 * 设备（接入组件）域的共用派生量（CELL_REGISTRY.md §8 F1）。
 *
 * 供「数据统计」P9 那个组件块里的 4 格用：
 *   · D100「SIP数量」 / D101「AF数量」 / D102「STA数量」 / D104「EDR数量」（用户口径 2026-10-13）
 *
 * ⚠️ **本域没有总表。** 别的域都读某个「*Rows」字段（六份总表解析出来的行对象），
 * 本域读的是**设备列表接口的返回行**（ctx.deviceRows）：
 *
 *   接口：POST /api/apex/device/v1/devices/list?viewRegionId=…&onlySelfPlatform=false
 *         body {keyword:'', type:0, pageSize:1000, pageNum, devStatus:[1,2,3,4]}
 *         取 data.total（总数）与 data.list（设备行）—— 全量翻页在下载层做完，
 *         见 mssw_client.js 的 fetchMsswDeviceRows
 *
 * 接口与 devType 分类沿用参考实现 C:\Users\User\Desktop\health-checkup-report
 * （src/mssw_client.js 的 collectMsswDeviceCategoryCounts / DEVICE_TYPE_CATEGORIES，
 * scripts/device_component_stats.py 与 分支1/report/policy_check_export.py 的 DEV_TYPE_DICT
 * 两处抄的映射值一致）。本仓自己那 4 格的口径由用户投喂，下表就是投喂的落点。
 *
 * ⚠️ **行对象的键是接口字段名，不是表头文字**（CELL_REGISTRY.md §7 C4 的例外，仅本域）：
 * C4 之所以要求按表头文字取列，是因为平台导出的**列集是数据相关的**（同一接口 116 条数据
 * 出 77 列、0 条只出 68 列），按下标写死的代码换份数据就会静默数到别的列上。
 * 设备列表是**定长字段**的 JSON 接口（每行永远是同一组字段，实测 30 个键），
 * 没有「这一份少几列」这回事，所以按字段名取（`row.devType`）是安全的 ——
 * 而按字段名取正是 C4 的本意。
 */

const { requireColumn } = require('./rows');
const { UNAVAILABLE_TEXT } = require('../context');

/**
 * 设备行里表示「设备类型」的字段名 —— 本域四格唯一的判据列。
 *
 * 依据：参考实现的 classifyDeviceType(Number(device.devType))，以及真实样本
 * C:\Users\User\Desktop\health-checkup-report\tmp\device.json（6 台设备，
 * devType 取值 {25:3, 12:1, 3:1, 69:1}）逐行确认过这个字段在、且是数字。
 */
const DEVICE_TYPE_FIELD = 'devType';

/** 报错文案里的数据源名（requireColumn 的第二个参数）。 */
const DEVICE_SOURCE_LABEL = '设备列表接口';

/**
 * 四个组件各认哪些 devType（用户口径 2026-10-12；devType 代号沿用参考实现）。
 *
 * ⚠️ **EDR 是家族，不是一个代号**：12 是 EDR 本体，另外 5 个是同一族的产品形态
 * （37 CWPP、100038 SaaS-EDR-探针版、50038 EDR-探针版、100012 SAAS EDR、69 SaaS NGES）。
 * 参考实现把它整族算作一类（那边叫 `aes`），用户口径 2026-10-13 明确「数全部家族的 6 个」，
 * 所以 D104 认的是下表这 6 个代号 —— 别只认 12。
 *
 * ⚠️ 四个集合**互不相交**（逐个比对过：3 / 9 / 25 都不在 EDR 那 6 个里），
 * 所以四格之间不存在同一台设备被数两次的问题；不属于这四个集合的设备
 * （2 AC、15 云镜、19 aTrust、69 之外的 SaaS 系、72 云镜-服务版、以及第三方设备）
 * 这四格一个都不算 —— 模板里那个「第三方」块另有格子，且**不是同一把尺子**：
 * D103「第三方数量」读的是**另一个接口**（第三方应用实例台账）报的总数，
 * 见 stats/metrics/third_party.js；同块的 D106（另一行「第三方」）仍未接。
 * 所以「第三方设备」在这里一行都不算，是对的 —— 它们不该进这四格。
 */
const SIP_DEVICE_TYPES = [9];
const AF_DEVICE_TYPES = [3];
const STA_DEVICE_TYPES = [25];
const EDR_DEVICE_TYPES = [12, 37, 100038, 50038, 100012, 69];

/**
 * 设备列表里 devType 落在给定代号集合里的**行数** —— 本域四格共用的这一段（H4）。
 *
 * 四格只差一个代号集合（SIP / AF / STA / EDR 家族各一份），过滤条件只写在这里一处；
 * 也就是说用户哪天改某个组件的代号范围，四格一起来自 `*_DEVICE_TYPES` 这一个常量。
 *
 * 口径边界（写进各格 desc 的五件事）：
 *   · 计数单位是**设备行数**（一台设备一行），**不按 IP / 设备名去重** ——
 *     同一条 devId 在接口里出现两次就是 2
 *   · **不叠加报告期过滤**：设备台账是「当前的接入情况」，接口不带时间参数，
 *     与 --start/--end 无关（与资产表那几格同一条：台账类数据本仓不另加时间条件）
 *   · **不叠加第二位过滤**：设备状态范围由**请求体**定死（devStatus [1,2,3,4]，四档全要），
 *     取值层不对 devStatus / isDelete 再做一次筛选 —— 请求就是那一道筛
 *   · 与 `--business-systems` 无关（问的是"接进来几台某型设备"，不是"某个业务系统名下几台"）
 *   · **接口不通时写「接口不通无值」**（长期口径，用户口径 2026-10-13）——
 *     下载层把失败收成 `null`（ctx 里「读不到」那一档），本函数返回
 *     `UNAVAILABLE_TEXT`，**不是 0、也不是不写值**。0 留给"接口答了、一台都没有"这一档
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {number[]} devTypes 这一格认的 devType 代号集合（SIP_DEVICE_TYPES 等）
 * @returns {number|string} 命中行数。设备一台都没有（接口返回 0 台 -> ctx.deviceRows 是空数组）
 *   时是 **0**（0 是结论，不是缺数 —— 那正是"这个客户没接这种设备"）；
 *   **接口不通（`ctx.deviceRows === null`）时是 `UNAVAILABLE_TEXT`**
 * @throws {Error} 有行数据、却没有任何一行带 `devType` 字段（接口改了字段名，
 *   不许静默数出 0）
 */
function deviceCountByType(ctx, devTypes) {
  const rows = ctx.deviceRows;

  // 接口不通：这一档与「0 台」刻意分开（见 stats/context.js 的 UNAVAILABLE_TEXT）
  if (rows === null) return UNAVAILABLE_TEXT;

  if (!Array.isArray(rows) || rows.length === 0) return 0;

  requireColumn(rows, DEVICE_TYPE_FIELD, DEVICE_SOURCE_LABEL);

  const wanted = new Set(devTypes.map(Number));
  return rows.filter((row) => wanted.has(Number(row[DEVICE_TYPE_FIELD]))).length;
}

module.exports = {
  DEVICE_TYPE_FIELD,
  DEVICE_SOURCE_LABEL,
  SIP_DEVICE_TYPES,
  AF_DEVICE_TYPES,
  STA_DEVICE_TYPES,
  EDR_DEVICE_TYPES,
  deviceCountByType
};
