# -*- coding: utf-8 -*-
"""进口模块：本包任何其他模块之前必须先 import 它。

做两件事，顺序不能反：

1. 设定进程 env：`MSS_ENV_PATH`（指向仓库根的 .env.ppt）、`MSS_OUTPUTS_DIR`
   （把引擎的写入关进 outputs/_engine_state）、`PYTHONIOENCODING`
2. 把 `<repo>/vendor` 插进 sys.path，好让 `mss_ai_ppt_sample_assets.*` 能原地导入

**顺序不能反的原因**：vendor 的 `config.py` 在 **import 期**就执行
`load_dotenv(MSS_ENV_PATH, override=True)` 并实例化模块级 `settings = Settings()`。
env 还没设就 import，settings 就定格在错误的值上，之后再也改不回来
（override=True 会盖掉后设的进程 env，而不是反过来）。

`engine.py` 的第一行 import 就是本模块，所以只要走 engine 就不会踩到顺序问题。

关于 `.env.ppt` 缺失：**不会抛异常**。load_dotenv 对不存在的路径是静默 no-op，
于是 settings.enable_llm 落到默认的 false，AI 位退化成 mock 文案、PPT 照样生成成功 ——
这正是最需要防的失败模式。所以这里只负责**记录事实**（env_missing），
由调用方决定是警告还是拒绝。
"""

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = REPO_ROOT / "vendor"
ENV_EXAMPLE = REPO_ROOT / ".env.ppt.example"


def _env_file():
    """引擎 env 文件（含 OPENAI_API_KEY）。三级回落，与 `paths._env_file()` 逐条一致。

    bootstrap 刻意**不** import paths —— 它的职责是「比包内任何模块先跑」，
    反过来依赖包内模块就成环了。所以这套顺序在这里有一份镜像，改要一起改。
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


def _engine_state_dir():
    """引擎写入的落点。集群下必须落在可写区（skill 根只读），本地保持 `<repo>/outputs`。

    与 `paths.OUTPUTS_DIR` / `workdir.engineStateDir()` 同一套布局，三处必须一致。
    这里不 import paths —— bootstrap 的职责是"本包任何模块之前先跑"，
    反过来依赖包内模块就成环了。
    """
    raw = (os.environ.get("SKILL_OUTPUT_DIR") or "").strip()
    base = Path(raw).resolve() / "outputs" if raw else REPO_ROOT / "outputs"
    return base / "_engine_state"


ENGINE_STATE_DIR = _engine_state_dir()

# 实际上游包名。engine.py 是唯一 import 它的文件。
UPSTREAM_PACKAGE = "mss_ai_ppt_sample_assets"

env_missing = not ENV_FILE.exists()


def _prepare():
    # --- 0. 禁止写字节码缓存 ---
    # 不加这一行，import 一次 vendor 就会在 `vendor/**/__pycache__/` 里落下 20 个
    # .pyc。后果不只是脏：`vendor/` 是 1:1 快照、要提交进 git、`--verify-vendor`
    # 还要复算 sha256 —— 快照的字节可复现性会被我们自己破坏。
    # 代价是每次冷启动多花约 0.5 秒编译（实测 2.5s → 3.0s），换来「快照永不漂移」。
    sys.dont_write_bytecode = True

    # --- 1. 进程 env ---
    # setdefault 而不是赋值：pipeline.js 会显式注入这些变量（并且可能按次覆盖
    # 输出目录），不能盖掉它。这里只在「没人设过」时兜底。
    os.environ.setdefault("MSS_ENV_PATH", str(ENV_FILE))
    os.environ.setdefault("MSS_OUTPUTS_DIR", str(ENGINE_STATE_DIR))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    # 刻意**不设** MSS_DATA_DIR：config.py 由它推导 TEMPLATES_DIR，
    # 设了就会把模板目录从 vendor 里挪走，引擎就找不到 plus.pptx 了。

    # --- 2. sys.path ---
    for entry in (str(VENDOR_DIR), str(REPO_ROOT)):
        if entry not in sys.path:
            sys.path.insert(0, entry)

    ENGINE_STATE_DIR.mkdir(parents=True, exist_ok=True)


_prepare()


def env_hint():
    """给报错用的、可直接照抄的下一步。"""
    return f"cp {ENV_EXAMPLE.name} {ENV_FILE.name}  然后填 OPENAI_API_KEY"


def describe():
    """doctor / 汇总 JSON 用的 env 事实。"""
    return {
        "env_path": str(ENV_FILE),
        "env_exists": not env_missing,
        "engine_state_dir": os.environ.get("MSS_OUTPUTS_DIR"),
        "vendor_dir": str(VENDOR_DIR),
    }
