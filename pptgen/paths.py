# -*- coding: utf-8 -*-
"""仓库内路径与落盘布局。

    <repo>/
      outputs/
        latest.json                              最近一次 generate 的指针（原子写）
        {YYYYMMDD_HHMMSS}/                       本次运行独占的目录，名字就是开始时间
          {客户}_report.xlsx                     Excel（下载产物；--excel 时来自外部）
          {客户}_report_{template_id}.pptx        成片
          {客户}_report_{template_id}_重写版_P{n}.pptx
          slidespec.json                         当前状态（rewrite 原地更新它）
          slidespec.original.json                generate 当时的快照，供 --from-original
          slidespec.P{n}.{ts}.json               每次 rewrite 的审记快照
          input.json                             TenantInput.raw + 命名依据，rewrite 复用
          manifest.json                          generate / rewrite 历史
        _engine_state/                           MSS_OUTPUTS_DIR 指向这里
        _logs/<run-id>.log                       pptgen 的 stderr 全量落盘

**一次运行 = 一个目录**：Excel 与 PPT 落在同一个 run 目录里，名字是这次运行的开始时间。
所以重复跑 generate 不会撞车、也不需要用 --force 去覆盖上一次的产物 —— 每次都是新目录。

文件名对齐上游 `report-generation` 的口径（`report_service.py` 落盘叫
`{input_id}_{template_id}.pptx`，`routers/v1/reports.py` 下载时再前缀
`%Y%m%d_%H%M%S_`）。我们这里 `input_id` 的对应物是**源 Excel 的词干**，于是成片名永
远能和它的源 Excel 对上，不用去猜是哪个客户、哪个模板跑的。

时间戳只在目录名里出现一次（上游是目录叫 job_id、文件名再带一遍时间；我们这套
一次运行就是一个目录，重复一遍反而更难读）。

`outputs/_engine_state` 的存在意义：vendor 的 config.py 有 OUTPUTS_DIR（默认落在
backend/outputs）。把它重定向进来，保证引擎**不会往 report-generation 写任何东西** ——
这是「不改上游仓库」这条约束在运行期的落地。
"""

import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _outputs_dir():
    """可写根：集群上 skill 根是只读挂载，产物必须落进 guard 注入的 SKILL_OUTPUT_DIR。

    未设置时**逐字保持历史行为**（`<repo>/outputs`）—— 本地开发要有那个目录可看，
    而且这是 `pipeline.js` 的 newRunDir / mssw_downloader 都认得的同一套布局。
    集群下对齐 `workdir.js` 的 `runsDir()`：`<SKILL_OUTPUT_DIR>/outputs`。
    """
    raw = (os.environ.get("SKILL_OUTPUT_DIR") or "").strip()
    if not raw:
        return REPO_ROOT / "outputs"
    return Path(raw).resolve() / "outputs"


OUTPUTS_DIR = _outputs_dir()
ENGINE_STATE_DIR = OUTPUTS_DIR / "_engine_state"
LOGS_DIR = OUTPUTS_DIR / "_logs"

LATEST_POINTER = OUTPUTS_DIR / "latest.json"

# 与上游 download 名的 ts 同格式（routers/v1/reports.py 的 %Y%m%d_%H%M%S）
RUN_TS_FORMAT = "%Y%m%d_%H%M%S"
_RUN_DIR_BUMP_LIMIT = 120

VENDOR_DIR = REPO_ROOT / "vendor"
MANIFEST_PATH = VENDOR_DIR / "MANIFEST.json"
ENV_EXAMPLE = REPO_ROOT / ".env.ppt.example"


def _env_file():
    """PPT 引擎的 env 文件（放 OPENAI_API_KEY 与功能开关）。

    **不能只有 `<repo>/.env.ppt` 一条路**：那个文件被 .gitignore 排除（含密钥），
    不会进上传包；集群上 skill 根又是只读的，到那儿也建不出来。所以三级回落：

      1. 显式注入的 `MSS_ENV_PATH`（集群镜像 / runtime 烘的路径优先）
      2. `<SKILL_OUTPUT_DIR>/.env.ppt`（可写区，能把 key 放这儿）
      3. `<repo>/.env.ppt`（本地开发的原路径，逐字不变）

    与 `bootstrap._env_file()` 同一套顺序 —— bootstrap 刻意不 import 本模块
    （它必须比包内任何模块先跑），两处要一起改。
    """
    injected = (os.environ.get("MSS_ENV_PATH") or "").strip()
    if injected:
        return Path(injected)
    raw = (os.environ.get("SKILL_OUTPUT_DIR") or "").strip()
    if raw:
        candidate = Path(raw).resolve() / ".env.ppt"
        if candidate.exists():
            return candidate
    return REPO_ROOT / ".env.ppt"


