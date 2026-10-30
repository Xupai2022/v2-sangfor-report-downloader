'use strict';

/**
 * L62:M66「遭受外部攻击的主机 / 日志数量」十格的取值逻辑（用户口径 2026-10-20）。
 *
 * ⚠️ 表头写的是「遭受外部攻击的主机 / 日志数量」，用户投喂时叫「目的 IP Top 5 名称
 * 和对应的数量」，接口字段是 `dst_ip` —— 三处指的是同一个东西（被攻击的目的 IP）。
 * 本文件统一按接口字段叫「目的 IP」。
 *
 * 数据源是 topn 接口（与 F62:G66 / I62:J66 同一套两次问）：
 *   1) POST /gateway/workflow/order/v1/tool_box/topn/device_list
 *   2) POST /gateway/workflow/order/v1/tool_box/topn/dst_ip
 * 第二问的请求体与 src_ip_geo 逐字相同，只有 `ip_type` 从 `src_ip` 换成 `dst_ip`
 * （topn=5、date_scope=0、security_log、attack_direction=1、device_infos 同一套构造规则）。
 *
 * 取值口径（与前两块同一条）：
 *   · L 列 = 响应行里的 `dst_ip`，**行序照接口返回原样**，不按 attack_count 重排
 *   · M 列 = 同一行的 `attack_count`，落数字、不转字符串
 *   · 最多 5 行；少于 5 行时剩下的 L/M 都写空串（接口答了、就是没那么多）
 *   · 接口不通（ctx.dstIpRows === null）-> 十格都写「topn接口不通无法取值」
 *   · 行里缺 `dst_ip` / `attack_count`（平台改字段名）-> 抛错，只让那一格进
 *     errors，不静默写空（CELL_REGISTRY.md H6 / MIGRATION.md R10）
 *
 * ⚠️ 响应里的 `src_ip` 是**聚合过的**（如「202.0.134.111、202.0.100.138等14个IP」），
 * 与 `dst_ip`、`asset_name`、`threat_type` 一样只是附带的展示字段，本块一个都不读，
 * 只取 `dst_ip` 与 `attack_count`。
 *
 * ctx 契约见 stats/context.js 的 SOURCE_FIELDS（`dstIpRows`）：
 *   · `null`      = 接口不通（写那句话）
 *   · `[]`        = 接口答了、0 行（十格空串）
 *   · `undefined` = 归一成空数组（没有这个数据源 = 答了 0 行）
 */

/** 接口不通时十格统一写的那句话（用户口径 2026-10-19/20）。 */
const DST_IP_UNAVAILABLE_TEXT = 'topn接口不通无法取值';

/** 接口最多给 5 名（请求体 topn=5），多给也只认前 5 行。 */
const DST_IP_SLOTS = 5;

function dstIpRowAt(ctx, rank) {
  if (ctx.dstIpRows === null) return null;
  const rows = ctx.dstIpRows || [];
  return rows[rank] || null;
}

/**
 * L 列（第 `rank` 名，0 起）：该行 `dst_ip` 原样落字符串。
 *
 * 接口不通 -> 那句话；没这么多行 -> 空串；有行但缺字段 -> 抛错。
 */
function dstIpLabelAt(ctx, rank) {
  if (ctx.dstIpRows === null) return DST_IP_UNAVAILABLE_TEXT;
  const item = dstIpRowAt(ctx, rank);
  if (!item) return '';
  if (!Object.prototype.hasOwnProperty.call(item, 'dst_ip')) {
    throw new Error(`topn 接口返回的第 ${rank + 1} 行没有 dst_ip 字段：`
      + `${JSON.stringify(item).slice(0, 300)}（平台可能改了字段名）`);
  }
  return String(item.dst_ip);
}

/**
 * M 列（第 `rank` 名，0 起）：该行 `attack_count` 原样落数字。
 *
 * 接口不通 -> 那句话；没这么多行 -> 空串（不写 0）；有行但缺字段 / 不是数字 -> 抛错。
 */
function dstIpAttackCountAt(ctx, rank) {
  if (ctx.dstIpRows === null) return DST_IP_UNAVAILABLE_TEXT;
  const item = dstIpRowAt(ctx, rank);
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
  DST_IP_UNAVAILABLE_TEXT,
  DST_IP_SLOTS,
  dstIpLabelAt,
  dstIpAttackCountAt
};
