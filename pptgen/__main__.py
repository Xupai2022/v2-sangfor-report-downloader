# -*- coding: utf-8 -*-
"""`python -m pptgen` 的入口。

只有一行实质内容：把 cli.main() 的返回码交给 sys.exit。
退出码由 errors.EXIT_* 决定，pipeline.js 靠它区分「重试」还是「改参数」。
"""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
