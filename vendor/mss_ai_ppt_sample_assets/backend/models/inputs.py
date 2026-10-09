from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import json
from pydantic import BaseModel


class InputCatalogEntry(BaseModel):
    input_id: str
    file: str
    description: str = ""


class TenantInput(BaseModel):
    """Wrapper around raw tenant input JSON for downstream modules."""

    raw: Dict[str, Any]

    @classmethod
    def load_from_file(cls, path: Path) -> "TenantInput":
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(raw=data)

    def get(self, key: str, default=None):
        return self.raw.get(key, default)
