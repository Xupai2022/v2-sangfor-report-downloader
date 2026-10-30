'use strict';

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const https = require('https');
const path = require('path');

const { readMsswCookieInfo } = require('./cookie_reader');
const { encodePath } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');
const { withRetry } = require('./mssw_retry');
const { pagedExportMsswAssetList } = require('./mssw_asset_paged_export');

const DEFAULT_MSSW_BASE_URL = normalizeBaseUrl('sitmssw.soar.sangfor.com.cn');
// Referer 头的默认路径（与 origin 拼成 "<origin>/index.html"）
const DEFAULT_REFERER_PATH = '/index.html';

// 下载（requestBuffer）的超时。原先是硬编码 30s —— 资产表那种大 xlsx 在慢链路上
// 30s 不够；而下载是 GET、幂等可重试，放宽不吃亏。
const MSSW_DOWNLOAD_TIMEOUT_MS = 120000;

const MSSW_CUSTOMER_STATISTIC_ENDPOINT = '/gateway/customer-mgr-service/order/v1/user/customer_statistic';
const MSSW_INCIDENT_EXPORT_ENDPOINT = '/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incidents/export/tasks';

// 资产表：同步导出（无 task_id/轮询），列由 export_fields 接口决定
const MSSW_ASSET_EXPORT_FIELDS_ENDPOINT = '/apps/asset/view/asset/export_fields?_method=GET';
const MSSW_ASSET_EXPORT_ENDPOINT = '/apps/asset/view/asset/export';
const MSSW_ASSET_DOWNLOAD_ENDPOINT = '/apps/asset/view/asset/download_file';
const MSSW_ASSET_COUNT_ENDPOINT = '/apps/asset/view/asset/asset_view/count?_method=GET';

// ---- 设备列表（接入组件数量：D100/D101/D102/D104）----
// 与资产表同属 apex 侧、同一种「同步 JSON 查询」范式：POST 一个查询体、直接回数据。
// **不落盘**：它是取值层要的行对象，不是报告里的 sheet（没有下载件，也没有 parse* 环节），
// 所以这里只把 data.list 翻页收齐交给调用方，见 fetchMsswDeviceRows。
// 两个 query 参数照抓包原样带：viewRegionId 是服务端不校验的占位视图 id
// （与告警表那个 MSSW_ALERT_VIEW_INSTANCE_ID 同性质），onlySelfPlatform=false 表示
// 不限定本平台 —— 与参考实现 C:\...\health-checkup-report\src\mssw_client.js:33 逐字一致。
const MSSW_DEVICE_LIST_ENDPOINT = '/api/apex/device/v1/devices/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false';
// 设备列表每页条数。参考实现用的也是 1000（fetchMsswDeviceList 的默认 pageSize），
// 而设备台账的规模是"几十台"量级，正常一次就拉完。
const MSSW_DEVICE_PAGE_SIZE = 1000;
// 单个设备列表请求的超时（查询接口，同 fetchMsswAssetTotalCount 那档）
const MSSW_DEVICE_REQUEST_TIMEOUT_MS = 30000;

// ---- topn 源 IP 地域（攻击来源地域分布top5：F62:G66）----
// 与设备列表同属 workflow 侧、同一种「同步 JSON 查询」范式，但**是两次问**：
//   1) device_list：拿设备台账，拼出 src_ip_geo 请求体里的 device_infos；
//   2) src_ip_geo：拿报告期内攻击次数前 5 的源 IP 归属地。
// 两次都**不落盘**（没有下载件、没有 parse* 环节、报告里也没有对应的 sheet），
// 行对象直接交给 ctx（见 stats/context.js 的 SOURCE_FIELDS 与
// stats/metrics/top_src_geo.js 的头注）。
//
// device_infos 的构造（用户 2026-10-19 按抓包确认）：
//   · 只取 device_type（小写）与 device_info_list[].device_id
//   · **按 device_id 去重**：同一份台账里 SIP 两台设备可能共用同一个 id，
//     total 数的是行、不是唯一设备（抓包里 total=10、唯一 id=9）
//   · **不按 device_status 过滤**：抓包把 status=2（离线）的设备也带上了；
//     只取在线会凭空少几台，直接改变统计结果
//   · 空组（某类型一台设备都没有）不往请求体里塞
const MSSW_TOPN_DEVICE_LIST_ENDPOINT = '/gateway/workflow/order/v1/tool_box/topn/device_list';
const MSSW_TOPN_SRC_IP_GEO_ENDPOINT = '/gateway/workflow/order/v1/tool_box/topn/src_ip_geo';
// 威胁类型 Top5（I62:J66）：与 src_ip_geo 同一个请求体，只换端点。
const MSSW_TOPN_THREAT_TYPE_ENDPOINT = '/gateway/workflow/order/v1/tool_box/topn/threat_type';
// 目的 IP Top5（L62:M66）：同一个请求体，只换端点、并把 ip_type 换成 dst_ip。
const MSSW_TOPN_DST_IP_ENDPOINT = '/gateway/workflow/order/v1/tool_box/topn/dst_ip';
// 接口固定返回前 5 名（请求体 topn:5；抓包原样）。
const MSSW_TOPN_LIMIT = 5;
// 报告期由 latest_time（epoch 毫秒，本地日界闭区间）决定，date_scope 按用户口径固定 0。
const MSSW_TOPN_DATE_SCOPE = 0;
// 抓包原样的固定筛子：安全日志 + 攻击方向 1（外部→内部）。
// ⚠️ 这两个值是报告口径的一部分，别按接口默认值改写。
const MSSW_TOPN_ATTACK_TYPE = 'security_log';
const MSSW_TOPN_ATTACK_DIRECTION = '1';
// 查询接口超时：跨一年的聚合可能慢，沿用设备列表的 30s 略放宽。
const MSSW_TOPN_REQUEST_TIMEOUT_MS = 60000;

// ---- 第三方设备（接入组件数量：D103）----
// 与设备列表**不是同一个接口**：那边数的是深信服自己的设备（按 devType 分类），
// 这边是**第三方**（非深信服）应用实例的台账 —— 同一个 apex 范式、同一种
// 「同步 JSON 查询」，但两个接口的集合互不相交（D103 与 D100/D101/D102/D104 不重叠）。
// 参数与请求体逐字照参考实现 C:\...\health-checkup-report\src\mssw_client.js:34 与
// fetchMsswThirdPartyDeviceStats（那边只取 data.count）。
const MSSW_THIRD_PARTY_DEVICE_ENDPOINT = '/api/apex/thirdparty/v1/app/instance/list?viewRegionId=ffffffffffffffffffffffff&onlySelfPlatform=false';
// 参考实现请求体里写死的分页参数。本仓**只取 data.count**（接口报的总数），
// 不翻页也不按行重算 —— 所以这个 pageSize 只是"与抓包一致"的摆设，见
// fetchMsswThirdPartyDeviceCount 的头注。
const MSSW_THIRD_PARTY_PAGE_SIZE = 20;

// ---- 日志量（「xdr日志数」：G99；「已拦截外联次数」：D23）----
// 单跳两问：同一个聚合计数接口，`tableName` 分别给两张日志表的**英文标识符**，
// 各取 `data.total` 后**相加**（用户口径 2026-10-14，浏览器抓包）。
// ⚠️ 此前那套 `datalake/v1/ckTableQuery` 取表 id + `datalake/v1/ckCount` 的两跳写法
// **整个换掉了**，不是并存的两条路 —— 旧端点也别再当兜底。
const MSSW_LOG_COUNT_ENDPOINT = '/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/logs-aggregations-count';
// 两张日志表在**请求体**里的表名：这一路接口直接吃标识符，不问表清单、也不认表 id。
// `key` 只用来给返回值与日志行取字段名（数组顺序就是和式「网络安全 + 终端安全」的顺序）。
const MSSW_LOG_TABLES = [
  { key: 'network', tableName: 'network_security_log', label: '网络安全日志' },
  { key: 'endpoint', tableName: 'endpoint_security_log', label: '终端安全日志' }
];
// D23「已拦截外联次数」用的过滤串（用户口径 2026-10-14，逐张表照浏览器抓包）。
// 与 G99 是**同一个端点、同一批表**，只多这一条 `searchString`：
//   · 网络安全日志：`srcIpTag=1 AND dstIpTag=0` 就是「内→外」那个方向，
//     `action = 2` 是「已拦截」；两个条件是 AND（抓包原样，别拆成两句）
//   · 终端安全日志：终端日志没有方向概念，只有 `action = 2` 这一条
// 按 `key` 认表（表名与 label 只在 MSSW_LOG_TABLES 里写一份）。
const MSSW_INTERCEPTED_OUTBOUND_FILTERS = {
  network: 'filter srcIpTag=1 AND dstIpTag=0 AND action = 2',
  endpoint: 'filter action = 2'
};
// D61「外部攻击日志数量（XDR）」用的过滤串（用户口径 2026-10-17，浏览器抓包原样）。
// 与 G99/D23 是**同一个端点**，但**只问网络安全日志这一张表**（抓包的 `tableName`
// 里只有 `network_security_log`）：
//   · `srcIpTag=0 AND dstIpTag=1` 是「外→内」那个方向 —— 与 D23 的「内→外」
//     正好反过来（D23 是 `srcIpTag=1 AND dstIpTag=0`），即「从外部打进来的攻击日志」
//   · 抓包里**没有**「已拦截」`action = 2` 这一条 —— 本格数的是全部外部攻击日志，
//     不是其中被拦下的那一部分
//   ⚠️ 终端安全日志没有方向概念，抓包里也没有这一张表 —— 别顺手补上第二问。
const MSSW_EXTERNAL_ATTACK_FILTER = 'filter srcIpTag=0 AND dstIpTag=1';
// C73:N73「恶意外联数（按月）」用的过滤串（用户口径 2026-10-20：
// 「请求体条件是 srcIpTag=1 AND dstIpTag=0」）—— 「内→外」，与上面那条正好反方向。
// ⚠️ 与 D23「已拦截外联次数」**不是同一条**：D23 的抓包串还带 `action = 2`（只要已拦截的），
// 用户这次给的条件里**没有**那一条 —— 本块数的是全部「内→外」日志，不管拦没拦下。
// `filter` 前缀是平台 searchString 的写法（与 D61 / D23 抓包同一形态），用户口述的是条件本体。
const MSSW_MALICIOUS_OUTBOUND_FILTER = 'filter srcIpTag=1 AND dstIpTag=0';
// D23 的第二问（终端安全日志）在抓包里是 `pageSize: 60`、G99 也是 60 —— 两处都只取
// `data.total`，分页参数与口径无关（见 buildMsswLogCountRequestBody）。
// 日志量查询的超时：抓包不带超时；跨一年日志的聚合计数可能慢，沿用这一路原先给的 90s。
const MSSW_LOG_REQUEST_TIMEOUT_MS = 90000;
// 日志量接口的时区头（抓包原样）：请求体里的起止是 epoch 秒，这个头告诉服务端按哪个时区解释。
const MSSW_LOG_TIME_ZONE = 'Asia/Shanghai';

// 资产数量超过此值直接走分页导出，不等默认导出超时（省一次 10 分钟白等）
const PAGED_EXPORT_THRESHOLD = 10000;
// 分页导出总开关：置 true 可绕过分页路径，回归"默认导出超时即失败"的旧行为，便于排查
const DISABLE_PAGED_EXPORT = false;

// ---- 告警表（安全告警）导出 ----
// 与事件表同属"异步任务"范式：触发建任务 → 轮询任务结果 → 按结果里的文件路径下载。
// 但端点在 ngsoc 侧而非 mss-mdr 网关，且请求体是整份视图配置，不是简单的 filters。
const MSSW_ALERT_EXPORT_ENDPOINT = '/ngsoc/INCIDENT/api/v1/operation/task/add/exportAlertExcel';
const MSSW_ALERT_TASK_RESULT_ENDPOINT = '/ngsoc/INCIDENT/api/v1/operation/task/result';
const MSSW_ALERT_TABLE_SERVICE_INFO = {
  appName: 'incident',
  servletContextPath: '/',
  serviceType: 'table',
  handler: 'alertTableQueryHandler'
};
const MSSW_ALERT_EXPORT_SERVICE_INFO = {
  appName: 'incident',
  servletContextPath: '/',
  serviceType: 'batchOperation',
  handler: 'exportAlertExcel'
};
// 不透明的视图关联 id，服务端**不做校验**：实测填 'deadbeef…' 也返回 code=0，
// 只有传空串才失败。取抓包里的值，仅用于让请求与浏览器侧一致。
const MSSW_ALERT_VIEW_INSTANCE_ID = '69af9592ab099826f3ac3e67';

// ---- 弱密码表（内网 / 互联网两份独立导出，导出与下载都在 v1） ----
//
// ⚠️「弱密码表」是**两份独立导出**：
//   · 内网弱密码表：POST /order/v1/vul_manage/vul_risk_export
//   · 互联网弱密码表：POST /order/v1/internet_vul_manage/vul_risk_export
//     （见下方 MSSW_INTERNET_WEAKPWD_* 那一段）
// 两份的导出请求体**不能互相套用**（互联网那份键集更小、字段与视图配置不同），
// 下载都走 v1 的 download_file。报告里各落一张 sheet（「内网弱密码表」「互联网弱密码表」），
// 取值层把两份行拼成一份再算（全表 = 两份相加）。
//
// 两份的列集都**不是写死的**：发导出前先打各自的 custom_headers 接口
// （POST，body `{"header_id": ...}`）拿回三段视图配置，把所有 item 的 selected 置 true
// 后原样回传。请求序列因此是「取列配置 → 导出 → 下载」三步。
//
// 第三种范式：**同步阻塞导出**。没有 task_id、没有轮询、没有状态接口 ——
// 建任务的 POST 自己就是"建任务 + 等导出完成"，回 `{code:0, data:{file_name}}`
// （浏览器里那段"卡一下"就是这个请求在等）。弱密码表实测很小（94 行，1.3s），
// 但 600s 上限保留：大宗客户的行数增长没有实测数据，超时只说明平台卡住。
// 返回的 file_name 再拿去 download_file 换文件，两步之间没有等待（实测 0.6s 拿到）。
const MSSW_WEAKPWD_EXPORT_ENDPOINT = '/order/v1/vul_manage/vul_risk_export';
const MSSW_WEAKPWD_DOWNLOAD_ENDPOINT = '/order/v1/vul_manage/download_file';
// 内网弱密码表的视图配置接口（导出前必调）。header_id 是平台的列预设枚举。
const MSSW_VUL_MANAGE_CUSTOM_HEADERS_ENDPOINT = '/order/v1/vul_manage/custom_headers';
const MSSW_WEAKPWD_HEADER_ID = 'week_pass_1';

// 同步导出的等待上限。弱密码表实测小（94 行，1.3s），600s 是给大宗客户留的富余；超时只说明
// 平台卡住，继续等没有意义（与告警轮询的 600s 同量级）。
const MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS = 600000;

/**
 * 内网弱密码表导出的筛选器，**一律留空 = 不过滤**。
 *
 * 时间范围不在这个常量里 —— 它由 buildMsswVulManageExportRequestBody 现算
 * （走 resolveVulManageTimeRangeMs），键名见 MSSW_VUL_MANAGE_TIME_RANGE_KEY。
 * fixed_status 保持空数组：全量拉回后在本地删「处置完成（误报）」的行（判据见
 * MSSW_VUL_MANAGE_DROP_STATUS_VALUES），不让服务端按处置状态筛。
 * 视图配置（custom_headers）同样不在这个常量里：导出前现取（见 fetchWeakPwdCustomHeaders）。
 */
const MSSW_VUL_MANAGE_BASE_FILTERS = {
  asset_ip: { op: '=', val: '' },
  asset_manager: { op: '=', val: '' },
  asset_status: [],
  asset_tags: [],
  asset_type: 'all',
  attack_state: [],
  branch_ids: [],
  disposal_tag: [],
  exposure: [],
  fix_priority: [],
  fixed_status: [],
  group_ids: [],
  keyword: '',
  keyword_all: '',
  magnitude: [],
  name: { op: '=', val: '' },
  order_status: [],
  platform_ids: [],
  platform_filter: [],
  retest_status: [],
  source_device: [],
  whitelisted_status: [],
  // 明文导出（不是脱敏）。这个开关直接决定返回的「密码」列里有没有值。
  is_show: 1
};

// ---- 互联网弱密码表（与内网弱密码表是两次独立导出，视图配置各自现取） ----
//
// 内网 / 互联网是**两个后端服务**，请求体键集与视图配置都不一样，不能互相套用：
// 互联网这份导出请求体只有六个键（见 buildMsswInternetWeakPwdExportRequestBody），
// 内网那份带着一整组空筛选器（见 MSSW_VUL_MANAGE_BASE_FILTERS）。
//
// 下载**不能**沿用内网的 `/order/v1/vul_manage/download_file`：那个端点会拿文件名做
// 归属校验，喂它互联网导出的文件名会被判为格式不合法。互联网这份有自己的
// `/order/v1/internet_vul_manage/download_file`。
const MSSW_INTERNET_WEAKPWD_EXPORT_ENDPOINT = '/order/v1/internet_vul_manage/vul_risk_export';
const MSSW_INTERNET_WEAKPWD_DOWNLOAD_ENDPOINT = '/order/v1/internet_vul_manage/download_file';
// 互联网弱密码表的视图配置接口（导出前必调）。
const MSSW_INTERNET_WEAKPWD_CUSTOM_HEADERS_ENDPOINT = '/order/v1/internet_vul_manage/custom_headers';
const MSSW_INTERNET_WEAKPWD_EXPORT_TIMEOUT_MS = 600000;
const MSSW_INTERNET_WEAKPWD_HEADER_ID = 'internet_weak_pwd_1';
const MSSW_INTERNET_WEAKPWD_DATA_TYPE = 'weak_pwd';

/**
 * 互联网弱密码表导出请求体。
 *
 * **键集照抄平台的六个键，不拿内网那份补齐**：补了就是替平台猜契约。
 * 时间键仍是 found_time_range（首次发现时间），与内网弱密码表同一语义、
 * 同一单位（epoch 毫秒）。视图配置（custom_headers）导出前现取后传进来。
 *
 * @param {number[]} [timeRangeMs] 报告期区间；空数组 = 全量
 * @param {object} customHeaders  fetchInternetWeakPwdCustomHeaders 的返回值
 */
function buildMsswInternetWeakPwdExportRequestBody(timeRangeMs = [], customHeaders = {}) {
  return {
    data_type: [MSSW_INTERNET_WEAKPWD_DATA_TYPE],
    fixed_status: [],
    [MSSW_VUL_MANAGE_TIME_RANGE_KEY]: timeRangeMs,
    header_id: MSSW_INTERNET_WEAKPWD_HEADER_ID,
    custom_headers: customHeaders,
    // 明文导出（不是脱敏）。这个开关直接决定返回的「密码」列里有没有值。
    is_show: 1
  };
}

/**
 * 报告期在 vul_manage 请求体里的写法 —— 平台把「按哪一列圈」直接编进了**键名**：
 *   found_time_range  = 首次发现时间 ← 2026-10-10 用户给的漏洞表、弱密码表两份抓包都是它
 *   latest_time_range = 最近发现时间 ← 2026-10-09 及更早的抓包（已废）
 *
 * 不按 kind 分：两张表同一天、同一套视图配置的两次抓包**一起换的**，没有分叉的证据。
 * 与事件表改用 created_time（创建时间）、告警表改用 firstTime（首次发生时间）是同一波改动 ——
 * 平台侧默认从「最近」挪到了「首次/创建」。
 *
 * ⚠️ 这不是纯改名：键名换掉 = 圈的是**另一列**。实测同一客户 13301 行漏洞里，
 * 「最近发现时间」与「首次发现时间」有 2373 行不同，换错列会静默给出另一批数据。
 */
const MSSW_VUL_MANAGE_TIME_RANGE_KEY = 'found_time_range';
const MSSW_VUL_MANAGE_TIME_RANGE_LABEL = '首次发现时间';

/**
 * vul_manage 下两条导出路径的差异清单 —— 路由用 kind（vuln / weakpwd）。
 *
 * ⚠️ 现在**只有 weakpwd 真能发出去**：triggerMsswVulManageExport 会对
 * kind !== 'weakpwd' 直接报错，漏洞表走异步报告导出那条路。
 * vuln 这一项留着只因为请求体构造（buildMsswVulManageExportRequestBody）还按它比对。
 *
 * extraFilters 是各自独有的筛选器键：**照抄抓包、不互相补**。看着"漏了几个空数组"
 * 别顺手补齐，那是在替平台猜它的请求契约。
 *
 * 视图配置（custom_headers）不在这里：两张表都是导出前现取（见 fetchWeakPwdCustomHeaders）。
 */
