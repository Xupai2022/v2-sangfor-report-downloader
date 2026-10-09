# -*- coding: utf-8 -*-
"""PPT 生成子包。

分层（详见各模块 docstring）：

    cli / __main__        命令行分派，顶层异常 → JSON
    generate / rewrite    编排
    templates / input     模板页清单、Excel → 引擎入参
    paths / logs / b64 / errors   基础设施
    bootstrap             进口：设 env + sys.path，必须最先 import
    engine                ★ 全仓库唯一 import mss_ai_ppt_sample_assets.* 的文件
    doctor                自检：vendor 漂移 / 符号签名 / 数据指纹 / 依赖 / env / LLM

除 engine.py 外，本包任何模块都不得出现 mss_ai_ppt_sample_assets。
那样「换上游版本要改哪里」的答案才始终是唯一一个文件。
"""
