'use strict';

/**
 * 把各份总表的下载结果合并成一份 {客户}_report.xlsx。
 *
 * ⚠️ 本文件**只是编排层**，一个单元格都不碰。
 *
 * 以前这里用 SheetJS 做实际的 Excel 读写，现在整套读写都是 Python（openpyxl）：
 * SheetJS 社区版能读样式但**写不出**样式（字体/填充/边框只有 Pro 版支持），
 * 于是模板里的格式、图片全被静默丢掉，等于违反了 MIGRATION.md R2。改用 openpyxl
 * 顺手把这件事修了，也让仓库的 npm 依赖归零。
 *
 * 三层分工（改动时别混）：
 *
 *   stats/write_statistics_sheet.js  决定「数据统计」写哪一格、写什么
 *                                    -> 交出 writes 计划（F2 唯一决策点，见 CELL_REGISTRY.md）
 *   scripts/build_report.py          执行：搬表 + 表格预处理 + 按计划落值 + 落盘
 *   report_writer.js（本文件）        串起来 + 打印日志 + 调美化
 *
 * `options.ctx` 由调用方拼装（C1：只有 stats/context.js 能拼）。ctx 里的六份总表**行对象**
 * 来自 R9 的 `parse*`（mssw_parser.js -> scripts/parse_table_rows.py），读的是**下载得到的
 * 中间件**，也就是表格预处理之前的表 —— 所以今天读不到预处理新加的「内网外网资产」列。
 * 键是表头文字、空值是空串，契约见 CELL_REGISTRY.md §7（C4–C7）。
 *
 * 各表落成 sheet 之后，落盘之前依次还有两步（顺序在 Python 里固定）：
 *
 *   表格预处理（report_preprocess.py）  资产表建 IP -> 内网/外网 映射，事件表追加「内网外网资产」列
 *   数据统计取值（writes）              写「数据统计」sheet
 *
 * 数据统计 sheet：调用方传了 options.ctx 就写，没传就跳过（模板原样）。不管哪种情况，
 * 单元格地址集合都不变（R1 单元格冻结）。**表格预处理不依赖 ctx，无条件跑** ——
 * 它改的是事件表，不是「数据统计」。
 * 暴露面 尚未迁移，保留模板中的空 sheet。
 *
 * 全部写完后还有一步：调 scripts/beautify_report.py 给除「数据统计」外的 sheet
 * 套统一视觉规范（宋体 + 深蓝表头 + 浅蓝底，主题见 excel_beautifier/themes）。
 * 这一步仍然单独一次调用、单独一次读写盘 —— 它是可跳过的观感层，不是数据层。
 * 美化失败不回滚报告（数据是对的，缺的只是观感），但会明确记进返回值和日志，不静默。
 */

const fs = require('fs');
const path = require('path');

const { encodePath } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');
const { buildStatisticsWrites } = require('./stats/write_statistics_sheet');

// 模板骨架（R3 + R3a：6 个 sheet 顺序不变，外加第 7 个「弱密码表」）
// 顺序照抄 data.xlsx 模板的真实顺序（R3：sheet 顺序由模板定，代码不重排）。
// 这份列表只用于「模板缺 sheet 就早失败」的存在性校验，顺序本身不参与决策。
const TEMPLATE_SHEETS = ['数据统计', '暴露面', '资产漏洞表', '资产表', '告警表', '事件表', '弱密码表'];

/** 表类型 -> 报告里的 sheet 名。 */
const TABLE_SHEET_NAMES = {
  asset: '资产表',
  alarm: '告警表',
  event: '事件表',
  vuln: '资产漏洞表',
  weakpwd: '弱密码表'
};

/** 合并引擎，以及它必须绕开的 sheet（数据统计 sheet 单元格冻结，MIGRATION.md R1）。 */
const BUILD_SCRIPT = path.join(__dirname, 'scripts', 'build_report.py');
const BEAUTIFY_SCRIPT = path.join(__dirname, 'scripts', 'beautify_report.py');
const BEAUTIFY_EXCLUDE_SHEETS = ['数据统计'];

/** 美化步骤的默认主题，可选值见 scripts/excel_beautifier/themes/*.json。 */
const DEFAULT_BEAUTIFY_THEME = 'classic';

/**
 * 两个 Python 脚本共用的 execFile 选项。
 *
 * 事件表动辄几千行，maxBuffer 给足；timeout 10 分钟 —— 纯本地读写盘，超时说明卡住了，
 * 不该再占着整条流水线。
 * env 走 workdir.childEnv()：关掉 __pycache__（集群上 skill 根是只读挂载）+ TMPDIR 指到可写区。
 */
const PYTHON_OPTIONS = {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 600000,
  env: workdir.childEnv()
};