const MSSW_VUL_MANAGE_KINDS = {
  vuln: {
    label: '漏洞表',
    dataType: 'loophole',
    headerId: 'loophole_1',
    extraFilters: {
      attack_type: '',
      cve: { op: '=', val: '' },
      risk_level: [],
      scan_type: [],
      threat_tag: []
    }
  },
  weakpwd: {
    label: '内网弱密码表',
    dataType: 'weak_pwd',
    headerId: MSSW_WEAKPWD_HEADER_ID,
    extraFilters: {}
  }
};

// ---- 暴露面表（六份总表的最后一份，2026-10-15 接入）----
// 第四种范式：**异步任务 + 轮询 + 附件下载**，但三段都跟前三种不一样：
//   1. 建任务 POST 一个极简请求体（只有 company_id 与几个空数组），回 `data.task_id`（**字符串**）；
//   2. 轮询 POST `{task_id_list:[...]}` 到**另一个端点**（不是 .../query 那种后缀），
//      回的是 `data.rotation_status` + `data.attachment_list[]`；
//   3. 文件**不在本服务的下载接口上**，而是通用附件端点
//      `/gateway/workflow/order/v1/attachments?_file=<文件 id>`（轮询响应里给的全路径）。
//
// ⚠️ **请求体里没有任何时间参数**（用户口径 2026-10-15：照抓包，不带）：
// 这份表与其他五份不同，不受 --start/--end 影响 —— 导的是平台**当前**的暴露面，
// 报告期只影响别处（J1/L1 那几格仍由 CLI 直传）。
// 别顺手补个 found_time_range：键名、列、单位一个都没投喂过，补了就是替平台猜契约。
const MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report';
const MSSW_EXPOSED_SURFACE_TASK_ENDPOINT = '/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report_async_task';
// 附件下载端点 = 轮询响应里 `attachment_list[].url` 的路径部分。
// 它属于 workflow 服务、不归 easm-exposure 管，所以**不自己拼 URL**：以响应给的为准，
// 这里只留一份前缀当注释与测试锚点（响应里给的形状见 buildMsswExposedSurfaceAttachmentUrl）。
const MSSW_EXPOSED_SURFACE_ATTACHMENT_PATH = '/gateway/workflow/order/v1/attachments';
// 请求体里的 data_type —— 抓包原样（50 = 暴露面）。这个数是**接口的枚举**，
// 不是可以跟着别的表抄的值：换一个数就是另一份数据。
const MSSW_EXPOSED_SURFACE_DATA_TYPE = 50;
// 轮询上限：与告警表同量级（异步导出，服务端排队的等待比同步导出的 600s 更不可控）。
const MSSW_EXPOSED_SURFACE_POLL_TIMEOUT_MS = 600000;

/**
 * 落盘后删行判据 —— 事件表 / 漏洞表 / 弱密码表都读表自带的「处置状态」列，命中即整行删除。
 *
 * 判据取自用户口径（事件表「已忽略」；漏洞表与弱密码表 2026-10-08「处置完成（误报）」），
 * 不靠接口拉 ID 清单：那样会受分页抖动、跨系统 ID 对齐影响。
 * 实际匹配在 scripts/remove_rows_by_status.py：列要精确命中，值要相等 ——
 * 只有括号全半角/空白差异的写法也算命中，但会在诊断里逐条列出来。
 */
const DISPOSAL_STATUS_COLUMN = '处置状态';
const MSSW_INCIDENT_DROP_STATUS_VALUES = ['已忽略'];
const MSSW_VUL_MANAGE_DROP_STATUS_VALUES = ['处置完成（误报）'];
/** 精确匹配不到「处置状态」时的子串退路（只对事件表用；漏洞/弱密码表列多，留退路容易挑错列）。 */
const MSSW_INCIDENT_STATUS_COLUMN_ALIASES = ['处理状态', '处置情况'];

/**
 * 事件表导出字段。导出 xlsx 的列名由平台按这些字段渲染成中文表头，
 * 因此这个清单同时决定了后续处理里出现的列名。
 *
 * 末尾三列（manage_status / contain_time / dispose_time）按 2026-10-10 的浏览器抓包补齐 ——
 * 加列不影响取值层（那里按中文表头找列），但不加就与平台前端发的请求体不一致。
 *
 * push_status（导出后表头为「推送状态」）是**长期约定**，2026-10-12 用户口径：
 * 平台抓包/请求体示例未必带它，但事件表导出**每份请求体都要有这一条**，
 * 后续无论用户再给什么格式的事件表导出请求体样例，都要把这列补进去 ——
 * 抓包里的字段清单只是起点、不是边界，push_status 是叠在上面的固定增量。
 * 换句话说：拿新抓包对齐请求体时，**去掉 push_status 再对齐，加回来**；
 * tmp/verify_incident_body/run_check.js 里那句逐字比对的 REFERENCE 也按这个规则维护。
 *
 * 只多导出一列，取值层要不要用它另说（那里按中文表头找列，不受影响）。
 */
const MSSW_INCIDENT_EXPORT_FIELDS = [
  'severity', 'name', 'company_name', 'host_ip', 'end_time',
  'attack_state', 'created_time', 'current_handler_name', 'deal_status',
  'incident_id', 'host_group_names', 'dev_source_name',
  'incident_threat_class', 'incident_threat_type', 'src_ip', 'dst_ip', 'ioc',
  'service_manager_name', 'service_group_name', 'checkout_time', 'start_time',
  'status_note', 'finished_time', 'gpt_result', 'gpt_sub_result',
  'manage_status', 'contain_time', 'dispose_time', 'push_status'
];

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * 归一化成完整 origin（含 scheme）。
 *
 * 裸域名（如 sitmssw.soar.sangfor.com.cn）→ 补 https://，与历史行为**逐字相同**；
 * 已带 scheme 的原样保留 —— 集群入口是明文 http + 端口的
 * http://mssw-inner.sangfor.com.cn:30001（入口按环境不同，见 config/api_config.json）。
 */
function resolveOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) {
    return `https://${DEFAULT_MSSW_BASE_URL}`;
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * 取请求的 host 头。
 *
 * - 显式传了就用它；传 '' 表示**不发** host 头（交给 URL 自带）
 * - 没传则等于 origin 的 host[:port] —— 裸域名场景与历史的 `host: 域名` 逐字相同
 */
function hostHeaderFor(origin, explicit) {
  if (explicit !== undefined && explicit !== null) {
    return String(explicit);
  }
  const raw = String(origin || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    return normalizeBaseUrl(raw) || DEFAULT_MSSW_BASE_URL;
  }
  return new URL(raw).host;
}

/**
 * 由 options 造平台描述符 { origin, hostHeader, refererPath }。
 *
 * 这是「本地 vs 集群」的唯一差异注入点：
 * - 本地：不传 msswHostHeader → host 头等于域名，origin 走 https://<域名>
 * - 集群：由 session.js 传入内网 origin + 统一 Host 头 inner.sangfor.com.cn
 */
function resolvePlatform(options = {}) {
  const origin = resolveOrigin(options.msswBaseUrl || options.msswOrigin);
  return {
    origin,
    hostHeader: hostHeaderFor(origin, options.msswHostHeader),
    refererPath: options.msswRefererPath || DEFAULT_REFERER_PATH
  };
}

/** 容错：内部函数一律吃描述符，但仍兼容传字符串的老调用方。 */
function ensurePlatform(platform) {
  if (typeof platform === 'string') {
    return resolvePlatform({ msswBaseUrl: platform });
  }
  if (!platform || typeof platform !== 'object') {
    return resolvePlatform({});
  }
  return platform;
}

/** 拼完整接口 URL：origin 已含 scheme（+ 集群下的端口），路径一律以 / 开头。 */
function platformEndpoint(platform, endpointPath) {
  const p = ensurePlatform(platform);
  return `${p.origin}${endpointPath}`;
}

function logInfo(logger, message) {
  if (typeof logger === 'function') {
    logger(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMsswHeaders(cookieString, platform, overrides = {}) {
  const p = ensurePlatform(platform);
  const headers = {
    host: p.hostHeader,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    cookie: cookieString,
    origin: p.origin,
    referer: `${p.origin}${p.refererPath}`,
    'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
    ...overrides
  };
  // hostHeader 为空串 = 明确要求不发 host 头（交给 URL 自带）
  if (!p.hostHeader) {
    delete headers.host;
  }
  return headers;
}

/**
 * 带租户的导出请求头，接口调用一律用这个。
 *
 * 不发 x-csrf-token：cookie 里的 csrf_token 不是鉴权项（唯一必需的是 soc-token），
 * 2026-09-24 起各接口实测都不需要它，故整体移除、不留兜底值。
 */
function buildMsswExportHeaders(cookieInfo, platform, companyId, overrides = {}) {
  return buildMsswHeaders(cookieInfo.cookieString, platform, {
    'x-mssw-company-id': String(companyId || ''),
    ...overrides
  });
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * 资产接口专用头：带随机 traceid。
 * 注意下载资产文件时用的是服务端生成的 trace 标识，因此这里刻意与导出头区分开。
 */
function buildMsswAssetExportHeaders(cookieInfo, platform, companyId) {
  return buildMsswHeaders(cookieInfo.cookieString, platform, {
    traceid: generateUUID(),
    'x-mssw-company-id': String(companyId || '')
  });
}

/**
 * 调用点给的重试策略 -> 归一化。
 *
 * onTimeout 的默认值取决于方法：超时意味着请求**可能已被服务端受理**，非幂等的 POST
 * （建导出任务）重试会变成建两个任务，所以默认只有 GET 重试；幂等的查询（事件/告警轮询）
 * 与下载由调用点显式打开。
 *
 * attempts 只在调用点给了值时才带上 —— 让 mssw_retry 的默认值保持唯一一处定义。
 */
function normalizeRetryPolicy(retry, method) {
  const cfg = retry || {};
  const policy = {
    baseDelayMs: cfg.baseDelayMs,
    onTimeout: cfg.onTimeout == null ? method === 'GET' : cfg.onTimeout,
    logger: cfg.logger,
    label: cfg.label
  };
  if (cfg.attempts != null) {
    policy.attempts = cfg.attempts;
  }
  return policy;
}

/**
 * 带重试的 JSON 请求：六张表的所有请求都从这一门过，重试逻辑不必在 export* 里再写一遍。
 *
 * 判据（哪些错该重试）全在 mssw_retry；这里只负责把「方法 + 调用点策略」翻成策略，
 * 以及给日志一个能定位到接口的 label。
 */
async function requestJson(url, { headers, body, timeout, retry }) {
  const method = body === undefined ? 'GET' : 'POST';
  const policy = normalizeRetryPolicy(retry, method);
  policy.label = policy.label || `MSSW 请求 ${method} ${new URL(url).pathname}`;
  return withRetry(() => requestJsonOnce(url, { headers, body, timeout }), policy);
}

async function requestJsonOnce(url, { headers, body, timeout }) {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;
  const timeoutMs = Number(timeout) || 30000;
  const method = body === undefined ? 'GET' : 'POST';

  return new Promise((resolve, reject) => {
    const req = transport.request(parsedUrl, {
      method,
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          parsed = text;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          // **必须带上是哪个接口**：一次 generate 有十几个调用点（找客户 ID → 建导出任务
          // → 轮询 → 下载 → 资产分页…），只说「403」等于什么都没说 ——
          // 2026-09-24 那次 9451 就是卡在这里，日志里看不出是哪一个请求。
          // 只给 path，不给 query（`?` 后面的东西没必要进日志）。
          reject(Object.assign(new Error(
            `MSSW 请求失败 ${res.statusCode} [${method} ${parsedUrl.pathname}]: `
            + `${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 500)}`
          ), { statusCode: res.statusCode }));
          return;
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      // timedOut 与「连接层 errno」分开：超时的请求可能已被服务端受理，
      // 该不该重试要看调用点（非幂等的建任务不重试），判据见 mssw_retry。
      req.destroy(Object.assign(new Error(`MSSW 请求超时: ${url}`), { timedOut: true }));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function requestBuffer(url, { headers, timeout, retry }) {
  const policy = normalizeRetryPolicy(retry, 'GET');
  policy.label = policy.label || `MSSW 下载 ${new URL(url).pathname}`;
  return withRetry(() => requestBufferOnce(url, { headers, timeout }), policy);
}

async function requestBufferOnce(url, { headers, timeout }) {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;
  const timeoutMs = Number(timeout) || MSSW_DOWNLOAD_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const req = transport.request(parsedUrl, {
      method: 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // 同 requestJson：带上接口，否则「下载失败 403」无法定位是哪一份表。
          reject(Object.assign(new Error(
            `MSSW 下载失败 ${res.statusCode} [GET ${parsedUrl.pathname}]: `
            + `${buffer.toString('utf8').slice(0, 500)}`
          ), { statusCode: res.statusCode }));
          return;
        }
        resolve({
          buffer,
          headers: res.headers,
          statusCode: res.statusCode
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      // 下载是 GET、幂等，超时重试安全（downloadMssw*File 都开了 onTimeout）。
      req.destroy(Object.assign(new Error(`MSSW 下载请求超时: ${url}`), { timedOut: true }));
    });
    req.end();
  });
}

/**
 * 解析 YYYY-MM-DD 为本地时区秒级时间戳。
 * @param {string|number} value
 * @param {boolean} [endOfDay] true 取当天 23:59:59，否则 00:00:00
 * @returns {number|null} 秒级时间戳
 */
function parseLocalDate(value, endOfDay = false) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    return Number(value);
  }

  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`日期格式无效: ${value}，请使用 YYYY-MM-DD`);
  }

  const [, year, month, day] = match.map(Number);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * 把 CLI 的本地日期范围解析成 epoch 秒。
 *
 * 注意调用方对单位的需求不同：事件表与漏洞/弱密码表要毫秒（走 resolveMsswTimeRangeMs），
 * 告警表直接吃秒。
 */
function resolveMsswTimeRange(options = {}, label = '事件导出') {
  const begin = parseLocalDate(options.begin || options.start, false);
  const end = parseLocalDate(options.end, true);
  if (!begin || !end) {
    throw new Error(`MSSW ${label}需要 --start YYYY-MM-DD 和 --end YYYY-MM-DD`);
  }
  if (begin > end) {
    throw new Error(`MSSW ${label}时间范围无效: --start 不能晚于 --end`);
  }
  return { begin, end };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 同样的日期范围，解析成 epoch **毫秒**的本地日界闭区间：
 * 起 = 起日 00:00:00.000，止 = 止日 23:59:59.999。
 *
 * 事件表（filters.created_time）与漏洞/弱密码表（found_time_range）共用这一处定义 ——
 * 两份抓包的收尾都是 ...599999，各算一遍迟早算岔。
 *
 * 为什么不复用 resolveMsswTimeRange 的返回值：那个函数取的是当天 23:59:59.**999**，
 * 再 floor 到秒就变成 23:59:59.000，收尾正好差 999ms。校验仍然复用它（格式 + 起止先后），
 * 毫秒值从原始日期重算。
 */
function resolveMsswTimeRangeMs(options = {}, label = '事件导出') {
  const rawStart = options.begin || options.start;
  resolveMsswTimeRange(options, label);

  const startMs = parseLocalDate(rawStart, false) * 1000;
  const endMs = parseLocalDate(options.end, false) * 1000 + MS_PER_DAY - 1;
  return [startMs, endMs];
}

/**
 * 事件表导出请求体。
 *
 * 时间键是 `filters.created_time`（创建时间），毫秒闭区间，**不是 `end_time`**。
 * 2026-10-10 用户给的浏览器抓包改用「创建时间」圈报告期；此前按「结束时间」过滤，
 * 回来的行集跟报告期对不上 —— 而且不报错，只有对着时间列核才发现。
 *
 * 其余键也照那份抓包逐字对齐：`export_company_range: 'all'` + `selection` 取代了早先的
 * format / is_all / my_customer / event_id_list 那套（早先那套能跑通，但平台前端已经这么发了，
 * 跟着平台的写法走，下次抓包比对时不会再出现一堆无谓的差异）。
 *
 * @param {number[]} timeRangeMs filters.created_time，见 resolveMsswTimeRangeMs；必填 ——
 *   这个接口没有「全量」模式，缺时间范围要当场报错而不是发一份不圈时间的请求。
 */
function buildMsswIncidentExportRequestBody({ timeRangeMs, companyId, fields }) {
  if (!Array.isArray(timeRangeMs) || timeRangeMs.length !== 2) {
    throw new Error('事件表导出请求体缺少 created_time 时间范围（[-startMs, -endMs]）');
  }

  return {
    filters: {
      created_time: timeRangeMs,
      customer_type: 'single_customer',
      company_ids: [String(companyId)]
    },
    sorts: [{ field: 'sla_deadline', order: 'asc' }],
    export_mode: 'custom',
    export_company_range: 'all',
    selection: { is_select_all: 0, select_incident_ids: [] },
    fields: fields || MSSW_INCIDENT_EXPORT_FIELDS
  };
}

/** 创建导出任务，返回 task_id。 */
async function triggerMsswIncidentExport(cookieInfo, platform, options) {
  const timeRangeMs = options.timeRangeMs || resolveMsswTimeRangeMs(options);
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_INCIDENT_EXPORT_ENDPOINT);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswIncidentExportRequestBody({ timeRangeMs, companyId })),
    // 建任务是**非幂等**的：只重试连接层错（请求根本没出去），超时不重试 ——
    // 超时多半是服务端已在处理，再发一次就是两个任务。attempts 给 2 而不是 3，
    // 因为失败在这里基本只有「网络不通」一种，多打一次就够判断了。
    retry: { logger: options.logger, label: '事件导出建任务', attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 事件导出创建任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/** 轮询导出任务直到 completed，返回最终响应（含 download_url / file_name）。 */
async function pollMsswIncidentExportTask(cookieInfo, platform, taskId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const intervalMs = Number(options.pollIntervalMs || 3000);
  const startedAt = Date.now();
  const logger = options.logger;
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, `${MSSW_INCIDENT_EXPORT_ENDPOINT}/query`);
  let lastStatus = '';

  while (Date.now() - startedAt <= timeoutMs) {
    const response = await requestJson(url, {
      headers,
      body: JSON.stringify({ task_id: taskId }),
      // 查询是幂等的，超时也重试：轮询中途抖一下不该让前面等的时间全白费。
      retry: { logger, label: '事件导出轮询', onTimeout: true }
    });

    const code = response && response.code;
    if (code !== 0 && code !== '0') {
      throw new Error(`MSSW 事件导出查询任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
    }

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const status = String(data.status || '').toLowerCase();

    if (status !== lastStatus) {
      logInfo(logger, `事件导出任务状态: ${status}`);
      lastStatus = status;
    }

    if (status === 'completed') {
      return response;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`MSSW 事件导出失败: ${data.error_msg || '未知错误'}`);
    }

    await sleep(intervalMs);
  }

  throw new Error(`MSSW 事件导出轮询超时: ${timeoutMs}ms`);
}

/**
 * 下载导出文件到指定目录。
 *
 * 与其它接口不同，下载要按二进制读，且必须去掉 x-requested-with / content-type，
 * 否则会被网关当作普通 XHR 拦掉。
 */
async function downloadMsswIncidentFile(cookieInfo, platform, taskId, downloadDir, filename, companyId, { logger } = {}) {
  const downloadUrl = platformEndpoint(platform, `${MSSW_INCIDENT_EXPORT_ENDPOINT}/${taskId}/download`);

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: '*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  // 下载是 GET、幂等：默认 3 次、超时也重试（onTimeout 的默认值见 normalizeRetryPolicy）。
  const downloaded = await requestBuffer(downloadUrl, {
    headers,
    retry: { logger, label: '事件表下载' }
  });
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename,
    downloadUrl
  };
}

/**
 * 告警表导出请求体里的 tableFields。
 *
 * 每项: [field, show, selected, sort, columnWidth, dataType]，转录自浏览器抓包。
 *
 * 只列 selected=true 的字段。抓包里还有一批 show=true/selected=false（gpt*、
 * siemuserDefine*）和大量 show=false/selected=false 的字段，**故意不带**：
 * 实测导出接口并不按这里的 selected 决定列，服务端按自己的 schema 展开，
 * 连没请求的字段（GPT 研判、INT/LONG/STRING/BOOL 等）也会出列。
 * 所以这份清单对列集没有影响，带上只是徒增请求体体积。
 *
 * **列集是数据相关的，不是固定的**：同一接口同一参数，116 条数据时 77 列，
 * 0 条时只有 68 列 —— 少掉的 9 列（用户代理1/部门/登录名/INT/LONG/STRING/
 * BOOL/P13账号/黑名单软件名称）是整列无值就不出现。
 * 因此下游解析**必须按列名取，绝不能按列下标**。
 */
const MSSW_ALERT_TABLE_FIELDS = [
  ['lastTime', true, true, 'desc', 130, 'value'],
  ['name', true, true, 'disable', 200, 'value'],
  ['operationLabels', true, true, 'disable', 330, 'array'],
  ['severity', true, true, 'disable', 116, 'value'],
  ['srcIp', true, true, 'disable', 125, 'array'],
  ['dstIp', true, true, 'disable', 125, 'array'],
  ['hostIp', true, true, 'disable', 145, 'value'],
  ['accessDirection', true, true, 'disable', 110, 'value'],
  ['attackResult', true, true, 'disable', 126, 'value'],
  ['dealStatus', true, true, 'disable', 126, 'value'],
  ['devSourceNames', true, true, 'disable', 180, 'array'],
  ['trafficForwardLocation', true, true, 'disable', 200, 'array'],
  ['firstTime', true, true, 'disable', 136, 'value'],
  ['threatDefine', true, true, 'disable', 95, 'array'],
  ['uuId', true, true, 'disable', 300, 'value'],
  ['incidentRootIds', true, true, 'disable', 150, 'array'],
  ['xForwardedFor', true, true, 'disable', 125, 'array'],
  ['srcPort', true, true, 'disable', 110, 'array'],
  ['dstPort', true, true, 'disable', 110, 'array'],
  ['platformHostBranchId', true, true, 'disable', 150, 'value'],
  ['dealAction', true, true, 'disable', 132, 'value'],
  ['devUId', true, true, 'disable', 150, 'array'],
  ['devUIdProxy', true, true, 'disable', 120, 'array'],
  ['platformHostGroupIds', true, true, 'disable', 150, 'array'],
  ['newestUsername', true, true, 'disable', 150, 'value'],
  ['checkOutUsername', true, true, 'disable', 150, 'value'],
  ['responsible', true, true, 'disable', 80, 'value'],
  ['mssStatus', true, true, 'disable', 150, 'value'],
  ['incidentRelated', true, true, 'disable', 150, 'value'],
  ['similarId', true, true, 'disable', 100, 'value'],
  ['similarRuleId', true, true, 'disable', 100, 'value'],
  ['xUserName', true, true, 'disable', 150, 'value'],
  ['xUserGroup', true, true, 'disable', 150, 'value'],
  ['respStatus', true, true, 'disable', 110, 'value'],
  ['requestHead', true, true, 'disable', 150, 'value'],
  ['responseHead', true, true, 'disable', 150, 'value'],
  ['requestBody', true, true, 'disable', 150, 'value'],
  ['responseBody', true, true, 'disable', 150, 'value'],
  ['confidence', true, true, 'disable', 110, 'value'],
  ['stage', true, true, 'disable', 100, 'value'],
  ['natTransform', true, true, 'disable', 150, 'value'],
  ['whiteStatus', true, true, 'disable', 100, 'value'],
  ['engineName', true, true, 'disable', 140, 'array'],
  ['virusName', true, true, 'disable', 140, 'array'],
  ['threatClass', true, true, 'disable', 150, 'value'],
  ['threatTypeProxy', true, true, 'disable', 150, 'value'],
  ['threatSubTypeProxy', true, true, 'disable', 150, 'value'],
  ['riskTag', true, true, 'disable', 180, 'value'],
  ['attckTechnique', true, true, 'disable', 150, 'array'],
  ['attckSubTechnique', true, true, 'disable', 150, 'array'],
  ['fileMd5', true, true, 'disable', 180, 'array'],
  ['url', true, true, 'disable', 200, 'array'],
  ['domain', true, true, 'disable', 125, 'array'],
  ['cveId', true, true, 'disable', 180, 'value'],
  ['pName', true, true, 'disable', 180, 'array'],
  ['whiteListIds', true, true, 'disable', 150, 'array'],
  ['logTraceInfo', true, true, 'disable', 150, 'value'],
  ['disposeTime', true, true, 'disable', 140, 'value'],
  ['platformId', true, true, 'disable', 110, 'value'],
  ['hostAssetAnalyzeResult', true, true, 'disable', 150, 'value'],
  ['platformIdAndGroupId', true, true, 'disable', 120, 'value'],
  ['gptRuleUid', true, true, 'disable', 150, 'value']
];

/** 告警接口请求头：带租户。 */
function buildMsswAlertHeaders(cookieInfo, platform, companyId, overrides = {}) {
  return buildMsswHeaders(cookieInfo.cookieString, platform, {
    'x-mssw-company-id': String(companyId || ''),
    ...overrides
  });
}

/**
 * 告警表导出请求体。
 *
 * 时间给 epoch **秒**（不是毫秒），闭区间 [起日 00:00:00, 止日 23:59:59]；
 * timeField 是 **firstTime**（首次发生时间）—— 2026-10-10 用户给的浏览器抓包用的是这一列，
 * 此前写的是 lastTime（最近发生时间）：值算得一样，但**圈的是另一批行**，而接口照样 code=0。
 */
function buildMsswAlertExportRequestBody({ begin, end }) {
  return {
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'firstTime',
        begin: { type: 'absolute', value: begin },
        end: { type: 'absolute', value: end }
      }
    },
    spl: {
      mappedSpl: '',
      originalSpl: '',
      extensionParams: { frontRender: [], mappedInputSpl: '', originalInputSpl: '' }
    },
    selection: {
      childSelections: [],
      parentSelections: [],
      selectAll: false,
      selected: []
    },
    tableArea: {
      enable: true,
      viewName: 'AlertView',
      aggregationStrategies: null,
      tableFields: MSSW_ALERT_TABLE_FIELDS.map(([field, show, selected, sort, columnWidth, dataType]) => ({
        field, show, selected, sort, columnWidth, fixed: false, dataType
      })),
      pageNum: 1,
      pageSize: 10,
      serviceInfo: MSSW_ALERT_TABLE_SERVICE_INFO,
      subTable: null,
      rightClicked: false,
      selectAllPage: true,
      routers: [],
      rightActions: [],
      extensionParams: {},
      tag: null
    },
    viewInstanceId: MSSW_ALERT_VIEW_INSTANCE_ID,
    model: 'simple',
    batchSize: 1000,
    max: 100000,
    serviceInfo: MSSW_ALERT_EXPORT_SERVICE_INFO,
    timeOutMs: 1000000,
    type: 'exportAlertExcel',
    name: '导出报告'
  };
}

/** 创建告警导出任务，返回 task_id。 */
async function triggerMsswAlertExport(cookieInfo, platform, companyId, options = {}) {
  const { begin, end } = resolveMsswTimeRange(options, '告警导出');
  const headers = buildMsswAlertHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ALERT_EXPORT_ENDPOINT);
  const body = JSON.stringify(buildMsswAlertExportRequestBody({ begin, end }));
  headers['content-length'] = String(Buffer.byteLength(body));

  // 非幂等的建任务：同事件表，只重试连接层错，超时不重试。
  const response = await requestJson(url, {
    headers,
    body,
    retry: { logger: options.logger, label: '告警导出建任务', attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 告警导出创建任务失败: ${response.message || response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/**
 * 轮询告警导出任务，返回结果文件路径（data.result）。
 *
 * **必须等到 result 出现为止**：实测 status 先变成 success，那一刻 result 仍是 null，
 * 再等一轮才有值。只判 status 会拿到 undefined 而白跑一次导出。
 */
async function pollMsswAlertExportTask(cookieInfo, platform, companyId, taskId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 600000);
  const intervalMs = Number(options.pollIntervalMs || 3000);
  const startedAt = Date.now();
  const logger = options.logger;
  const headers = buildMsswAlertHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ALERT_TASK_RESULT_ENDPOINT);
  const body = JSON.stringify({
    taskId,
    viewInstanceId: MSSW_ALERT_VIEW_INSTANCE_ID,
    serviceInfo: MSSW_ALERT_EXPORT_SERVICE_INFO
  });
  headers['content-length'] = String(Buffer.byteLength(body));

  let lastStatus = '';

  while (Date.now() - startedAt <= timeoutMs) {
    // 查询幂等，超时也重试（600s 的轮询窗口里抖一下不该从头再来）。
    const response = await requestJson(url, {
      headers,
      body,
      retry: { logger, label: '告警导出轮询', onTimeout: true }
    });

    const code = response && response.code;
    if (code !== 0 && code !== '0') {
      throw new Error(`MSSW 告警导出查询任务失败: ${response.message || response.msg || JSON.stringify(response).slice(0, 500)}`);
    }

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const task = data.task && typeof data.task === 'object' ? data.task : {};
    const status = String(task.status || '').toLowerCase();

    if (status !== lastStatus) {
      logInfo(logger, `告警导出任务状态: ${status}（total=${task.total} handled=${task.handled}）`);
      lastStatus = status;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`MSSW 告警导出失败: ${task.errorMessage || task.businessErrorMessage || '未知错误'}`);
    }

    if (status === 'success' && data.result) {
      return { resultPath: String(data.result), total: Number(task.total || 0), task };
    }

    await sleep(intervalMs);
  }

  throw new Error(`MSSW 告警导出轮询超时: ${timeoutMs}ms`);
}

/** 从 content-disposition 解析文件名，兼容 filename*= 与 filename= 两种写法。 */
function parseContentDispositionFilename(disposition, fallback) {
  if (!disposition) return fallback;
  const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
  if (starMatch) {
    let value = starMatch[1].trim().replace(/^["']|["']$/g, '');
    const sepIdx = value.indexOf("''");
    if (sepIdx !== -1) value = value.slice(sepIdx + 2);
    try {
      return decodeURIComponent(value) || fallback;
    } catch (error) {
      return value || fallback;
    }
  }
  const plainMatch = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  if (plainMatch && plainMatch[1].trim()) {
    return plainMatch[1].trim();
  }
  return fallback;
}

/**
 * 下载告警导出文件。
 *
 * 与事件表不同：结果里给的是**文件路径**（/ngsoc/.../files/export/<hash>），
 * 不是带文件名的下载 URL；真实文件名要从 content-disposition 里取。
 * 同样是二进制读，且要去掉 x-requested-with / content-type。
 */
async function downloadMsswAlertFile(cookieInfo, platform, companyId, resultPath, downloadDir, { logger } = {}) {
  const downloadUrl = resultPath.startsWith('http')
    ? resultPath
    : platformEndpoint(platform, `${resultPath.startsWith('/') ? '' : '/'}${resultPath}`);

  const headers = buildMsswAlertHeaders(cookieInfo, platform, companyId, {
    accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*'
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, {
    headers,
    retry: { logger, label: '告警表下载' }
  });
  const filename = parseContentDispositionFilename(
    downloaded.headers && (downloaded.headers['content-disposition'] || downloaded.headers['Content-Disposition']),
    `安全告警-${Date.now()}.xlsx`
  );
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename,
    downloadUrl
  };
}

/**
 * 导出告警表（安全告警）：创建任务 → 轮询 → 下载到 cookie 所在目录。
 *
 * **不做任何加工**，原样落盘（用户 2026-09-21 确认）。
 * 产物是单 sheet「安全告警」，表头在第 1 行，固定 77 列。
 *
 * @returns {Promise<object>} 含 filePath（xlsx 路径）与任务元信息
 */
async function exportMsswAlertList(options) {
  const logger = options.logger;
  logInfo(logger, `导出 MSSW 告警表: ${options.start} ~ ${options.end}`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const exportResponse = await triggerMsswAlertExport(cookieInfo, platform, companyId, options);
  const exportData = exportResponse && exportResponse.data && typeof exportResponse.data === 'object' ? exportResponse.data : {};
  const taskId = exportData.id;
  if (!taskId) {
    throw new Error(`MSSW 告警导出创建任务返回缺少 taskId: ${JSON.stringify(exportResponse).slice(0, 500)}`);
  }
  logInfo(logger, `告警导出任务: ${taskId}`);

  const polled = await pollMsswAlertExportTask(cookieInfo, platform, companyId, taskId, options);
  logInfo(logger, `告警导出完成，共 ${polled.total} 条`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswAlertFile(cookieInfo, platform, companyId, polled.resultPath, downloadDir, { logger });
  logInfo(logger, `告警表已下载: ${downloaded.filePath}`);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    taskId,
    resultPath: polled.resultPath,
    downloadUrl: downloaded.downloadUrl,
    total: polled.total,
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

async function fetchMsswCustomerListPage(cookieInfo, platform, { companyId, keyword, offset, limit }) {
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, `${MSSW_CUSTOMER_STATISTIC_ENDPOINT}?_method=GET`);
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify({
      order: 'desc',
      keyword: keyword || '',
      customer_category: 1,
      company_id: String(companyId || ''),
      offset: offset || 0,
      limit: limit || 20
    })
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 客户列表查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/** 按客户中文名精确匹配 company_id。 */
async function findMsswCustomerIdByName(cookieInfo, platform, customerName) {
  if (!customerName || !String(customerName).trim()) {
    throw new Error('findMsswCustomerIdByName 需要 customerName 参数');
  }

  const name = String(customerName).trim();
  const pageSize = 20;
  let offset = 0;
  let foundId = null;

  while (foundId === null) {
    const response = await fetchMsswCustomerListPage(cookieInfo, platform, {
      keyword: name,
      offset,
      limit: pageSize
    });

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const list = Array.isArray(data.list) ? data.list : [];
    const total = Number(data.total || 0);

    for (const item of list) {
      if (item && String(item.company_name || '').trim() === name) {
        foundId = String(item.company_id || '');
        break;
      }
    }

    if (foundId !== null) {
      break;
    }

    offset += pageSize;
    if (offset >= total || list.length < pageSize) {
      break;
    }
  }

  if (!foundId) {
    throw new Error(`未找到匹配的客户: ${name}，请检查 --customer 参数或手动指定 --customer-id`);
  }

  return foundId;
}

/**
 * 取资产导出字段集（分组结构）。这份返回**原样**作为导出接口 body 的 export_fields，
 * 因此它同时决定了下载后 xlsx 的列。
 *
 * 分页兜底路径不调这个接口，改用 scripts/mssw_asset_paged_export.py 里硬编码的
 * 32 项 DEFAULT_EXPORT_FIELDS。两条路看起来会分叉，但 2026-09-21 实测
 * （客户 19616826，两条路各导一次）结果为**逐列逐序完全相同的 34 列**：
 * 平台并不照单全收请求的字段，而是按租户配置返回，其中 custom_attribute 组
 * （请求里给空数组）实际返回「推理责任人 / 推理资产组 / 推理业务组」3 列，
 * 而参考清单里的「资产定位推理」根本不出现。所以硬编码清单的差异不会传导到产物列上。
 */
async function fetchMsswExportFields(cookieInfo, platform, companyId) {
  const headers = buildMsswAssetExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ASSET_EXPORT_FIELDS_ENDPOINT);
  const body = JSON.stringify({});
  headers['content-length'] = String(Buffer.byteLength(body));

  const response = await requestJson(url, { headers, body });

  if (!response || response.success !== true || !response.data) {
    throw new Error(`MSSW 资产字段接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/**
 * 资产总数预查。走 count 接口，用来判断是否直接切分页导出。
 * 返回 response.total。
 */
async function fetchMsswAssetTotalCount(cookieInfo, platform, companyId, searchType = 'current') {
  const headers = buildMsswAssetExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ASSET_COUNT_ENDPOINT);
  const body = JSON.stringify({ branch_id: 'all', search_type: searchType, start: 0, limit: 20 });
  headers['content-length'] = String(Buffer.byteLength(body));

  const response = await requestJson(url, { headers, body, timeout: 30000 });

  const code = response && response.code;
  const apiSuccess = response && (response.success === true || response.success === 'true');
  if (code !== 0 && code !== '0' && !apiSuccess) {
    throw new Error(`MSSW 资产总数接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return Number(response.total || 0);
}

/**
 * 设备列表**一页**（POST，同步 JSON 查询）。
 *
 * 请求体照参考实现逐字一致（health-checkup-report 的 fetchMsswDeviceList）：
 * keyword 空串 = 不按名字筛、type 0 = 全类型、devStatus [1,2,3,4] = 设备状态四档全要。
 * 这几个值是**请求侧的筛子**：取值层不再对 devStatus / isDelete 做二次过滤
 * （见 stats/metrics/device.js 的 deviceCountByType）。
 *
 * 成功判据比参考实现**严**：那边把 `code === undefined` 也算成功，于是解析失败的响应体
 * （HTML 错误页会被 requestJson 原样回传成字符串）会走进来、后面读 data.list 读不到，
 * 结果安静地数出「0 台设备」。这里要求 code 在 {0, '0', 'Success'} 里（或干脆没有 code，
 * 即接口不返回这个字段的形态），并且**必须有 data 对象** —— 缺了就是抛错，不是 0。
 *
 * @returns {Promise<{total: number, list: Array<Object>}>} 首页（data.total 是全量总数）
 * @throws {Error} 业务码非成功 / 响应里没有 data
 */
async function fetchMsswDeviceListPage(cookieInfo, platform, companyId, pageSize, pageNum = 1) {
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_DEVICE_LIST_ENDPOINT);
  const body = JSON.stringify({
    keyword: '',
    type: 0,
    pageSize: pageSize || MSSW_DEVICE_PAGE_SIZE,
    pageNum,
    devStatus: [1, 2, 3, 4]
  });

  // onTimeout: true —— 纯查询、幂等，超时重发安全（非幂等的是"建导出任务"那类，这里不是）。
  const response = await requestJson(url, {
    headers,
    body,
    timeout: MSSW_DEVICE_REQUEST_TIMEOUT_MS,
    retry: { onTimeout: true, label: `MSSW 设备列表第 ${pageNum} 页` }
  });

  const code = response && response.code;
  if (code !== undefined && code !== 0 && code !== '0' && code !== 'Success') {
    throw new Error(`MSSW 设备列表接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`MSSW 设备列表接口返回里没有 data: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return {
    total: Number(data.total || 0),
    list: Array.isArray(data.list) ? data.list : []
  };
}

/**
 * 设备列表**全量**：翻页收齐所有设备行，交给取值层当 ctx.deviceRows。
 *
 * 为什么不用下载件：这四格（D100/D101/D102/D104）要的是「一台设备一行」的行对象，
 * 报告里没有「设备表」这个 sheet，落一份 xlsx 再解析回来只是绕路。所以本函数
 * **不落盘**、也不进 `results`（没有 filePath / 中间件可删），直接回内存数组。
 *
 * 翻页照参考实现：先拿首页的 data.total，按 ceil(total / pageSize) 逐页取。
 * ⚠️ 与实际拉到的行数**不一致只记 ⚠️、不抛错**：设备台账是活数据，
 * 翻页途中新接入一台（或删掉一台）就会让 total 与实际行数对不上 —— 那是正常现象，
 * 抛错会把整份报告拦下。真正要紧的是**接口本身调不通**，那种情况这里直接抛（R10）。
 *
 * 与 --start/--end 无关：设备台账是"当前的接入情况"，接口不带时间参数。
 *
 * @param {Object} options 与其它 export* 同一套：msswCookiePath / msswBaseUrl /
 *   msswHostHeader / msswRefererPath / customerId / logger
 * @returns {Promise<{rows: Array<Object>, total: number, pages: number}>}
 *   rows —— data.list 的并集，**原样**（键是接口字段名，如 `devType`，不做任何改名）
 * @throws {Error} cookie 读不到 / 请求失败 / 业务码非成功 / 响应缺 data
 */
async function fetchMsswDeviceRows(options = {}) {
  const logger = options.logger;
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';
  const pageSize = Number(options.pageSize) || MSSW_DEVICE_PAGE_SIZE;

  const firstPage = await fetchMsswDeviceListPage(cookieInfo, platform, companyId, pageSize, 1);
  const total = firstPage.total;
  const rows = [...firstPage.list];
  const pages = total > 0 ? Math.ceil(total / pageSize) : 1;

  for (let pageNum = 2; pageNum <= pages; pageNum += 1) {
    const page = await fetchMsswDeviceListPage(cookieInfo, platform, companyId, pageSize, pageNum);
    if (page.list.length === 0) break; // 与 total 打架时空转的兜底，防死循环
    rows.push(...page.list);
  }

  if (rows.length !== total) {
    // 不抛错，但**必须点名**：这两种数不一样时，报告上的组件数量是按实际拉到的行算的
    logInfo(logger, `[提示] 设备列表接口报的总数 ${total} 与实际拉到的 ${rows.length} 行不一致`
      + '（翻页途中台账变了，或分页上限被服务端截断）—— 四格按实际拉到的行数计数');
  }

  return { rows, total, pages: Math.max(1, Math.ceil(rows.length / pageSize) || 1) };
}

/**
 * 校验 topn 系列接口的成功外壳，返回 `data`。
 *
 * 与 fetchMsswDeviceListPage 同一条判据：业务码在 {0, '0', 'Success'} 里（或接口干脆
 * 不带 code），并且**必须有 data 对象** —— 缺了就是抛错，不是"没有数据"。
 * 解析失败的响应体（HTML 错误页）会被 requestJson 原样回传成字符串，这里也会拦住。
 */
function requireTopnData(response, label) {
  const code = response && response.code;
  if (code !== undefined && code !== 0 && code !== '0' && code !== 'Success') {
    throw new Error(`MSSW ${label}接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }
  const data = response && response.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`MSSW ${label}接口返回里没有 data: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return data;
}

/**
 * device_list 的 `data.list` -> src_ip_geo 请求体的 `device_infos`。
 *
 * 口径（用户 2026-10-19 按抓包确认，见文件头 topn 那一段）：
 *   · 只取 `device_type`（统一小写）与 `device_info_list[].device_id`
 *   · 按 `device_id` **去重**（同一类型内用 Set）—— 抓包里两台 SIP 设备共用
 *     `467452B5`，请求体里只出现一次
 *   · **不看 `device_status`**：离线设备也带（抓包里 4 台 status=2 的 AF 都在）
 *   · 不拿 `total` 当设备数（它数行、不数唯一 id）；空组不塞进请求体
 *   · 组间顺序不影响结果（抓包响应 sta/af/sip、请求体 sip/af/sta）
 *
 * @param {Array} groups device_list 的 data.list
 * @returns {Array<{device_type: string, device_id_list: string[]}>}
 * @throws {Error} data.list 不是数组（接口形状变了）
 */
function buildTopnDeviceInfos(groups) {
  if (!Array.isArray(groups)) {
    throw new Error('MSSW topn 设备列表接口的 data.list 不是数组');
  }

  const byType = new Map();
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const type = String(group.device_type || '').trim().toLowerCase();
    if (!type) continue;

    if (!byType.has(type)) byType.set(type, new Set());
    const ids = byType.get(type);
    const devices = Array.isArray(group.device_info_list) ? group.device_info_list : [];
    for (const device of devices) {
      const id = String((device && device.device_id) || '').trim();
      if (id) ids.add(id);
    }
  }

  return [...byType.entries()]
    .filter(([, ids]) => ids.size > 0)
    .map(([device_type, ids]) => ({ device_type, device_id_list: [...ids] }));
}

/**
 * topn 第一问：设备台账 -> `device_infos`。
 *
 * 请求体只有 `company_id`（抓包原样；客户范围也靠它圈）。与设备列表那套翻页接口
 * 不是同一个端点 —— 这里只拿 topn 自己要的设备类型与 id，不落盘。
 *
 * @throws {Error} 请求失败 / 业务码非成功 / 响应缺 data / data.list 不是数组
 */
async function fetchMsswTopnDeviceInfos(cookieInfo, platform, companyId, logger) {
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_TOPN_DEVICE_LIST_ENDPOINT);
  const body = JSON.stringify({ company_id: String(companyId || '') });

  const response = await requestJson(url, {
    headers,
    body,
    timeout: MSSW_TOPN_REQUEST_TIMEOUT_MS,
    // 纯查询、幂等，超时重发安全
    retry: { onTimeout: true, label: 'MSSW topn 设备列表' }
  });

  const data = requireTopnData(response, 'topn 设备列表');
  const deviceInfos = buildTopnDeviceInfos(data.list);
  logInfo(logger, `[数据统计] topn 设备台账：${deviceInfos.length} 类设备，`
    + deviceInfos.map((info) => `${info.device_type}=${info.device_id_list.length}`).join(' / ')
    + `（接口报的总数 ${Number(data.total || 0)}，按 device_id 去重后共 `
    + `${deviceInfos.reduce((sum, info) => sum + info.device_id_list.length, 0)} 个 id）`);
  return deviceInfos;
}

/**
 * topn 设备台账（三块 topn 共用的一次查询）—— F62:G66 / I62:J66 / L62:M66 都调它。
 *
 * 用户口径 2026-10-20：「取一次就行」。三块 topn 的 `device_infos` 是**同一份**设备
 * 台账，没有理由每块各问一次，所以下载层先调本函数拿一次，再把结果作为
 * `topnDeviceInfos` 传给三个 fetch —— 那三个函数见到这个字段就不再自己问。
 *
 * 台账是"当前的设备清单"，与报告期无关（不带时间参数）。
 * 接口不通则抛错，由下载层收成 `null`：三块共 30 格一起写「topn接口不通无法取值」
 * （设备台账都没有，三个排行都没法问）。
 *
 * @param {Object} options 与其它 export* 同一套：msswCookiePath / msswBaseUrl /
 *   msswHostHeader / msswRefererPath / customerId / logger
 * @returns {Promise<Array<{device_type: string, device_id_list: string[]}>>}
 *   空数组 = 接口答了、就是没有设备（不是接口不通）
 * @throws {Error} 请求失败 / 业务码非成功 / 响应缺 data.list
 */
async function fetchMsswTopnDeviceInfosOnce(options = {}) {
  const logger = options.logger;
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';
  return fetchMsswTopnDeviceInfos(cookieInfo, platform, companyId, logger);
}

/**
 * topn 系列接口的公共前两问（src_ip_geo / threat_type / dst_ip 共用）。
 *
 * 报告期**就是命令行 --start/--end**（用户口径 2026-10-19）：起 = 起始日 00:00:00.000、
 * 止 = 结束日 23:59:59.999（本地时区，走 resolveMsswTimeRangeMs，与事件/漏洞表同一把尺子），
 * 换算成 epoch **毫秒**放进 `latest_time`。抓包里的 `latest_time` 是浏览器"近一年"默认值，
 * **不算口径**（与 G99 那条注释同一条规则）。`date_scope` 固定 0（用户口径 2026-10-19）。
 *
 * `device_infos` 由第一问现拼（见 buildTopnDeviceInfos）—— 不缓存、不读设备台账下载件。
 * 三块 topn 共用一份：调用方传 `config.deviceInfos` 时直接用它（下载层取一次，
 * 见 fetchMsswTopnDeviceInfosOnce），没传才自己问一次。
 *
 * 三个端点的请求体逐字相同，只换 endpoint / ip_type；行对象里取哪个字段由调用方映射。
 *
 * @param {Object} options 与其它 export* 同一套：msswCookiePath / msswBaseUrl /
 *   msswHostHeader / msswRefererPath / customerId / start / end / logger
 * @param {{endpoint: string, label: string, timeLabel: string, ipType?: string,
 *   deviceInfos?: Array<Object>}} config
 *   endpoint = topn 端点；label = 日志/错误文案里的名字（如「源 IP 地域」）；
 *   timeLabel = resolveMsswTimeRangeMs 的口径名（如「topn 源 IP 地域分布」）；
 *   ipType = 请求体 `ip_type`（缺省 `src_ip`；目的 IP 端点传 `dst_ip`）；
 *   deviceInfos = 已经取好的设备台账（三块共用；不传则现值现取）
 * @returns {Promise<{list: Array<Object>, deviceInfos: Array<Object>,
 *   fromMs: number, toMs: number}>} `list` 未截断，调用方按 topn 上限取前 5
 * @throws {Error} 缺 --start/--end / 请求失败 / 业务码非成功 / 响应缺 data.list
 */
async function fetchMsswTopnList(options, config) {
  const logger = options.logger;
  const label = config.label; // 例：'源 IP 地域' / '威胁类型'
  const [fromMs, toMs] = resolveMsswTimeRangeMs(options, config.timeLabel);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  // 三块 topn 共用一份台账：下载层取过一次就传进来；没传（单独调用/测试）才现值现取。
  const deviceInfos = Array.isArray(config.deviceInfos)
    ? config.deviceInfos
    : await fetchMsswTopnDeviceInfos(cookieInfo, platform, companyId, logger);

  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, config.endpoint);
  const body = JSON.stringify({
    company_id: String(companyId || ''),
    ip_type: config.ipType || 'src_ip',
    topn: MSSW_TOPN_LIMIT,
    latest_time: [fromMs, toMs],
    device_infos: deviceInfos,
    attack_type: [{ id: MSSW_TOPN_ATTACK_TYPE }],
    attack_direction: [{ id: MSSW_TOPN_ATTACK_DIRECTION }],
    date_scope: MSSW_TOPN_DATE_SCOPE,
    resource_group_ids: [],
    only_asset: 0
  });

  const response = await requestJson(url, {
    headers,
    body,
    timeout: MSSW_TOPN_REQUEST_TIMEOUT_MS,
    retry: { onTimeout: true, label: `MSSW topn ${label}` }
  });

  const data = requireTopnData(response, `topn ${label}`);
  if (!Array.isArray(data.list)) {
    throw new Error(`MSSW topn ${label}接口的 data.list 不是数组: `
      + `${JSON.stringify(response).slice(0, 500)}`);
  }

  return { list: data.list, deviceInfos, fromMs, toMs };
}

/**
 * 「攻击来源地域分布top5 / 攻击数量」（F62:G66）—— topn 接口的两次问。
 *
 * 报告期 / date_scope / device_infos 的构造见 fetchMsswTopnList（三个 topn 端点共用）。
 * `options.topnDeviceInfos` 可传下载层已经取好的设备台账（三块共用一次查询）；
 * 不传时本函数才自己问一次 device_list。
 *
 * 返回值是**接口答了**的行（最多 5 行）：少于 5 行是正常结论，取值层把剩下的格子留空；
 * 接口调不通则抛错，由下载层收成 `null`（=「topn接口不通无法取值」那一档）。
 *
 * @param {Object} options 与其它 export* 同一套：msswCookiePath / msswBaseUrl /
 *   msswHostHeader / msswRefererPath / customerId / start / end / logger
 * @returns {Promise<{rows: Array<{src_ip_geo: string, attack_count: number}>,
 *   deviceInfos: Array<Object>, fromMs: number, toMs: number}>}
 * @throws {Error} 缺 --start/--end / 请求失败 / 业务码非成功 / 响应缺 data.list /
 *   行里缺 src_ip_geo 或 attack_count（字段改名，不许静默写空）
 */
async function fetchMsswSrcIpGeoTopN(options = {}) {
  const logger = options.logger;
  const {
    list, deviceInfos, fromMs, toMs
  } = await fetchMsswTopnList(options, {
    endpoint: MSSW_TOPN_SRC_IP_GEO_ENDPOINT,
    label: '源 IP 地域',
    timeLabel: 'topn 源 IP 地域分布',
    deviceInfos: options.topnDeviceInfos
  });

  const rows = list.slice(0, MSSW_TOPN_LIMIT).map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`MSSW topn 源 IP 地域接口第 ${index + 1} 行不是对象: `
        + `${JSON.stringify(item).slice(0, 300)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'src_ip_geo')) {
      throw new Error(`MSSW topn 源 IP 地域接口第 ${index + 1} 行没有 src_ip_geo 字段`
        + '（平台可能改了字段名）');
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'attack_count')) {
      throw new Error(`MSSW topn 源 IP 地域接口第 ${index + 1} 行没有 attack_count 字段`
        + '（平台可能改了字段名）');
    }
    const attackCount = Number(item.attack_count);
    if (!Number.isFinite(attackCount)) {
      throw new Error(`MSSW topn 源 IP 地域接口第 ${index + 1} 行 attack_count 不是数字: `
        + `${JSON.stringify(item.attack_count)}`);
    }
    return {
      src_ip_geo: String(item.src_ip_geo),
      attack_count: attackCount
    };
  });

  logInfo(logger, `[数据统计] topn 源 IP 地域 `
    + `${formatMsswDateTime(fromMs / 1000)} ~ ${formatMsswDateTime(toMs / 1000)}: `
    + `返回 ${rows.length} 行 —— F62:G66 按响应顺序落值`
    + (rows.length ? `（第 1 名 ${rows[0].src_ip_geo} / ${rows[0].attack_count}）` : ''));

  return { rows, deviceInfos, fromMs, toMs };
}

/**
 * 「攻击类型top5 / 攻击数量」（I62:J66）—— topn 接口的两次问。
 *
 * 请求体与 fetchMsswSrcIpGeoTopN **逐字相同**（见 fetchMsswTopnList），只换端点
 * `/topn/threat_type`，响应行换成 `{threat_type, attack_count}`。
 * `options.topnDeviceInfos` 可传下载层已经取好的设备台账（三块共用一次查询）。
 * 口径（报告期 = CLI --start/--end、date_scope=0、device_infos 同一份构造规则、
 * 最多 5 行、失败由下载层收成 null）见 stats/metrics/threat_type.js 头注。
 *
 * @param {Object} options 与其它 export* 同一套
 * @returns {Promise<{rows: Array<{threat_type: string, attack_count: number}>,
 *   deviceInfos: Array<Object>, fromMs: number, toMs: number}>}
 * @throws {Error} 缺 --start/--end / 请求失败 / 业务码非成功 / 响应缺 data.list /
 *   行里缺 threat_type 或 attack_count（字段改名，不许静默写空）
 */
async function fetchMsswThreatTypeTopN(options = {}) {
  const logger = options.logger;
  const {
    list, deviceInfos, fromMs, toMs
  } = await fetchMsswTopnList(options, {
    endpoint: MSSW_TOPN_THREAT_TYPE_ENDPOINT,
    label: '威胁类型',
    timeLabel: 'topn 威胁类型',
    deviceInfos: options.topnDeviceInfos
  });

  const rows = list.slice(0, MSSW_TOPN_LIMIT).map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`MSSW topn 威胁类型接口第 ${index + 1} 行不是对象: `
        + `${JSON.stringify(item).slice(0, 300)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'threat_type')) {
      throw new Error(`MSSW topn 威胁类型接口第 ${index + 1} 行没有 threat_type 字段`
        + '（平台可能改了字段名）');
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'attack_count')) {
      throw new Error(`MSSW topn 威胁类型接口第 ${index + 1} 行没有 attack_count 字段`
        + '（平台可能改了字段名）');
    }
    const attackCount = Number(item.attack_count);
    if (!Number.isFinite(attackCount)) {
      throw new Error(`MSSW topn 威胁类型接口第 ${index + 1} 行 attack_count 不是数字: `
        + `${JSON.stringify(item.attack_count)}`);
    }
    return {
      threat_type: String(item.threat_type),
      attack_count: attackCount
    };
  });

  logInfo(logger, `[数据统计] topn 威胁类型 `
    + `${formatMsswDateTime(fromMs / 1000)} ~ ${formatMsswDateTime(toMs / 1000)}: `
    + `返回 ${rows.length} 行 —— I62:J66 按响应顺序落值`
    + (rows.length ? `（第 1 名 ${rows[0].threat_type} / ${rows[0].attack_count}）` : ''));

  return { rows, deviceInfos, fromMs, toMs };
}

/**
 * 「遭受外部攻击的主机 / 日志数量」（L62:M66）—— topn 接口的两次问。
 *
 * 请求体与 fetchMsswSrcIpGeoTopN 逐字相同，只换端点 `/topn/dst_ip`、
 * 并把 `ip_type` 换成 `dst_ip`，响应行里取 `{dst_ip, attack_count}`。
 * `options.topnDeviceInfos` 可传下载层已经取好的设备台账（三块共用一次查询）。
 * 口径（报告期 = CLI --start/--end、date_scope=0、device_infos 同一套构造规则、
 * 最多 5 行、失败由下载层收成 null）见 stats/metrics/dst_ip.js 头注。
 *
 * @param {Object} options 与其它 export* 同一套
 * @returns {Promise<{rows: Array<{dst_ip: string, attack_count: number}>,
 *   deviceInfos: Array<Object>, fromMs: number, toMs: number}>}
 * @throws {Error} 缺 --start/--end / 请求失败 / 业务码非成功 / 响应缺 data.list /
 *   行里缺 dst_ip 或 attack_count（字段改名，不许静默写空）
 */
async function fetchMsswDstIpTopN(options = {}) {
  const logger = options.logger;
  const {
    list, deviceInfos, fromMs, toMs
  } = await fetchMsswTopnList(options, {
    endpoint: MSSW_TOPN_DST_IP_ENDPOINT,
    label: '目的 IP',
    timeLabel: 'topn 目的 IP',
    ipType: 'dst_ip',
    deviceInfos: options.topnDeviceInfos
  });

  const rows = list.slice(0, MSSW_TOPN_LIMIT).map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`MSSW topn 目的 IP 接口第 ${index + 1} 行不是对象: `
        + `${JSON.stringify(item).slice(0, 300)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'dst_ip')) {
      throw new Error(`MSSW topn 目的 IP 接口第 ${index + 1} 行没有 dst_ip 字段`
        + '（平台可能改了字段名）');
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'attack_count')) {
      throw new Error(`MSSW topn 目的 IP 接口第 ${index + 1} 行没有 attack_count 字段`
        + '（平台可能改了字段名）');
    }
    const attackCount = Number(item.attack_count);
    if (!Number.isFinite(attackCount)) {
      throw new Error(`MSSW topn 目的 IP 接口第 ${index + 1} 行 attack_count 不是数字: `
        + `${JSON.stringify(item.attack_count)}`);
    }
    return {
      dst_ip: String(item.dst_ip),
      attack_count: attackCount
    };
  });

  logInfo(logger, `[数据统计] topn 目的 IP `
    + `${formatMsswDateTime(fromMs / 1000)} ~ ${formatMsswDateTime(toMs / 1000)}: `
    + `返回 ${rows.length} 行 —— L62:M66 按响应顺序落值`
    + (rows.length ? `（第 1 名 ${rows[0].dst_ip} / ${rows[0].attack_count}）` : ''));

  return { rows, deviceInfos, fromMs, toMs };
}

/**
 * 第三方设备（应用实例）**总数** —— D103「第三方数量」的取值源。
 *
 * ⚠️ 与设备列表那套**刻意不同**：那边翻页收齐 data.list、按 devType 数行；
 * 这边**只取接口报的 data.count** 就返回（不翻页、不按行重算）。理由是参考实现
 * （health-checkup-report 的 collectMsswDeviceCategoryCounts，那边请求体甚至只取 20 条一页）
 * 用的就是这个总数：这一格要的就是"接进来多少个第三方应用实例"，
 * 平台自己已经算好了，重算一次只会多一个和平台对不上的机会。
 *
 * 请求体逐字照参考实现：全是空筛子（不按名字 / 不按能力类型 / 不按启用状态筛），
 * 与设备列表的 keyword:'' 同理 —— 请求就是那一道筛，取值层不再做二次过滤。
 *
 * 与 --start/--end 无关：第三方台账是"当前的接入情况"，接口不带时间参数。
 *
 * @param {Object} options 与其它 export* 同一套：msswCookiePath / msswBaseUrl /
 *   msswHostHeader / msswRefererPath / customerId / logger
 * @returns {Promise<{count: number, list: Array<Object>}>} count = data.count（第三方实例总数）
 * @throws {Error} cookie 读不到 / 请求失败 / 业务码非成功 / 响应缺 data / data.count 不是数字
 *   ——**缺 count 不当成 0**：那与"真的一个都没有"是两个结论（H6/R10）
 */
async function fetchMsswThirdPartyDeviceCount(options = {}) {
  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_THIRD_PARTY_DEVICE_ENDPOINT);
  const body = JSON.stringify({
    name: '',
    appIds: [],
    hostIp: '',
    statusList: [],
    abilityTypeList: [],
    enableList: [],
    appInstanceId: '',
    pageIndex: 1,
    pageSize: MSSW_THIRD_PARTY_PAGE_SIZE
  });

  // 纯查询、幂等，超时重发安全（同设备列表那条）
  const response = await requestJson(url, {
    headers,
    body,
    timeout: MSSW_DEVICE_REQUEST_TIMEOUT_MS,
    retry: { onTimeout: true, label: 'MSSW 第三方设备统计' }
  });

  const code = response && response.code;
  if (code !== undefined && code !== 0 && code !== '0' && code !== 'Success') {
    throw new Error(`MSSW 第三方设备统计接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`MSSW 第三方设备统计接口返回里没有 data: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const count = Number(data.count);
  if (!Number.isFinite(count)) {
    throw new Error(`MSSW 第三方设备统计接口的 data.count 无效: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return { count, list: Array.isArray(data.list) ? data.list : [] };
}

/**
 * epoch 秒 -> 「YYYY-MM-DD HH:mm:ss」（**本地时区**）。
 *
 * ⚠️ 2026-10-14 换接口后**只给日志行用**：日志量接口自己吃 epoch 秒
 * （`fromDate` / `toDate` 是整数，见 buildMsswLogCountRequestBody），不再要字符串。
 * 与 parseLocalDate 同用本地时区（报告期本来就是用户按本地日历给的），
 * 所以日志里打出来的起止跟 CLI 输入对得上。
 */
function formatMsswDateTime(seconds) {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无效时间戳: ${seconds}`);
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 日志量接口专用头：host / origin / referer 仍走平台那套，
 * 但按用户给的抓包（2026-10-14）改成下面三样。
 *
 * 与导出类接口的三点差别（抓包里就是这样，别顺手"统一"掉）：
 *   · `referer` 是日志检索前端的 `/ui-analyze/index.html`
 *   · 补 `x-csrftoken`（取自 cookie 里的 `csrf_token`）与每次随机的 `traceid`
 *   · 带 `x-time-zone: Asia/Shanghai` —— 请求体里的起止是 epoch 秒，
 *     这个头告诉服务端按哪个时区解释它们
 *
 * ⚠️ 这里**不发 `x-mssw-company-id`**：这一路接口的"客户"是请求体里的
 * `constrains: 客户 = <companyId>`（见 buildMsswLogCountRequestBody），抓包里也没有那个头 ——
 * 别顺手补上，那是导出类接口的头。
 * ⚠️ 抓包里的 `priority: u=1, i` 是浏览器 fetch 的优先级提示、平台不校验，
 * 全仓哪一路都不发（不是漏了）。
 */
function buildMsswLogCountHeaders(cookieInfo, platform) {
  const p = ensurePlatform(platform);
  const csrfToken = (cookieInfo && cookieInfo.cookies && cookieInfo.cookies.csrf_token) || '';
  return buildMsswHeaders(cookieInfo.cookieString, p, {
    referer: `${p.origin}/ui-analyze/index.html`,
    traceid: generateUUID(),
    'x-csrftoken': csrfToken,
    'x-time-zone': MSSW_LOG_TIME_ZONE
  });
}

/**
 * 日志量查询请求体：时间范围 + 一张表 + 一条过滤串 + 一条「客户 = companyId」约束。
 * 逐字照用户给的浏览器抓包（2026-10-14）：
 *
 *   {"fromDate":1791959815,"toDate":...,"tableName":["network_security_log"],
 *    "searchString":"","constrains":[{"fieldAlias":"客户",...}],
 *    "pageNo":1,"pageSize":60,"fieldList":[]}
 *
 * ⚠️ 时间是 **epoch 秒**（整数），不是「YYYY-MM-DD HH:mm:ss」字符串 —— 旧那两跳接口
 * 吃字符串、这一路吃秒，换接口时最容易被"看着像时间就照抄"的地方。
 * `constrains` 那一条是**唯一**的客户圈法（请求头里没有 `x-mssw-company-id`）。
 * `pageNo` / `pageSize` / `fieldList` 是抓包里的原样（两格都只取 `data.total`，
 * 不翻页也不读 `fieldList`），留着是为了下次跟抓包比对时没有无谓差异。
 *
 * `searchString` 是**两格共用一个入参**：G99「xdr日志数」要的是"这段时间收到多少日志"、
 * 不筛任何东西（抓包里就是空串），D23「已拦截外联次数」要的是"其中已拦截的外联" ——
 * 同一个端点两种问法，差别**只在这一个字段**（用户口径 2026-10-14）。
 * 省略 / 空 = G99 那条问法（抓包原样就是 `""`，不是 `null`）。
 */
function buildMsswLogCountRequestBody({ tableName, searchString = '', fromDate, toDate, companyId }) {
  return {
    fromDate,
    toDate,
    tableName: [tableName],
    searchString,
    constrains: [
      {
        fieldAlias: '客户',
        fieldName: 'customer',
        fieldOperater: '=',
        fieldValue: String(companyId)
      }
    ],
    pageNo: 1,
    pageSize: 60,
    fieldList: []
  };
}

/**
 * 单张日志表在给定时间范围内的日志条数（epoch 秒闭区间）。
 * @param {string} tableName 请求体里的表标识符，见 MSSW_LOG_TABLES
 * @param {string} [searchString] 过滤串；省略 = 不筛（G99 那条问法）
 * @returns {Promise<number>} data.total；不是数字就抛（不静默当 0）
 */
async function fetchMsswLogCountByTable(cookieInfo, platform, companyId, tableName, fromDate, toDate, logger, searchString = '') {
  const url = platformEndpoint(platform, MSSW_LOG_COUNT_ENDPOINT);
  const headers = buildMsswLogCountHeaders(cookieInfo, platform);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswLogCountRequestBody({ tableName, searchString, fromDate, toDate, companyId })),
    timeout: MSSW_LOG_REQUEST_TIMEOUT_MS,
    retry: { onTimeout: true, label: `MSSW 日志量（${tableName}）` }
  });

  const code = response && response.code;
  if (code !== undefined && code !== 0 && code !== '0') {
    throw new Error(`MSSW 日志量接口(tableName=${tableName})返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data;
  const total = Number(data && data.total);
  if (!Number.isFinite(total)) {
    throw new Error(`MSSW 日志量接口(tableName=${tableName})的 data.total 无效: ${JSON.stringify(response).slice(0, 500)}`);
  }

  logInfo(logger, `[数据统计] ${tableName} 的日志条数: ${total}`);
  return total;
}

/**
 * 同一个端点、同一批表、按 `key` 给每张表配一条过滤串地问一遍 ——
 * G99（无过滤）与 D23（已拦截外联）**共用这一份循环**，差别只在传进来的 filters。
 *
 * 两问**并发**（同一端点、`tableName` 不同），两个 `data.total` 相加。
 * 任一问失败都抛（下载层会把它收成"接口不通"，见 mssw_downloader.js 的
 * readSecurityLogCount / readInterceptedOutboundCount）。
 *
 * @param {Object} filters key -> searchString；**没配的表按空串问**（= 不筛）
 * @returns {Promise<{total: number, network: number, endpoint: number,
 *   fromDate: number, toDate: number}>} fromDate / toDate 是**发出去的那两个 epoch 秒**
 * @throws {Error} 缺 --start/--end / 起止倒置 / 请求失败 / 业务码非成功 / 缺数量
 */
async function fetchMsswLogTableCounts(options = {}, filters = {}) {
  const logger = options.logger;
  const { begin, end } = resolveMsswTimeRange(options, '日志量统计');

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const counts = await Promise.all(MSSW_LOG_TABLES.map((table) => fetchMsswLogCountByTable(
    cookieInfo, platform, companyId, table.tableName, begin, end, logger, filters[table.key] || ''
  )));

  const result = { fromDate: begin, toDate: end };
  MSSW_LOG_TABLES.forEach((table, index) => { result[table.key] = counts[index]; });
  result.total = counts.reduce((sum, count) => sum + count, 0);

  return { result, begin, end };
}

/**
 * 「xdr日志数」（G99）—— 网络安全日志 + 终端安全日志两张表在报告期内的条数**之和**。
 *
 * 报告期来源：**命令行 --start/--end 直传**（用户口径 2026-10-13），
 * 起 = 起始日 00:00:00、止 = 结束日 23:59:59（本地时区，走 resolveMsswTimeRange，
 * 与事件/告警表同一把尺子）—— 这两个数直接当 `fromDate` / `toDate` 发出去。
 * ⚠️ 抓包里的起止是浏览器"近 30 天"默认值（两个数差整 30 天），**不算口径**：
 * 报告期仍然只由 CLI 的 --start/--end 定，不做"近 30 天"之类的收窄。
 *
 * 这一问**不带任何过滤串**（`searchString: ''`，抓包原样）—— 要的是这段时间收到的全部日志。
 *
 * @param {Object} options 与其它 export* 同一套，外加 start / end（YYYY-MM-DD）
 * @returns {Promise<{total: number, network: number, endpoint: number,
 *   fromDate: number, toDate: number}>}
 * @throws {Error} 缺 --start/--end / 起止倒置 / 请求失败 / 业务码非成功 / 缺数量
 */
async function fetchMsswSecurityLogCount(options = {}) {
  const { result, begin, end } = await fetchMsswLogTableCounts(options);

  logInfo(options.logger, `[数据统计] 日志量 ${formatMsswDateTime(begin)} ~ ${formatMsswDateTime(end)}: `
    + MSSW_LOG_TABLES.map((table) => `${table.label} ${result[table.key]}`).join(' + ')
    + ` = ${result.total}`);
  return result;
}

/**
 * 「已拦截外联次数」（D23）—— **同一个端点、同一批表**，每张表多带一条过滤串。
 *
 * 用户口径 2026-10-14（浏览器抓包逐张表给的那两条 `searchString`，见
 * MSSW_INTERCEPTED_OUTBOUND_FILTERS）：网络安全日志问「内→外 且已拦截」、
 * 终端安全日志问「已拦截」，两张表的 `data.total` **相加** = 本格。
 *
 * ⚠️ 与 G99「xdr日志数」是**两次各自独立的问**（同一个接口、同一段时间，筛不筛而已）：
 * 两格的数一般不等（G99 恒 ≥ D23），下载层问两次、互不牵连 ——
 * 一次失败不该让另一格跟着变成「接口不通无值」（各自独立地断）。
 * 报告期同样是 CLI 的 --start/--end 直传，不做任何收窄。
 *
 * @param {Object} options 同 fetchMsswSecurityLogCount
 * @returns {Promise<{total: number, network: number, endpoint: number,
 *   fromDate: number, toDate: number}>} total = 两张表已拦截外联条数之和
 * @throws {Error} 同 fetchMsswSecurityLogCount
 */
async function fetchMsswInterceptedOutboundCount(options = {}) {
  const { result, begin, end } = await fetchMsswLogTableCounts(options, MSSW_INTERCEPTED_OUTBOUND_FILTERS);

  logInfo(options.logger, `[数据统计] 已拦截外联 ${formatMsswDateTime(begin)} ~ ${formatMsswDateTime(end)}: `
    + MSSW_LOG_TABLES.map((table) => `${table.label} ${result[table.key]}`).join(' + ')
    + ` = ${result.total}`);
  return result;
}

/**
 * 「外部攻击日志数量（XDR）」（D61）—— 用户口径 2026-10-17（浏览器抓包）：
 * **只问网络安全日志一张表**，`searchString` 是 `filter srcIpTag=0 AND dstIpTag=1`
 * （外→内，即从外部打进来的攻击），取 `data.total`。
 *
 * 与 G99「xdr日志数」/ D23「已拦截外联次数」是**同一个端点**，但问法都不同：
 *   · G99  ：两张表、不筛 —— 这段时间收到多少日志
 *   · D23  ：两张表、按表各带一条过滤串（网络「内→外 且已拦截」、终端「已拦截」）
 *   · D61  ：**一张表**（网络安全日志）、带「外→内」这一条过滤串 —— 外部攻击日志有多少
 * 所以它是本仓在这个端点上的**第四种问法**，同样**单独问一次**、不与 D23/G99 同生共死
 * （一次失败只让读它的那格写「接口不通无值」，见 stats/metrics/security_log.js）。
 *
 * 报告期与 G99/D23 同一把尺子：CLI 的 --start/--end 直传（起 00:00:00 / 止 23:59:59，
 * 本地时区），换算成 epoch 秒发出去；抓包里那两个数差整 30 天不算口径。
 *
 * @param {Object} options 同 fetchMsswSecurityLogCount
 * @returns {Promise<{total: number, network: number, fromDate: number, toDate: number}>}
 *   total 与 network 是同一个数（只有一张表，保留 network 是为了与另外两个 fetch 的返回形状对齐）
 * @throws {Error} 缺 --start/--end / 起止倒置 / 请求失败 / 业务码非成功 / 缺数量
 */
async function fetchMsswExternalAttackLogCount(options = {}) {
  const logger = options.logger;
  const { begin, end } = resolveMsswTimeRange(options, '外部攻击日志量统计');

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const network = MSSW_LOG_TABLES.find((table) => table.key === 'network');
  const total = await fetchMsswLogCountByTable(
    cookieInfo, platform, companyId, network.tableName, begin, end, logger, MSSW_EXTERNAL_ATTACK_FILTER
  );

  logInfo(logger, `[数据统计] 外部攻击日志量 ${formatMsswDateTime(begin)} ~ ${formatMsswDateTime(end)}: `
    + `${network.label} ${total} = ${total}`);

  return { fromDate: begin, toDate: end, network: total, total };
}

/**
 * 「外部攻击数（按月）」（C71:N72）—— D61 那条接口条件**逐月各问一次**
 * （用户口径 2026-10-20：「按照输入的时间范围划分出月份，按照月份调用多次 D61 的接口条件…
 * 最多 12 个月，月份不足就留空。首尾月要限定在输入的时间范围里」）。
 *
 * 每一问与 D61 **逐字相同**：日志量端点、只问**网络安全日志一张表**、
 * `searchString` = `filter srcIpTag=0 AND dstIpTag=1`（外→内）—— 差别只在时间范围：
 *   · 首月从报告期的起始日算起、末月到报告期的结束日为止（裁到报告期）；
 *   · 中间各月是整月。
 * 月份桶本身**不在这里算**：调用方（mssw_downloader.js 的 readMonthlyExternalAttackLogCounts）
 * 用 stats/periods.js 的 monthPeriods 切好、按 `{label, start, end}` 传进来 ——
 * 与取值层 `monthRange` 共用同一条月份轴，槽位才能逐格对上。
 *
 * ⚠️ **各月各自独立地断**：某个月请求失败只让 segment.total = `null`
 * （那一格写「接口不通无值」），其余月份照常问、照常落值 —— 不整段连坐，
 * 也不拿"已通的那几个月之和"冒充全部（本函数回的是逐月数组，没有"和"这个东西）。
 * 只有"连 cookie 都读不出来"这种整段前置失败会抛（下载层收成整段 `null`）。
 *
 * @param {Object} options 与 fetchMsswSecurityLogCount 同一套（cookie / platform /
 *   customerId / logger），外加 `months`
 * @param {Array<{label: string, start: string, end: string}>} options.months
 *   月份桶（stats/periods.js 的 monthPeriods 的输出），升序、互不重叠，
 *   start / end 是 `YYYY-MM-DD`
 * @returns {Promise<{segments: Array<{label: string, start: string, end: string,
 *   total: number|null}>}>} 与传进来的 months 等长同序；`total` 为 null = 那个月接口不通
 * @throws {Error} months 为空 / 读 cookie 失败（整段前置失败）
 */
async function fetchMsswMonthlyExternalAttackLogCounts(options = {}) {
  return fetchMsswMonthlyNetworkLogCounts(options, {
    label: '外部攻击日志量',
    filter: MSSW_EXTERNAL_ATTACK_FILTER
  });
}

/**
 * 「恶意外联数（按月）」C73:N73 —— 与上面那个函数**同一套逐月循环**，只换过滤串
 * （用户口径 2026-10-20：「请求体条件是 srcIpTag=1 AND dstIpTag=0」，即「内→外」）。
 *
 * 它与 D23「已拦截外联次数」**不是同一条口径**：D23 的抓包串还带 `action = 2`，
 * 本块的条件里没有那一条 —— 数的是全部内→外日志，不管是否被拦截。也不与 D61 相加/相减：
 * 三个量是同一个端点上的三次独立问。
 *
 * @param {Object} options 与 fetchMsswMonthlyExternalAttackLogCounts 同一套
 * @returns {Promise<{segments: Array<{label: string, start: string, end: string,
 *   total: number|null}>}>} 与月份桶等长同序；`total` 为 null = 那个月接口不通
 */
async function fetchMsswMonthlyMaliciousOutboundLogCounts(options = {}) {
  return fetchMsswMonthlyNetworkLogCounts(options, {
    label: '恶意外联日志量',
    filter: MSSW_MALICIOUS_OUTBOUND_FILTER
  });
}

/**
 * 「按月各问一次网络安全日志」的共用循环 —— C71:N72（外部攻击数）与 C73:N73（恶意外联数）
 * 两份逐月序列共用这一处（H4：循环/失败语义只有一份），差别只在 `searchString` 与日志里的叫法。
 *
 * @param {Object} options cookie / platform / customerId / logger / months（见下）
 * @param {{label: string, filter: string}} spec 日志叫法 + 过滤串
 * @returns {Promise<{segments: Array<{label: string, start: string, end: string,
 *   total: number|null}>}>}
 */
async function fetchMsswMonthlyNetworkLogCounts(options, spec) {
  const logger = options.logger;
  const months = options.months || [];
  if (months.length === 0) {
    throw new Error(`MSSW 按月${spec.label}需要至少一个月份桶`);
  }

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';
  const network = MSSW_LOG_TABLES.find((table) => table.key === 'network');

  const segments = [];
  for (const month of months) {
    // 每个桶都是"起日 00:00:00 ~ 止日 23:59:59"的本地日界闭区间 —— 与 D61 同一把尺子。
    const { begin, end } = resolveMsswTimeRange({ start: month.start, end: month.end },
                                                `按月${spec.label}统计`);
    try {
      const total = await fetchMsswLogCountByTable(
        cookieInfo, platform, companyId, network.tableName, begin, end, logger, spec.filter
      );
      segments.push({ label: month.label, start: month.start, end: month.end, total });
    } catch (error) {
      // 各月各自独立地断：这一格写「接口不通无值」，后面的月份照问。
      logInfo(logger, `⚠️ [数据统计] ${month.label} 的${spec.label}接口不通（${error.message}）`
        + '—— 只有这一个月的格子写「接口不通无值」，其余月份照常取数');
      segments.push({ label: month.label, start: month.start, end: month.end, total: null });
    }
  }

  const failed = segments.filter((segment) => segment.total === null).map((segment) => segment.label);
  logInfo(logger, `[数据统计] ${spec.label}（按月）${segments.length} 个月：`
    + segments.map((segment) => `${segment.label}=${segment.total === null ? '不通' : segment.total}`).join(' ')
    + (failed.length ? `（${failed.join('、')} 这几个月接口不通）` : ''));

  return { segments };
}

/**
 * 「重要时期安全日志数」（D27）—— 对每个重要时期段各问一次日志量，把各段的
 * 「网络安全日志 + 终端安全日志」之和再相加（用户口径 2026-10-14：「按照日志查询接口，
 * 根据重要时间，**分段**查网络安全日志+终端安全日志，无需额外的筛选条件…**分段的结果求和**」）。
 *
 * ⚠️ 与 G99 是**同一个端点、同一批表、同一种问法**（不筛，第二参不传 = 每张表空串）
 * —— 差别只在**报告期被切成了多段**：本函数把每一段各当一次独立的
 * `fetchMsswLogTableCounts` 调用（段内仍是"一次问两张表、并发、相加"，那一份循环完全复用），
 * 段与段之间**串行**（报告期跨整年时段数最多约 8：串行换来逐段可读的进度日志，
 * 也避免 N 段一起压同一个聚合端点）。超时沿用 MSSW_LOG_REQUEST_TIMEOUT_MS。
 *
 * 段**不在这里算** —— 由调用方（mssw_downloader.js 的 readImportantPeriodLogCount）
 * 用 stats/periods.js 的 importantPeriods 算好传进来。报告期内一段都没有时，
 * 调用方直接给 0、**根本不会调到这里**（0 是结论，不是缺数）。
 *
 * @param {Object} options 与 fetchMsswSecurityLogCount 同一套（cookie / platform /
 *   customerId / logger），外加 `periods`
 * @param {Array<{name: string, start: string, end: string}>} options.periods
 *   重要时期段，**升序、互不重叠**，start / end 是 `YYYY-MM-DD`（stats/periods.js 的形状）
 * @returns {Promise<{total: number, segments: Array<{name: string, start: string,
 *   end: string, total: number}>}>} total = 各段之和；segments 供日志与事后排查
 * @throws {Error} 任一段请求失败 / 业务码非成功 / 缺数量（下载层把它收成"接口不通"那一档）
 */
async function fetchMsswImportantPeriodLogCount(options = {}) {
  const periods = options.periods || [];
  const segments = [];
  let total = 0;

  for (const period of periods) {
    // begin/end 由 resolveMsswTimeRange 从 start/end 解析（它读 options.begin || options.start），
    // 每个段都是"起日 00:00:00 ~ 止日 23:59:59"的本地日界闭区间 —— 与 G99 同一把尺子。
    const { result } = await fetchMsswLogTableCounts(
      Object.assign({}, options, { start: period.start, end: period.end })
    );

    total += result.total;
    segments.push({ name: period.name, start: period.start, end: period.end, total: result.total });

    logInfo(options.logger, `[数据统计] 重要时期「${period.name}」${period.start} ~ ${period.end}: `
      + MSSW_LOG_TABLES.map((table) => `${table.label} ${result[table.key]}`).join(' + ')
      + ` = ${result.total}`);
  }

  logInfo(options.logger, `[数据统计] 重要时期安全日志数 = ${segments.length} 段之和 = ${total} 条（D27）`);
  return { total, segments };
}

/** 判定是否为超时类错误（默认导出超时后要切分页兜底，其它错误不该掩盖）。 */
function isTimeoutError(error) {
  if (!error || typeof error.message !== 'string') return false;
  const text = error.message.toLowerCase();
  return text.includes('timeout') || text.includes('超时') || text.includes('etimedout') || text.includes('esockettimedout');
}

/**
 * 资产导出请求体。export_fields 原样来自 export_fields 接口的 data，
 * 它同时决定了下载后 xlsx 的列。
 */
function buildMsswAssetExportRequestBody(exportFields, ids = [], searchType = 'current') {
  return {
    branch_id: 'all',
    search_type: searchType,
    is_all: false,
    ids: Array.isArray(ids) ? ids : [],
    exclude_ids: [],
    export_fields: exportFields
  };
}

/** 资产导出接口把文件名放在 data 上（是个字符串，不是对象）。 */
function resolveAssetExportFilename(response) {
  if (!response) return '';
  if (response.data) return String(response.data);
  if (response.filename) return String(response.filename);
  return '';
}

/**
 * 触发资产导出，返回文件名。同步接口：没有 task_id，也没有轮询。
 * 超时给到 10 分钟（资产导出是同步接口，大客户可能跑很久）。
 */
async function triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, ids = [], searchType = 'current', { logger } = {}) {
  const headers = buildMsswAssetExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ASSET_EXPORT_ENDPOINT);
  const body = JSON.stringify(buildMsswAssetExportRequestBody(exportFields, ids, searchType));
  headers['content-length'] = String(Buffer.byteLength(body));

  // 同步导出，非幂等（服务端会生成一份文件）：只重试连接层错，600s 超时不重试 ——
  // 超时正是「导出跑不完」的信号，再等 10 分钟没有意义（往下一段会切分页兜底）。
  const response = await requestJson(url, {
    headers,
    body,
    timeout: 600000,
    retry: { logger, label: `资产导出(${searchType})`, attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  const apiSuccess = response && (response.success === true || response.success === 'true');
  if (code !== 0 && code !== '0' && !apiSuccess) {
    throw new Error(`MSSW 资产导出接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/** 下载资产文件：GET + query string，无请求体；这里换掉 content-type。 */
async function downloadMsswAssetFile(cookieInfo, platform, companyId, filename, downloadDir, { logger } = {}) {
  const downloadUrl = platformEndpoint(platform, `${MSSW_ASSET_DOWNLOAD_ENDPOINT}?file=${encodeURIComponent(filename)}`);

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, {
    headers,
    retry: { logger, label: '资产表下载' }
  });
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename
  };
}

/**
 * 资产表加工：清洗「所属业务」列 + 合并待审核资产并新增「审核状态」列。
 *
 * **不删列**：保留资产台账的全部原始列。
 *
 * @param {string} excelPath 资产台账 xlsx
 * @param {string} [waitApprovePath] 待审核资产 xlsx
 * @param {string} outputDir 加工结果输出目录
 */
async function processAssetTable(excelPath, waitApprovePath, outputDir) {
  if (!excelPath) {
    throw new Error('processAssetTable 需要资产台账路径');
  }

  const scriptPath = path.join(__dirname, 'scripts', 'process_asset_table.py');
  const args = [encodePath(excelPath), encodePath(outputDir)];
  if (waitApprovePath) {
    args.push(encodePath(waitApprovePath));
  }

  const { stdout } = await execPythonWithDiagnostics(scriptPath, args, '资产表加工失败');
  const parsed = JSON.parse(stdout);
  if (!parsed.filePath) {
    throw new Error(`资产表加工未返回 filePath: ${stdout.slice(0, 500)}`);
  }
  return parsed;
}

/**
 * 导出资产表：取字段集 → 导出台账 → 导出待审核 → 加工（清洗所属业务 + 合并）。
 *
 * 落盘目录与事件表一致：不传 downloadDir 时落在 cookie 文件所在目录；
 * 加工结果写到 outputDir（默认 <repo>/tmp/exports）。
 */
async function exportMsswAssetList(options) {
  const logger = options.logger;
  logInfo(logger, '导出 MSSW 资产表（资产台账 + 待审核资产）');

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';
  const assetIds = options.assetIds || [];
  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const outputDir = path.resolve(options.outputDir || path.join(__dirname, 'tmp', 'exports'));

  const exportFieldsResponse = await fetchMsswExportFields(cookieInfo, platform, companyId);
  const exportFields = exportFieldsResponse.data;
  logInfo(logger, `资产导出字段组: ${Object.keys(exportFields || {}).join(', ')}`);

  let currentFilePath = '';
  let waitApproveFilePath = '';
  let currentFilename = '';
  let pagedFallback = false;
  let preCheckedTotal = null;

  if (assetIds.length) {
    logInfo(logger, `使用 ${assetIds.length} 个指定资产 ID 导出`);
  }

  // 双维度切分页：
  //   1) 资产数 > PAGED_EXPORT_THRESHOLD 时直接走分页，省掉一次注定超时的默认导出
  //   2) 默认导出超时（600s）后兜底走分页
  if (!DISABLE_PAGED_EXPORT && !assetIds.length) {
    try {
      const currentTotal = await fetchMsswAssetTotalCount(cookieInfo, platform, companyId, 'current');
      const waitApproveTotal = await fetchMsswAssetTotalCount(cookieInfo, platform, companyId, 'wait_approve');
      preCheckedTotal = Math.max(currentTotal, waitApproveTotal);
      logInfo(logger, `资产总数（接口预查）: 资产台账 ${currentTotal}，待审核 ${waitApproveTotal}，取最大值 ${preCheckedTotal} 作为分页阈值判断依据`);
    } catch (error) {
      // 预查失败不致命：退化成"先试默认导出，超时再兜底"
      logInfo(logger, `资产总数预查失败（继续走默认导出 + 超时兜底）: ${error.message}`);
      preCheckedTotal = null;
    }
  }

  if (!DISABLE_PAGED_EXPORT && preCheckedTotal !== null && preCheckedTotal > PAGED_EXPORT_THRESHOLD) {
    logInfo(logger, `资产台账 ${preCheckedTotal} > ${PAGED_EXPORT_THRESHOLD}，直接走分页导出（避免默认导出超时白等）`);
    pagedFallback = true;
    const pagedResult = await pagedExportMsswAssetList({
      cookieInfo,
      platform,
      companyId,
      outputDir: downloadDir,
      pageSize: 1000,
      searchType: 'both',
      logger
    });
    currentFilePath = pagedResult.currentFilePath;
    waitApproveFilePath = pagedResult.waitApproveFilePath || '';
    currentFilename = currentFilePath ? path.basename(currentFilePath) : '';
  } else {
    try {
      // 第 1 步：资产台账（search_type=current）
      const currentExport = await triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, assetIds, 'current', { logger });
      currentFilename = resolveAssetExportFilename(currentExport);
      if (!currentFilename) {
        throw new Error(`MSSW 资产台账导出接口返回缺少文件名: ${JSON.stringify(currentExport).slice(0, 500)}`);
      }
      const currentDownloaded = await downloadMsswAssetFile(cookieInfo, platform, companyId, currentFilename, downloadDir, { logger });
      currentFilePath = currentDownloaded.filePath;
      logInfo(logger, `资产台账已下载: ${currentFilePath}`);

      // 第 2 步：待审核资产（search_type=wait_approve），失败不阻断主流程
      try {
        const waitApproveExport = await triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, assetIds, 'wait_approve', { logger });
        const waitApproveFilename = resolveAssetExportFilename(waitApproveExport);
        if (waitApproveFilename) {
          const waitApproveDownloaded = await downloadMsswAssetFile(cookieInfo, platform, companyId, waitApproveFilename, downloadDir, { logger });
          waitApproveFilePath = waitApproveDownloaded.filePath;
          logInfo(logger, `待审核资产已下载: ${waitApproveFilePath}`);
        } else {
          logInfo(logger, '待审核资产导出接口返回缺少文件名，仅使用资产台账数据');
        }
      } catch (error) {
        logInfo(logger, `待审核资产导出失败（不影响主流程）: ${error.message}`);
      }
    } catch (error) {
      // 只有超时才兜底；其它错误（鉴权、参数、字段）直接抛，掩盖了更难排查
      if (!isTimeoutError(error)) {
        throw error;
      }
      if (DISABLE_PAGED_EXPORT) {
        logInfo(logger, `默认导出接口超时（${error.message}），分页导出已屏蔽，直接失败`);
        throw error;
      }
      logInfo(logger, `默认导出接口超时（${error.message}），切换分页接口兜底导出`);
      pagedFallback = true;
      const pagedResult = await pagedExportMsswAssetList({
        cookieInfo,
        platform,
        companyId,
        outputDir: downloadDir,
        pageSize: 1000,
        searchType: 'both',
        logger
      });
      currentFilePath = pagedResult.currentFilePath;
      waitApproveFilePath = pagedResult.waitApproveFilePath || '';
      currentFilename = currentFilePath ? path.basename(currentFilePath) : '';
    }
  }

  // 第 3 步：加工 — 清洗所属业务列 + 合并待审核并新增审核状态列（不删列）
  const processed = await processAssetTable(currentFilePath, waitApproveFilePath, outputDir);
  logInfo(logger, `资产表已加工写入: ${processed.filePath}${pagedFallback ? '（分页兜底）' : ''}`);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: processed.filePath,
    rawFilePath: currentFilePath,
    waitApproveFilePath: waitApproveFilePath || undefined,
    filename: currentFilename,
    pagedFallback,
    assetTotal: preCheckedTotal === null ? undefined : preCheckedTotal,
    exportFields
  };
}

