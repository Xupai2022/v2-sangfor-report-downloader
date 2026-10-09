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
const { pagedExportMsswAssetList } = require('./mssw_asset_paged_export');

const DEFAULT_MSSW_BASE_URL = normalizeBaseUrl('sitmssw.soar.sangfor.com.cn');
// Referer 头的默认路径（与 origin 拼成 "<origin>/index.html"）
const DEFAULT_REFERER_PATH = '/index.html';

const MSSW_CUSTOMER_STATISTIC_ENDPOINT = '/gateway/customer-mgr-service/order/v1/user/customer_statistic';
const MSSW_INCIDENT_EXPORT_ENDPOINT = '/gateway/mss-mdr/web/api/mssw/mss-mdr/v1/incidents/export/tasks';

// 资产表：同步导出（无 task_id/轮询），列由 export_fields 接口决定
const MSSW_ASSET_EXPORT_FIELDS_ENDPOINT = '/apps/asset/view/asset/export_fields?_method=GET';
const MSSW_ASSET_EXPORT_ENDPOINT = '/apps/asset/view/asset/export';
const MSSW_ASSET_DOWNLOAD_ENDPOINT = '/apps/asset/view/asset/download_file';
const MSSW_ASSET_COUNT_ENDPOINT = '/apps/asset/view/asset/asset_view/count?_method=GET';

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

// ---- 漏洞表 / 弱密码表（同源：/order/v1/vul_manage/*） ----
// 两张"脆弱性"类的表共用**同一对接口**，只靠请求体里的 data_type + header_id + 视图配置区分：
//   loophole → 漏洞表   （导出 sheet 名「漏洞」，31 列）
//   weak_pwd → 弱密码表 （导出 sheet 名「弱密码」，29 列）
//
// 这是第三种范式：**同步阻塞导出**。没有 task_id、没有轮询、没有状态接口 ——
// 建任务的 POST 自己就是"建任务 + 等导出完成"，实测漏洞表全量 13301 行要 40s 才返回
// `{code:0, data:{file_name}}`（浏览器里看到的那段"卡一下"就是这个请求在等），
// 弱密码表小得多（94 行，1.3s）。所以 requestJson 的默认 30s 超时会被漏洞表跑爆，
// 这个接口走 MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS。
// 返回的 file_name 再拿去 download_file 换文件，两步之间没有等待（实测 0.6s 拿到）。
const MSSW_VUL_MANAGE_EXPORT_ENDPOINT = '/order/v1/vul_manage/vul_risk_export';
const MSSW_VUL_MANAGE_DOWNLOAD_ENDPOINT = '/order/v1/vul_manage/download_file';

// 同步导出的等待上限。实测漏洞表全量 40s，给到这个数是给大宗客户留富余；超时只说明
// 平台卡住，继续等没有意义（与告警轮询的 600s 同量级）。
const MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS = 600000;

/**
 * 两表共用的筛选器，**一律留空 = 不过滤**。
 *
 * 逐字对过 2026-10-08 / 2026-10-09 两次抓包的两份请求体，这里只放两边都有的键；各自独有的
 * （漏洞表有 attack_type/cve/risk_level/scan_type/threat_tag，弱密码表有
 * whitelisted_status/is_show）见 MSSW_VUL_MANAGE_KINDS 的 extraFilters。
 *
 * **时间范围不在这个常量里** —— 它由 buildMsswVulManageExportRequestBody 现算
 * （走 resolveVulManageTimeRangeMs），所以这里连 latest_time_range 这个键都不留。
 * 出处：2026-10-08 曾按用户口径「不要传时间」留空数组，2026-10-09 用户改口 ——
 * 两张表都要按报告期取数，并给了两份带 latest_time_range 的抓包当作样例。
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
  source_device: []
};

/**
 * **漏洞表**的视图配置（"显示哪些列"那一段），逐字转录自 2026-10-08 的浏览器抓包。
 *
 * 刻意**不裁剪**：与告警表不同（那份 tableFields 实测对列集无影响，见其注释），
 * 漏洞导出的列集是否由 custom_headers/header_id 决定**没有验证过**，凭猜去掉有风险。
 *
 * ⚠️ 导出的实际列序**不等于**这里的顺序：实测导出把 base_info 提到最前、asset_info
 * 放在中间（弱密码表同样错位）。所以下游一律**按列名取，绝不按列下标**。
 */
