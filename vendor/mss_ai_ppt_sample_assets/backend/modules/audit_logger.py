from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.models.audit import AuditEntry


class AuditLogger:
    def __init__(self, log_path: Optional[Path] = None):
        self.log_path = log_path or (config.LOGS_DIR / "audit.log")
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(
        self,
        event: str,
        details: Dict[str, Any],
        job_id: Optional[str] = None,
        slide_key: Optional[str] = None,
        severity: str = "info",
    ) -> None:
        entry = AuditEntry(
            timestamp=datetime.now(timezone.utc),
            event=event,
            details=details,
            job_id=job_id,
            slide_key=slide_key,
            severity=severity,
        )
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry.dict(), ensure_ascii=False, default=str) + "\n")