/**
 * 跑一个 Python 辅助脚本，拿它的 stdout/stderr。
 *
 * 解释器由 python_cmd 解析（本地 python / 集群 python3）—— 集群镜像里通常没有
 * `python`，写死会在流水线末段（删事件表/漏洞表的误报行）才炸。
 */
function execPythonWithDiagnostics(scriptPath, args, label) {
  return pythonCmd.execFilePython(scriptPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 1800000,
    // childEnv：关掉 __pycache__（集群上 skill 根只读）+ TMPDIR 指到可写区
    env: workdir.childEnv()
  }).then(
    ({ stdout, stderr }) => ({ stdout: stdout.trim(), stderr }),
    (error) => {
      // stderr 原文优先（脚本自己的 traceback 比 Node 的 error.message 有用）
      throw new Error(`${label}: ${error.message}`);
    }
  );
}

/**
 * 删除表中「处置状态」命中判据的行，原地改写文件（事件表 / 漏洞表共用）。
 *
 * @param {string} excelPath 表 xlsx 路径（原地改写）
 * @param {Object} spec
 * @param {string} spec.column 判据列名（精确匹配，见 scripts/remove_rows_by_status.py）
 * @param {string[]} spec.values 待删除的处置状态文字（精确相等）
 * @param {string[]} [spec.aliases] 列名子串退路，仅在精确匹配不到时生效
 * @param {string} spec.label 表名，只进日志/报错文案
 */