ENV_FILE = _env_file()


def run_dir_name(moment=None):
    """本次 run 目录的名字 = 开始时间。纯时间戳，不带客户名与周期。

    客户与周期去哪了：Excel 名与成片名里都有客户，`latest.json` / `manifest.json`
    里有全套（客户、客户 ID、起止、模板），所以目录名不需要再背一遍。
    """
    return (moment or datetime.now()).strftime(RUN_TS_FORMAT)


def new_run_dir(moment=None):
    """outputs/{YYYYMMDD_HHMMSS} —— 本次运行独占，**保证是个新目录**。

    同一秒内起第二次（`--excel --mock` 的冒烟循环真会撞上）就顺延到下一秒。
    名字仍然是纯时间戳，且永远不会踩掉上一次运行的产物 —— 这比「撞了就报
    run_dir_conflict 让人加 --force」安全得多：后者会让 --force 变成
    「删掉上一次运行的产物来给这一次腾位置」，而用户以为只是重跑了一遍。
    """
    moment = moment or datetime.now()
    for offset in range(_RUN_DIR_BUMP_LIMIT):
        candidate = OUTPUTS_DIR / run_dir_name(moment + timedelta(seconds=offset))
        if not candidate.exists():
            return candidate
    raise RuntimeError(
        f"outputs/ 下连续 {_RUN_DIR_BUMP_LIMIT} 秒的时间戳目录都被占了，先清理 outputs/"
    )


def report_pptx_name(excel_stem, template_id):
    """{Excel 词干}_{模板id}.pptx —— 上游 `{input_id}_{template_id}.pptx` 的对应物。

    用 Excel 的词干而不是客户名，是为了让成片永远能和它的源 Excel 对上：
    本仓库自己下载的 Excel 叫 `{客户}_report.xlsx`，于是成片是
    `{客户}_report_mss_classic_ops_2.pptx`；`--excel plus_data.xlsx` 时成片就叫
    `plus_data_mss_classic_ops_2.pptx`。客户名拼不出这个 —— 它对「这份 Excel 是哪来的」一无所知。
    """
    return f"{excel_stem}_{template_id}.pptx"


def rewrite_pptx_name(pptx_stem, slide_no):
    """{原成片词干}_重写版_P{n}.pptx，另存，不覆盖原稿。

    以原成片的词干为基（而不是重新拼客户/起止/模板），所以重写版必然与它改的那份
    原稿同名同源，一眼能配对；也免掉了「从 input.json 回读客户与周期再拼名字」那一整套。
    """
    return f"{pptx_stem}_重写版_P{slide_no}.pptx"


def timestamp():
    """本地时间戳，用于审记快照文件名。带微秒避免同一秒内两次 rewrite 撞名。"""
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def ensure_dirs():
    """run 目录由调用方 mkdir（它是每次运行独占的），这里只管常驻的那两个。"""
    for directory in (OUTPUTS_DIR, ENGINE_STATE_DIR, LOGS_DIR):
        directory.mkdir(parents=True, exist_ok=True)


# ---------- 原子写 ----------

def write_json_atomic(path, payload):
    """先写同目录的临时文件再 os.replace。同盘 rename 是原子的。

    直接 open(path,'w') 然后 json.dump 的话，进程在写到一半被 kill（超时是常见原因）
    会留下半截 JSON，读方拿到 JSONDecodeError 而不知道是「上次没写完」。
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(tmp), str(path))
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def read_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


# ---------- latest.json ----------

def write_latest(payload):
    write_json_atomic(LATEST_POINTER, payload)


def read_latest():
    """读最近一次 generate 的指针。没有则返回 None（调用方负责给 hint）。"""
    if not LATEST_POINTER.exists():
        return None
    try:
        return read_json(LATEST_POINTER)
    except (json.JSONDecodeError, OSError):
        return None


def update_latest_rewrites(entry):
    """把一次 rewrite 追加进 latest.json 的 rewrites 列表。"""
    latest = read_latest()
    if not latest:
        return None
    latest.setdefault("rewrites", []).append(entry)
    write_latest(latest)
    return latest