const MSSW_VULN_EXPORT_CUSTOM_HEADERS = {
  asset_info: [
    { disabled: true, key: 'asset', label: '风险资产', selected: true },
    { disabled: false, key: 'asset_type', label: '资产类型', selected: true },
    { disabled: false, key: 'business_name', label: '所属资产组', selected: true },
    { disabled: false, key: 'group_name', label: '所属业务', selected: true },
    { disabled: false, key: 'manager', label: '资产责任人', selected: true },
    { disabled: false, key: 'magnitude', label: '资产重要性', selected: true },
    { disabled: true, key: 'port', label: '端口', selected: true },
    { disabled: true, key: 'url', label: 'url', selected: true },
    { disabled: false, key: 'exposure', label: '互联网暴露', selected: true },
    { disabled: true, key: 'evidence_information', label: '举证信息', selected: true },
    { disabled: false, key: 'asset_status', label: '资产管理状态', selected: true },
    { disabled: false, key: 'platform_name', label: '来源平台', selected: true },
    { disabled: false, key: 'managed_level', label: '托管状态', selected: true }
  ],
  base_info: [
    { disabled: true, key: 'name', label: '漏洞名称', selected: true },
    { disabled: true, key: 'fix_priority_level', label: '修复优先级', selected: true },
    { disabled: true, key: 'risk_Level', label: '风险等级', selected: true },
    { disabled: false, key: 'attack_type', label: '漏洞类型', selected: true },
    { disabled: false, key: 'fix_advise', label: '修复建议', selected: true },
    { disabled: false, key: 'risk_description', label: '风险描述', selected: true },
    { disabled: false, key: 'threat_tags', label: '威胁标签', selected: true },
    { disabled: false, key: 'src_type', label: '数据源', selected: true },
    { disabled: false, key: 'scan_type', label: '检测方式', selected: true },
    { disabled: false, key: 'last_time', label: '最近发现时间', selected: true },
    { disabled: false, key: 'found_time', label: '首次发现时间', selected: true },
    { disabled: false, key: 'cve', label: 'CVE 编号', selected: true },
    { disabled: false, key: 'attack_state', label: '攻击结果', selected: true },
    { disabled: false, key: 'is_gpt', label: 'GPT检测', selected: true }
  ],
  disposal_info: [
    { disabled: false, key: 'fixed_status', label: '处置状态', selected: true },
    { disabled: false, key: 'fixed_tag', label: '处置标签', selected: true },
    { disabled: false, key: 'order_progress', label: '最新工单进展', selected: true },
    { disabled: false, key: 'retest_status', label: '验证状态', selected: true }
  ]
};

/**
 * **弱密码表**的视图配置，同样逐字转录（2026-10-08 抓包）。
 *
 * 与漏洞表的差异不只是列名：弱密码表没有 port/url（asset_info）、没有
 * 漏洞类型/修复建议/风险描述/威胁标签/检测方式/CVE/攻击结果，多了账号/密码/url/
 * refer/进程路径（base_info）与「加白状态」（disposal_info）。
 */