async function removeRowsByStatus(excelPath, spec) {
  const label = spec.label || '表';
  if (!excelPath) {
    return { removed: 0, totalBefore: 0, totalAfter: 0, message: `${label}路径为空`, diagnostics: [] };
  }

  const scriptPath = path.join(__dirname, 'scripts', 'remove_rows_by_status.py');
  const payload = {
    column: spec.column,
    values: spec.values,
    aliases: Array.isArray(spec.aliases) ? spec.aliases : [],
    label
  };
  const { stdout, stderr } = await execPythonWithDiagnostics(
    scriptPath,
    [encodePath(excelPath), JSON.stringify(payload)],
    `${label}按「${spec.column}」删除 ${spec.values.join(' / ')} 行失败`
  );
  const parsed = JSON.parse(stdout);
  const diagnostics = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { raw: line };
      }
    });

  return {
    removed: Number(parsed.removed || 0),
    totalBefore: Number(parsed.total_before || 0),
    totalAfter: Number(parsed.total_after || 0),
    message: parsed.message || '',
    diagnostics
  };
}

/**
 * 把一份删除结果里的诊断行打给日志（列命中情况、状态值分布、逐行命中明细）。
 */
function logRemoveDiagnostics(logger, removeResult) {
  for (const diag of removeResult.diagnostics || []) {
    logInfo(logger, `[过滤诊断] ${JSON.stringify(diag)}`);
  }
}

