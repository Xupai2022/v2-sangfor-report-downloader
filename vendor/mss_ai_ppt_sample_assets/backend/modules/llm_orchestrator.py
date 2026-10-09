from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from functools import lru_cache
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

import httpx
from openai import OpenAI

from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.modules.retry_policy import with_llm_retry
from mss_ai_ppt_sample_assets.backend.models.slidespec import (
    SlideSpecV2, create_empty_slidespec_v2
)
from mss_ai_ppt_sample_assets.backend.models.templates import (
    TemplateDescriptorV2, PlaceholderDefinition
)
from mss_ai_ppt_sample_assets.backend.models.inputs import TenantInput
from mss_ai_ppt_sample_assets.backend.modules.template_loader import TemplateRepository

# Configure logging
logger = logging.getLogger(__name__)


def _build_openai_client() -> OpenAI:
    client_kwargs = {"api_key": config.settings.openai_api_key}
    if config.settings.openai_base_url:
        client_kwargs["base_url"] = config.settings.openai_base_url
    # 禁用 SDK 内置自动重试：统一由我们自己的重试策略控制，避免多层重试叠加。
    client_kwargs["max_retries"] = 0
    # 显式绑定四类超时，确保“卡住”能在可控时间内被识别并反馈给用户。
    client_kwargs["http_client"] = httpx.Client(
        timeout=httpx.Timeout(
            # connect/read/write/pool 分别对应建连、读响应、写请求、等连接池可用连接。
            connect=config.settings.llm_connect_timeout_seconds,
            read=config.settings.llm_read_timeout_seconds,
            write=config.settings.llm_write_timeout_seconds,
            pool=config.settings.llm_pool_timeout_seconds,
        ),
        trust_env=False,
    )
    return OpenAI(**client_kwargs)


class LLMGenerationError(Exception):
    """Error during LLM content generation"""
    pass


