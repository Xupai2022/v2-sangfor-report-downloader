'use strict';

/**
 * 「攻击来源地域分布top5 / 攻击数量」（F62:G66）的取值。
 *
 * 数据来自 **topn 接口**，不是六份总表里的任何一份：没有下载件、没有 parse 环节、
 * 报告里也没有对应的 sheet。下载层先 POST
 * `/gateway/workflow/order/v1/tool_box/topn/device_list` 拿设备台账，用
 * `device_type` + `device_id_list`（按 device_id 去重、不按 device_status 过滤）拼出
 * `device_infos`，再 POST `/gateway/workflow/order/v1/tool_box/topn/src_ip_geo`
 * （`topn: 5`，报告期 = CLI 的 --start/--end），把 `data.list` 原样交给 ctx.topSrcGeoRows。
 *
 * 四条口径（都写在 F62:G66 各格的 desc 里，H10）：
 *   · 行序 = **接口返回的顺序**，不自己按 attack_count 重排、也不按地域合并；
 *     同一地域出现两行就是两行（接口排的是 top5 源 IP，不是 top5 地域聚合）
 *   · F 列取 `src_ip_geo`（JSON 解码后的中文，如「法国 巴黎」；不是字面的 `\uXXXX`）
 *   · G 列取 `attack_count`，落**数字**，不转字符串
 *   · 最多 5 行；少于 5 行时剩下的 F/G 都写空串（接口答了，就是没那么多）
 *
 * 「接口不通」是另一档（用户口径 2026-10-19）：下载层把失败收成 `null`
 * （ctx.topSrcGeoRows === null），10 格都写 `TOP_SRC_GEO_UNAVAILABLE_TEXT`
 * —— 不是空串、也不是 0（0 是「接口答了、确实没有攻击」那个结论）。
 *
 * 字段缺失（接口改了字段名）**抛错**，由写层记入 errors（H6/R10）：
 * 安静地写一片空串与「这次真的没有数据」在报告上一模一样。
 */

/** 接口不通时 F62:G66 十格落的字面量（用户口径 2026-10-19，全仓只此一处定义）。 */
const TOP_SRC_GEO_UNAVAILABLE_TEXT = 'topn接口不通无法取值';

/** 接口固定返回前 5 名（请求体 topn:5）；万一平台多给，取值层只认前 5 行。 */
const TOP_SRC_GEO_SLOTS = 5;

/**
 * 取第 rank 行（从 0 起）的 `src_ip_geo`。
 *
 * @param {Object} ctx stats/context.js 构造的 ctx
 * @param {number} rank 0..4
 * @returns {string} 地域名；名次不存在时是空串；接口不通时是「topn接口不通无法取值」
 * @throws {Error} 行存在、却没有 `src_ip_geo` 字段（= 平台改了字段名）
 */
function srcIpGeoLabelAt(ctx, rank) {
  if (ctx.topSrcGeoRows === null) return TOP_SRC_GEO_UNAVAILABLE_TEXT;
  const item = ctx.topSrcGeoRows[rank];
  if (!item) return '';

  if (!Object.prototype.hasOwnProperty.call(item, 'src_ip_geo')) {
    throw new Error(
      `topn 接口返回的第 ${rank + 1} 行没有 src_ip_geo 字段：`
      + `${JSON.stringify(item).slice(0, 300)}（平台可能改了字段名）`
    );
  }
  return String(item.src_ip_geo);
}

/**
 * 取第 rank 行（从 0 起）的 `attack_count`。
 *
 * @param {Object} ctx stats/context.js 构造的 ctx
 * @param {number} rank 0..4
 * @returns {number|string} 攻击次数（数字）；名次不存在时是空串；接口不通时是那句话
 * @throws {Error} 行存在、却没有 `attack_count` 字段，或它不是数字
 */
function srcIpGeoAttackCountAt(ctx, rank) {
  if (ctx.topSrcGeoRows === null) return TOP_SRC_GEO_UNAVAILABLE_TEXT;
  const item = ctx.topSrcGeoRows[rank];
  if (!item) return '';

  if (!Object.prototype.hasOwnProperty.call(item, 'attack_count')) {
    throw new Error(
      `topn 接口返回的第 ${rank + 1} 行没有 attack_count 字段：`
      + `${JSON.stringify(item).slice(0, 300)}（平台可能改了字段名）`
    );
  }
  const count = Number(item.attack_count);
  if (!Number.isFinite(count)) {
    throw new Error(
      `topn 接口返回的第 ${rank + 1} 行 attack_count 不是数字：`
      + `${JSON.stringify(item.attack_count)}`
    );
  }
  return count;
}

module.exports = {
  TOP_SRC_GEO_UNAVAILABLE_TEXT,
  TOP_SRC_GEO_SLOTS,
  srcIpGeoLabelAt,
  srcIpGeoAttackCountAt
};