/** 客户名可能带 / : 等 Windows 非法字符，替换成 _ 以免建不出文件。 */
function sanitizeFilePart(value) {
  return String(value || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
}

function generateReportFileName(customer, customerId) {
  return `${sanitizeFilePart(customer || customerId || 'unknown')}_report.xlsx`;
}

/**
 * 拉起一个 Python 脚本并解析它的 stdout JSON；失败时把 stderr 的日志一起交回来。
 *
 * 每个参数都过一遍 encodePath：里面带中文路径（客户名）和中文 sheet 名，
 * Windows 命令行直接传会乱码，靠 scripts/_path_helper.py 的 decode_argv() 还原。
 * 编码是幂等安全的 —— decode_arg 只认 B64: 前缀，认不出就原样返回。
 *
 * @param {string[]} args 已经 encodePath 过的参数
 */
function runPython(scriptPath, args, what) {
  // 早失败给个人话的错误，不然 execFile 只会抛 ENOENT 这种看不出所以然的信息
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(new Error(`${what}脚本不存在: ${scriptPath}`));
  }

  return pythonCmd.execFilePython(scriptPath, args, PYTHON_OPTIONS).then((result) => {
    try {
      return JSON.parse(String(result.stdout).trim());
    } catch (parseError) {
      throw new Error(`${what}脚本输出无法解析: ${result.stdout}`);
    }
  });
}

/**
 * 把 build_report.py 的失败翻译成人话。
 *
 * 脚本失败时会把 stderr 写成 {"diag":"error","message","logs"}，logs 是失败前已经产生的
 * 日志行 —— 用户"看过"的那部分照常打出来，缺的只是后面几步，不至于让人以为整轮什么都没跑。
 * 解析不出来（比如解释器压根没起来）就原样用 stderr / error.message。
 */
function buildFailure(error) {
  const raw = String(error.message || '').trim();
  let diag = null;
  try {
    diag = JSON.parse(raw);
  } catch (ignored) {
    diag = null;
  }
  if (diag && typeof diag === 'object' && typeof diag.message === 'string') {
    const failure = new Error(diag.message);
    failure.logs = Array.isArray(diag.logs) ? diag.logs : [];
    return failure;
  }
  const failure = new Error(raw || '合并报告失败（Python 侧没有给出原因）');
  failure.logs = [];
  return failure;
}

/**
 * 合并引擎：把 writes 计划交给 Python 落盘，并把它的日志按顺序回放。
 *
 * 数据统计那一层的日志（含 R10/H6 的缺数告警）由本函数打印，而不是 Python ——
 * 「写哪一格、写什么」是 stats/write_statistics_sheet.js 的决定，它的文案就该跟它走。
 */
async function runBuildEngine(payload, logger, statisticsLogs) {
  let result;
  try {
    result = await runPython(BUILD_SCRIPT, [encodePath(JSON.stringify(payload))], '合并');
  } catch (error) {
    const failure = buildFailure(error);
    failure.logs.forEach((line) => logger(line));
    throw failure;
  }

  // 先校验再回放：logs 缺了的话 result.logs.forEach 会先抛 TypeError，看不出真正原因
  assertEngineResult(result);
  result.logs.forEach((line) => logger(line));
  statisticsLogs(result);
  return result;
}

/** 引擎返回的 sheets/preprocess/logs，缺一个都算契约破了 —— 早说，别产出半份报告。 */
function assertEngineResult(result) {
  const missing = ['sheets', 'preprocess', 'logs'].filter((key) => result[key] === undefined);
  if (missing.length) {
    throw new Error(`合并脚本返回的 JSON 缺字段: ${missing.join('、')}`);
  }
  return result;
}

/**
 * 生成报告工作簿。
 *
 * @param {Object} options
 * @param {string} [options.templatePath] 模板路径，默认 <repo>/data.xlsx
 * @param {string} options.outputPath 产物路径
 * @param {Object} options.tables 形如 { asset: {filePath}, alarm: {filePath}, event: {filePath}, vuln: {filePath} }
 * @param {Object} [options.ctx] 由 stats/context.js 构造的计算层输入（CELL_REGISTRY.md §7）。
 *   传了才写「数据统计」sheet；不传则跳过，模板该 sheet 原样（M1 行为）
 * @param {boolean} [options.beautify] 是否套统一视觉规范，默认 true
 * @param {string} [options.beautifyTheme] 美化主题，默认 classic
 * @param {(msg: string) => void} [options.logger]
 * @returns {Promise<{filePath: string, sheets: Array, statistics: Object, beautify: Object, preprocess: Object}>}
 */
