from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class AuditEntry(BaseModel):
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    event: str
    details: Dict[str, Any] = Field(default_factory=dict)
    job_id: Optional[str] = None
    slide_key: Optional[str] = None
    severity: str = "info"
