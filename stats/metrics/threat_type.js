'use strict';

/**
 * I62:J66「攻击类型top5 / 攻击数量」十格的取值逻辑（用户口径 2026-10-19）。
 *
 * ⚠️ 表头写的是「攻击类型top5 / 攻击数量」，用户投喂时叫「威胁类型 Top 5 名称 /
 * 威胁类型 Top 5 数量」，接口字段是 `threat_type` —— 三处指的是同一个东西，
 * 本文件统一按接口字段叫「威胁类型」。
 *
 * 数据源是 topn 接口（与 F62:G66 攻击来源地域同一套两次问）：
 *   1) POST /gateway/workflow/order/v1/tool_box/topn/device_list
 *   2) POST /gateway/workflow/order/v1/tool_box/topn/threat_type
 * 第二问的请求体与 src_ip_geo 逐字相同（topn=5、date_scope=0、security_log、
 * attack_direction=1、device_infos 同一份构造规则），只换端点。
 *
 * 取值口径（与 top_src_geo.js 同一条）：
 *   · I 列 = 响应行里的 `threat_type`，**行序照接口返回原样**，不按 attack_count 重排
 *   · J 列 = 同一行的 `attack_count`，落数字、不转字符串
 *   · 最多 5 行；少于 5 行时剩下的 I/J 都写空串（接口答了、就是没那么多）
 *   · 接口不通（ctx.threatTypeRows === null）-> 十格都写「topn接口不通无法取值」
 *   · 行里缺 `threat_type` / `attack_count`（平台改字段名）-> 抛错，只让那一格进
 *     errors，不静默写空（CELL_REGISTRY.md H6 / MIGRATION.md R10）
 *
 * ⚠️ `threat_type` 可能是平台的占位符「-」（未归类桶，抓包响应里真实出现过）。
 * 这一档**原样保留**：接口已经把它排进 top5，删掉会让后面的名次整体前移，
 * 与「行序 = 响应顺序」相冲突；「- 不算一种定性」那条规则适用于总表按行计数
 * （C135 那一片），不适用于这里。
 *
 * ctx 契约见 stats/context.js 的 SOURCE_FIELDS（`threatTypeRows`）：
 *   · `null`      = 接口不通（写那句话）
 *   · `[]`        = 接口答了、0 行（十格空串）
 *   · `undefined` = 归一成空数组（没有这个数据源 = 答了 0 行）
 */

/** 接口不通时十格统一写的那句话（用户口径 2026-10-19）。 */
const THREAT_TYPE_UNAVAILABLE_TEXT = 'topn接口不通无法取值';

/** 接口最多给 5 名（请求体 topn=5），多给也只认前 5 行。 */
const THREAT_TYPE_SLOTS = 5;

function threatTypeRowAt(ctx, rank) {
  if (ctx.threatTypeRows === null) return null;
  const rows = ctx.threatTypeRows || [];
  return rows[rank] || null;
}

/**
 * I 列（第 `rank` 名，0 起）：该行 `threat_type` 原样落字符串。
 *
 * 接口不通 -> 那句话；没这么多行 -> 空串；有行但缺字段 -> 抛错。
 */
function threatTypeLabelAt(ctx, rank) {
  if (ctx.threatTypeRows === null) return THREAT_TYPE_UNAVAILABLE_TEXT;
  const item = threatTypeRowAt(ctx, rank);
  if (!item) return '';
  if (!Object.prototype.hasOwnProperty.call(item, 'threat_type')) {
    throw new Error(`topn 接口返回的第 ${rank + 1} 行没有 threat_type 字段：`
      + `${JSON.stringify(item).slice(0, 300)}（平台可能改了字段名）`);
  }
  return String(item.threat_type);
}

/**
 * J 列（第 `rank` 名，0 起）：该行 `attack_count` 原样落数字。
 *
 * 接口不通 -> 那句话；没这么多行 -> 空串（不写 0）；有行但缺字段 / 不是数字 -> 抛错。
 */
function threatTypeAttackCountAt(ctx, rank) {
  if (ctx.threatTypeRows === null) return THREAT_TYPE_UNAVAILABLE_TEXT;
  const item = threatTypeRowAt(ctx, rank);
  if (!item) return '';
  if (!Object.prototype.hasOwnProperty.call(item, 'attack_count')) {
    throw new Error(`topn 接口返回的第 ${rank + 1} 行没有 attack_count 字段：`
      + `${JSON.stringify(item).slice(0, 300)}（平台可能改了字段名）`);
  }
  const count = Number(item.attack_count);
  if (!Number.isFinite(count)) {
    throw new Error(`topn 接口返回的第 ${rank + 1} 行 attack_count 不是数字：`
      + `${JSON.stringify(item.attack_count)}`);
  }
  return count;
}

module.exports = {
  THREAT_TYPE_UNAVAILABLE_TEXT,
  THREAT_TYPE_SLOTS,
  threatTypeLabelAt,
  threatTypeAttackCountAt
};
