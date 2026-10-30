'use strict';

/**
 * 事件表预处理层 —— 「下载之后、解析之前」那一步。
 *
 * **用户口径（2026-10-12）：取值层必须在预处理之后。** 也就是说 ctx 里的行对象要能
 * 直接读到预处理追加出来的列（眼下是「内网外网资产」、五个时长列，以及 2026-10-14 追加的
 * 「事件创建月份」），所以这几步只能在 `parse*` **之前**落到下载件上，不能等到合并报告的时候。
 *
 * 实际干活的是 scripts/report_preprocess.py 的 `preprocess_event_file`，本文件只负责
 * 拉起它、把结果与错误翻译成人话 —— 与 mssw_parser.js 和 parse_table_rows.py 的分工同款。
 *
 * 跑的是四步（第 1 步建映射 + 第 2 步追加「内网外网资产」+ 第 4 步追加五个时长列
 * + 第 5 步追加「事件创建月份」）。从前还有一步「告警表『主机IP』剥括号后缀」留在合并
 * 报告时跑，2026-10-12 已删除 —— 表格预处理现在**只有这一处**。
 *
 * ⚠️ 第 4 条的五个时长列**逐列独立**（用户口径 2026-10-12「不要因为一个影响别的时间计算」）：
 * 一列时长只看自己那两个源列在不在，缺一个只停它自己那一列 —— 「事件遏制时间」缺席时
 * 「识别时长 / 处置时长 / 响应时长 / 闭环时长」照建照算（G9 因此照常落值）。所以 `duration`
 * 不能只看 `status`：**算了哪几列看 `addedNames`，没算哪几列、各缺哪一列看 `blocked`**。
 *
 * ⚠️ **事件表下载件是原地改写的**（与 scripts/remove_rows_by_status.py 同款做法）：
 * 跑完之后磁盘上那个 xlsx 就多了那七列，sheet 名与其余内容不变。
 * 所以本函数对同一份文件**不是**「跑几次都一样」的自由操作 —— 虽然 Python 侧加了幂等闸
 * （列已经在表头里就跳过，不会追加出重名列），但重复跑是多花一次整本读写。
 */

const fs = require('fs');
const path = require('path');

const { encodePayload } = require('./path_helper');
const pythonCmd = require('./python_cmd');
const workdir = require('./workdir');

const PREPROCESS_SCRIPT = path.join(__dirname, 'scripts', 'report_preprocess.py');

/**
 * 与 mssw_parser.js / report_writer.js 的 PYTHON_OPTIONS 同款。
 *
 * 事件表动辄几千行，openpyxl 整本读 + 写 + 存要几秒到几十秒（实测 6051×28 约 8.5 秒），
 * 超时给 10 分钟 —— 纯本地读盘，超时说明卡住了。env 走 workdir.childEnv()：
 * 关掉 __pycache__（集群上 skill 根是只读挂载）+ TMPDIR 指到可写区。
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
 * 脚本失败时把 stderr 写成 {"diag":"error","message","logs"}，message 已经是人话
 * （哪份表、缺哪一列、是不是文件不存在），直接用。解析不出来（比如解释器压根没起来）
 * 就原样交回 error.message。
 */
function preprocessFailure(error) {
  const raw = String((error && error.message) || '').trim();
  try {
    const diag = JSON.parse(raw);
    if (diag && typeof diag === 'object' && typeof diag.message === 'string') {
      const failure = new Error(diag.message);
      // 失败前跑出来的日志不能丢：预处理是原地改写的，出错的现场就在那几行里
      if (Array.isArray(diag.logs) && diag.logs.length) {
        failure.logs = diag.logs;
      }
      return failure;
    }
  } catch (ignored) {
    // 不是 JSON：走下面原样交回
  }
  return new Error(raw || '表格预处理失败（Python 侧没有给出原因）');
}

/**
 * 事件表预处理：资产表建映射 -> 事件表原地追加「内网外网资产」+ 五个时长列 + 「事件创建月份」。
 *
 * @param {Object} options
 * @param {string} [options.assetPath] 资产表下载结果（prepare_asset_table 加工过的那个）。
 *   为空 = 「这次没有资产表」：不建映射，事件表所有有 IP 的行都标「不在资产表」。
 * @param {string} options.eventPath 事件表下载结果（**会被原地改写**）
 * @returns {Promise<{ran: boolean, asset: Object, event: Object, duration: Object,
 *   month: Object, logs: string[]}>}
 *   `event` / `duration` / `month` 里带那一列的落点与取值分布，原样可以塞进 buildReport 的
 *   `preprocess` 选项（它并进返回值，好让一条日志链把「预处理跑了什么」讲全）。
 * @throws {Error} 脚本缺失 / 解释器起不来 / 事件表路径为空 / 工作簿里已有同名 sheet
 */
function runPreprocess({ assetPath, eventPath } = {}) {
  if (!eventPath) {
    return Promise.reject(new Error('事件表路径为空，无法跑表格预处理'));
  }
  if (!fs.existsSync(PREPROCESS_SCRIPT)) {
    // 早失败给个人话的错误，不然 execFile 只会抛 ENOENT 这种看不出所以然的信息
    return Promise.reject(new Error(`预处理脚本不存在: ${PREPROCESS_SCRIPT}`));
  }

  const payload = {
    asset: assetPath || null,
    event: eventPath
  };

  return pythonCmd
    .execFilePython(PREPROCESS_SCRIPT, [encodePayload(payload)], PYTHON_OPTIONS)
    .then((result) => {
      let parsed;
      try {
        parsed = JSON.parse(String(result.stdout).trim());
      } catch (parseError) {
        throw new Error(`预处理脚本输出无法解析: ${result.stdout}`);
      }
      // 形状对不上就当契约破了，早说 —— 少一个字段会让下游静默走缺数分支
      const missing = ['ran', 'asset', 'event', 'duration', 'month']
        .filter((key) => parsed[key] === undefined);
      if (missing.length) {
        throw new Error(`预处理脚本返回的 JSON 缺字段: ${missing.join('、')}`);
      }
      return parsed;
    }, (error) => {
      throw preprocessFailure(error);
    });
}

module.exports = { runPreprocess, PREPROCESS_SCRIPT };