/**
 * 导出事件表：创建任务 → 轮询 → 下载到 cookie 所在目录 → 删除「已忽略」行。
 *
 * 下载目录刻意与 cookie 文件同目录（不传 downloadDir 时），
 * 而不是 Windows 配置的「下载」目录。
 *
 * @returns {Promise<object>} 含 filePath（最终 xlsx 路径）与任务元信息
 */
async function exportMsswIncidentList(options) {
  const logger = options.logger;
  logInfo(logger, `导出 MSSW 事件表: ${options.start} ~ ${options.end}`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const exportResponse = await triggerMsswIncidentExport(cookieInfo, platform, options);
  const exportData = exportResponse && exportResponse.data && typeof exportResponse.data === 'object' ? exportResponse.data : {};
  const taskId = exportData.task_id;
  if (!taskId) {
    throw new Error(`MSSW 事件导出创建任务返回缺少 task_id: ${JSON.stringify(exportResponse).slice(0, 500)}`);
  }

  logInfo(logger, `事件导出任务: ${taskId}`);

  const queryResponse = await pollMsswIncidentExportTask(cookieInfo, platform, taskId, options);
  const queryData = queryResponse && queryResponse.data && typeof queryResponse.data === 'object' ? queryResponse.data : {};
  const fileUrl = queryData.download_url;
  const fileName = queryData.file_name || `incident-export-${taskId}.xlsx`;

  if (!fileUrl) {
    throw new Error(`MSSW 事件导出查询返回缺少下载路径: ${JSON.stringify(queryResponse).slice(0, 500)}`);
  }

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswIncidentFile(cookieInfo, platform, taskId, downloadDir, fileName, companyId, { logger });
  logInfo(logger, `事件表已下载: ${downloaded.filePath}`);

  // 误报过滤：直接读事件表自带的「处置状态」列，删除标记为「已忽略」的行。
  const removeResult = await removeRowsByStatus(downloaded.filePath, {
    column: DISPOSAL_STATUS_COLUMN,
    values: MSSW_INCIDENT_DROP_STATUS_VALUES,
    aliases: MSSW_INCIDENT_STATUS_COLUMN_ALIASES,
    label: '事件表'
  });
  logInfo(logger, `已忽略事件过滤完成: ${removeResult.message} (removed=${removeResult.removed}, totalBefore=${removeResult.totalBefore}, totalAfter=${removeResult.totalAfter})`);
  logRemoveDiagnostics(logger, removeResult);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    taskId,
    fileUrl,
    downloadUrl: downloaded.downloadUrl,
    removedRows: removeResult.removed,
    totalBefore: removeResult.totalBefore,
    totalAfter: removeResult.totalAfter,
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

// ---------------------------------------------------------------------------
// 弱密码表（vul_manage 那一对接口；**漏洞表 2026-10-16 起已不在这一段**，
// 见下方 MSSW_VULN_ASYNC_* / exportMsswVulnList）
// ---------------------------------------------------------------------------

/**
 * 弱密码表导出的 timeRange 值：epoch **毫秒**，起 = 起始日 00:00:00.000，
 * 止 = 结束日 23:59:59.**999**。
 *
 * 收尾用 .999（与事件表、异步漏洞表同一套 resolveMsswTimeRangeMs）。平台前端自己就在
 * .000 / .999 之间摇摆，差这 999ms 正常碰不到（平台的时间列是秒/日粒度），
 * 统一到 .999，也省掉一份重复实现。
 *
 * 「按哪一列圈」由 MSSW_VUL_MANAGE_TIME_RANGE_KEY 决定（弱密码表是「首次发现时间」）——
 * 这不是本函数的事，但它决定了这个区间的语义，改键时必须一起来看。
 *
 * 两个日期一个都没传时回落空数组 = 全量导出（`--type weakpwd` 单独跑仍可用）；
 * 只传一个则照常报错，因为那多半是手滑，静默退全量会得出另一份数据。
 *
 * @param {object} options 认 --start/--end（也认 begin，与事件表一致）
 * @returns {number[]} [startMs, endMs]，或空数组表示不过滤
 */
function resolveVulManageTimeRangeMs(options = {}) {
  const hasStart = Boolean(options.begin || options.start);
  const hasEnd = Boolean(options.end);
  if (!hasStart && !hasEnd) return [];

  return resolveMsswTimeRangeMs(options, '弱密码表导出');
}

/**
 * vul_manage 导出请求体。两个 kind 共用一套筛选器，只有差异部分按 kind 取。
 *
 * @param {'vuln'|'weakpwd'} kind
 * @param {number[]} [timeRangeMs] 报告期区间，见 resolveVulManageTimeRangeMs；缺省空数组 =
 *   全量。**键名由平台定**（MSSW_VUL_MANAGE_TIME_RANGE_KEY = found_time_range）——
 *   平台把「按哪一列圈」编进了键名本身，两张表共用这一个键。
 *   键显式放在第一个，与平台抓包里的位置一致（弱密码抓包里它在中间，键序无语义，无所谓）。
 * @param {object} [customHeaders] 视图配置，导出前现取（见 fetchWeakPwdCustomHeaders）
 */
function buildMsswVulManageExportRequestBody(kind, timeRangeMs = [], customHeaders = {}) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的 vul_manage 表类型: ${kind}（可选 ${Object.keys(MSSW_VUL_MANAGE_KINDS).join(' / ')}）`);
  }

  return {
    [MSSW_VUL_MANAGE_TIME_RANGE_KEY]: timeRangeMs,
    ...MSSW_VUL_MANAGE_BASE_FILTERS,
    ...spec.extraFilters,
    data_type: [spec.dataType],
    custom_headers: customHeaders,
    header_id: spec.headerId,
    is_all: false,
    multiple_choice: [],
    exclude_multiple_choice: []
  };
}

/**
 * 把 custom_headers 三段视图配置里每个 item 的 selected 都置 true。
 *
 * 平台的视图配置会按用户习惯勾/取消勾列，那份「选中哪些列」直接决定导出文件里有哪几列。
 * 导出方要的是**稳定列集**，所以一律全选 —— 否则同一个客户换个浏览器/换个人导，
 * 列就变了，下游按列名取会静默落空。
 *
 * 输入输出都是 `{base_info:[...], asset_info:[...], disposal_info:[...]}`，
 * 不新增/删除任何 item，也不动 disabled / key / label。
 */
function forceSelectAllCustomHeaders(sections) {
  const out = {};
  for (const [section, items] of Object.entries(sections || {})) {
    out[section] = Array.isArray(items)
      ? items.map(item => (item && typeof item === 'object' ? { ...item, selected: true } : item))
      : items;
  }
  return out;
}

/**
 * 取某张表的视图配置并全选。导出前必调 —— 请求序列是「取列配置 → 导出 → 下载」三步。
 *
 * 响应形如 `{code:0, data:{base_info:[...], asset_info:[...], disposal_info:[...]}}`。
 * 只填 `data` 里的三段，别的键（如果有）原样带上。
 *
 * @param {object} cookieInfo
 * @param {object} platform
 * @param {string} companyId
 * @param {string} endpoint custom_headers 端点（内网/互联网各一个）
 * @param {string} headerId   平台列预设枚举
 * @param {object} [options]  认 logger / timeout
 */
async function fetchCustomHeadersSections(cookieInfo, platform, companyId, endpoint, headerId, options = {}) {
  const url = platformEndpoint(platform, endpoint);
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify({ header_id: headerId }),
    timeout: Number(options.customHeadersTimeoutMs || 60000),
    retry: { logger: options.logger, label: '取视图配置', attempts: 2 }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW 取视图配置失败(${headerId}): ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }
  const data = response && response.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`MSSW 取视图配置返回缺少 data(${headerId}): ${JSON.stringify(response).slice(0, 500)}`);
  }
  return forceSelectAllCustomHeaders(data);
}

/** 内网弱密码表的视图配置（全选）。 */
function fetchWeakPwdCustomHeaders(cookieInfo, platform, companyId, options = {}) {
  return fetchCustomHeadersSections(
    cookieInfo, platform, companyId,
    MSSW_VUL_MANAGE_CUSTOM_HEADERS_ENDPOINT, MSSW_WEAKPWD_HEADER_ID, options
  );
}

/** 互联网弱密码表的视图配置（全选）。 */
function fetchInternetWeakPwdCustomHeaders(cookieInfo, platform, companyId, options = {}) {
  return fetchCustomHeadersSections(
    cookieInfo, platform, companyId,
    MSSW_INTERNET_WEAKPWD_CUSTOM_HEADERS_ENDPOINT, MSSW_INTERNET_WEAKPWD_HEADER_ID, options
  );
}

/**
 * 触发导出并**同步等它跑完**，返回服务端给的文件名。
 *
 * 这个接口没有 task_id：POST 返回时导出已经完成，`data.file_name` 就是待下载的文件名。
 * 文件名形如 `vul-middle-risk_20261008104536.xlsx` —— ⚠️ 里面的 "middle-risk" 是**死的**，
 * 与数据无关（实测该文件名下的表里严重/高危/中危/低危都有），别拿它当口径。
 *
 * 导出前先取视图配置（全选），见 fetchWeakPwdCustomHeaders。
 * 取数范围由 options.start/end 经 resolveVulManageTimeRangeMs 决定（不传 = 全量）。
 */
async function triggerMsswVulManageExport(cookieInfo, platform, companyId, kind, options = {}) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  if (kind !== 'weakpwd') {
    // 同步导出只服务弱密码表。漏洞表拿 loophole 的请求体打过来不会报错，
    // 只会静默导出一份别的数据 —— 早失败。
    throw new Error(`同步导出接口现在只服务弱密码表，${spec ? spec.label : kind}`
      + '已改走异步报表接口（见 exportMsswVulnList）');
  }
  const url = platformEndpoint(platform, MSSW_WEAKPWD_EXPORT_ENDPOINT);
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  // 时间范围从 --start/--end 现算；调用方（exportMsswVulManageList）已经把算好的塞进
  // options.timeRangeMs，直调本函数的探针脚本则在这里自己算。
  const timeRangeMs = options.timeRangeMs || resolveVulManageTimeRangeMs(options);
  const customHeaders = options.customHeaders
    || await fetchWeakPwdCustomHeaders(cookieInfo, platform, companyId, options);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswVulManageExportRequestBody(kind, timeRangeMs, customHeaders)),
    timeout: Number(options.exportTimeoutMs || MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS),
    // 同步阻塞导出，非幂等。超时不重试：这个接口的超时上限就是 600s，
    // 「超时 = 平台卡住」，再等 10 分钟只会把一次失败拖成 20 分钟。
    retry: { logger: options.logger, label: `${spec.label}导出`, attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW ${spec.label}导出失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const fileName = data.file_name;
  if (!fileName) {
    throw new Error(`MSSW ${spec.label}导出返回缺少 file_name: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return { fileName, response };
}

/**
 * 落盘名（漏洞表 / 弱密码表 / 暴露面表共用）—— 比 parseContentDispositionFilename 多一次
 * **百分号解码**。
 *
 * 平台的 content-disposition 是 `filename=%E8%84%86%E5%BC%B1...xlsx` —— 百分号编码的中文
 * （只带 `filename=`、不带 `filename*=`，所以走的是 parseContentDispositionFilename 的普通
 * 分支，而那个分支**不解码**）。照原样用会往磁盘上写一个 %E8%84%86… 的文件名，这里补一次
 * 解码；解不出来就退回导出接口给的那个 ASCII 名（vul-middle-risk_*.xlsx），不因为一个
 * 文件名把整表搞失败。
 *
 * 注意脆弱性那两张表的中文名是**同一个**（都是「脆弱性导出报告_<时间戳>.xlsx」）——
 * 文件名里分不出是哪一张。反正中间件默认用完就删；要留档用 --keep-intermediates 时，
 * 落盘目录里的两个文件靠时间戳区分，别靠名字。
 *
 * 暴露面表走附件端点（/gateway/workflow/order/v1/attachments），那一份的
 * content-disposition 没实测过 —— 正因为没实测过，才走这条**会解码**的路：
 * 平台在别处就是百分号编码中文，赌它不编码没有好处（赌错就是磁盘上一个 %E6%9A%B4 文件名）。
 *
 * 刻意**不改** parseContentDispositionFilename 本身：它同时服务告警表，那边的
 * content-disposition 长什么样没实测过，不拿告警表冒这个险。
 */
function resolveExportFilename(disposition, fallback) {
  const parsed = parseContentDispositionFilename(disposition, '');
  if (!parsed) return fallback;
  if (!parsed.includes('%')) return parsed;
  try {
    return decodeURIComponent(parsed) || fallback;
  } catch (error) {
    return fallback;
  }
}

/**
 * 下载回来的东西必须是 xlsx（zip，魔数 `PK`）。网关的错误体是 HTTP 200 +
 * `{"code":1,"message":"..."}`，不拦下来就会被当成表格写盘、在下游的
 * openpyxl 里炸成 BadZipFile，看不出服务端给的真正原因。
 */
function assertDownloadedZip(downloaded, { label = '下载', downloadUrl = '' } = {}) {
  const buffer = (downloaded && downloaded.buffer) || Buffer.alloc(0);
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return;

  const body = buffer.slice(0, 500).toString('utf8');
  let serverMessage = '';
  try {
    const parsed = JSON.parse(body);
    serverMessage = parsed.message || parsed.msg || '';
  } catch (error) {
    // 不是 JSON 就按原样截一段
  }

  throw new Error(
    `MSSW ${label}返回的不是文件${serverMessage ? `：${serverMessage}` : ''}`
      + `（${buffer.length} 字节, ${downloadUrl}）${serverMessage ? '' : ` 内容: ${body}`}`
  );
}

/**
 * 下载弱密码表的导出文件。默认走内网的 `/order/v1/vul_manage/download_file`；
 * **互联网那份必须传自己的 endpoint**（`MSSW_INTERNET_WEAKPWD_DOWNLOAD_ENDPOINT`），
 * 内网端点会拿文件名做格式校验，喂互联网的文件名回「file格式不合法」（2026-10-20 实测）。
 *
 * 与其他两份"按文件名换文件"的接口一致：二进制读，且必须去掉
 * x-requested-with / content-type，否则会被网关当作普通 XHR 拦掉。
 */
async function downloadMsswVulManageFile(
  cookieInfo,
  platform,
  companyId,
  fileName,
  downloadDir,
  { logger, endpoint = MSSW_WEAKPWD_DOWNLOAD_ENDPOINT, label = '脆弱性表下载' } = {}
) {
  const downloadUrl = platformEndpoint(
    platform,
    `${endpoint}?file=${encodeURIComponent(fileName)}`
  );

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: '*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  // 默认端点走内网弱密码表；互联网那份由调用方传 endpoint 覆盖。
  // 默认日志写「脆弱性表」—— 导出文件名本来也是同一个（见 resolveExportFilename 上方注释）。
  const downloaded = await requestBuffer(downloadUrl, {
    headers,
    retry: { logger, label }
  });

  // 网关出错时是 HTTP 200 + `application/json` 的错误体（如「file格式不合法」
  // 「文件不存在，请重新生成文件」），照写成本地 .xlsx 的话，报错会拖到
  // openpyxl 那里变成一句 BadZipFile，把服务端真正的原因盖掉。这里提前拦。
  assertDownloadedZip(downloaded, { label, downloadUrl });

  const disposition = downloaded.headers
    && (downloaded.headers['content-disposition'] || downloaded.headers['Content-Disposition']);
  const filename = resolveExportFilename(disposition, fileName);
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename,
    downloadUrl
  };
}

