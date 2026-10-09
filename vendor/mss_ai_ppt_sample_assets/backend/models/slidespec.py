from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import json
from pydantic import BaseModel


# ============================================================================
# V2 SlideSpec - Simplified structure for AI-driven generation
# ============================================================================

class SlideContentV2(BaseModel):
    """Content for a single slide in V2 format.

    In V2, data is a flat dict mapping token names directly to their values.
    """
    slide_no: int
    slide_key: str
    placeholders: Dict[str, Any]  # token -> generated/extracted value


class SlideSpecV2(BaseModel):
    """SlideSpec for V2 templates.

    Simplified structure where each slide contains a flat mapping
    of placeholder tokens to their values.
    """
    template_id: str
    slides: List[SlideContentV2]

    @classmethod
    def load_from_file(cls, path: Path) -> "SlideSpecV2":
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return cls.model_validate(data)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            json.dump(self.model_dump(), f, ensure_ascii=False, indent=2)

    def get_slide(self, slide_key: str) -> Optional[SlideContentV2]:
        """Get a slide by its key."""
        for slide in self.slides:
            if slide.slide_key == slide_key:
                return slide
        return None

    def get_placeholder_value(self, slide_key: str, token: str) -> Optional[Any]:
        """Get a specific placeholder value."""
        slide = self.get_slide(slide_key)
        if slide:
            return slide.placeholders.get(token)
        return None

    def set_placeholder_value(self, slide_key: str, token: str, value: Any) -> None:
        """Set a specific placeholder value."""
        slide = self.get_slide(slide_key)
        if slide:
            slide.placeholders[token] = value


# ============================================================================
# Utility functions
# ============================================================================

def create_empty_slidespec_v2(template_id: str, slide_keys: List[tuple[int, str]]) -> SlideSpecV2:
    """Create an empty SlideSpecV2 with the given slide structure.

    Args:
        template_id: Template ID
        slide_keys: List of (slide_no, slide_key) tuples

    Returns:
        Empty SlideSpecV2 ready to be populated
    """
    slides = [
        SlideContentV2(slide_no=no, slide_key=key, placeholders={})
        for no, key in slide_keys
    ]
    return SlideSpecV2(template_id=template_id, slides=slides)