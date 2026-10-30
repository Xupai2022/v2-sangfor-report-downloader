'use strict';

/**
 * 总表读取层 —— MIGRATION.md R9 的 `parse*` 那一半。
 *
 * R9：每份总表对应一个 `fetch*`（下到磁盘，在 mssw_client.js）+ 一个 `parse*`
 * （读成内存行对象）。本文件是后半截，与 mssw_client.js 成对。
 *
 * 为什么读表要绕一圈到 Python：本仓库的 Excel 读写已经全是 openpyxl，JS 侧连读一个
 * xlsx 都做不到（那正是去掉 SheetJS 想要的结果）。所以实际干活的是
 * scripts/parse_table_rows.py，本文件只负责拉起它、把结果和错误翻译成人话。
 *
 * **行对象的契约写在那个 Python 脚本的头注里**（键=表头文字、每行带全键、请求了但
 * 表头没有的列不补空串、表头重名抛错、时间给 epoch 秒）。改这里之前先看那份 ——
 * 这几条是 stats/metrics/*.js 的 hasOwnProperty 防线赖以成立的前提。
 */

const fs = require('fs');
const path = require('path');

const { encodePayload } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');

const PARSE_SCRIPT = path.join(__dirname, 'scripts', 'parse_table_rows.py');

/**
 * 暴露面表「文档说明」专用的读取脚本 —— 与上面的通用读表器分开。
 *
 * 那份 sheet 不是「第一行就是表头」的规整表：标题、基本信息占住上半张，
 * 汇总表从第 15 行才开始。用通用读表器会把标题行当表头，所以按投喂口径
 * 「逐格找子类型文字、取右侧一格」另走一条（见 scripts/parse_exposed_summary.py）。
 */
const PARSE_EXPOSED_SUMMARY_SCRIPT = path.join(__dirname, 'scripts', 'parse_exposed_summary.py');

/**
 * 与 report_writer.js 的 PYTHON_OPTIONS 同款。
 *
 * 事件表动辄几千行，maxBuffer 给足；timeout 10 分钟 —— 纯本地读盘，超时说明卡住了。
 * env 走 workdir.childEnv()：关掉 __pycache__（集群上 skill 根是只读挂载）
 * + TMPDIR 指到可写区。
 */
const PYTHON_OPTIONS = {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 600000,
  env: workdir.childEnv()
};

/**
 * 把 Python 侧的失败翻译成人话。
 *
 * 脚本失败时把 stderr 写成 {"diag":"error","message"}，message 已经是人话
 * （哪份表、缺哪一列、是不是文件不存在），直接用。解析不出来（比如解释器压根没起来）
 * 就原样交回 error.message。
 */
function parseFailure(error) {
  const raw = String((error && error.message) || '').trim();
  try {
    const diag = JSON.parse(raw);
    if (diag && typeof diag === 'object' && typeof diag.message === 'string') {
      return new Error(diag.message);
    }
  } catch (ignored) {
    // 不是 JSON：走下面原样交回
  }
  return new Error(raw || '读总表失败（Python 侧没有给出原因）');
}

/**
 * 读一份总表 -> 行对象数组。
 *
 * @param {string} filePath 总表 xlsx 路径（下载得到的中间件）
 * @param {Object} [options]
 * @param {string[]} [options.columns] 要读的列（**强烈建议给**）。省略 = 全部具名列，
 *   大表会撞 maxBuffer —— 告警导出没有行数上限，63 列全量回传能到几十 MB。
 * @param {string|string[]} [options.sheet] sheet 名，默认第一个 worksheet。
 *   传**数组**时逐张按同一份 columns 白名单读、行顺序拼接成**一个**行数组
 *   （漏洞表 2026-10-16 起：一个下载件里「内网漏洞表」「互联网漏洞表」两张，
 *   而「全表」的口径就是两份相加）—— 调用方拿到手仍是单个数组，
 *   见 scripts/parse_table_rows.py 头注。
 * @returns {Promise<{sheet: string, header: string[], rowCount: number,
 *   rows: Array<Object>, missingColumns: string[], unnamedColumns: number}>}
 * @throws {Error} 表不存在 / 列重名 / 解释器起不来。**读不出来一律抛，不返回空数组** ——
 *   拿空数组糊过去的话，下游算出的结果是「这段时间没有数据」，与真的没有数据长得
 *   一模一样（R10 缺数不静默）。
 */