/**
 * 导出**弱密码表**：同步导出 → 拿 file_name → 下载到 cookie 所在目录。
 *
 * 落盘后的加工：删掉「处置状态」=「处置完成（误报）」的行、原地改写
 * （与事件表同一套机制）；**不加**「内网外网资产」列（那是事件表独有的）。
 *
 * @param {object} options 与其它 export* 同：msswCookiePath / msswBaseUrl / customerId / downloadDir，
 *   另认 start/end（YYYY-MM-DD）—— 取数范围，不传则全量
 * @param {'vuln'|'weakpwd'} kind 现在只接受 'weakpwd'；'vuln' 会在 trigger 那层报错
 * @returns {Promise<object>} 含 filePath（xlsx 路径）、导出元信息与 removedRows/totalBefore/totalAfter
 */
async function exportMsswVulManageList(options, kind) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的 vul_manage 表类型: ${kind}（可选 ${Object.keys(MSSW_VUL_MANAGE_KINDS).join(' / ')}）`);
  }

  const logger = options.logger;
  // 时间范围先算再打日志：日志里得写清这一次到底按哪一段取的数。
  const timeRangeMs = resolveVulManageTimeRangeMs(options);
  logInfo(logger, timeRangeMs.length
    ? `导出 MSSW ${spec.label}: ${options.start || options.begin} ~ ${options.end}（按「${MSSW_VUL_MANAGE_TIME_RANGE_LABEL}」过滤）`
    : `导出 MSSW ${spec.label}: 全量（未传 --start/--end，${MSSW_VUL_MANAGE_TIME_RANGE_KEY} 留空）`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  // 同步接口：这一行要等到平台把整份表导出完才回来，所以日志分两句 ——
  // 不然日志里会是一段没有解释的空白。
  const startedAt = Date.now();
  const { fileName, response } = await triggerMsswVulManageExport(
    cookieInfo, platform, companyId, kind, { ...options, timeRangeMs }
  );
  logInfo(logger, `${spec.label}导出完成: ${fileName}（服务端耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswVulManageFile(cookieInfo, platform, companyId, fileName, downloadDir, { logger });
  logInfo(logger, `${spec.label}已下载: ${downloaded.filePath}`);

  // 误报过滤：落盘后读表自带的「处置状态」列，删掉「处置完成（误报）」的行。
  // 弱密码表与漏洞表同判据（用户 2026-10-08 口径；漏洞表现在走异步接口，仍在解包层之外
  // 由 mssw_downloader 处理）；事件表走自己的「已忽略」，见上方常量。
  const removeResult = await removeRowsByStatus(downloaded.filePath, {
    column: DISPOSAL_STATUS_COLUMN,
    values: MSSW_VUL_MANAGE_DROP_STATUS_VALUES,
    label: spec.label
  });
  logInfo(logger, `${spec.label}误报过滤完成: ${removeResult.message} (removed=${removeResult.removed}, totalBefore=${removeResult.totalBefore}, totalAfter=${removeResult.totalAfter})`);
  logRemoveDiagnostics(logger, removeResult);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    fileUrl: fileName,
    downloadUrl: downloaded.downloadUrl,
    removedRows: removeResult.removed,
    totalBefore: removeResult.totalBefore,
    totalAfter: removeResult.totalAfter,
    removeMessage: removeResult.message,
    exportResponse: {
      code: response && response.code,
      message: response && response.message
    },
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

// ---------------------------------------------------------------------------
// 互联网弱密码表（与内网弱密码表是两次独立导出）
// ---------------------------------------------------------------------------

/**
 * 触发互联网弱密码表导出并**同步等它跑完**，返回服务端给的文件名。
 *
 * 与内网那份同样是同步导出（POST 回来即 `{code:0, data:{file_name}}`），
 * 所以复用同一套超时/不重试策略：超时 = 平台卡住，再等一个 600s 没有意义。
 * 导出前先取互联网自己的视图配置（全选），再走
 * buildMsswInternetWeakPwdExportRequestBody（独立键集，不共用内网筛选器）。
 */
