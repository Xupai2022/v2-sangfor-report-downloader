'use strict';

/**
 * 暴露面域的取值（CELL_REGISTRY.md §8 F1）——
 * 「数据统计」D128「暴露面数」一格（用户口径 2026-10-19）。
 *
 * 数据源是六份总表里最后一份的**下载件**：暴露面表「文档说明」sheet 的汇总表
 * （K 列子类型 / L 列总数）。那份 sheet 上半部分是文档标题与基本信息，
 * 不是从第一行就是表头的规整表，所以读取层另起了一个 parse*
 * （mssw_parser.js 的 parseExposedSummary -> scripts/parse_exposed_summary.py），
 * 把「子类型文字 -> 右侧一格的总数」抽成行对象：
 *
 *     { "子类型": "根域名资产", "总数": 41 }
 *
 * 口径（投喂原话拆成可核对的判据）：
 *   · 在「文档说明」sheet 里逐格找 EXPOSED_SURFACE_SUMMARY_LABELS 这 13 项文字，
 *     整格**精确相等**（只去首尾空白，不做包含匹配）；
 *   · 取文字**右侧一个单元格**的值作为这一项的「总数」；
 *   · 13 项的总数**直接相加**，就是 D128。
 *
 * ⚠️ 投喂原话写的是「这12项文字」，但紧接着列出的文字有 **13 项**；经核对
 * `暴露面成果清单_华能集团_2026-10-19.xlsx` 的「文档说明」sheet，13 项全部逐字命中
 * （K16:K28），所以本格按 **13 项**求和。若以后确认只算其中 12 项，改下面这一个数组即可
 * （H4：这份清单全仓只此一处定义）。
 *
 * 边界：
 *   · 暴露面表下载件 0 行（ctx.exposedRows 为空数组）-> 写 0，与其它计数格同一条
 *     「空表 = 0 行」口径；
 *   · 有行、却缺其中某一项 -> **不写部分和**，抛错进错误列表（R10 缺数不静默）；
 *   · 右侧一格不是数字（平台改成文本 / 占位符）-> 同上，抛错；
 *   · 同一项出现两次 -> 取哪一个都是猜，抛错；
 *   · 不叠加报告期：暴露面导出的是**当前**暴露面，接口不带时间参数（见 mssw_client.js
 *     的 MSSW_EXPOSED_SURFACE_EXPORT_ENDPOINT 头注）。
 */

const { requireColumn, cellText } = require('./rows');

/** 子类型文字所在列的表头（「文档说明」第 15 行，逐字）。 */
const EXPOSED_SURFACE_LABEL_COLUMN = '子类型';

/** 总数所在列的表头（「文档说明」第 15 行，逐字）。 */
const EXPOSED_SURFACE_TOTAL_COLUMN = '总数';

/**
 * D128 求和的 13 项子类型 —— **投喂的原文，顺序也照投喂**。
 *
 * 权威只在 stats/metrics/exposed.js 这一处（H4）：`mssw_downloader.js` 把它传给
 * 读取层（parseExposedSummary）当定位清单，`desc` 与实现也对着这一份看。
 */
const EXPOSED_SURFACE_SUMMARY_LABELS = [
  '根域名资产',
  '子域名资产',
  'IP资产',
  '端口资产',
  'WEB资产',
  '非WEB资产',
  '网络&安全设备',
  '云类资产',
  'SSL证书',
  'APP',
  '高危端口&服务',
  '重要组件',
  '登录入口'
];

/**
 * 暴露面表「文档说明」sheet 的汇总行（D128「暴露面数」）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 13 项子类型右侧「总数」之和
 * @throws {Error} 有行但缺项 / 重复 / 右侧不是数字时
 */
