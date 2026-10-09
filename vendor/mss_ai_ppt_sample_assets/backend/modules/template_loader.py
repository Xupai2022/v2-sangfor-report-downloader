from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Union

from mss_ai_ppt_sample_assets.backend.config import TEMPLATES_DIR
from mss_ai_ppt_sample_assets.backend.models.templates import (
    TemplateDescriptorV2,
    is_v2_template,
    load_template_descriptor,
)


class TemplateNotFoundError(Exception):
    pass


class TemplateRepository:
    """Loads and caches template descriptors from the local filesystem.

    Supports V2 (AI-driven) template formats.
    """

    def __init__(self, base_dir: Path = TEMPLATES_DIR):
        self.base_dir = base_dir
        self._catalog = self._load_catalog()
        self._descriptor_cache: Dict[str, TemplateDescriptorV2] = {}

    def clear_cache(self) -> None:
        """Clear the descriptor cache to reload templates from disk."""
        self._descriptor_cache.clear()

    def _load_catalog(self) -> List[Dict]:
        catalog_path = self.base_dir / "catalog.json"
        with catalog_path.open("r", encoding="utf-8") as f:
            return json.load(f).get("templates", [])

    def list_templates(self, include_deprecated: bool = False) -> List[Dict]:
        """List available templates."""
        if include_deprecated:
            return self._catalog
        return [t for t in self._catalog if not t.get("deprecated", False)]

    def list_v2_templates(self) -> List[Dict]:
        """Backwards-compatible API: returns all templates."""
        return [t for t in self._catalog if is_v2_template(t["template_id"])]

    def get_descriptor_v2(self, template_id: str) -> TemplateDescriptorV2:
        """Get template descriptor.

        Args:
            template_id: Template ID (should be a V2 template)

        Returns:
            TemplateDescriptorV2 instance

        Raises:
            TemplateNotFoundError: If template not found
        """
        if template_id in self._descriptor_cache:
            return self._descriptor_cache[template_id]

        entry = self._get_catalog_entry(template_id)
        descriptor_path = self.base_dir / entry["descriptor_file"]
        descriptor = load_template_descriptor(descriptor_path)

        self._descriptor_cache[template_id] = descriptor
        return descriptor

    def get_pptx_path(self, template_id: str) -> Path:
        """Get path to the PPTX template file."""
        entry = self._get_catalog_entry(template_id)
        return self.base_dir / entry["pptx_file"]

    def get_catalog_entry(self, template_id: str) -> Dict:
        """Get catalog entry for a template (public API)."""
        return self._get_catalog_entry(template_id)

    def _get_catalog_entry(self, template_id: str) -> Dict:
        """Get catalog entry for a template (internal)."""
        entry = next((t for t in self._catalog if t["template_id"] == template_id), None)
        if not entry:
            raise TemplateNotFoundError(f"Template {template_id} not found in catalog")
        return entry

    def is_v2(self, template_id: str) -> bool:
        """Backwards-compatible API: always returns True."""
        return is_v2_template(template_id)