async function triggerMsswInternetWeakPwdExport(cookieInfo, platform, companyId, options = {}) {
  const label = '互联网弱密码表';
  const url = platformEndpoint(platform, MSSW_INTERNET_WEAKPWD_EXPORT_ENDPOINT);
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const timeRangeMs = options.timeRangeMs || resolveVulManageTimeRangeMs(options);
  const customHeaders = options.customHeaders
    || await fetchInternetWeakPwdCustomHeaders(cookieInfo, platform, companyId, options);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswInternetWeakPwdExportRequestBody(timeRangeMs, customHeaders)),
    timeout: Number(options.exportTimeoutMs || MSSW_INTERNET_WEAKPWD_EXPORT_TIMEOUT_MS),
    retry: { logger: options.logger, label: `${label}导出`, attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW ${label}导出失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const fileName = data.file_name;
  if (!fileName) {
    throw new Error(`MSSW ${label}导出返回缺少 file_name: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return { fileName, response };
}

/**
 * 导出**互联网弱密码表**：同步导出 → 拿 file_name → 用**互联网自己的** download_file 下载。
 *
 * 落盘后的加工与内网弱密码表完全一致：删「处置状态」=「处置完成（误报）」的行。
 * 返回结构与 exportMsswVulManageList 对齐，下游 downloadTable 不用分支处理字段。
 *
 * @param {object} options 与其它 export* 同：msswCookiePath / msswBaseUrl / customerId /
 *   downloadDir，另认 start/end（YYYY-MM-DD）—— 不传则全量
 */
async function exportMsswInternetWeakPwdList(options = {}) {
  const label = '互联网弱密码表';
  const logger = options.logger;
  const timeRangeMs = resolveVulManageTimeRangeMs(options);
  logInfo(logger, timeRangeMs.length
    ? `导出 MSSW ${label}: ${options.start || options.begin} ~ ${options.end}（按「${MSSW_VUL_MANAGE_TIME_RANGE_LABEL}」过滤）`
    : `导出 MSSW ${label}: 全量（未传 --start/--end，${MSSW_VUL_MANAGE_TIME_RANGE_KEY} 留空）`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const startedAt = Date.now();
  const { fileName, response } = await triggerMsswInternetWeakPwdExport(
    cookieInfo, platform, companyId, { ...options, timeRangeMs }
  );
  logInfo(logger, `${label}导出完成: ${fileName}（服务端耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswVulManageFile(
    cookieInfo, platform, companyId, fileName, downloadDir,
    {
      logger,
      label: `${label}下载`,
      endpoint: MSSW_INTERNET_WEAKPWD_DOWNLOAD_ENDPOINT
    }
  );
  logInfo(logger, `${label}已下载: ${downloaded.filePath}`);

  // 与内网弱密码表同判据（用户 2026-10-08「处置完成（误报）」）。这份 13 列里也有
  // 「处置状态」，所以同一套 remove_rows_by_status 可以直接用。
  const removeResult = await removeRowsByStatus(downloaded.filePath, {
    column: DISPOSAL_STATUS_COLUMN,
    values: MSSW_VUL_MANAGE_DROP_STATUS_VALUES,
    label
  });
  logInfo(logger, `${label}误报过滤完成: ${removeResult.message} (removed=${removeResult.removed}, totalBefore=${removeResult.totalBefore}, totalAfter=${removeResult.totalAfter})`);
  logRemoveDiagnostics(logger, removeResult);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    fileUrl: fileName,
    downloadUrl: downloaded.downloadUrl,
    removedRows: removeResult.removed,
    totalBefore: removeResult.totalBefore,
    totalAfter: removeResult.totalAfter,
    removeMessage: removeResult.message,
    exportResponse: {
      code: response && response.code,
      message: response && response.message
    },
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

// ---------------------------------------------------------------------------
// 漏洞表（2026-10-16 起：与暴露面表**同一套异步报表接口**）
// ---------------------------------------------------------------------------
//
// 用户口径 2026-10-16：「当前的漏洞表下载要变成下载两份表，接口变了。跟当前暴露面的接口一样，
// 只不过一开始的 <origin>/gateway/easm-exposure/order/v1/vulnmgr/exposed_surface/report
// 要传请求体是 {…}，除了时间和公司 id 是变化的，其他不变；然后轮询接口也是一样，拿刚刚的
// 接口返回的 task_id，行为跟暴露面一致。」
//
// 也就是说：端点是暴露面那两个（MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT / _TASK_ENDPOINT），
// 三段流程（建任务 -> 轮询 -> 下载附件）与暴露面共用，**差别只有建任务那个请求体**。
//
// ⚠️ 与暴露面最大的不同：**这份带时间**。暴露面的请求体里一个时间键都没有（那份表没有时间
// 维度），别把这条经验套过来 —— 漏洞表按「首次发现时间」圈报告期，键名与旧接口一致
// （found_time_range），位置从旧接口的顶层挪到了 params.list_filters 里。
//
// ⚠️ 弱密码表**不在这条路上**：它走同步导出（见上方 MSSW_VUL_MANAGE_*）。
// 两张表不同源，别再按「同源」改其中一处，也别把这套异步三段套到弱密码表上。

/** 请求体里的 data_type —— 用户给的抓包原样（51 = 漏洞表）。暴露面那份是 50。 */
const MSSW_VULN_ASYNC_DATA_TYPE = 51;

/**
 * 漏洞表导出请求体 —— 逐字照 2026-10-16 用户给的那条 curl，只有公司 id 与时间现填。
 *
 * 几个"看着像默认值、其实是契约"的键，都是一位都不许动的：
 *   params.company_id      租户 id，**字符串**（就是 CLI 的 --customer-id 那个值）
 *   export_scope: combined / export_mode: single_table / split{enabled:false, by:fix_priority}
 *                          —— 导出范围与切分方式。`split.enabled:false` 与 exposed 那处的
 *                          `need_split:false` 是同一件事的两处写法，别只改一处
 *   fixed_status: [0,1,2,6,3,4]  处置状态的**白名单**（不是排除项），少一个数就是少一批行
 *   scan_type: [1]         检测方式。与 fixed_status 同理，是"只导这些"，不是"都导"
 *   list_filters.found_time_range 报告期，epoch **毫秒**闭区间（见 buildMsswVulnExportRequestBody）
 *   need_split: false      ⚠️ 与用户给的抓包一致（暴露面那份抓包是 true、被用户改成了 false）
 *
 * 出处：用户 2026-10-16 那条 curl（data_type 51、时间 2026-07-01 ~ 2026-08-01）。
 */
const MSSW_VULN_ASYNC_EXPORT_SCOPE = 'combined';
const MSSW_VULN_ASYNC_EXPORT_MODE = 'single_table';
const MSSW_VULN_ASYNC_FIXED_STATUS = [0, 1, 2, 6, 3, 4];
const MSSW_VULN_ASYNC_SCAN_TYPE = [1];
const MSSW_VULN_ASYNC_SPLIT = { enabled: false, by: 'fix_priority' };

/**
 * @param {string|number} companyId 租户 id
 * @param {number[]} timeRangeMs [startMs, endMs] 闭区间，见 resolveMsswTimeRangeMs
 *   （起 = 起始日 00:00:00.000，止 = 结束日 23:59:59.999 —— 用户给的抓包里就是 .999，
 *   与漏洞表**旧**接口那套截到 .000 的算法刻意不同，别拿 resolveVulManageTimeRangeMs 顶替）
 */
function buildMsswVulnExportRequestBody(companyId, timeRangeMs) {
  const id = String(companyId || '');
  if (!id) {
    throw new Error('MSSW 漏洞表导出缺少 company_id');
  }
  if (!Array.isArray(timeRangeMs) || timeRangeMs.length !== 2) {
    throw new Error('MSSW 漏洞表导出请求体缺少 found_time_range 时间范围（[startMs, endMs]）');
  }

  // 键序照抓包（JSON 的对象键序无语义，这里只是让 diff 与抓包能对着看）。
  return {
    data_type: MSSW_VULN_ASYNC_DATA_TYPE,
    need_split: false,
    params: {
      company_id: id,
      export_scope: MSSW_VULN_ASYNC_EXPORT_SCOPE,
      fixed_status: [...MSSW_VULN_ASYNC_FIXED_STATUS],
      scan_type: [...MSSW_VULN_ASYNC_SCAN_TYPE],
      export_mode: MSSW_VULN_ASYNC_EXPORT_MODE,
      split: { ...MSSW_VULN_ASYNC_SPLIT },
      list_filters: { found_time_range: [timeRangeMs[0], timeRangeMs[1]] }
    }
  };
}

/**
 * 漏洞表（2026-10-16 起走**异步报表**接口，见上面 MSSW_VULN_ASYNC_* 那一段）。
 *
 * ⚠️ 原来这里是 `exportMsswVulManageList(options, 'vuln')`（同步的 /order/v1/vul_manage/*）。
 * 平台换接口后那条路对漏洞表已废（用户 2026-10-16：「当前的漏洞表下载要变成下载两份表，
 * 接口变了」）。弱密码表仍是同步导出，但它**不在这条异步路上** —— 两张表不同源。
 *
 * 本函数只负责**把 zip 字节原样落到磁盘**：一个字节都不改、不解包、不删行
 * （scripts/verify_vuln_async.js 明确钉着这条）。解包是**下载之后**那一步的事，
 * 归 mssw_vuln_extract.js -> scripts/extract_vuln_report.py（"两份表怎么处理"的答案是
 * 各自搬一张 sheet，见那里；别把 unzip 塞进这一层，那条验收门会当场变红）。
 */
async function exportMsswVulnList(options) {
  const logger = options.logger;
  const hasStart = Boolean(options.begin || options.start);
  if (!hasStart || !options.end) {
    // 新接口的请求体里 found_time_range 是**必带**的（2026-10-16 用户给的抓包里就有），
    // 不像旧接口那样有「不传 = 全量」这个档。只传一头多半是手滑，
    // 不替平台猜一个空档长什么样：当场报错。
    throw new Error(
      `MSSW 漏洞表导出（异步报表接口）必须带完整报告期：`
      + `--start=${options.start || options.begin || '（缺）'} / --end=${options.end || '（缺）'}。`
      + '旧的「不传 = 全量」只适用弱密码表那条路。'
    );
  }

  const timeRangeMs = resolveMsswTimeRangeMs(options, 'MSSW 漏洞表导出');
  logInfo(logger, `导出 MSSW 漏洞表（异步报表，data_type=${MSSW_VULN_ASYNC_DATA_TYPE}）: `
    + `${options.start || options.begin} ~ ${options.end}（按「${MSSW_VUL_MANAGE_TIME_RANGE_LABEL}」过滤）`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const { taskId } = await triggerMsswAsyncReportExport(
    cookieInfo, platform, companyId,
    buildMsswVulnExportRequestBody(companyId, timeRangeMs),
    { ...options, label: '漏洞表' }
  );
  logInfo(logger, `漏洞表导出任务: ${taskId}`);

  const polled = await pollMsswAsyncReportTask(cookieInfo, platform, companyId, taskId, {
    ...options, label: '漏洞表'
  });
  logInfo(logger, `漏洞表导出完成（rotation_status=${polled.rotationStatus}）`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswAsyncReportFile(
    cookieInfo, platform, companyId, polled.attachmentUrl, downloadDir, {
      logger,
      label: '漏洞表',
      // 兜底名：抓包里内容是压缩包、content-disposition 没实测过 —— 取不到就用这个名，
      // 别把「文件名没拿到」当成「文件不对」。真下载件优先以响应头里的为准。
      fallbackFilename: `漏洞表-${Date.now()}.zip`,
      accept: 'application/zip,application/x-zip-compressed,application/octet-stream,'
        + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'
    }
  );
  logInfo(logger, `漏洞表已下载: ${downloaded.filePath}`);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    taskId,
    attachmentUrl: polled.attachmentUrl,
    rotationStatus: polled.rotationStatus,
    downloadUrl: downloaded.downloadUrl,
    dataType: MSSW_VULN_ASYNC_DATA_TYPE,
    timeRangeMs,
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

/** 内网弱密码表。 */
function exportMsswWeakPwdList(options) {
  return exportMsswVulManageList(options, 'weakpwd');
}

/**
 * 暴露面表导出请求体 —— 逐字照 2026-10-15 用户给的浏览器抓包。
 *
 * 只有五个键，一个都不是"顺手加的默认值"：
 *   params.company_id       租户 id，**字符串**（就是 CLI 的 --customer-id 那个值）
 *   params.target_company_id / related_task
 *                           两个空数组。看着空，但它们是契约的一部分（抓包原样），别删
 *   need_split: false       ⚠️ **与抓包不同**：抓包是 true，用户 2026-10-16 改成 false。
 *                           别看着抓包"改回去" —— 照抓包是默认口径，用户明确改过的除外
 *   data_type: 50           暴露面这份数据的枚举（见 MSSW_EXPOSED_SURFACE_DATA_TYPE）
 *
 * ⚠️ **没有时间键**。这份表不受 --start/--end 影响（用户口径 2026-10-15：照抓包、不带）——
 * 导的是平台**当前**的暴露面。别顺手补个 found_time_range：键名/列/单位一个都没投喂过，
 * 补了就是替平台猜契约，而且猜错不会报错，只会静默给出另一批数据。
 */
function buildMsswExposedSurfaceExportRequestBody(companyId) {
  const id = String(companyId || '');
  if (!id) {
    throw new Error('MSSW 暴露面表导出缺少 company_id');
  }

  return {
    params: {
      company_id: id,
      target_company_id: [],
      related_task: []
    },
    need_split: false,
    data_type: MSSW_EXPOSED_SURFACE_DATA_TYPE
  };
}

/**
 * 建任务（异步报表三件套的第一件）—— **暴露面表与漏洞表共用**，区别只有请求体。
 *
 * 2026-10-16 之前只有暴露面表走这条路；漏洞表当时走的是另一对同步接口
 * （/order/v1/vul_manage/*，见 MSSW_VUL_MANAGE_* 那一段，现在只剩弱密码表还在用）。
 * 平台把漏洞表也挪到了这套异步接口上，**端点与暴露面逐字相同**、只有请求体不一样 ——
 * 所以这里做成请求体由调用方给的通用件，两个导出各自只提供 body 与日志名 label。
 *
 * ⚠️ task_id 在 `data.task_id`（**字符串**），不是事件表那种 `data.id` ——
 * 同一个平台的两套异步任务，字段名不一样，别按事件表抄。
 */
async function triggerMsswAsyncReportExport(cookieInfo, platform, companyId, requestBody, options = {}) {
  const label = options.label || '暴露面';
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT);

  // 非幂等的建任务：同事件表/告警表，只重试连接层错，超时不重试（超时多半是服务端已在处理）。
  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(requestBody),
    retry: { logger: options.logger, label: `${label}导出建任务`, attempts: 2, onTimeout: false }
  });

  const code = response && response.code;
  if (code !== 0 && code !== '0') {
    throw new Error(`MSSW ${label}导出创建任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
  }

  const data = response && response.data && typeof response.data === 'object' ? response.data : {};
  const taskId = data.task_id;
  if (!taskId) {
    throw new Error(`MSSW ${label}导出创建任务返回缺少 task_id: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return { taskId: String(taskId), response };
}

/**
 * 创建暴露面导出任务，返回 task_id。
 *
 * 走通用件（triggerMsswAsyncReportExport）：端点与漏洞表公用，差别只在请求体；
 * label 保持「暴露面」，所以日志与报错文案与拆分之前逐字一致。
 */
function triggerMsswExposedSurfaceExport(cookieInfo, platform, companyId, options = {}) {
  return triggerMsswAsyncReportExport(
    cookieInfo, platform, companyId,
    buildMsswExposedSurfaceExportRequestBody(companyId),
    { ...options, label: '暴露面' }
  );
}

/**
 * 轮询暴露面导出任务，返回附件地址。
 *
 * 与事件/告警表的轮询**不是同一套**：这里问的是 `.../report_async_task`，请求体是
 * `{task_id_list:[…]}`（要**列表**，不是单个 task_id 键），回的是
 * `data.rotation_status` + `data.attachment_list[{status, progress, url, task_id}]` ——
 * 没有 `status: completed` 那种任务态，也没有"查询失败"的业务态。
 *
 * 判就绪：**名单里认自己那个 task_id 的那一项**（attachment_list 是列表，将来可能同时轮多个任务），
 * 且它带 url 且（`status === 'success'` 或 `progress >= 100`）——
 * 两个判据取或，是因为抓包里这两个字段同时是"成功/100"，但谁先到齐没实测过。
 * 与告警表同一条教训：**别只看一个状态字段就返回**（那边是 status=success 而 result 仍是 null）。
 *
 * 判失败：那一项的 status 是 failed/error/fail（带上 progress 一起报，好定位卡在哪一步）。
 * 顶层 `success:false` 也当场抛 —— 抓包里它是 true，没有"false 但有数据"这种形态。
 *
 * 超时不是静默重试的理由：抛错并**把最近一次看到的 rotation_status / 各附件状态写进消息**，
 * 否则下次只能看到一个光秃秃的 timeout，不知道是排队没跑完还是字段改了。
 */
async function pollMsswAsyncReportTask(cookieInfo, platform, companyId, taskId, options = {}) {
  const label = options.label || '暴露面';
  const timeoutMs = Number(options.timeoutMs || MSSW_EXPOSED_SURFACE_POLL_TIMEOUT_MS);
  const intervalMs = Number(options.pollIntervalMs || 3000);
  const startedAt = Date.now();
  const logger = options.logger;
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_EXPOSED_SURFACE_TASK_ENDPOINT);
  const body = JSON.stringify({ task_id_list: [String(taskId)] });

  let lastLine = '';
  let lastSeen = '（一次都没问到）';

  while (Date.now() - startedAt <= timeoutMs) {
    // 查询幂等，超时也重试（600s 的窗口里抖一下不该从头再来）。
    const response = await requestJson(url, {
      headers,
      body,
      retry: { logger, label: `${label}导出轮询`, onTimeout: true }
    });

    if (response && response.success === false) {
      throw new Error(`MSSW ${label}导出查询失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
    }

    const code = response && response.code;
    if (code !== 0 && code !== '0') {
      throw new Error(`MSSW ${label}导出查询任务失败: ${response.msg || JSON.stringify(response).slice(0, 500)}`);
    }

    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const rotationStatus = data.rotation_status;
    const attachments = Array.isArray(data.attachment_list) ? data.attachment_list : [];
    const mine = attachments.filter((item) => item && String(item.task_id || '') === String(taskId));
    // 认不出自己那一项时（字段改名/换了 id），退回取最后一项 —— 单任务场景下它就是我们这份。
    const attachment = mine.length ? mine[mine.length - 1] : (attachments.length ? attachments[attachments.length - 1] : null);

    const status = String((attachment && attachment.status) || '').toLowerCase();
    const progress = attachment ? Number(attachment.progress) : NaN;
    const line = `rotation_status=${rotationStatus} attachment=${attachment ? `${status}/${progress}` : '（无）'}`;
    if (line !== lastLine) {
      logInfo(logger, `${label}导出任务状态: ${line}${mine.length ? '' : '（未按 task_id 匹配到，取的是最后一项）'}`);
      lastLine = line;
    }
    lastSeen = line;

    if (attachment && ['failed', 'error', 'fail'].includes(status)) {
      throw new Error(`MSSW ${label}导出失败: status=${status} progress=${progress}`);
    }

    if (attachment && attachment.url && (status === 'success' || progress >= 100)) {
      return {
        attachmentUrl: String(attachment.url),
        rotationStatus,
        attachment
      };
    }

    await sleep(intervalMs);
  }

  throw new Error(`MSSW ${label}导出轮询超时: ${timeoutMs}ms（最近一次: ${lastSeen}）`);
}

/** 轮询暴露面导出任务（通用件 + label「暴露面」）。 */
function pollMsswExposedSurfaceExportTask(cookieInfo, platform, companyId, taskId, options = {}) {
  return pollMsswAsyncReportTask(cookieInfo, platform, companyId, taskId, { ...options, label: '暴露面' });
}

/**
 * 轮询响应里的附件地址 -> 可下载的完整 URL。
 *
 * 地址属于 **workflow** 服务（`/gateway/workflow/order/v1/attachments?_file=<文件 id>`），
 * 不归 easm-exposure 管，所以**不自己拼路径**：以响应给的那个为准，只补 origin。
 * 也容忍服务端哪天改成回整条 URL（同 downloadMsswAlertFile 的写法）。
 */
function buildMsswExposedSurfaceAttachmentUrl(platform, attachmentUrl) {
  const raw = String(attachmentUrl || '');
  if (!raw) {
    throw new Error('MSSW 暴露面表导出没有给出附件地址');
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return platformEndpoint(platform, raw.startsWith('/') ? raw : `/${raw}`);
}

/**
 * 下载暴露面导出文件。
 *
 * 与其他三份"按地址换文件"的接口同款：二进制读，且必须去掉
 * x-requested-with / content-type，否则会被网关当作普通 XHR 拦掉。
 *
 * 文件名取 content-disposition（走 resolveExportFilename，会解百分号编码的中文），
 * 取不到就用自己的中文名兜底 —— 这个文件是中间件，默认合并完就删。
 */
async function downloadMsswAsyncReportFile(cookieInfo, platform, companyId, attachmentUrl, downloadDir, options = {}) {
  const label = options.label || '暴露面表';
  const logger = options.logger;
  const downloadUrl = buildMsswExposedSurfaceAttachmentUrl(platform, attachmentUrl);

  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId, {
    accept: options.accept
      || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*'
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  // 下载是 GET、幂等：默认 3 次、超时也重试（onTimeout 的默认值见 normalizeRetryPolicy）。
  const downloaded = await requestBuffer(downloadUrl, {
    headers,
    retry: { logger, label: `${label}下载` }
  });
  const filename = resolveExportFilename(
    downloaded.headers && (downloaded.headers['content-disposition'] || downloaded.headers['Content-Disposition']),
    options.fallbackFilename || `${label}-${Date.now()}.xlsx`
  );
  const targetPath = path.join(downloadDir, filename);
  await fsp.mkdir(downloadDir, { recursive: true });
  await fsp.writeFile(targetPath, downloaded.buffer);

  return {
    ...downloaded,
    filePath: targetPath,
    filename,
    downloadUrl
  };
}

/** 下载暴露面导出文件（通用件 + label「暴露面表」与原来的兜底名）。 */
function downloadMsswExposedSurfaceFile(cookieInfo, platform, companyId, attachmentUrl, downloadDir, options = {}) {
  return downloadMsswAsyncReportFile(cookieInfo, platform, companyId, attachmentUrl, downloadDir, {
    ...options,
    label: '暴露面表',
    fallbackFilename: `暴露面-${Date.now()}.xlsx`
  });
}

/**
 * 导出**暴露面表**：建任务 → 轮询 → 下载到 cookie 所在目录。
 *
 * **不做任何加工**，原样落盘：删行/加列那些口径（事件表有「内网外网资产」，脆弱性两张表有
 * 「处置完成（误报）」过滤）**都没有投喂过暴露面这一份**，所以这里一格都不动。
 *
 * @param {object} options 与其它 export* 同：msswCookiePath / msswBaseUrl / customerId / downloadDir。
 *   ⚠️ **不认 start/end** —— 这份表没有时间维度（见 buildMsswExposedSurfaceExportRequestBody）。
 * @returns {Promise<object>} 含 filePath（xlsx 路径）与任务/附件元信息
 */
async function exportMsswExposedSurfaceList(options) {
  const logger = options.logger;
  logInfo(logger, '导出 MSSW 暴露面表（当前暴露面，不带时间范围）');

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  const { taskId } = await triggerMsswExposedSurfaceExport(cookieInfo, platform, companyId, options);
  logInfo(logger, `暴露面导出任务: ${taskId}`);

  const polled = await pollMsswExposedSurfaceExportTask(cookieInfo, platform, companyId, taskId, options);
  logInfo(logger, `暴露面导出完成（rotation_status=${polled.rotationStatus}）`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswExposedSurfaceFile(
    cookieInfo, platform, companyId, polled.attachmentUrl, downloadDir, { logger }
  );
  logInfo(logger, `暴露面表已下载: ${downloaded.filePath}`);

  return {
    msswBaseUrl: platform.origin,
    downloadDir,
    filePath: downloaded.filePath,
    filename: downloaded.filename,
    taskId,
    attachmentUrl: polled.attachmentUrl,
    rotationStatus: polled.rotationStatus,
    downloadUrl: downloaded.downloadUrl,
    downloadResponse: {
      statusCode: downloaded.statusCode,
      headers: downloaded.headers
    }
  };
}

module.exports = {
  DEFAULT_MSSW_BASE_URL,
  MSSW_INCIDENT_EXPORT_ENDPOINT,
  MSSW_INCIDENT_EXPORT_FIELDS,
  normalizeBaseUrl,
  resolveOrigin,
  hostHeaderFor,
  resolvePlatform,
  platformEndpoint,
  parseLocalDate,
  resolveMsswTimeRange,
  resolveMsswTimeRangeMs,
  buildMsswHeaders,
  buildMsswExportHeaders,
  // HTTP 层：给 scripts/verify_retry.js 对着本地 server 打，验重试的接线
  requestJson,
  requestBuffer,
  buildMsswIncidentExportRequestBody,
  triggerMsswIncidentExport,
  pollMsswIncidentExportTask,
  downloadMsswIncidentFile,
  fetchMsswCustomerListPage,
  findMsswCustomerIdByName,
  // 告警表
  MSSW_ALERT_EXPORT_ENDPOINT,
  MSSW_ALERT_TASK_RESULT_ENDPOINT,
  MSSW_ALERT_TABLE_FIELDS,
  buildMsswAlertHeaders,
  buildMsswAlertExportRequestBody,
  triggerMsswAlertExport,
  pollMsswAlertExportTask,
  parseContentDispositionFilename,
  downloadMsswAlertFile,
  exportMsswAlertList,
  buildMsswAssetExportHeaders,
  fetchMsswExportFields,
  fetchMsswAssetTotalCount,
  // 设备列表（接入组件数量：D100/D101/D102/D104）—— 不落盘，只回行对象
  MSSW_DEVICE_LIST_ENDPOINT,
  fetchMsswDeviceListPage,
  fetchMsswDeviceRows,
  // topn 源 IP 地域（攻击来源地域分布top5：F62:G66）—— 不落盘，只回行对象
  MSSW_TOPN_DEVICE_LIST_ENDPOINT,
  MSSW_TOPN_SRC_IP_GEO_ENDPOINT,
  MSSW_TOPN_THREAT_TYPE_ENDPOINT,
  MSSW_TOPN_DST_IP_ENDPOINT,
  MSSW_TOPN_LIMIT,
  buildTopnDeviceInfos,
  fetchMsswTopnDeviceInfos,
  fetchMsswTopnDeviceInfosOnce,
  fetchMsswSrcIpGeoTopN,
  fetchMsswThreatTypeTopN,
  fetchMsswDstIpTopN,
  // 第三方设备（接入组件数量：D103）与日志量（xdr日志数：G99 / 已拦截外联次数：D23）
  // —— 同样不落盘，只回标量
  MSSW_THIRD_PARTY_DEVICE_ENDPOINT,
  MSSW_LOG_COUNT_ENDPOINT,
  MSSW_LOG_TABLES,
  MSSW_INTERCEPTED_OUTBOUND_FILTERS,
  MSSW_EXTERNAL_ATTACK_FILTER,
  MSSW_MALICIOUS_OUTBOUND_FILTER,
  fetchMsswThirdPartyDeviceCount,
  buildMsswLogCountHeaders,
  buildMsswLogCountRequestBody,
  fetchMsswLogCountByTable,
  fetchMsswSecurityLogCount,
  fetchMsswInterceptedOutboundCount,
  fetchMsswExternalAttackLogCount,
  fetchMsswMonthlyExternalAttackLogCounts,
  fetchMsswMonthlyMaliciousOutboundLogCounts,
  fetchMsswImportantPeriodLogCount,
  isTimeoutError,
  buildMsswAssetExportRequestBody,
  triggerMsswAssetExport,
  downloadMsswAssetFile,
  processAssetTable,
  exportMsswAssetList,
  removeRowsByStatus,
  exportMsswIncidentList,
  // 弱密码表（内网 / 互联网两份独立导出）
  MSSW_WEAKPWD_EXPORT_ENDPOINT,
  MSSW_WEAKPWD_DOWNLOAD_ENDPOINT,
  MSSW_VUL_MANAGE_CUSTOM_HEADERS_ENDPOINT,
  MSSW_WEAKPWD_HEADER_ID,
  MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS,
  MSSW_VUL_MANAGE_BASE_FILTERS,
  MSSW_VUL_MANAGE_TIME_RANGE_KEY,
  MSSW_VUL_MANAGE_TIME_RANGE_LABEL,
  MSSW_VUL_MANAGE_KINDS,
  resolveVulManageTimeRangeMs,
  buildMsswVulManageExportRequestBody,
  forceSelectAllCustomHeaders,
  fetchWeakPwdCustomHeaders,
  fetchInternetWeakPwdCustomHeaders,
  triggerMsswVulManageExport,
  downloadMsswVulManageFile,
  exportMsswVulManageList,
  exportMsswVulnList,
  exportMsswWeakPwdList,
  // 互联网弱密码表（弱密码表拆成内网/互联网两份）
  MSSW_INTERNET_WEAKPWD_EXPORT_ENDPOINT,
  MSSW_INTERNET_WEAKPWD_DOWNLOAD_ENDPOINT,
  MSSW_INTERNET_WEAKPWD_CUSTOM_HEADERS_ENDPOINT,
  MSSW_INTERNET_WEAKPWD_EXPORT_TIMEOUT_MS,
  MSSW_INTERNET_WEAKPWD_HEADER_ID,
  buildMsswInternetWeakPwdExportRequestBody,
  triggerMsswInternetWeakPwdExport,
  exportMsswInternetWeakPwdList,
  // 漏洞表的新接口（异步报表，与暴露面共用端点，见 MSSW_VULN_ASYNC_* 常量）
  MSSW_VULN_ASYNC_DATA_TYPE,
  MSSW_VULN_ASYNC_EXPORT_SCOPE,
  MSSW_VULN_ASYNC_EXPORT_MODE,
  MSSW_VULN_ASYNC_FIXED_STATUS,
  MSSW_VULN_ASYNC_SCAN_TYPE,
  MSSW_VULN_ASYNC_SPLIT,
  buildMsswVulnExportRequestBody,
  // 异步报表三件套（暴露面与漏洞表共用，见 triggerMsswAsyncReportExport）
  triggerMsswAsyncReportExport,
  pollMsswAsyncReportTask,
  downloadMsswAsyncReportFile,
  // 暴露面表（异步任务 + 附件下载，见 MSSW_EXPOSED_SURFACE_* 常量）
  MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT,
  MSSW_EXPOSED_SURFACE_TASK_ENDPOINT,
  MSSW_EXPOSED_SURFACE_ATTACHMENT_PATH,
  MSSW_EXPOSED_SURFACE_DATA_TYPE,
  buildMsswExposedSurfaceExportRequestBody,
  triggerMsswExposedSurfaceExport,
  pollMsswExposedSurfaceExportTask,
  buildMsswExposedSurfaceAttachmentUrl,
  downloadMsswExposedSurfaceFile,
  exportMsswExposedSurfaceList
};