function exposedSurfaceTotal(ctx) {
  const rows = ctx.exposedRows;

  // 空表 = 0 行（与其它计数格同一条：0 是结论，不是缺数）。
  // 生产里暴露面下载件一定带「文档说明」汇总表；解析层在一个子类型都找不到时
  // 会当场抛错（见 scripts/parse_exposed_summary.py），不会让这里看到"结构没了"的空数组。
  if (rows.length === 0) return 0;

  requireColumn(rows, EXPOSED_SURFACE_LABEL_COLUMN, '暴露面表「文档说明」');
  requireColumn(rows, EXPOSED_SURFACE_TOTAL_COLUMN, '暴露面表「文档说明」');

  const totals = new Map();
  for (const row of rows) {
    const label = cellText(row[EXPOSED_SURFACE_LABEL_COLUMN]);

    // 汇总表只有这 13 项；读取层按清单返回，别的行（若平台以后加了一项）不参与本格。
    if (!EXPOSED_SURFACE_SUMMARY_LABELS.includes(label)) continue;

    const value = row[EXPOSED_SURFACE_TOTAL_COLUMN];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `暴露面表「文档说明」里「${label}」右侧一格不是数字: ${JSON.stringify(value)}`
          + '（平台可能把「总数」改成了文本 / 占位符）'
      );
    }
    if (totals.has(label)) {
      throw new Error(
        `暴露面表「文档说明」里「${label}」出现了不止一次，无法确定取哪一个`
      );
    }
    totals.set(label, value);
  }

  const missing = EXPOSED_SURFACE_SUMMARY_LABELS.filter((label) => !totals.has(label));
  if (missing.length) {
    throw new Error(
      `暴露面表「文档说明」里找不到这些子类型：${missing.join('、')}`
        + '（平台可能改了表结构；不写部分和）'
    );
  }

  return EXPOSED_SURFACE_SUMMARY_LABELS.reduce(
    (sum, label) => sum + totals.get(label), 0
  );
}

/**
 * 暴露面表「高危端口&服务」sheet 名（I81 的口径源）。
 *
 * 与「文档说明」是同一个下载件里的两张 sheet：D128 读汇总表，I81 数这张数据表的行。
 */
const EXPOSED_HIGH_RISK_PORT_SHEET = '高危端口&服务';

/**
 * I79 / I80 要定位的两项汇总文字（投喂口径 2026-10-21）。
 *
 * 权威只在这里（H4）：`mssw_downloader.js` 把它传给读取层（parseExposedSummary 的
 * contains 模式）当定位清单，两格的 `desc` 也对着这一份看。
 *
 * ⚠️ 投喂原话写的是「暴露面表**高危端口&服务** sheet」，但三份真实下载件
 * （2026-10-19 华能 / 2026-10-17 测试客户 / 2026-10-21 一致性验收客户）里，
 * 「IP资产」「端口资产」这两格文字都只在**「文档说明」**汇总表（K18/K19），
 * 高危端口&服务 那张 sheet 是纯数据表（序号/服务/IP地址/端口/banner/资产归属），
 * 没有汇总行。所以本仓按「文档说明」取数 —— 与 D128 同一个 sheet、同一张汇总表，
 * 只是判据换成**包含**、并且只抽这两项（D128 的 13 项精确匹配不受影响）。
 */
const EXPOSED_INTERNET_ASSET_LABELS = ['IP资产', '端口资产'];

/**
 * I79「互联网IP数量」/ I80「互联网端口数量」的共同取值
 * （用户口径 2026-10-21：投喂原话「找包含『IP资产』的单元格右侧一个单元格的值」，
 * I80 同理换成「端口资产」）。
 *
 * 口径：
 *   · 数据源 = 暴露面下载件「文档说明」sheet 的汇总表（见上面那条 ⚠️ 的核对结论），
 *     由下载层用 contains 判据单独再读一次（`ctx.exposedAssetCountRows`，
 *     行对象 `{子类型, 总数}`）；
 *   · 在行里找「子类型」**包含**该文字的项（精确等于也算包含），取它的「总数」——
 *     就是文字右侧一格的值；
 *   · 计数单位是**那个单元格里的数**（不是数行数、不是求和）；不去重（只有一项）；
 *   · 不叠加报告期：暴露面导出的是**当前**暴露面，接口不带时间参数。
 *
 * 边界：
 *   · 没有汇总行（空数组）-> 写 0（与 D128 的空表口径同一条）；
 *   · 有汇总行、却找不到这一项 -> 不写值 + 抛错（R10 缺数不静默）；
 *   · 同一项出现不止一次 -> 抛错（取哪一个都是猜）；
 *   · 右侧一格不是数字 -> 抛错（平台改成文本 / 占位符）。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @param {string} label 「IP资产」/「端口资产」
 * @returns {number} 该文字右侧一格的值
 */