const MSSW_WEAKPWD_EXPORT_CUSTOM_HEADERS = {
  asset_info: [
    { disabled: true, key: 'asset', label: '风险资产', selected: true },
    { disabled: false, key: 'asset_type', label: '资产类型', selected: true },
    { disabled: false, key: 'business_name', label: '所属资产组', selected: true },
    { disabled: false, key: 'group_name', label: '所属业务', selected: true },
    { disabled: false, key: 'manager', label: '资产责任人', selected: true },
    { disabled: false, key: 'magnitude', label: '资产重要性', selected: true },
    { disabled: true, key: 'port', label: '端口', selected: true },
    { disabled: false, key: 'exposure', label: '互联网暴露', selected: true },
    { disabled: false, key: 'evidence_information', label: '举证信息', selected: true },
    { disabled: false, key: 'asset_status', label: '资产管理状态', selected: true },
    { disabled: false, key: 'platform_name', label: '来源平台', selected: true },
    { disabled: false, key: 'managed_level', label: '托管状态', selected: true }
  ],
  base_info: [
    { disabled: true, key: 'name', label: '弱密码名称', selected: true },
    { disabled: true, key: 'fix_priority_level', label: '修复优先级', selected: true },
    { disabled: true, key: 'risk_Level', label: '风险等级', selected: true },
    { disabled: true, key: 'user', label: '账号', selected: true },
    { disabled: true, key: 'pwd', label: '密码', selected: true },
    { disabled: true, key: 'url', label: 'url', selected: true },
    { disabled: false, key: 'refer', label: 'refer', selected: true },
    { disabled: false, key: 'process_path', label: '进程路径', selected: true },
    { disabled: false, key: 'src_type', label: '数据源', selected: true },
    { disabled: false, key: 'last_time', label: '最近发现时间', selected: true },
    { disabled: false, key: 'found_time', label: '首次发现时间', selected: true },
    { disabled: false, key: 'is_gpt', label: 'GPT检测', selected: true }
  ],
  disposal_info: [
    { disabled: false, key: 'whitelisted_status', label: '加白状态', selected: true },
    { disabled: false, key: 'fixed_status', label: '处置状态', selected: true },
    { disabled: false, key: 'fixed_tag', label: '处置标签', selected: true },
    { disabled: false, key: 'order_progress', label: '最新工单进展', selected: true },
    { disabled: false, key: 'retest_status', label: '验证状态', selected: true }
  ]
};

/**
 * vul_manage 下两张表的差异清单 —— 路由用 kind（vuln / weakpwd），其余全共用。
 *
 * extraFilters 是各自独有的筛选器键：**照抄抓包、不互相补**。看着"漏了几个空数组"
 * 别顺手补齐，那是在替平台猜它的请求契约。
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
    },
    customHeaders: MSSW_VULN_EXPORT_CUSTOM_HEADERS
  },
  weakpwd: {
    label: '弱密码表',
    dataType: 'weak_pwd',
    headerId: 'week_pass_1',
    extraFilters: {
      whitelisted_status: [],
      // 2026-10-09 的样例抓包是 1，2026-10-08 那份是 0 —— 按新样例取 1（用户 2026-10-09 确认）。
      // 这个开关直接决定返回行数，不是可以随便跟一个的默认值。
      is_show: 1
    },
    customHeaders: MSSW_WEAKPWD_EXPORT_CUSTOM_HEADERS
  }
};

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
 */