async function buildReport(options) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const templatePath = options.templatePath || path.join(__dirname, 'data.xlsx');
  const outputPath = path.resolve(options.outputPath);
  const tables = options.tables || {};

  if (!templatePath || !fs.existsSync(templatePath)) {
    throw new Error(`报告模板不存在: ${templatePath}`);
  }

  // 「数据统计」sheet 的取值层。ctx 缺席时不写任何格子（M1 行为，模板原样）——
  // 这是刻意的默认值，让「没接 ctx」和「口径未定」两种情况都表现为
  // 「数据统计 sheet 保持模板原样」。
  let statistics = { connected: false, written: [], unresolved: [], errors: [], applied: [] };
  const payload = {
    template: templatePath,
    output: outputPath,
    tables,
    statistics: { writes: [] }
  };

  if (options.ctx) {
    const plan = buildStatisticsWrites(options.ctx);
    payload.statistics.writes = plan.writes;
    statistics = Object.assign(
      { connected: true, applied: [] },
      { written: plan.written, unresolved: plan.unresolved, errors: plan.errors }
    );
  } else {
    logger('[数据统计] 未传 ctx，按 M1 行为跳过（模板原样，一个格子都不写）');
  }

  const result = await runBuildEngine(payload, logger, (built) => {
    if (!options.ctx) return;
    const applied = (built.statistics && built.statistics.applied) || [];
    statistics.applied = applied;
    logger(
      `[数据统计] 已写入 ${applied.length} 个单元格` +
      `，口径未定 ${statistics.unresolved.length} 个（不写入）`
    );
    if (statistics.errors.length) {
      // R10 / H6：缺数不静默。报告照出，但必须把哪些格子没算出来讲清楚
      const detail = statistics.errors.map((e) => `${e.addr}(${e.message})`).join('；');
      logger(`[数据统计] ⚠️ ${statistics.errors.length} 个单元格未取到值，已留空: ${detail}`);
    }
    if (applied.length !== statistics.written.length) {
      // 计划与落笔数对不上：说明 Python 侧丢了几格。不静默 —— 这正是"悄悄少写一格"
      // 那类最难发现的问题，宁可吵一点。
      logger(
        `[数据统计] ⚠️ 计划写 ${statistics.written.length} 格，实际落笔 ${applied.length} 格，`
        + `差额 ${statistics.written.length - applied.length} 格未写入`
      );
    }
  });

  // 合并完成后再套统一视觉规范。失败不回滚报告：数据是对的，缺的只是观感，
  // 但必须说清楚，不静默（否则拿到一份没美化的报告还以为成功了）。
  let beautify = { ok: false, theme: null, styled: [], skipped: [], message: '' };
  if (options.beautify === false) {
    beautify = { ok: false, theme: null, styled: [], skipped: [], message: '--no-beautify 已指定，跳过美化' };
    logger('[美化] 已跳过（--no-beautify）');
  } else {
    const theme = options.beautifyTheme || DEFAULT_BEAUTIFY_THEME;
    try {
      const styled = await beautifyReport(outputPath, { theme });
      beautify = {
        ok: true,
        theme: styled.theme || theme,
        styled: styled.styled || [],
        skipped: styled.skipped || [],
        message: ''
      };
      const skippedNames = beautify.skipped.map((s) => `${s.name}（${s.reason}）`).join('、');
      logger(`[美化] 主题 ${beautify.theme}，已套用 ${beautify.styled.length} 个 sheet: ${beautify.styled.map((s) => s.name).join('、')}`);
      if (skippedNames) {
        logger(`[美化] 跳过: ${skippedNames}`);
      }
    } catch (error) {
      beautify = { ok: false, theme, styled: [], skipped: [], message: error.message };
      logger(`[美化] 失败，报告已生成但未套用统一格式: ${error.message}`);
    }
  }

  return {
    filePath: outputPath,
    sheets: result.sheets,
    statistics,
    beautify,
    preprocess: result.preprocess
  };
}

/**
 * 给已写好的报告套统一视觉规范（原地改写）。
 *
 * 单独一次进程、单独一次读写盘：美化是可跳过的观感层，不该混进合并引擎里。
 *
 * @param {string} filePath 报告路径
 * @param {{theme?: string}} [options]
 * @returns {Promise<{theme: string, styled: string[], skipped: Array}>}
 */
function beautifyReport(filePath, options = {}) {
  const theme = options.theme || DEFAULT_BEAUTIFY_THEME;
  return runPython(
    BEAUTIFY_SCRIPT,
    [encodePath(filePath), encodePath(JSON.stringify({ theme, exclude_sheets: BEAUTIFY_EXCLUDE_SHEETS }))],
    '美化'
  );
}

module.exports = {
  buildReport,
  beautifyReport,
  generateReportFileName,
  sanitizeFilePart,
  TABLE_SHEET_NAMES,
  TEMPLATE_SHEETS,
  DEFAULT_BEAUTIFY_THEME,
  BEAUTIFY_EXCLUDE_SHEETS
};