function parseTableRows(filePath, options = {}) {
  if (!filePath) {
    return Promise.reject(new Error('总表路径为空'));
  }
  if (!fs.existsSync(PARSE_SCRIPT)) {
    // 早失败给个人话的错误，不然 execFile 只会抛 ENOENT 这种看不出所以然的信息
    return Promise.reject(new Error(`读表脚本不存在: ${PARSE_SCRIPT}`));
  }

  const payload = {
    path: filePath,
    sheet: options.sheet || null,
    columns: options.columns || null
  };

  return pythonCmd
    .execFilePython(PARSE_SCRIPT, [encodePayload(payload)], PYTHON_OPTIONS)
    .then((result) => {
      let parsed;
      try {
        parsed = JSON.parse(String(result.stdout).trim());
      } catch (parseError) {
        throw new Error(`读表脚本输出无法解析: ${result.stdout}`);
      }
      // 形状对不上就当契约破了，早说 —— 少一个字段会让下游静默走缺数分支
      const missing = ['sheet', 'header', 'rowCount', 'rows', 'missingColumns']
        .filter((key) => parsed[key] === undefined);
      if (missing.length) {
        throw new Error(`读表脚本返回的 JSON 缺字段: ${missing.join('、')}`);
      }
      return parsed;
    }, (error) => {
      throw parseFailure(error);
    });
}

/**
 * 读暴露面表「文档说明」sheet -> 汇总行对象数组（D128 的口径源）。
 *
 * 与 parseTableRows 是**两个**读表器，原因写在 PARSE_EXPOSED_SUMMARY_SCRIPT 的注释里：
 * 那份 sheet 的表头不在第 1 行。返回值：
 *
 *   { sheet, header: ['子类型', '总数'], rowCount, rows: [{子类型, 总数}],
 *     missingLabels, duplicateLabels, invalidLabels }
 *
 * **失败语义与 parseTableRows 相同**：文件 / sheet 不存在、一个子类型都找不到时抛错，
 * 不返回空数组糊过去（R10）。部分缺失 / 重复 / 右侧不是数字**不抛**，交给取值层
 * （stats/metrics/exposed.js）按行对象判、记进那一格的错误列表 —— 与「缺列」同档。
 *
 * @param {string} filePath 暴露面表下载件路径
 * @param {Object} options
 * @param {string} [options.sheet] sheet 名，默认「文档说明」
 * @param {string[]} options.labels 要定位的子类型文字（权威在 stats/metrics/exposed.js）
 * @param {'exact'|'contains'} [options.match] 文字判据，默认 exact；contains 用于
 *   I79/I80 那种「找包含某段文字的单元格」的口径（同样是取右侧一格）
 */
function parseExposedSummary(filePath, options = {}) {
  if (!filePath) {
    return Promise.reject(new Error('暴露面表路径为空'));
  }
  if (!fs.existsSync(PARSE_EXPOSED_SUMMARY_SCRIPT)) {
    return Promise.reject(new Error(`读表脚本不存在: ${PARSE_EXPOSED_SUMMARY_SCRIPT}`));
  }

  // labels 必须由调用方给：清单的权威在 stats/metrics/exposed.js，不在 Python 里写第二份。
  if (!Array.isArray(options.labels) || options.labels.length === 0) {
    return Promise.reject(new Error('parseExposedSummary 缺少 labels（子类型清单）'));
  }
  const match = options.match === undefined ? 'exact' : options.match;
  if (match !== 'exact' && match !== 'contains') {
    return Promise.reject(new Error(`parseExposedSummary 的 match 只能是 exact / contains，收到: ${match}`));
  }

  const payload = {
    path: filePath,
    sheet: options.sheet || null,
    labels: options.labels,
    match
  };

  return pythonCmd
    .execFilePython(PARSE_EXPOSED_SUMMARY_SCRIPT, [encodePayload(payload)], PYTHON_OPTIONS)
    .then((result) => {
      let parsed;
      try {
        parsed = JSON.parse(String(result.stdout).trim());
      } catch (parseError) {
        throw new Error(`暴露面汇总读取脚本输出无法解析: ${result.stdout}`);
      }
      // 形状对不上就当契约破了，早说 —— 少一个字段会让下游静默走缺数分支
      const missing = ['sheet', 'header', 'rowCount', 'rows',
                       'missingLabels', 'duplicateLabels', 'invalidLabels']
        .filter((key) => parsed[key] === undefined);
      if (missing.length) {
        throw new Error(`暴露面汇总读取脚本返回的 JSON 缺字段: ${missing.join('、')}`);
      }
      return parsed;
    }, (error) => {
      throw parseFailure(error);
    });
}

module.exports = { parseTableRows, parseExposedSummary, PARSE_SCRIPT,
                   PARSE_EXPOSED_SUMMARY_SCRIPT };