const MSSW_INCIDENT_EXPORT_FIELDS = [
  'severity', 'name', 'company_name', 'host_ip', 'end_time',
  'attack_state', 'created_time', 'current_handler_name', 'deal_status',
  'incident_id', 'host_group_names', 'dev_source_name',
  'incident_threat_class', 'incident_threat_type', 'src_ip', 'dst_ip', 'ioc',
  'service_manager_name', 'service_group_name', 'checkout_time', 'start_time',
  'status_note', 'finished_time', 'gpt_result', 'gpt_sub_result'
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

async function requestJson(url, { headers, body, timeout }) {
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
          reject(new Error(
            `MSSW 请求失败 ${res.statusCode} [${method} ${parsedUrl.pathname}]: `
            + `${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 500)}`
          ));
          return;
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`MSSW 请求超时: ${url}`));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function requestBuffer(url, { headers }) {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === 'http:' ? http : https;

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
          reject(new Error(
            `MSSW 下载失败 ${res.statusCode} [GET ${parsedUrl.pathname}]: `
            + `${buffer.toString('utf8').slice(0, 500)}`
          ));
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
    req.setTimeout(30000, () => {
      req.destroy(new Error(`MSSW 下载请求超时: ${url}`));
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
 * 注意调用方对单位的需求不同：事件表要毫秒（自己 *1000），告警表直接吃秒。
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

function buildMsswIncidentExportRequestBody({ begin, end, companyId, fields }) {
  return {
    filters: {
      end_time: [begin, end],
      customer_type: 'single_customer',
      company_ids: [String(companyId)]
    },
    sorts: [{ field: 'sla_deadline', order: 'asc' }],
    export_mode: 'custom',
    format: 'xlsx',
    is_all: 0,
    my_customer: 0,
    event_id_list: [],
    fields: fields || MSSW_INCIDENT_EXPORT_FIELDS
  };
}

/** 创建导出任务，返回 task_id。 */
async function triggerMsswIncidentExport(cookieInfo, platform, options) {
  const { begin, end } = resolveMsswTimeRange(options);
  const companyId = options.customerId || options.companyId || '';
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_INCIDENT_EXPORT_ENDPOINT);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswIncidentExportRequestBody({
      begin: begin * 1000,
      end: end * 1000,
      companyId
    }))
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
      body: JSON.stringify({ task_id: taskId })
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
async function downloadMsswIncidentFile(cookieInfo, platform, taskId, downloadDir, filename, companyId) {
  const downloadUrl = platformEndpoint(platform, `${MSSW_INCIDENT_EXPORT_ENDPOINT}/${taskId}/download`);

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: '*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
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
 * 时间给 epoch **秒**（不是毫秒），timeField 固定 lastTime（最近发生时间）。
 */
function buildMsswAlertExportRequestBody({ begin, end }) {
  return {
    globalCondition: {
      branchIds: [],
      time: {
        timeField: 'lastTime',
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

  const response = await requestJson(url, { headers, body });

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
    const response = await requestJson(url, { headers, body });

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
async function downloadMsswAlertFile(cookieInfo, platform, companyId, resultPath, downloadDir) {
  const downloadUrl = resultPath.startsWith('http')
    ? resultPath
    : platformEndpoint(platform, `${resultPath.startsWith('/') ? '' : '/'}${resultPath}`);

  const headers = buildMsswAlertHeaders(cookieInfo, platform, companyId, {
    accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*'
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
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
  const downloaded = await downloadMsswAlertFile(cookieInfo, platform, companyId, polled.resultPath, downloadDir);
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
async function triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, ids = [], searchType = 'current') {
  const headers = buildMsswAssetExportHeaders(cookieInfo, platform, companyId);
  const url = platformEndpoint(platform, MSSW_ASSET_EXPORT_ENDPOINT);
  const body = JSON.stringify(buildMsswAssetExportRequestBody(exportFields, ids, searchType));
  headers['content-length'] = String(Buffer.byteLength(body));

  const response = await requestJson(url, { headers, body, timeout: 600000 });

  const code = response && response.code;
  const apiSuccess = response && (response.success === true || response.success === 'true');
  if (code !== 0 && code !== '0' && !apiSuccess) {
    throw new Error(`MSSW 资产导出接口返回异常: ${JSON.stringify(response).slice(0, 500)}`);
  }

  return response;
}

/** 下载资产文件：GET + query string，无请求体；这里换掉 content-type。 */
async function downloadMsswAssetFile(cookieInfo, platform, companyId, filename, downloadDir) {
  const downloadUrl = platformEndpoint(platform, `${MSSW_ASSET_DOWNLOAD_ENDPOINT}?file=${encodeURIComponent(filename)}`);

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
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
      const currentExport = await triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, assetIds, 'current');
      currentFilename = resolveAssetExportFilename(currentExport);
      if (!currentFilename) {
        throw new Error(`MSSW 资产台账导出接口返回缺少文件名: ${JSON.stringify(currentExport).slice(0, 500)}`);
      }
      const currentDownloaded = await downloadMsswAssetFile(cookieInfo, platform, companyId, currentFilename, downloadDir);
      currentFilePath = currentDownloaded.filePath;
      logInfo(logger, `资产台账已下载: ${currentFilePath}`);

      // 第 2 步：待审核资产（search_type=wait_approve），失败不阻断主流程
      try {
        const waitApproveExport = await triggerMsswAssetExport(cookieInfo, platform, companyId, exportFields, assetIds, 'wait_approve');
        const waitApproveFilename = resolveAssetExportFilename(waitApproveExport);
        if (waitApproveFilename) {
          const waitApproveDownloaded = await downloadMsswAssetFile(cookieInfo, platform, companyId, waitApproveFilename, downloadDir);
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
  const downloaded = await downloadMsswIncidentFile(cookieInfo, platform, taskId, downloadDir, fileName, companyId);
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
// 漏洞表 / 弱密码表（同源：/order/v1/vul_manage/*）
// ---------------------------------------------------------------------------

/**
 * vul_manage 的 latest_time_range：epoch **毫秒**、本地日界，与事件表/告警表那份
 * --start/--end 同一个口径（起 = 起始日 00:00:00.000，止 = 结束日 23:59:59.999）。
 *
 * 为什么不用 resolveMsswTimeRange 的返回值：那个函数把时间戳压到**秒**，收尾会变成
 * 23:59:59.000。而本接口吃毫秒 —— 用户 2026-10-09 给的漏洞表抓包里收尾是 1791561599999
 * （.999，浏览器侧 Math 出来的原始值），另一个弱密码抓包是 ...599000（被截过的）。
 * 差这 999ms 正常情况碰不到，但既然毫秒粒度不花代价，就照平台真正的写法来。
 * 校验仍然复用 resolveMsswTimeRange（格式 + 起止先后），只是不要它那个秒值。
 *
 * 过滤的列是**「最近发现时间」**：实测单日窗口返回的行全落该日。不是「首次发现时间」——
 * 某客户 13301 行里这两列有 2373 行不同，选错列差别很大。
 *
 * 两个日期一个都没传时回落空数组 = 全量导出（`--type vuln` 单独跑仍可用）；
 * 只传一个则照常报错，因为那多半是手滑，静默退全量会得出另一份数据。
 *
 * @param {object} options 认 --start/--end（也认 begin，与事件表一致）
 * @returns {number[]} [startMs, endMs]，或空数组表示不过滤
 */
function resolveVulManageTimeRangeMs(options = {}) {
  const rawStart = options.begin || options.start;
  const rawEnd = options.end;
  if (!rawStart && !rawEnd) return [];

  resolveMsswTimeRange(options, '漏洞表/弱密码表导出');

  const startMs = parseLocalDate(rawStart, false) * 1000;
  const endMs = parseLocalDate(rawEnd, false) * 1000 + 24 * 60 * 60 * 1000 - 1;
  return [startMs, endMs];
}

/**
 * vul_manage 导出请求体。两个 kind 共用一套筛选器，只有差异部分按 kind 取。
 *
 * @param {'vuln'|'weakpwd'} kind
 * @param {number[]} [timeRangeMs] latest_time_range，见 resolveVulManageTimeRangeMs；
 *   缺省空数组 = 全量。键显式放在第一个，与平台抓包里的位置一致。
 */
function buildMsswVulManageExportRequestBody(kind, timeRangeMs = []) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的 vul_manage 表类型: ${kind}（可选 ${Object.keys(MSSW_VUL_MANAGE_KINDS).join(' / ')}）`);
  }

  return {
    latest_time_range: timeRangeMs,
    ...MSSW_VUL_MANAGE_BASE_FILTERS,
    ...spec.extraFilters,
    data_type: [spec.dataType],
    custom_headers: spec.customHeaders,
    header_id: spec.headerId,
    is_all: false,
    multiple_choice: [],
    exclude_multiple_choice: []
  };
}

/**
 * 触发导出并**同步等它跑完**，返回服务端给的文件名。
 *
 * 这个接口没有 task_id：POST 返回时导出已经完成，`data.file_name` 就是待下载的文件名。
 * 文件名形如 `vul-middle-risk_20261008104536.xlsx` —— ⚠️ 里面的 "middle-risk" 是**死的**，
 * 而且**两张表共用这一个命名**（弱密码表导出的文件也叫 vul-middle-risk_*），
 * 与数据无关（实测该文件名下的漏洞表里严重/高危/中危/低危都有），别拿它当口径。
 *
 * 取数范围由 options.start/end 经 resolveVulManageTimeRangeMs 决定（不传 = 全量）。
 */
async function triggerMsswVulManageExport(cookieInfo, platform, companyId, kind, options = {}) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  const url = platformEndpoint(platform, MSSW_VUL_MANAGE_EXPORT_ENDPOINT);
  const headers = buildMsswExportHeaders(cookieInfo, platform, companyId);
  // 时间范围从 --start/--end 现算；调用方（exportMsswVulManageList）已经把算好的塞进
  // options.timeRangeMs，直调本函数的探针脚本则在这里自己算。
  const timeRangeMs = options.timeRangeMs || resolveVulManageTimeRangeMs(options);

  const response = await requestJson(url, {
    headers,
    body: JSON.stringify(buildMsswVulManageExportRequestBody(kind, timeRangeMs)),
    timeout: Number(options.exportTimeoutMs || MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS)
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
 * 落盘名（漏洞表 / 弱密码表共用）。
 *
 * 平台的 content-disposition 是 `filename=%E8%84%86%E5%BC%B1...xlsx` —— 百分号编码的中文
 * （只带 `filename=`、不带 `filename*=`，所以走的是 parseContentDispositionFilename 的普通
 * 分支，而那个分支**不解码**）。照原样用会往磁盘上写一个 %E8%84%86… 的文件名，这里补一次
 * 解码；解不出来就退回导出接口给的那个 ASCII 名（vul-middle-risk_*.xlsx），不因为一个
 * 文件名把整表搞失败。
 *
 * 注意两张表的中文名是**同一个**（都是「脆弱性导出报告_<时间戳>.xlsx」）——文件名里
 * 分不出是哪一张。反正中间件默认用完就删；要留档用 --keep-intermediates 时，
 * 落盘目录里的两个文件靠时间戳区分，别靠名字。
 *
 * 刻意**不改** parseContentDispositionFilename 本身：它同时服务告警表，那边的
 * content-disposition 长什么样没实测过，不拿告警表冒这个险。
 */
function resolveVulManageFilename(disposition, fallback) {
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
 * 下载导出文件（漏洞表 / 弱密码表共用）。
 *
 * 与其他两份"按文件名换文件"的接口一致：二进制读，且必须去掉
 * x-requested-with / content-type，否则会被网关当作普通 XHR 拦掉。
 */
async function downloadMsswVulManageFile(cookieInfo, platform, companyId, fileName, downloadDir) {
  const downloadUrl = platformEndpoint(
    platform,
    `${MSSW_VUL_MANAGE_DOWNLOAD_ENDPOINT}?file=${encodeURIComponent(fileName)}`
  );

  const headers = buildMsswHeaders(cookieInfo.cookieString, platform, {
    accept: '*/*',
    'x-mssw-company-id': String(companyId || '')
  });
  delete headers['x-requested-with'];
  delete headers['content-type'];

  const downloaded = await requestBuffer(downloadUrl, { headers });
  const disposition = downloaded.headers
    && (downloaded.headers['content-disposition'] || downloaded.headers['Content-Disposition']);
  const filename = resolveVulManageFilename(disposition, fileName);
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
 * 导出**漏洞表 / 弱密码表**：同步导出 → 拿 file_name → 下载到 cookie 所在目录。
 *
 * 落盘后的加工：两张表都删掉「处置状态」=「处置完成（误报）」的行、原地改写
 * （与事件表同一套机制）；两张表都**不加**「内网外网资产」列（那是事件表独有的）。
 *
 * @param {object} options 与其它 export* 同：msswCookiePath / msswBaseUrl / customerId / downloadDir，
 *   另认 start/end（YYYY-MM-DD）—— 取数范围，不传则全量
 * @param {'vuln'|'weakpwd'} kind
 * @returns {Promise<object>} 含 filePath（xlsx 路径）、导出元信息，漏洞表另带 removedRows/totalBefore/totalAfter
 */
async function exportMsswVulManageList(options, kind) {
  const spec = MSSW_VUL_MANAGE_KINDS[kind];
  if (!spec) {
    throw new Error(`未知的 vul_manage 表类型: ${kind}（可选 ${Object.keys(MSSW_VUL_MANAGE_KINDS).join(' / ')}）`);
  }

  const logger = options.logger;
  // 时间范围先算再打日志：这两张表最慢能跑 40s，日志里得写清这一次到底按哪一段取的数。
  const timeRangeMs = resolveVulManageTimeRangeMs(options);
  logInfo(logger, timeRangeMs.length
    ? `导出 MSSW ${spec.label}: ${options.start || options.begin} ~ ${options.end}（按「最近发现时间」过滤）`
    : `导出 MSSW ${spec.label}: 全量（未传 --start/--end，latest_time_range 留空）`);

  const cookieInfo = await readMsswCookieInfo(options.msswCookiePath);
  const platform = resolvePlatform(options);
  const companyId = options.customerId || options.companyId || '';

  // 同步接口：这一行要等到平台把整份表导出完才回来（漏洞表实测全量 40s），
  // 所以日志分两句 —— 不然日志里会是一段没有解释的空白。
  const startedAt = Date.now();
  const { fileName, response } = await triggerMsswVulManageExport(
    cookieInfo, platform, companyId, kind, { ...options, timeRangeMs }
  );
  logInfo(logger, `${spec.label}导出完成: ${fileName}（服务端耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`);

  const downloadDir = options.downloadDir || path.dirname(cookieInfo.resolvedPath);
  const downloaded = await downloadMsswVulManageFile(cookieInfo, platform, companyId, fileName, downloadDir);
  logInfo(logger, `${spec.label}已下载: ${downloaded.filePath}`);

  // 误报过滤：落盘后读表自带的「处置状态」列，删掉「处置完成（误报）」的行。
  // 漏洞表与弱密码表同判据（用户 2026-10-08 口径）；事件表走自己的「已忽略」，见上方常量。
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

/** 漏洞表。 */
function exportMsswVulnList(options) {
  return exportMsswVulManageList(options, 'vuln');
}

/** 弱密码表。 */
function exportMsswWeakPwdList(options) {
  return exportMsswVulManageList(options, 'weakpwd');
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
  buildMsswHeaders,
  buildMsswExportHeaders,
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
  isTimeoutError,
  buildMsswAssetExportRequestBody,
  triggerMsswAssetExport,
  downloadMsswAssetFile,
  processAssetTable,
  exportMsswAssetList,
  removeRowsByStatus,
  exportMsswIncidentList,
  // 漏洞表 / 弱密码表（同源，见 MSSW_VUL_MANAGE_KINDS）
  MSSW_VUL_MANAGE_EXPORT_ENDPOINT,
  MSSW_VUL_MANAGE_DOWNLOAD_ENDPOINT,
  MSSW_VUL_MANAGE_EXPORT_TIMEOUT_MS,
  MSSW_VUL_MANAGE_BASE_FILTERS,
  MSSW_VUL_MANAGE_KINDS,
  resolveVulManageTimeRangeMs,
  buildMsswVulManageExportRequestBody,
  triggerMsswVulManageExport,
  downloadMsswVulManageFile,
  exportMsswVulManageList,
  exportMsswVulnList,
  exportMsswWeakPwdList
};