function exposedInternetAssetCount(ctx, label) {
  const rows = Array.isArray(ctx.exposedAssetCountRows) ? ctx.exposedAssetCountRows : [];

  if (rows.length === 0) return 0;

  requireColumn(rows, EXPOSED_SURFACE_LABEL_COLUMN, '暴露面表「文档说明」');
  requireColumn(rows, EXPOSED_SURFACE_TOTAL_COLUMN, '暴露面表「文档说明」');

  const matched = rows.filter(
    (row) => cellText(row[EXPOSED_SURFACE_LABEL_COLUMN]).includes(label)
  );
  if (matched.length === 0) {
    throw new Error(
      `暴露面表「文档说明」里找不到包含「${label}」的单元格`
        + `（平台可能改了表结构；不写值、不填 0）`
    );
  }
  if (matched.length > 1) {
    throw new Error(
      `暴露面表「文档说明」里包含「${label}」的单元格出现了 ${matched.length} 个，`
        + '无法确定取哪一个'
    );
  }

  const value = matched[0][EXPOSED_SURFACE_TOTAL_COLUMN];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `暴露面表「文档说明」里「${label}」右侧一格不是数字: ${JSON.stringify(value)}`
        + '（平台可能把「总数」改成了文本 / 占位符）'
    );
  }
  return value;
}

/** I79「互联网IP数量」：包含「IP资产」那一格右侧的数。 */
function internetIpAssetCount(ctx) {
  return exposedInternetAssetCount(ctx, EXPOSED_INTERNET_ASSET_LABELS[0]);
}

/** I80「互联网端口数量」：包含「端口资产」那一格右侧的数。 */
function internetPortAssetCount(ctx) {
  return exposedInternetAssetCount(ctx, EXPOSED_INTERNET_ASSET_LABELS[1]);
}

/**
 * I81「暴露面风险端口数量」的取值（用户口径 2026-10-19，投喂原话：
 * 「i81是暴露面风险端口数量，取暴露面表的高危端口&服务sheet，统计除了表头的行数」）。
 *
 * 口径：
 *   · 数据源 = 暴露面下载件的「高危端口&服务」sheet（不是「文档说明」）；
 *   · 行数 = **除表头行以外**的数据行数，整行没值的空行不算（读取层
 *     scripts/parse_table_rows.py 的 rowCount 与报告 sheet 的行集合同源）；
 *   · 不按列筛选、不去重、不叠加报告期 —— 暴露面导出的是**当前**暴露面，
 *     接口不带时间范围（`--start/--end` 不参与）。
 *
 * 边界：
 *   · 只有表头、0 行数据 -> 写 0（"这一版暴露面没有高危端口"是结论，与其它计数格同一条）；
 *   · sheet 不存在 / 下载件读不了 -> 读取层当场抛错（R10），整份报告不出；
 *     取值层见不到那一档，所以这里只接受数组。
 *
 * @param {Object} ctx 由 stats/context.js 构造（CELL_REGISTRY.md §7）
 * @returns {number} 「高危端口&服务」sheet 的数据行数（不含表头）
 * @throws {Error} 行数据没传进来时（不许静默算 0）
 */
function exposedHighRiskPortCount(ctx) {
  const rows = ctx.exposedHighRiskPortRows;

  if (!Array.isArray(rows)) {
    throw new Error(
      '暴露面表「高危端口&服务」的行数据没有传进来（ctx.exposedHighRiskPortRows 应为数组）'
    );
  }
  return rows.length;
}

module.exports = {
  EXPOSED_SURFACE_SUMMARY_LABELS,
  EXPOSED_SURFACE_LABEL_COLUMN,
  EXPOSED_SURFACE_TOTAL_COLUMN,
  EXPOSED_HIGH_RISK_PORT_SHEET,
  EXPOSED_INTERNET_ASSET_LABELS,
  exposedSurfaceTotal,
  exposedHighRiskPortCount,
  exposedInternetAssetCount,
  internetIpAssetCount,
  internetPortAssetCount
};