class LLMOrchestratorV2:
    """V2 Orchestrator for AI-driven content generation.

    Key differences from V1:
    - Takes raw TenantInput directly, no pre-processing
    - Uses placeholder-based AI instructions from template
    - Generates content based on ai_instruction fields
    - Validates only key numerical fields
    """
    _ANNOTATIONS: List[Dict[str, str]] = [
        {
            "id": "business_protection",
            "title": "业务保护",
            "content": (
                "定义为：围绕关键资产，明确保护对象；消除脆弱性，减少被攻击面；抵御威胁，防止业务被破坏；快速处置安全事件，保障业务持续不中断。保护业务不中断、数据不失控、运行可持续。此用户选择偏好强调业务连续性、风险遏制和可执行防护结果。"
            ),
        },
        {
            "id": "vulnerability",
            "title": "漏洞优先",
            "content": (
                "优先关注漏洞暴露面、根因和修复优先级。"
            ),
        },
        {
            "id": "alert",
            "title": "告警优先",
            "content": (
                "优先关注威胁告警、事件模式和响应成效。"
            ),
        },
    ]
    _DUTY_SUMMARY_TOKEN = "duty_summary"
    _DUTY_SUMMARY_FESTIVAL_TOKENS: List[str] = [
        "mid_autumn_festival",
        "national_day",
        "new_years_day",
        "spring_festival",
        "qingming_festival",
        "labor_day",
        "dragon_boat_festival",
    ]

    def __init__(self, template_repo: Optional[TemplateRepository] = None):
        self.template_repo = template_repo or TemplateRepository()
        self.client: Optional[OpenAI] = None

        if config.settings.enable_llm:
            try:
                self.client = _build_openai_client()
                logger.info("OpenAI client initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize OpenAI client: {e}")
                raise LLMGenerationError(f"OpenAI client initialization failed: {e}") from e

    @staticmethod
    def _sanitize_filename(value: str) -> str:
        text = re.sub(r"[^0-9A-Za-z._-]+", "_", value or "").strip("._")
        return text or "unknown"

    def _dump_prompt_markdown(
        self,
        *,
        session_id: Optional[str],
        scene: str,
        template_id: str,
        system_prompt: str,
        user_prompt: str,
        slide_key: Optional[str] = None,
        batch_index: Optional[int] = None,
        total_batches: Optional[int] = None,
    ) -> None:
        """Persist full prompt payload as markdown under the session directory."""
        if not session_id:
            return

        try:
            session_dir = config.SESSIONS_DIR / session_id
            session_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            parts = [f"llm_prompt_{self._sanitize_filename(scene)}"]
            if batch_index is not None:
                if total_batches is not None and total_batches > 0:
                    parts.append(f"batch{batch_index + 1}of{total_batches}")
                else:
                    parts.append(f"batch{batch_index + 1}")
            if slide_key:
                parts.append(self._sanitize_filename(slide_key))
            filename = "_".join(parts) + f"_{ts}.md"
            path = session_dir / filename

            meta_lines = [
                f"- scene: `{scene}`",
                f"- template_id: `{template_id}`",
                f"- session_id: `{session_id}`",
            ]
            if slide_key:
                meta_lines.append(f"- slide_key: `{slide_key}`")
            if batch_index is not None:
                if total_batches is not None and total_batches > 0:
                    meta_lines.append(f"- batch: `{batch_index + 1}/{total_batches}`")
                else:
                    meta_lines.append(f"- batch: `{batch_index + 1}`")

            markdown = "\n".join([
                "# LLM Prompt Dump",
                "",
                "## Metadata",
                *meta_lines,
                "",
                "## System Prompt",
                "```text",
                system_prompt,
                "```",
                "",
                "## User Prompt",
                "```text",
                user_prompt,
                "```",
                "",
            ])
            path.write_text(markdown, encoding="utf-8")
            logger.info("Prompt markdown dumped: %s", path)
        except Exception as e:
            logger.warning("Failed to dump prompt markdown for session %s: %s", session_id, e)

    def _get_nested(self, data: Any, path: str) -> Any:
        """Get nested value from dict or TenantInput using dot notation path."""
        if not path:
            return None

        # Handle TenantInput by getting its raw data
        if hasattr(data, 'raw'):
            current = data.raw
        elif isinstance(data, dict):
            current = data
        else:
            return None

        for part in path.split('.'):
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list) and part.isdigit():
                idx = int(part)
                current = current[idx] if idx < len(current) else None
            else:
                return None
            if current is None:
                return None
        return current

    def _resolve_format_path(self, data: Dict[str, Any], path: str) -> Any:
        """Resolve a dotted path in data, handling .length for lists."""
        parts = path.split('.')
        current = data

        for i, part in enumerate(parts):
            if part == "length" and isinstance(current, list):
                return len(current)

            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list) and part.isdigit():
                idx = int(part)
                current = current[idx] if idx < len(current) else None
            else:
                return None

            if current is None:
                return None

        return current

    def _format_template_string(self, template: str, data: Dict[str, Any]) -> str:
        """Format a template string with custom path resolution supporting .length."""
        import re

        def replace_placeholder(match):
            path = match.group(1)
            value = self._resolve_format_path(data, path)
            if value is None:
                return match.group(0)  # Keep original if not found
            return str(value)

        # Find all {path} patterns and replace them
        result = re.sub(r'\{([^}]+)\}', replace_placeholder, template)
        return result

    def _format_value(self, value: Any, placeholder: PlaceholderDefinition) -> str:
        """Format a value according to placeholder definition."""
        if value is None:
            return placeholder.default or ""

        # Apply transform
        if placeholder.transform:
            if placeholder.transform == "uppercase":
                value = str(value).upper()
            elif placeholder.transform == "lowercase":
                value = str(value).lower()
            elif placeholder.transform == "percent":
                if isinstance(value, (int, float)):
                    value = f"{round(value * 100)}%"

        # Handle list values FIRST (before format check)
        if isinstance(value, list):
            if placeholder.format and "{" in placeholder.format:
                # Format each list item using the format template
                formatted_items = []
                for item in value:
                    if isinstance(item, dict):
                        try:
                            formatted_items.append(self._format_template_string(placeholder.format, item))
                        except Exception:
                            formatted_items.append(str(item))
                    else:
                        formatted_items.append(str(item))
                return "\n".join(f"- {item}" for item in formatted_items)
            elif placeholder.format == "join_comma":
                return ", ".join(str(v) for v in value)
            else:
                return "\n".join(f"- {str(v)}" for v in value)

        # Apply format template for non-list values
        if placeholder.format:
            if placeholder.format == "percent":
                if isinstance(value, (int, float)):
                    return f"{round(value * 100)}%"
            elif placeholder.format == "join_comma":
                return str(value)
            elif "{" in placeholder.format:
                # Template format like "{value} units" or "{start} ~ {end}"
                if isinstance(value, dict):
                    try:
                        return self._format_template_string(placeholder.format, value)
                    except Exception:
                        pass
                else:
                    try:
                        return placeholder.format.format(value=value)
                    except (KeyError, ValueError):
                        pass

        return str(value)

    @staticmethod
    def _coerce_number(value: Any) -> Optional[float]:
        """Best-effort conversion to float for chart payload normalization."""
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            text = value.strip().replace(",", "")
            if not text:
                return None
            is_percent = text.endswith("%")
            if is_percent:
                text = text[:-1].strip()
            try:
                number = float(text)
            except ValueError:
                return None
            return number / 100.0 if is_percent else number
        return None

    def _extract_chart_data(
        self,
        tenant_input: TenantInput,
        chart_config: Dict[str, Any],
        chart_type: str
    ) -> Dict[str, Any]:
        """Extract and format chart data from tenant input.

        Args:
            tenant_input: Raw tenant input
            chart_config: Chart configuration from placeholder definition
            chart_type: One of the supported chart placeholder types

        Returns:
            Formatted chart data ready for rendering
        """
        data_source = chart_config.get('data_source')
        if not data_source:
            logger.warning(f"Chart config missing data_source")
            return {}

        # Get data from tenant input
        source_data = self._get_nested(tenant_input, data_source)
        if not source_data:
            logger.warning(f"No data found at {data_source}")
            return {}

        result = {}

        if chart_type in ('P11_bar', 'P15_bar', 'P27_bar', 'P28_bar'):
            # Expect source_data to have 'labels' and 'values' or similar structure
            default_x_field = 'categories' if chart_type in ('P15_bar', 'P28_bar') else 'labels'
            x_field = chart_config.get('x_field', default_x_field)
            y_field = chart_config.get('y_field', 'values')

            if isinstance(source_data, dict):
                # Direct dict format: {"labels": [...], "values": [...]}
                categories = source_data.get(x_field, [])
                values = source_data.get(y_field, [])

                result['categories'] = categories
                result['series'] = [{'name': chart_config.get('series_name', 'Alerts'), 'values': values}]
            elif isinstance(source_data, list):
                # List of objects format: [{"category": ..., "count": ...}, ...]
                categories = []
                values = []
                for item in source_data:
                    if isinstance(item, dict):
                        cat_value = item.get(x_field)
                        val_value = item.get(y_field)
                        if cat_value is not None:
                            categories.append(cat_value)
                            values.append(val_value if val_value is not None else 0)

                if categories:
                    result['categories'] = categories
                    result['series'] = [{'name': chart_config.get('series_name', 'Alerts'), 'values': values}]
                else:
                    logger.warning(f"Bar chart data source {data_source} list has no valid items with fields {x_field}/{y_field}")
                    return {}
            else:
                logger.warning(f"Bar chart data source {data_source} is neither dict nor list")
                return {}

        elif chart_type in (
            'P11_pie', 'P13_pie', 'P14_pie', 'P15_pie_1', 'P15_pie_2',
            'P27_pie', 'P28_pie_1', 'P28_pie_2', 'P29_pie',
        ):
            # Expect source_data to be a dict like {'high': 52, 'medium': 473, 'low': 816}
            # or a dict with 'categories' and 'values' arrays for P11_pie/P13_pie/P14_pie
            if isinstance(source_data, dict):
                # Check if it's the P11_pie/P13_pie/P14_pie format with categories and values arrays
                if 'categories' in source_data and 'values' in source_data:
                    result['categories'] = source_data['categories']
                    result['values'] = source_data['values']
                else:
                    # Convert dict to categories and values
                    categories = []
                    values = []

                    # Map severity levels to Chinese names
                    severity_map = chart_config.get('category_map', {
                        'critical': 'Critical',
                        'high': 'High',
                        'medium': 'Medium',
                        'low': 'Low',
                        'info': 'Info'
                    })

                    for key, value in source_data.items():
                        # Use mapped name if available, otherwise use key
                        category_name = severity_map.get(key, key)
                        categories.append(category_name)
                        values.append(value)

                    result['categories'] = categories
                    result['values'] = values
            else:
                logger.warning(f"Pie chart data source {data_source} is not a dict")
                return {}

        elif chart_type in ('P15_line', 'P28_line'):
            # Expect source_data to be a dict with 'months', 'external_attacks', 'malicious_outbound'
            if isinstance(source_data, dict):
                months = source_data.get('months', [])
                external_attacks = source_data.get('external_attacks', [])
                malicious_outbound = source_data.get('malicious_outbound', [])

                # Convert to 10k unit (divide by 10000), keeping original precision behavior.
                def to_wan(value):
                    """Convert numeric value to 10k unit (divide by 10000)."""
                    if isinstance(value, (int, float)):
                        return value / 10000
                    return value

                result['months'] = months
                result['external_attacks'] = [to_wan(v) for v in external_attacks]
                result['malicious_outbound'] = [to_wan(v) for v in malicious_outbound]
            else:
                logger.warning(f"Line chart data source {data_source} is not a dict")
                return {}

        elif chart_type in ('P11_line', 'P26_line', 'P27_line', 'P29_line'):
            # Expect source_data to be a dict with 'months' (or 'categories') and multiple series
            # Example: {"months": ["Jan", "Feb", ...], "critical": [5, 3, ...], "high": [12, 15, ...], "medium": [45, 38, ...]}
            if isinstance(source_data, dict):
                # Get the category field (months or categories)
                months = source_data.get('months', source_data.get('categories', []))

                if isinstance(source_data.get('series'), list):
                    series_data = source_data.get('series', [])
                else:
                    # Extract all numeric series (skip metadata keys)
                    series_data = []
                    for key, values in source_data.items():
                        if key not in ['months', 'categories', 'series'] and isinstance(values, list):
                            series_data.append({
                                'name': key,
                                'values': values
                            })

                if months and series_data:
                    result['months'] = months
                    result['series'] = series_data
                else:
                    logger.warning(f"P11_line data source {data_source} missing valid months or series data")
                    return {}
            else:
                logger.warning(f"P11_line data source {data_source} is not a dict")
                return {}

        elif chart_type in ('P16_combo', 'P30_combo'):
            # Expect source_data to be a dict with 'categories', 'attack_counts', 'defense_rates'
            # attack_counts: daily attack numbers like [123, 145, ...]
            # defense_rates: percentages like [1.0, 0.98, ...] (1.0 = 100%)
            if isinstance(source_data, dict):
                categories = source_data.get('categories', [])
                attack_counts = source_data.get('attack_counts', [])
                defense_rates = source_data.get('defense_rates', [])

                normalized_attacks = []
                for count in attack_counts:
                    number = self._coerce_number(count)
                    if number is None:
                        normalized_attacks.append(0)
                    elif number.is_integer():
                        normalized_attacks.append(int(number))
                    else:
                        normalized_attacks.append(number)

                # Ensure defense_rates are in decimal format (0.0-1.0)
                # If they come as percentages (0-100), convert them
                normalized_rates = []
                for rate in defense_rates:
                    number = self._coerce_number(rate)
                    if number is not None:
                        # If rate > 1, assume it's percentage (e.g., 100 = 100%)
                        if number > 1:
                            normalized_rates.append(number / 100.0)
                        else:
                            normalized_rates.append(number)
                    else:
                        normalized_rates.append(0)

                result['categories'] = categories
                result['attack_counts'] = normalized_attacks
                result['defense_rates'] = normalized_rates
            else:
                logger.warning(f"Combo chart data source {data_source} is not a dict")
                return {}

        return result

    def _extract_table_data(
        self,
        tenant_input: TenantInput,
        table_config: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Extract and format table data from tenant input.

        Args:
            tenant_input: Raw tenant input
            table_config: Table configuration from placeholder definition

        Returns:
            Formatted table data ready for rendering
        """
        data_source = table_config.get('data_source')
        columns_config = table_config.get('columns', [])

        if not data_source or not columns_config:
            logger.warning(f"Table config missing data_source or columns")
            return {}

        # Get data from tenant input
        source_data = self._get_nested(tenant_input, data_source)
        if not source_data or not isinstance(source_data, list):
            logger.warning(f"No list data found at {data_source}")
            return {}

        # Extract headers
        headers = [col.get('header', '') for col in columns_config]

        # Extract rows
        rows = []
        max_rows = table_config.get('max_rows', 10)
        for item in source_data[:max_rows]:
            if isinstance(item, dict):
                row = []
                for col in columns_config:
                    field_name = col.get('field', '')
                    value = item.get(field_name, '')

                    # Format value based on column config
                    if col.get('format') == 'percent' and isinstance(value, (int, float)):
                        value = f"{int(value * 100)}%"

                    row.append(value)
                rows.append(row)

        return {
            'headers': headers,
            'rows': rows,
            'position': table_config.get('position')
        }

    def _extract_data_placeholders(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
    ) -> Dict[str, Dict[str, Any]]:
        """Extract all non-AI placeholders from input data.

        Returns:
            Dict[slide_key, Dict[token, value]]
        """
        result: Dict[str, Dict[str, Any]] = {}

        # Calculate derived values
        incidents = tenant_input.get("incidents", []) or []
        incidents_high_count = len([i for i in incidents if i.get("severity") == "high"])
        incidents_count = len(incidents)

        # Add computed values to a lookup dict
        computed = {
            "incidents.length": incidents_count,
            "incidents.high_count": incidents_high_count,
            "incidents_count": incidents_count,
            "incidents_high_count": incidents_high_count,
        }

        for slide_key, token, placeholder in template.get_data_placeholders():
            if slide_key not in result:
                result[slide_key] = {}

            # Handle chart placeholders
            if placeholder.type in (
                'P11_bar', 'P11_line', 'P11_pie', 'P13_pie', 'P14_pie',
                'P15_pie_1', 'P15_pie_2', 'P15_line', 'P15_bar', 'P16_combo',
                'P26_line', 'P27_bar', 'P27_line', 'P27_pie', 'P28_pie_1',
                'P28_pie_2', 'P28_line', 'P28_bar', 'P29_pie', 'P29_line',
                'P30_combo',
            ) and placeholder.chart_config:
                chart_data = self._extract_chart_data(
                    tenant_input,
                    placeholder.chart_config,
                    placeholder.type
                )
                result[slide_key][token] = chart_data

            # Handle native table placeholders
            elif placeholder.type == 'native_table' and placeholder.table_config:
                table_data = self._extract_table_data(
                    tenant_input,
                    placeholder.table_config
                )
                result[slide_key][token] = table_data

            # Handle grouped label/percent slots (e.g. 安全告警定性分布 on P37).
            # A placeholder with `group_index` reads one row from the group source
            # (a dict with parallel arrays, defaulting to 'categories' + 'values')
            # and renders it as "{label}    {percent}%" (or "{label} {count} {percent}%"
            # when group_fields is ["categories", "counts", "percents"]). Empty/missing
            # slots produce an empty string so the renderer can prune the box.
            elif placeholder.group_index is not None:
                source_data = self._get_nested(tenant_input, placeholder.source) if placeholder.source else None
                if isinstance(source_data, dict):
                    group_fields = placeholder.group_fields or ["categories", "values"]
                    arrays = {f: (source_data.get(f) or []) for f in group_fields}
                    idx = placeholder.group_index
                    present = [arr[idx] if idx < len(arr) else None for arr in arrays.values()]
                    if all(v is None for v in present):
                        result[slide_key][token] = ""
                    else:
                        label = present[0]
                        parts = []
                        for field, raw_value in zip(group_fields, present):
                            if raw_value is None:
                                continue
                            if field == "percents" or field == "values":
                                number = self._coerce_number(raw_value)
                                if number is not None:
                                    parts.append(f"{round(number * 100)}%")
                                    continue
                            parts.append(str(raw_value))
                        result[slide_key][token] = "    ".join(parts).strip()
                else:
                    result[slide_key][token] = ""

            # Handle regular text placeholders
            elif placeholder.default and not placeholder.source:
                result[slide_key][token] = placeholder.default
            elif placeholder.source:
                # Check computed values first
                if placeholder.source in computed:
                    value = computed[placeholder.source]
                else:
                    value = self._get_nested(tenant_input, placeholder.source)
                result[slide_key][token] = self._format_value(value, placeholder)
            else:
                result[slide_key][token] = ""

        return result

    @staticmethod
    def _resolve_slide_context_policy(slide: Any) -> str:
        """Resolve context policy for a slide definition."""
        policy = (getattr(slide, "context_policy", None) or "auto").strip().lower()
        if policy in {"local_only", "full_data", "auto"}:
            return policy
        return "auto"

    @staticmethod
    def _extract_instruction_roots(ai_instruction: Optional[str], available_roots: Set[str]) -> Set[str]:
        """Extract potential top-level data roots from ai_instruction text."""
        if not ai_instruction:
            return set()

        roots: Set[str] = set()
        for token in re.findall(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\[\d+\])?", ai_instruction):
            root = token.split(".")[0]
            if root in available_roots:
                roots.add(root)
        return roots

    def _collect_slide_context_roots(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        slide_key: str,
    ) -> Set[str]:
        """Collect top-level data roots relevant to one slide."""
        available_roots = set(tenant_input.raw.keys())
        roots: Set[str] = set()

        slide = next((item for item in template.slides if item.slide_key == slide_key), None)
        if not slide:
            return roots

        for placeholder in slide.placeholders:
            if placeholder.source:
                roots.add(placeholder.source.split(".")[0])
            roots.update(
                self._extract_instruction_roots(
                    getattr(placeholder, "ai_instruction", None),
                    available_roots,
                )
            )

        if slide.slide_key in available_roots:
            roots.add(slide.slide_key)

        return {root for root in roots if root in available_roots}

    def _batch_requires_full_data(
        self,
        template: TemplateDescriptorV2,
        slide_keys: List[str],
    ) -> bool:
        """Whether any slide in this batch requires full-data context."""
        key_set = set(slide_keys)
        for slide in template.slides:
            if slide.slide_key not in key_set:
                continue
            if self._resolve_slide_context_policy(slide) == "full_data":
                return True
        return False

    def _build_context_payload_for_slides(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        slide_keys: List[str],
    ) -> Dict[str, Any]:
        """Build context payload according to slide context policies."""
        if self._batch_requires_full_data(template, slide_keys):
            return tenant_input.raw

        roots: Set[str] = set()
        for slide_key in slide_keys:
            roots.update(self._collect_slide_context_roots(tenant_input, template, slide_key))

        if not roots:
            return {}

        ordered_roots = [key for key in tenant_input.raw.keys() if key in roots]
        return {key: tenant_input.raw[key] for key in ordered_roots}

    def _build_system_prompt(self, template: TemplateDescriptorV2) -> str:
        """Build the system prompt for AI generation."""
        audience_desc = "管理层受众" if template.audience == "management" else "技术受众"

        return f"""你是一名专业的 MSS 安全报告写作助手。

## 写作目标
- 为 PPT 页面产出基于证据、富有洞察的内容。
- 确保表述风格与{audience_desc}匹配。

## 输出约束
1. 所有表述必须基于输入数据，保持事实准确。
2. 禁止输出无依据的判断或结论。
3. 在合适场景下优先给出可执行、可落地的建议。
4. 语言清晰、专业，满足业务汇报语境。
5. 如无必要不要体现“本季”“本年”等时间范围，确有必要则必须严格以当前服务期为准，如“period_start 至 period_end 内”或等价的显式日期表达。
6. 仅返回合法 JSON（不要使用 markdown 包裹）。
"""
    def _build_user_prompt(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        focus_options: Optional[List[str]] = None,
        rag_context: Optional[str] = None,
        rag_context_by_slide: Optional[Dict[str, str]] = None,
    ) -> str:
        """Build the user prompt with data and AI instructions."""
        slide_keys = [
            slide.slide_key for slide in template.slides
            if any(placeholder.ai_generate for placeholder in slide.placeholders)
        ]
        return self._build_user_prompt_for_slides(
            tenant_input=tenant_input,
            template=template,
            slide_keys=slide_keys,
            batch_index=0,
            total_batches=1,
            focus_options=focus_options,
            rag_context=rag_context,
            rag_context_by_slide=rag_context_by_slide,
        )

    def _build_user_prompt_for_slides(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        slide_keys: List[str],
        batch_index: int = 0,
        total_batches: int = 1,
        focus_options: Optional[List[str]] = None,
        rag_context: Optional[str] = None,
        rag_context_by_slide: Optional[Dict[str, str]] = None,
    ) -> str:
        """Build user prompt for a subset of slides (for batched generation)."""
        selected_annotations = self._resolve_selected_annotations(focus_options)
        preference_titles_text = self._build_preference_titles_text(selected_annotations)
        context_payload = self._build_context_payload_for_slides(tenant_input, template, slide_keys)
        period_text = self._extract_report_period_text(context_payload)

        prompt_parts: List[str] = [
            "## 任务",
            "请为指定页面和占位符生成 AI 内容。",
            "输出必须是合法 JSON，且只能输出 JSON。",
            "",
            "## 写作硬约束",
            "1) 严禁空话和套话（如“持续提升”“稳步推进”）单独成句。",
            "2) 每条结论至少包含“数据依据 + 判断”，优先补充“业务影响或行动建议”。",
            "3) 不得编造数据，不得输出与输入数据冲突的结论。",
            f"4) 如无必要不要体现“本季”“本年”等时间范围，确有必要则必须严格以当前服务期为准{period_text}。",
            "",
        ]

        if total_batches > 1:
            prompt_parts.extend([
                "## 批次信息",
                f"当前批次：{batch_index + 1}/{total_batches}",
                "",
            ])

        prompt_parts.extend([
            "## 输出格式",
            "```json",
            "{",
            "  \"slides\": [",
        ])

        slide_examples = []
        for slide in template.slides:
            if slide.slide_key not in slide_keys:
                continue
            ai_tokens = [ph.token for ph in slide.placeholders if ph.ai_generate]
            if ai_tokens:
                tokens_str = ", ".join(f"\"{t}\": \"...\"" for t in ai_tokens)
                slide_examples.append(f"    {{\"slide_key\": \"{slide.slide_key}\", \"placeholders\": {{{tokens_str}}}}}")

        prompt_parts.append(",\n".join(slide_examples))
        prompt_parts.extend([
            "  ]",
            "}",
            "```",
            "",
        ])

        self._append_annotation_section(prompt_parts, selected_annotations)
        if rag_context and not rag_context_by_slide:
            self._append_rag_context_section(prompt_parts, rag_context)

        ai_placeholders = template.get_ai_placeholders()
        current_slide = None

        for slide_key, token, placeholder in ai_placeholders:
            if slide_key not in slide_keys:
                continue

            if slide_key != current_slide:
                for slide in template.slides:
                    if slide.slide_key == slide_key:
                        prompt_parts.append(f"### 页面：{slide.title} ({slide_key})")
                        break
                if rag_context_by_slide:
                    self._append_slide_rag_context_section(
                        prompt_parts=prompt_parts,
                        slide_key=slide_key,
                        rag_context=rag_context_by_slide.get(slide_key),
                    )
                current_slide = slide_key

            constraints: List[str] = []
            if placeholder.max_length:
                constraints.append(f"max_length={placeholder.max_length}")
            if placeholder.max_items:
                constraints.append(f"max_items={placeholder.max_items}")
            if placeholder.max_chars_per_item:
                constraints.append(f"max_chars_per_item={placeholder.max_chars_per_item}")

            constraint_str = f" ({', '.join(constraints)})" if constraints else ""

            prompt_parts.append(f"\n**{token}**{constraint_str}")
            prompt_parts.append(self._render_ai_instruction(
                placeholder.ai_instruction,
                preference_titles_text,
            ))
            prompt_parts.append("")

        prompt_parts.extend([
            "",
            "## 输入数据",
            "```json",
            json.dumps(context_payload, ensure_ascii=False, indent=2),
            "```",
        ])

        return "\n".join(prompt_parts)

    @staticmethod
    def _extract_report_period_text(context_payload: Dict[str, Any]) -> str:
        """Extract a compact report period string from the prompt context."""
        cover = context_payload.get("cover") if isinstance(context_payload, dict) else None
        period = context_payload.get("period") if isinstance(context_payload, dict) else None

        start = ""
        end = ""

        if isinstance(cover, dict):
            start = str(cover.get("period_start") or "").strip()
            end = str(cover.get("period_end") or "").strip()

        if not start and isinstance(period, dict):
            start = str(period.get("start") or "").strip()
        if not end and isinstance(period, dict):
            end = str(period.get("end") or "").strip()

        if start and end:
            return f"{start} 至 {end}"
        if start:
            return f"{start}起"
        if end:
            return f"截至 {end}"
        return "输入数据中的 period_start 至 period_end"

    def _build_annotation_indexes(self) -> tuple[Dict[str, Dict[str, str]], Dict[str, List[Dict[str, str]]]]:
        """Build lookup indexes for annotation id and title."""
        by_id: Dict[str, Dict[str, str]] = {}
        by_title: Dict[str, List[Dict[str, str]]] = {}
        for annotation in self._ANNOTATIONS:
            by_id[annotation["id"]] = annotation
            by_title.setdefault(annotation["title"], []).append(annotation)
        return by_id, by_title

    def _resolve_selected_annotations(self, focus_options: Optional[List[str]]) -> List[Dict[str, str]]:
        """Resolve selected preferences to unique annotations by id/title."""
        if not focus_options:
            return []

        by_id, by_title = self._build_annotation_indexes()
        resolved: List[Dict[str, str]] = []
        seen_ids = set()

        for option in focus_options:
            option_text = (option or "").strip()
            if not option_text:
                continue

            annotation = by_id.get(option_text)
            if not annotation:
                matches = by_title.get(option_text, [])
                if len(matches) > 1:
                    raise ValueError(f"Ambiguous annotation title: {option_text}")
                annotation = matches[0] if matches else None

            if not annotation:
                raise ValueError(f"Unsupported focus option: {option_text}")

            annotation_id = annotation["id"]
            if annotation_id in seen_ids:
                continue
            seen_ids.add(annotation_id)
            resolved.append(annotation)

        return resolved

    @staticmethod
    def _build_preference_titles_text(selected_annotations: List[Dict[str, str]]) -> str:
        """Build a compact text for replacing {preference} placeholders."""
        if not selected_annotations:
            return ""
        return ", ".join(item["title"] for item in selected_annotations)

    @staticmethod
    def _render_ai_instruction(ai_instruction: Optional[str], preference_titles_text: str) -> str:
        """Render ai_instruction with runtime preference placeholders."""
        instruction = ai_instruction or ""
        if not preference_titles_text:
            return instruction

        rendered = instruction.replace("{preference}", preference_titles_text)
        rendered = rendered.replace("**偏好重点**", f"**{preference_titles_text}**")
        rendered = rendered.replace("偏好重点", preference_titles_text)
        rendered = rendered.replace("**用户偏好**", f"**{preference_titles_text}**")
        rendered = rendered.replace("用户偏好", preference_titles_text)
        return rendered

    def _append_annotation_section(
        self,
        prompt_parts: List[str],
        selected_annotations: List[Dict[str, str]],
    ) -> None:
        """Append selected annotation knowledge for the chosen preferences only."""
        if not selected_annotations:
            return

        prompt_parts.extend([
            "",
            "## 偏好重点指引",
            "请根据用户已选偏好控制内容重点与表达风格。",
        ])
        for annotation in selected_annotations:
            prompt_parts.append(f"- {annotation['title']}: {annotation['content']}")

    @staticmethod
    def _append_rag_context_section(
        prompt_parts: List[str],
        rag_context: Optional[str],
    ) -> None:
        """Append retrieved knowledge context as auxiliary evidence."""
        if not rag_context:
            return

        prompt_parts.extend([
            "",
            "## 检索证据（辅助上下文）",
            "仅作为补充证据使用；若与结构化输入冲突，必须以结构化输入为准。",
            "```text",
            rag_context,
            "```",
            "",
        ])

    @staticmethod
    def _append_slide_rag_context_section(
        prompt_parts: List[str],
        slide_key: str,
        rag_context: Optional[str],
    ) -> None:
        if not rag_context:
            return
        prompt_parts.extend([
            "检索证据（仅当前页面）:",
            f"```text\n[slide={slide_key}]\n{rag_context}\n```",
            "",
        ])

    def _build_rewrite_base_prompt(
        self,
        context_payload: Optional[Dict[str, Any]] = None,
        use_full_data: bool = False,
        rag_context: Optional[str] = None,
    ) -> str:
        """Build optional auxiliary context block for single-slide rewrite."""
        prompt_parts: List[str] = []
        if context_payload:
            section_title = "## 全量安全数据（仅上下文）" if use_full_data else "## 当前页面相关数据（仅上下文）"
            prompt_parts.extend([
                section_title,
                "如与当前页面结构化数据冲突，必须以当前页面结构化数据为准。",
                "```json",
                json.dumps(context_payload, ensure_ascii=False, indent=2),
                "```",
            ])
        if rag_context:
            prompt_parts.extend([
                "",
                "## 检索证据（辅助上下文）",
                "若检索证据与当前页面结构化数据冲突，必须优先结构化数据。",
                "```text",
                rag_context,
                "```",
            ])
        return "\n".join(prompt_parts)

    def _build_rewrite_prompt_with_user_preference(
        self,
        base_prompt: str,
        slide_key: str,
        ai_tokens: List[str],
        user_prompt: str,
        structured_slide_data: Optional[Dict[str, Any]] = None,
        historical_ai_content: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Append user preference instructions for single-slide AI rewrite."""
        ai_tokens_text = ", ".join(ai_tokens)
        output_tokens_preview = ", ".join(f'"{token}": "..."' for token in ai_tokens)

        task_section = "\n".join([
            "## 改写任务",
            f"仅改写该页面：{slide_key}",
            f"本次目标占位符：{ai_tokens_text}",
            "",
            "## 用户偏好（高优先级）",
            "在不编造数据的前提下，尽量遵循用户偏好：",
            user_prompt.strip(),
            "",
            "## 数据优先级",
            "1) 当前页面结构化数据（最高优先级）",
            "2) 上下文数据（仅辅助理解）",
            "3) 历史 AI 文案（仅风格参考）",
        ])

        structured_data_section = ""
        if structured_slide_data:
            structured_data_section = "\n".join([
                "",
                "## 当前页面结构化数据（最高优先级）",
                "改写后的数字必须与本节数据保持一致。",
                "```json",
                json.dumps(structured_slide_data, ensure_ascii=False, indent=2),
                "```",
            ])

        full_context_section = f"\n{base_prompt}" if base_prompt else ""

        historical_content_section = ""
        if historical_ai_content:
            historical_content_section = "\n".join([
                "",
                "## 历史 AI 文案（仅风格参考）",
                "若历史文案与数据冲突，必须忽略历史文案并遵循数据优先级。",
                "```json",
                json.dumps(historical_ai_content, ensure_ascii=False, indent=2),
                "```",
            ])

        hard_constraints_and_output = "\n".join([
            "## 硬约束",
            "1) 所有数字必须优先匹配当前页面结构化数据。",
            "2) 禁止空话套话（如“持续提升”“稳步推进”）单独成句。",
            "3) 每条结论至少包含“数据依据 + 判断”。",
            "4) 若历史文案与数据冲突，必须忽略历史文案。",
            f"5) 只输出以下目标占位符：{ai_tokens_text}。",
            "6) 输出必须为中文，并严格使用指定 JSON 格式。",
            "",
            "## 输出格式",
            "```json",
            "{",
            '  "slides": [',
            f'    {{"slide_key": "{slide_key}", "placeholders": {{{output_tokens_preview}}}}}',
            "  ]",
            "}",
            "```",
        ])
        return (
            f"{task_section}"
            f"{structured_data_section}"
            f"{full_context_section}"
            f"{historical_content_section}\n"
            f"{hard_constraints_and_output}"
        )

    def rewrite_single_slide_v2(
        self,
        tenant_input: TenantInput,
        template_id: str,
        slide_key: str,
        user_prompt: str,
        current_slide_content: Optional[Dict[str, Any]] = None,
        target_tokens: Optional[List[str]] = None,
        rag_context: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Rewrite AI-generated placeholders for one slide with user preference."""
        template = self.template_repo.get_descriptor_v2(template_id)

        target_slide = next((s for s in template.slides if s.slide_key == slide_key), None)
        if not target_slide:
            raise ValueError(f"Slide '{slide_key}' not found in template '{template_id}'")

        all_ai_tokens = [ph.token for ph in target_slide.placeholders if ph.ai_generate]
        if not all_ai_tokens:
            raise ValueError(f"Slide '{slide_key}' has no AI-generated placeholders to rewrite")

        ai_tokens = all_ai_tokens
        if target_tokens is not None and len(target_tokens) > 0:
            invalid_tokens = [token for token in target_tokens if token not in all_ai_tokens]
            if invalid_tokens:
                raise ValueError(
                    f"Invalid target_tokens for slide '{slide_key}': {', '.join(invalid_tokens)}"
                )
            ai_tokens = target_tokens

        system_prompt = self._build_system_prompt(template)
        use_full_data = self._batch_requires_full_data(template, [slide_key])
        base_user_prompt = self._build_rewrite_base_prompt(
            context_payload=None,
            use_full_data=use_full_data,
            rag_context=rag_context,
        )
        historical_ai_content: Dict[str, Any] = {}
        if isinstance(current_slide_content, dict):
            for token in ai_tokens:
                if token in current_slide_content:
                    historical_ai_content[token] = current_slide_content[token]

        all_ai_token_set = set(all_ai_tokens)
        structured_slide_data: Dict[str, Any] = {}
        for placeholder in target_slide.placeholders:
            token = placeholder.token
            if token in all_ai_token_set:
                continue

            value = None
            if placeholder.source:
                value = self._get_nested(tenant_input, placeholder.source)

            # Fallback to current slide payload when source is absent or unresolved.
            if value is None and isinstance(current_slide_content, dict):
                value = current_slide_content.get(token)

            if value is not None:
                structured_slide_data[token] = value

        rewrite_user_prompt = self._build_rewrite_prompt_with_user_preference(
            base_prompt=base_user_prompt,
            slide_key=slide_key,
            ai_tokens=ai_tokens,
            user_prompt=user_prompt,
            structured_slide_data=structured_slide_data or None,
            historical_ai_content=historical_ai_content or None,
        )

        parsed = self._call_and_parse_with_retry_compat(
            system_prompt,
            rewrite_user_prompt,
            template,
            prompt_dump={
                "session_id": session_id,
                "scene": "rewrite",
                "template_id": template_id,
                "slide_key": slide_key,
            },
        )

        slide_placeholders = parsed.get(slide_key)
        if not isinstance(slide_placeholders, dict):
            raise LLMGenerationError(
                f"LLM response missing placeholders for slide '{slide_key}'"
            )

        ai_token_set = set(ai_tokens)
        if self._DUTY_SUMMARY_TOKEN in ai_token_set:
            ai_token_set.update(self._DUTY_SUMMARY_FESTIVAL_TOKENS)
        filtered_placeholders = {
            token: value for token, value in slide_placeholders.items() if token in ai_token_set
        }
        missing_tokens = [
            token
            for token in ai_tokens
            if token not in filtered_placeholders and token != self._DUTY_SUMMARY_TOKEN
        ]
        if (
            self._DUTY_SUMMARY_TOKEN in ai_tokens
            and not any(token in filtered_placeholders for token in self._DUTY_SUMMARY_FESTIVAL_TOKENS)
        ):
            missing_tokens.append(self._DUTY_SUMMARY_TOKEN)

        warnings: List[str] = []
        if missing_tokens:
            warnings.append(
                f"LLM response did not include some AI placeholders: {', '.join(missing_tokens)}"
            )

        return {
            "slide_key": slide_key,
            "placeholders": filtered_placeholders,
            "warnings": warnings,
            "missing_tokens": missing_tokens,
            "updated_tokens": list(filtered_placeholders.keys()),
        }

    def _estimate_prompt_tokens(self, text: str) -> int:
        """Estimate token count for a text string.

        For Chinese text, roughly 1.5-2 characters per token.
        For English/code, roughly 4 characters per token.
        We use a conservative estimate of 2 characters per token for mixed content.
        """
        return len(text) // 2

    @staticmethod
    def _truncate_text_for_budget(text: str, max_chars: int) -> str:
        if max_chars <= 0:
            return ""
        if len(text) <= max_chars:
            return text
        # Try to keep complete evidence blocks when possible.
        trimmed = text[:max_chars].rstrip()
        last_break = trimmed.rfind("\n[")
        if last_break > max_chars // 3:
            return trimmed[:last_break].rstrip()
        return trimmed

    def _build_rag_context_by_slide_for_batch(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        slide_keys: List[str],
        max_tokens_per_batch: int,
        focus_options: Optional[List[str]],
        rag_context_by_slide: Optional[Dict[str, str]],
    ) -> Dict[str, str]:
        if not rag_context_by_slide:
            return {}

        batch_context = {
            key: (rag_context_by_slide.get(key) or "").strip()
            for key in slide_keys
            if (rag_context_by_slide.get(key) or "").strip()
        }
        if not batch_context:
            return {}

        base_prompt = self._build_user_prompt_for_slides(
            tenant_input=tenant_input,
            template=template,
            slide_keys=slide_keys,
            batch_index=0,
            total_batches=1,
            focus_options=focus_options,
            rag_context=None,
            rag_context_by_slide=None,
        )
        base_tokens = self._estimate_prompt_tokens(base_prompt)
        batch_cap = max(1000, int(max_tokens_per_batch))
        headroom_tokens = max(0, batch_cap - base_tokens)

        ratio = float(config.settings.rag_prompt_budget_ratio)
        ratio = min(0.8, max(0.05, ratio))
        target_tokens = int(batch_cap * ratio)
        min_tokens = max(100, int(config.settings.rag_prompt_budget_min_tokens))
        max_tokens = max(min_tokens, int(config.settings.rag_prompt_budget_max_tokens))
        rag_budget_tokens = min(max(min_tokens, target_tokens), max_tokens, headroom_tokens)
        if rag_budget_tokens <= 0:
            logger.info(
                "Batch %s has no RAG headroom: base_tokens=%s, cap=%s",
                slide_keys,
                base_tokens,
                batch_cap,
            )
            return {}

        rag_budget_chars = max(200, rag_budget_tokens * 2)
        remaining_chars = rag_budget_chars
        remaining_slides = len(batch_context)
        allocated: Dict[str, str] = {}

        for slide_key in slide_keys:
            context = batch_context.get(slide_key)
            if not context:
                continue
            remaining_slides = max(1, remaining_slides)
            cap = max(120, remaining_chars // remaining_slides)
            chunk = self._truncate_text_for_budget(context, cap)
            if chunk:
                allocated[slide_key] = chunk
                remaining_chars = max(0, remaining_chars - len(chunk))
            remaining_slides -= 1
            if remaining_chars <= 0:
                break

        logger.info(
            "Batch rag budget: slides=%s base_tokens=%s cap=%s rag_tokens=%s rag_chars=%s",
            slide_keys,
            base_tokens,
            batch_cap,
            rag_budget_tokens,
            sum(len(item) for item in allocated.values()),
        )
        return allocated

    def _call_and_parse_with_retry_compat(
        self,
        system_prompt: str,
        user_prompt: str,
        template: TemplateDescriptorV2,
        prompt_dump: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Compatibility wrapper for tests that monkeypatch old call signature."""
        try:
            return self._call_and_parse_with_retry(
                system_prompt,
                user_prompt,
                template,
                prompt_dump=prompt_dump,
            )
        except TypeError as e:
            if "prompt_dump" not in str(e):
                raise
            return self._call_and_parse_with_retry(
                system_prompt,
                user_prompt,
                template,
            )

    def _estimate_batch_prompt_tokens(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        slide_keys: List[str],
        focus_options: Optional[List[str]] = None,
    ) -> int:
        """Estimate prompt tokens for a batch using the real prompt builder."""
        prompt = self._build_user_prompt_for_slides(
            tenant_input=tenant_input,
            template=template,
            slide_keys=slide_keys,
            batch_index=0,
            total_batches=1,
            focus_options=focus_options,
        )
        return self._estimate_prompt_tokens(prompt)

    @staticmethod
    def _stats_variance_fraction(stats: Tuple[int, int, int, int]) -> Tuple[int, int]:
        """Variance fraction numerator/denominator from (max, sum, sumsq, k)."""
        _, total, total_sq, count = stats
        if count <= 0:
            return 0, 1
        numerator = total_sq * count - total * total
        denominator = count * count
        return numerator, denominator

    @classmethod
    def _is_better_stats(
        cls,
        candidate: Tuple[int, int, int, int],
        baseline: Tuple[int, int, int, int],
    ) -> bool:
        """Compare batch stats by objective: max -> variance -> batch count."""
        if candidate[0] != baseline[0]:
            return candidate[0] < baseline[0]

        c_num, c_den = cls._stats_variance_fraction(candidate)
        b_num, b_den = cls._stats_variance_fraction(baseline)
        left = c_num * b_den
        right = b_num * c_den
        if left != right:
            return left < right

        return candidate[3] < baseline[3]

    @staticmethod
    def _sort_batch_by_slide_no(batch: List[str], slide_no_map: Dict[str, int]) -> List[str]:
        return sorted(batch, key=lambda key: (slide_no_map.get(key, 10**9), key))

    @staticmethod
    def _batch_sort_key(batch: List[str], slide_no_map: Dict[str, int]) -> Tuple[int, str]:
        if not batch:
            return 10**9, ""
        first = min(batch, key=lambda key: (slide_no_map.get(key, 10**9), key))
        return slide_no_map.get(first, 10**9), first

    def _optimize_local_batches_exact(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        local_slide_keys: List[str],
        slide_no_map: Dict[str, int],
        hard_cap: int,
        focus_options: Optional[List[str]] = None,
        max_batches: Optional[int] = None,
    ) -> List[List[str]]:
        """Exact partition search for local_only slides (n <= 14)."""
        n = len(local_slide_keys)
        if n == 0:
            return []

        token_cache: Dict[int, int] = {}

        def mask_to_keys(mask: int) -> List[str]:
            keys = [local_slide_keys[idx] for idx in range(n) if mask & (1 << idx)]
            return self._sort_batch_by_slide_no(keys, slide_no_map)

        def batch_tokens(mask: int) -> int:
            if mask not in token_cache:
                token_cache[mask] = self._estimate_batch_prompt_tokens(
                    tenant_input=tenant_input,
                    template=template,
                    slide_keys=mask_to_keys(mask),
                    focus_options=focus_options,
                )
            return token_cache[mask]

        @lru_cache(maxsize=None)
        def solve(mask: int, budget_batches: int) -> Optional[Tuple[int, int, int, int, Tuple[int, ...]]]:
            if mask == 0:
                return 0, 0, 0, 0, tuple()
            if budget_batches <= 0:
                return None

            first = mask & -mask
            best: Optional[Tuple[int, int, int, int, Tuple[int, ...]]] = None
            sub = mask

            while sub:
                if sub & first:
                    tokens = batch_tokens(sub)
                    if tokens <= hard_cap:
                        remain = mask ^ sub
                        remain_result = solve(remain, budget_batches - 1)
                        if remain_result is not None:
                            rem_max, rem_sum, rem_sum_sq, rem_count, rem_parts = remain_result
                            candidate_count = rem_count + 1
                            candidate = (
                                max(tokens, rem_max),
                                rem_sum + tokens,
                                rem_sum_sq + tokens * tokens,
                                candidate_count,
                                rem_parts + (sub,),
                            )
                            if best is None:
                                best = candidate
                            else:
                                if self._is_better_stats(candidate[:4], best[:4]):
                                    best = candidate
                                elif candidate[:4] == best[:4] and candidate[4] < best[4]:
                                    best = candidate
                sub = (sub - 1) & mask

            return best

        full_mask = (1 << n) - 1
        budget = max_batches if max_batches is not None else n
        result = solve(full_mask, budget)
        if result is None:
            logger.warning("Exact local batch partition could not satisfy hard cap=%s, fallback to single-slide batches", hard_cap)
            return [[key] for key in local_slide_keys]

        _, _, _, _, masks = result
        batches = [mask_to_keys(mask) for mask in masks]
        return sorted(batches, key=lambda batch: self._batch_sort_key(batch, slide_no_map))

    def _optimize_local_batches_heuristic(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        local_slide_keys: List[str],
        slide_no_map: Dict[str, int],
        hard_cap: int,
        focus_options: Optional[List[str]] = None,
        max_batches: Optional[int] = None,
    ) -> List[List[str]]:
        """Heuristic optimizer for larger local_only sets (best-fit merge + local move)."""
        if not local_slide_keys:
            return []

        token_cache: Dict[FrozenSet[str], int] = {}

        def normalize(batch: List[str]) -> List[str]:
            return self._sort_batch_by_slide_no(sorted(set(batch)), slide_no_map)

        def batch_token(batch: List[str]) -> int:
            key = frozenset(batch)
            if key not in token_cache:
                token_cache[key] = self._estimate_batch_prompt_tokens(
                    tenant_input=tenant_input,
                    template=template,
                    slide_keys=normalize(batch),
                    focus_options=focus_options,
                )
            return token_cache[key]

        def calc_stats(batches: List[List[str]]) -> Tuple[int, int, int, int]:
            if not batches:
                return 0, 0, 0, 0
            tokens = [batch_token(batch) for batch in batches]
            return max(tokens), sum(tokens), sum(item * item for item in tokens), len(tokens)

        def sort_batches(batches: List[List[str]]) -> List[List[str]]:
            normalized = [normalize(batch) for batch in batches if batch]
            return sorted(normalized, key=lambda batch: self._batch_sort_key(batch, slide_no_map))

        batches = sort_batches([[slide_key] for slide_key in local_slide_keys])

        # Stage 1: best-fit merge if objective improves and cap satisfied
        while True:
            base_stats = calc_stats(batches)
            best_candidate: Optional[List[List[str]]] = None
            best_stats: Optional[Tuple[int, int, int, int]] = None

            for i in range(len(batches)):
                for j in range(i + 1, len(batches)):
                    merged = normalize(batches[i] + batches[j])
                    if batch_token(merged) > hard_cap:
                        continue
                    candidate = [batch for idx, batch in enumerate(batches) if idx not in {i, j}]
                    candidate.append(merged)
                    candidate = sort_batches(candidate)
                    candidate_stats = calc_stats(candidate)
                    if not self._is_better_stats(candidate_stats, base_stats):
                        continue
                    if best_stats is None or self._is_better_stats(candidate_stats, best_stats):
                        best_candidate = candidate
                        best_stats = candidate_stats

            if best_candidate is None:
                break
            batches = best_candidate

        # Stage 2: local move refinement
        improved = True
        while improved:
            improved = False
            base_stats = calc_stats(batches)

            for i, source_batch in enumerate(batches):
                if len(source_batch) <= 1:
                    continue
                for slide_key in list(source_batch):
                    for j, target_batch in enumerate(batches):
                        if i == j:
                            continue
                        moved_target = normalize(target_batch + [slide_key])
                        if batch_token(moved_target) > hard_cap:
                            continue

                        moved_source = [item for item in source_batch if item != slide_key]
                        candidate = []
                        for idx, batch in enumerate(batches):
                            if idx == i:
                                if moved_source:
                                    candidate.append(moved_source)
                            elif idx == j:
                                candidate.append(moved_target)
                            else:
                                candidate.append(batch)

                        candidate = sort_batches(candidate)
                        candidate_stats = calc_stats(candidate)
                        if self._is_better_stats(candidate_stats, base_stats):
                            batches = candidate
                            improved = True
                            break
                    if improved:
                        break
                if improved:
                    break

        return sort_batches(batches)

        # Unreachable; keep for clarity.

    def _force_merge_to_max_batches(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        batches: List[List[str]],
        slide_no_map: Dict[str, int],
        hard_cap: int,
        focus_options: Optional[List[str]] = None,
        max_batches: Optional[int] = None,
    ) -> List[List[str]]:
        """Best-effort merge to reduce batch count under hard cap."""
        if max_batches is None or max_batches <= 0:
            return batches
        if len(batches) <= max_batches:
            return batches

        token_cache: Dict[FrozenSet[str], int] = {}

        def normalize(batch: List[str]) -> List[str]:
            return self._sort_batch_by_slide_no(sorted(set(batch)), slide_no_map)

        def batch_token(batch: List[str]) -> int:
            key = frozenset(batch)
            if key not in token_cache:
                token_cache[key] = self._estimate_batch_prompt_tokens(
                    tenant_input=tenant_input,
                    template=template,
                    slide_keys=normalize(batch),
                    focus_options=focus_options,
                )
            return token_cache[key]

        def calc_stats(items: List[List[str]]) -> Tuple[int, int, int, int]:
            if not items:
                return 0, 0, 0, 0
            vals = [batch_token(item) for item in items]
            return max(vals), sum(vals), sum(v * v for v in vals), len(vals)

        working = [normalize(batch) for batch in batches]
        working = sorted(working, key=lambda batch: self._batch_sort_key(batch, slide_no_map))

        while len(working) > max_batches:
            best_candidate: Optional[List[List[str]]] = None
            best_stats: Optional[Tuple[int, int, int, int]] = None

            for i in range(len(working)):
                for j in range(i + 1, len(working)):
                    merged = normalize(working[i] + working[j])
                    if batch_token(merged) > hard_cap:
                        continue
                    candidate = [batch for idx, batch in enumerate(working) if idx not in {i, j}]
                    candidate.append(merged)
                    candidate = sorted(candidate, key=lambda batch: self._batch_sort_key(batch, slide_no_map))
                    candidate_stats = calc_stats(candidate)
                    if best_stats is None or self._is_better_stats(candidate_stats, best_stats):
                        best_candidate = candidate
                        best_stats = candidate_stats

            if best_candidate is None:
                break
            working = best_candidate

        return working

    def _get_smart_slide_batches(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        max_tokens_per_batch: int = 15000,
        focus_options: Optional[List[str]] = None,
        preferred_max_local_batches: Optional[int] = 2,
        disable_local_only_split: bool = False,
    ) -> List[List[str]]:
        """Smart batching with context policy and stability-first optimization."""
        ai_slides = [
            slide for slide in template.slides
            if any(placeholder.ai_generate for placeholder in slide.placeholders)
        ]
        if not ai_slides:
            return []

        hard_cap = max(1000, int(max_tokens_per_batch * 0.70))
        slide_no_map = {slide.slide_key: slide.slide_no for slide in template.slides}

        local_slide_keys: List[str] = []
        full_data_slide_keys: List[str] = []
        for slide in ai_slides:
            policy = self._resolve_slide_context_policy(slide)
            if policy == "full_data":
                full_data_slide_keys.append(slide.slide_key)
            else:
                local_slide_keys.append(slide.slide_key)

        local_slide_keys = self._sort_batch_by_slide_no(local_slide_keys, slide_no_map)
        full_data_slide_keys = self._sort_batch_by_slide_no(full_data_slide_keys, slide_no_map)

        if disable_local_only_split:
            # Keep legacy optimized path available, but allow forcing all local_only slides
            # into a single batch (e.g. slides 11-17) for comparative runs.
            local_batches = [local_slide_keys] if local_slide_keys else []
            logger.info(
                "Local-only split disabled: forcing single local batch slides=%s",
                local_slide_keys,
            )
        else:
            if len(local_slide_keys) <= 14:
                local_batches = self._optimize_local_batches_exact(
                    tenant_input=tenant_input,
                    template=template,
                    local_slide_keys=local_slide_keys,
                    slide_no_map=slide_no_map,
                    hard_cap=hard_cap,
                    focus_options=focus_options,
                    max_batches=preferred_max_local_batches,
                )
            else:
                local_batches = self._optimize_local_batches_heuristic(
                    tenant_input=tenant_input,
                    template=template,
                    local_slide_keys=local_slide_keys,
                    slide_no_map=slide_no_map,
                    hard_cap=hard_cap,
                    focus_options=focus_options,
                    max_batches=preferred_max_local_batches,
                )

            local_batches = self._force_merge_to_max_batches(
                tenant_input=tenant_input,
                template=template,
                batches=local_batches,
                slide_no_map=slide_no_map,
                hard_cap=hard_cap,
                focus_options=focus_options,
                max_batches=preferred_max_local_batches,
            )

        full_data_batches = [[slide_key] for slide_key in full_data_slide_keys]
        batches = local_batches + full_data_batches
        batches = sorted(batches, key=lambda batch: self._batch_sort_key(batch, slide_no_map))

        logger.info("Smart batching hard cap=%s", hard_cap)
        for index, batch in enumerate(batches, start=1):
            estimated = self._estimate_batch_prompt_tokens(
                tenant_input=tenant_input,
                template=template,
                slide_keys=batch,
                focus_options=focus_options,
            )
            logger.info("  Batch %s: slides=%s, estimated_tokens=%s", index, batch, estimated)

        return batches

    def _generate_ai_content_in_batches(
        self,
        tenant_input: TenantInput,
        template: TemplateDescriptorV2,
        max_tokens_per_batch: int = 15000,
        focus_options: Optional[List[str]] = None,
        rag_context: Optional[str] = None,
        rag_context_by_slide: Optional[Dict[str, str]] = None,
        session_id: str = None,
        ws_manager = None,
        event_loop = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Generate AI content in batches to avoid timeout issues.

        Args:
            tenant_input: Raw tenant input data
            template: Template descriptor
            max_tokens_per_batch: Maximum estimated tokens per API call
            session_id: Session ID for progress updates
            ws_manager: WebSocket manager for real-time progress
            event_loop: Event loop for scheduling async tasks from sync code

        Returns:
            Dict[slide_key, Dict[token, value]] with all AI-generated content
        """
        batches = self._get_smart_slide_batches(
            tenant_input=tenant_input,
            template=template,
            max_tokens_per_batch=max_tokens_per_batch,
            focus_options=focus_options,
            disable_local_only_split=config.settings.llm_disable_local_only_batch_split,
        )
        total_batches = len(batches)

        # Helper to send progress updates
        def send_progress(progress: int, message: str):
            if ws_manager and session_id and event_loop:
                import asyncio
                try:
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send_progress_update(session_id, progress, message),
                        event_loop
                    )
                except Exception as e:
                    logger.debug(f"Failed to send progress update: {e}")

        if total_batches <= 1:
            logger.info("Single batch - using standard generation")
            send_progress(35, "AI generating content...")
            system_prompt = self._build_system_prompt(template)
            batch_rag_context_by_slide = self._build_rag_context_by_slide_for_batch(
                tenant_input=tenant_input,
                template=template,
                slide_keys=batches[0] if batches else [],
                max_tokens_per_batch=max_tokens_per_batch,
                focus_options=focus_options,
                rag_context_by_slide=rag_context_by_slide,
            )
            user_prompt = self._build_user_prompt(
                tenant_input,
                template,
                focus_options=focus_options,
                rag_context=rag_context,
                rag_context_by_slide=batch_rag_context_by_slide,
            )
            result = self._call_and_parse_with_retry_compat(
                system_prompt,
                user_prompt,
                template,
                prompt_dump={
                    "session_id": session_id,
                    "scene": "generate",
                    "template_id": template.template_id,
                    "batch_index": 0,
                    "total_batches": 1,
                },
            )
            send_progress(60, "AI content generation completed")
            return result

        logger.info(f"Smart batching: splitting into {total_batches} batches")

        all_ai_placeholders: Dict[str, Dict[str, Any]] = {}
        system_prompt = self._build_system_prompt(template)

        # Progress range: 30% - 60%
        progress_per_batch = 30.0 / total_batches

        for i, batch_slide_keys in enumerate(batches):
            logger.info(f"Processing batch {i + 1}/{total_batches}: slides {batch_slide_keys}")

            current_progress = 30 + int(i * progress_per_batch)
            send_progress(current_progress, f"AI generating content (batch {i + 1}/{total_batches})...")

            user_prompt = self._build_user_prompt_for_slides(
                tenant_input,
                template,
                batch_slide_keys,
                batch_index=i,
                total_batches=total_batches,
                focus_options=focus_options,
                rag_context=rag_context,
                rag_context_by_slide=self._build_rag_context_by_slide_for_batch(
                    tenant_input=tenant_input,
                    template=template,
                    slide_keys=batch_slide_keys,
                    max_tokens_per_batch=max_tokens_per_batch,
                    focus_options=focus_options,
                    rag_context_by_slide=rag_context_by_slide,
                ),
            )

            prompt_tokens = self._estimate_prompt_tokens(user_prompt)
            logger.info(f"   Batch prompt size: ~{prompt_tokens} tokens")

            batch_placeholders = self._call_and_parse_with_retry_compat(
                system_prompt,
                user_prompt,
                template,
                prompt_dump={
                    "session_id": session_id,
                    "scene": "generate",
                    "template_id": template.template_id,
                    "batch_index": i,
                    "total_batches": total_batches,
                },
            )

            for slide_key, tokens in batch_placeholders.items():
                if slide_key not in all_ai_placeholders:
                    all_ai_placeholders[slide_key] = {}
                all_ai_placeholders[slide_key].update(tokens)

            logger.info(f"Batch {i + 1}/{total_batches} completed")

        send_progress(60, "All AI content generation completed")
        return all_ai_placeholders

    def _call_and_parse_with_retry(
        self,
        system_prompt: str,
        user_prompt: str,
        template: TemplateDescriptorV2,
        max_parse_retries: int = 5,
        prompt_dump: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Call LLM and parse response with retry on format errors."""
        if prompt_dump:
            self._dump_prompt_markdown(
                session_id=prompt_dump.get("session_id"),
                scene=prompt_dump.get("scene") or "generate",
                template_id=prompt_dump.get("template_id") or template.template_id,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                slide_key=prompt_dump.get("slide_key"),
                batch_index=prompt_dump.get("batch_index"),
                total_batches=prompt_dump.get("total_batches"),
            )

        for attempt in range(max_parse_retries):
            try:
                logger.info(f"LLM generation attempt {attempt + 1}/{max_parse_retries}")

                response = self._call_openai_with_retry(system_prompt, user_prompt)

                parsed = self._parse_llm_response(response, template)
                parsed = self._post_process_ai_placeholders(parsed)

                logger.info(f"Successfully parsed LLM response on attempt {attempt + 1}")
                return parsed

            except LLMGenerationError as e:
                logger.error(f"Parse attempt {attempt + 1}/{max_parse_retries} failed: {e}")

                if attempt < max_parse_retries - 1:
                    logger.warning("Retrying LLM call due to format error...")
                else:
                    error_msg = (
                        f"AI generation failed after {max_parse_retries} parse retries. "
                        f"Please check model output format or switch to mock mode. "
                        f"Last error: {e}"
                    )
                    logger.error(error_msg)
                    raise LLMGenerationError(error_msg) from e

        raise LLMGenerationError(f"Unexpected error: exceeded {max_parse_retries} retries")

    def _call_openai_with_retry(
        self,
        system_prompt: str,
        user_prompt: str,
        max_retries: int = 4,
        retry_delay: float = 2.0,
    ) -> str:
        """Call OpenAI API with retry logic."""
        if not self.client:
            raise LLMGenerationError("OpenAI client is not initialized. Enable LLM in settings.")

        logger.info("=" * 80)
        logger.info("CALLING OPENAI API (V2)")
        logger.info(f"System prompt length: {len(system_prompt)} chars")
        logger.info(f"User prompt length: {len(user_prompt)} chars")
        logger.info(f"Model: {config.settings.openai_model}")
        logger.info(f"Base URL: {config.settings.openai_base_url or 'default'}")
        logger.info("=" * 80)

        content = self._call_openai_api(system_prompt, user_prompt)
        return content

    def _extract_stream_content_piece(self, delta: Any) -> str:
        """Extract text content from a streamed delta payload across compatible providers."""
        if delta is None:
            return ""

        pieces: List[str] = []

        content = getattr(delta, "content", None)
        if isinstance(content, str):
            pieces.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, str):
                    pieces.append(item)
                    continue
                if isinstance(item, dict):
                    text_value = item.get("text") or item.get("content")
                    if isinstance(text_value, str):
                        pieces.append(text_value)
                        continue
                text_value = getattr(item, "text", None)
                if isinstance(text_value, str):
                    pieces.append(text_value)

        for attr_name in ("text",):
            attr_value = getattr(delta, attr_name, None)
            if isinstance(attr_value, str):
                pieces.append(attr_value)

        return "".join(piece for piece in pieces if piece)

    def _summarize_stream_chunk(self, chunk: Any, index: int) -> Dict[str, Any]:
        """Build a compact diagnostic summary for a streamed chunk."""
        summary: Dict[str, Any] = {
            "chunk_index": index,
            "chunk_type": type(chunk).__name__,
        }

        choices = getattr(chunk, "choices", None)
        summary["has_choices"] = bool(choices)
        summary["choices_count"] = len(choices) if choices else 0

        if not choices:
            return summary

        first_choice = choices[0]
        summary["finish_reason"] = getattr(first_choice, "finish_reason", None)

        delta = getattr(first_choice, "delta", None)
        if delta is None:
            summary["delta_type"] = None
            summary["delta_fields"] = []
            summary["content_preview"] = ""
            return summary

        summary["delta_type"] = type(delta).__name__
        delta_fields = []
        for attr_name in ("content", "text", "reasoning_content", "role", "tool_calls", "function_call", "refusal"):
            attr_value = getattr(delta, attr_name, None)
            if attr_value is not None:
                delta_fields.append(attr_name)
        summary["delta_fields"] = delta_fields

        content_preview = self._extract_stream_content_piece(delta)
        summary["content_preview"] = content_preview[:120]
        return summary

    def _extract_non_stream_content(self, response: Any) -> str:
        """Extract text content from a non-stream chat completion response."""
        choices = getattr(response, "choices", None) or []
        if not choices:
            return ""

        message = getattr(choices[0], "message", None)
        if message is None:
            return ""

        content = getattr(message, "content", None)
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            pieces: List[str] = []
            for item in content:
                if isinstance(item, str):
                    pieces.append(item)
                    continue
                text_value = getattr(item, "text", None)
                if isinstance(text_value, str):
                    pieces.append(text_value)
                    continue
                if isinstance(item, dict):
                    dict_text = item.get("text") or item.get("content")
                    if isinstance(dict_text, str):
                        pieces.append(dict_text)
            return "".join(pieces)
        return ""

    def _build_empty_response_error(
        self,
        *,
        stage: str,
        chunk_count: int = 0,
        chunk_summaries: Optional[List[Dict[str, Any]]] = None,
        extra: Optional[Dict[str, Any]] = None,
    ) -> LLMGenerationError:
        """Construct a detailed empty-response error with diagnostics."""
        diagnostics: Dict[str, Any] = {
            "stage": stage,
            "model": config.settings.openai_model,
            "base_url": config.settings.openai_base_url or "default",
            "chunk_count": chunk_count,
        }
        if chunk_summaries:
            diagnostics["chunk_summaries"] = chunk_summaries
        if extra:
            diagnostics.update(extra)

        return LLMGenerationError(
            f"OpenAI-compatible endpoint returned empty response. Diagnostics: "
            f"{json.dumps(diagnostics, ensure_ascii=False)}"
        )

    @with_llm_retry(max_attempts=1)
    def _call_openai_api(
        self,
        system_prompt: str,
        user_prompt: str,
    ) -> str:
        """Make the actual OpenAI API call (wrapped with retry decorator)."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]

        if not config.settings.llm_json_stream:
            response = self.client.chat.completions.create(
                model=config.settings.openai_model,
                messages=messages,
                temperature=config.settings.llm_temperature,
                response_format={"type": "json_object"},
                stream=False,
            )

            content = self._extract_non_stream_content(response).strip()
            choices = getattr(response, "choices", None) or []
            finish_reason = getattr(choices[0], "finish_reason", None) if choices else None
            if content:
                logger.info("=" * 80)
                logger.info("OPENAI API CALL SUCCESSFUL")
                logger.info(f"Response length: {len(content)} chars")
                logger.info(
                    "Non-stream diagnostics: finish_reason=%s temperature=%s",
                    finish_reason,
                    config.settings.llm_temperature,
                )
                logger.info("=" * 80)
                return content

            raise self._build_empty_response_error(
                stage="non_stream_empty",
                extra={
                    "finish_reason": finish_reason,
                    "choices_count": len(choices),
                    "response_type": type(response).__name__,
                },
            )

        stream = self.client.chat.completions.create(
            model=config.settings.openai_model,
            messages=messages,
            temperature=config.settings.llm_temperature,
            response_format={"type": "json_object"},
            stream=True,
        )

        content_chunks: List[str] = []
        chunk_count = 0
        non_empty_choice_chunks = 0
        chunk_summaries: List[Dict[str, Any]] = []
        finish_reasons: Set[str] = set()

        for chunk in stream:
            chunk_count += 1
            if len(chunk_summaries) < 5:
                chunk_summaries.append(self._summarize_stream_chunk(chunk, chunk_count))

            choices = getattr(chunk, "choices", None)
            if not choices:
                continue

            non_empty_choice_chunks += 1
            finish_reason = getattr(choices[0], "finish_reason", None)
            if finish_reason:
                finish_reasons.add(str(finish_reason))

            delta = getattr(choices[0], "delta", None)
            content_piece = self._extract_stream_content_piece(delta)
            if content_piece:
                content_chunks.append(content_piece)

        content = "".join(content_chunks).strip()
        if content:
            logger.info("=" * 80)
            logger.info("OPENAI API CALL SUCCESSFUL")
            logger.info(f"Response length: {len(content)} chars")
            logger.info(
                "Stream diagnostics: total_chunks=%s, chunks_with_choices=%s, finish_reasons=%s",
                chunk_count,
                non_empty_choice_chunks,
                sorted(finish_reasons) if finish_reasons else [],
            )
            logger.info("Temperature: %s", config.settings.llm_temperature)
            logger.info("=" * 80)
            return content

        logger.warning(
            "Empty stream content received from model=%s base_url=%s total_chunks=%s chunks_with_choices=%s finish_reasons=%s chunk_summaries=%s",
            config.settings.openai_model,
            config.settings.openai_base_url or "default",
            chunk_count,
            non_empty_choice_chunks,
            sorted(finish_reasons) if finish_reasons else [],
            json.dumps(chunk_summaries, ensure_ascii=False),
        )

        logger.info("Trying non-stream fallback for empty streamed response...")
        fallback_response = self.client.chat.completions.create(
            model=config.settings.openai_model,
            messages=messages,
            temperature=config.settings.llm_temperature,
            response_format={"type": "json_object"},
            stream=False,
        )

        fallback_content = self._extract_non_stream_content(fallback_response).strip()
        fallback_finish_reason = None
        fallback_response_type = type(fallback_response).__name__
        fallback_choices = getattr(fallback_response, "choices", None) or []
        fallback_preview = ""
        if isinstance(fallback_response, str):
            fallback_preview = fallback_response[:200]
        elif not fallback_choices:
            fallback_preview = str(fallback_response)[:200]
        if fallback_choices:
            fallback_finish_reason = getattr(fallback_choices[0], "finish_reason", None)

        if fallback_content:
            logger.warning(
                "Non-stream fallback succeeded after empty stream response; this suggests provider stream chunk incompatibility. finish_reason=%s response_length=%s",
                fallback_finish_reason,
                len(fallback_content),
            )
            return fallback_content

        raise self._build_empty_response_error(
            stage="stream_and_non_stream_empty",
            chunk_count=chunk_count,
            chunk_summaries=chunk_summaries,
            extra={
                "chunks_with_choices": non_empty_choice_chunks,
                "finish_reasons": sorted(finish_reasons) if finish_reasons else [],
                "fallback_finish_reason": fallback_finish_reason,
                "fallback_choices_count": len(fallback_choices),
                "fallback_response_type": fallback_response_type,
                "fallback_preview": fallback_preview,
            },
        )

    def _sanitize_llm_json(self, content: str) -> str:
        """Clean up LLM response for JSON parsing."""
        if not content:
            return content

        text = content.strip()

        # Remove markdown code fences
        fenced_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.IGNORECASE)
        if fenced_match:
            text = fenced_match.group(1).strip()

        # Remove single-line comments (// ...)
        text = re.sub(r'//.*?$', '', text, flags=re.MULTILINE)

        # Remove multi-line comments (/* ... */)
        text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)

        # Extract JSON object
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            return text[first_brace:last_brace + 1].strip()

        return text

    def _parse_llm_response(
        self,
        response: str,
        template: TemplateDescriptorV2
    ) -> Dict[str, Dict[str, Any]]:
        """Parse LLM response into slide placeholders.

        Returns:
            Dict[slide_key, Dict[token, value]]
        """
        cleaned = self._sanitize_llm_json(response)

        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response: {e}")
            logger.error(f"Response: {cleaned[:500]}...")
            raise LLMGenerationError(f"Invalid JSON from LLM: {e}") from e

        result: Dict[str, Dict[str, Any]] = {}

        if "slides" not in data:
            raise LLMGenerationError("Response missing 'slides' field")

        # Validate slides is a list
        if not isinstance(data["slides"], list):
            logger.error(f"'slides' field is not a list: {type(data['slides'])}")
            logger.error(f"Response data: {json.dumps(data, ensure_ascii=False, indent=2)[:1000]}")
            raise LLMGenerationError(f"'slides' field must be a list, got {type(data['slides'])}")

        for i, slide_data in enumerate(data["slides"]):
            # Validate each slide_data is a dict
            if not isinstance(slide_data, dict):
                logger.error(f"Slide data at index {i} is not a dict: {type(slide_data)}")
                logger.error(f"Slide data: {slide_data}")
                raise LLMGenerationError(f"Slide at index {i} must be a dict, got {type(slide_data)}: {slide_data}")

            slide_key = slide_data.get("slide_key")
            placeholders = slide_data.get("placeholders", {})

            if slide_key:
                result[slide_key] = placeholders

        return result

    def _parse_embedded_json_object(self, raw: Any) -> Optional[Dict[str, Any]]:
        """Parse dict or JSON-string content into a JSON object."""
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str):
            return None

        text = raw.strip()
        if not text:
            return None

        candidates = [text]
        sanitized = self._sanitize_llm_json(text)
        if sanitized and sanitized != text:
            candidates.append(sanitized)

        for candidate in candidates:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                continue
        return None

    def _expand_duty_summary_placeholders(self, placeholders: Dict[str, Any]) -> None:
        """Expand duty_summary JSON object into per-festival placeholders."""
        if not isinstance(placeholders, dict):
            return
        if self._DUTY_SUMMARY_TOKEN not in placeholders:
            return

        duty_summary_raw = placeholders.get(self._DUTY_SUMMARY_TOKEN)
        parsed = self._parse_embedded_json_object(duty_summary_raw)
        if not parsed:
            placeholders.pop(self._DUTY_SUMMARY_TOKEN, None)
            return

        for token in self._DUTY_SUMMARY_FESTIVAL_TOKENS:
            value = parsed.get(token)
            if value is None:
                continue
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            text = str(value).strip()
            placeholders[token] = text

        placeholders.pop(self._DUTY_SUMMARY_TOKEN, None)

    def _post_process_ai_placeholders(
        self,
        parsed: Dict[str, Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        """Apply token-level post-processing for AI output."""
        for slide_placeholders in parsed.values():
            if isinstance(slide_placeholders, dict):
                self._expand_duty_summary_placeholders(slide_placeholders)
        return parsed

    def generate_slidespec_v2(
        self,
        tenant_input: TenantInput,
        template_id: str,
        use_mock: bool = False,
        focus_options: Optional[List[str]] = None,
        rag_context: Optional[str] = None,
        rag_context_by_slide: Optional[Dict[str, str]] = None,
        session_id: str = None,
        ws_manager = None,
        event_loop = None,
    ) -> SlideSpecV2:
        """Generate SlideSpec for V2 template using AI.

        This is the main entry point for V2 generation.

        Args:
            tenant_input: Raw tenant input data
            template_id: V2 template ID
            use_mock: Whether to force mock/fallback generation
            focus_options: Optional report focus options for prompt augmentation
            session_id: Session ID for WebSocket progress updates
            ws_manager: WebSocket manager for real-time progress
            event_loop: Event loop for scheduling async tasks from sync code

        Returns:
            SlideSpecV2 with all placeholders filled
        """
        logger.info(f"Generating V2 slidespec for template: {template_id}, use_mock={use_mock}")

        # Helper to send progress updates
        def send_progress(progress: int, message: str):
            if ws_manager and session_id and event_loop:
                import asyncio
                try:
                    # Schedule coroutine in the main event loop
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send_progress_update(session_id, progress, message),
                        event_loop
                    )
                except Exception as e:
                    logger.debug(f"Failed to send progress update: {e}")

        # Weighted progress model:
        # preparation 0-5, template/data 5-25, ai 25-65, ppt 65-75, preview 75-95, finalization 95-100.
        # Load V2 template descriptor (template/data stage)
        send_progress(12, "加载模板描述...")
        template = self.template_repo.get_descriptor_v2(template_id)

        # Create empty slidespec structure
        slide_keys = [(s.slide_no, s.slide_key) for s in template.slides]
        slidespec = create_empty_slidespec_v2(template_id, slide_keys)

        # Step 1: Extract data placeholders (non-AI)
        logger.info("Extracting data placeholders...")
        send_progress(24, "提取数据占位符...")
        data_placeholders = self._extract_data_placeholders(tenant_input, template)

        for slide_key, tokens in data_placeholders.items():
            slide = slidespec.get_slide(slide_key)
            if slide:
                slide.placeholders.update(tokens)

        # Step 2: Generate AI placeholders (25% - 65%)
        if config.settings.enable_llm and not use_mock:
            logger.info("Generating AI content...")
            # Keep ASCII keywords for frontend stage classifier robustness.
            send_progress(28, "AI generating content...")
            try:
                # Use smart batched generation to avoid timeout issues
                # Batching is based on estimated token count, not hardcoded limits
                ai_placeholders = self._generate_ai_content_in_batches(
                    tenant_input,
                    template,
                    focus_options=focus_options,
                    rag_context=rag_context,
                    rag_context_by_slide=rag_context_by_slide,
                    session_id=session_id,
                    ws_manager=ws_manager,
                    event_loop=event_loop,
                )

                # Merge AI content (65%)
                send_progress(65, "合并 AI 生成内容...")
                for slide_key, tokens in ai_placeholders.items():
                    slide = slidespec.get_slide(slide_key)
                    if slide:
                        slide.placeholders.update(tokens)

                # (No validator) Keep generation flow simple
                send_progress(65, "校验生成内容...")

            except LLMGenerationError as e:
                logger.error(f"AI generation failed: {e}")
                raise
        else:
            logger.info(f"{'Using mock mode' if use_mock else 'LLM disabled'}, using fallback content")
            send_progress(45, "使用快速生成模式...")
            self._fill_ai_placeholders_with_fallback(slidespec, template)
            send_progress(65, "快速生成完成...")

        logger.info(f"V2 slidespec generation complete: {len(slidespec.slides)} slides")
        return slidespec

    def _fill_ai_placeholders_with_fallback(
        self,
        slidespec: SlideSpecV2,
        template: TemplateDescriptorV2,
    ) -> None:
        """Fill AI placeholders with fallback text when LLM is unavailable."""
        for slide_key, token, placeholder in template.get_ai_placeholders():
            slide = slidespec.get_slide(slide_key)
            if slide and token not in slide.placeholders:
                if token == self._DUTY_SUMMARY_TOKEN:
                    slide.placeholders[token] = {
                        festival_token: f"[{festival_token}: AI generated content]"
                        for festival_token in self._DUTY_SUMMARY_FESTIVAL_TOKENS
                    }
                    self._expand_duty_summary_placeholders(slide.placeholders)
                else:
                    slide.placeholders[token] = f"[{token}: AI generated content]"


