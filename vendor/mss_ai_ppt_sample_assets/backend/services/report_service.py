from __future__ import annotations

import json
import logging
import shutil
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Union

from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.models.inputs import TenantInput
from mss_ai_ppt_sample_assets.backend.models.slidespec import SlideSpecV2
from mss_ai_ppt_sample_assets.backend.modules import (
    AuditLogger,
    TemplateRepository,
    SessionManager,
    FileLock,
)
from mss_ai_ppt_sample_assets.backend.modules.llm_orchestrator import (
    LLMOrchestratorV2,
    LLMGenerationError,
)
from mss_ai_ppt_sample_assets.backend.modules.ppt_generator import PPTGeneratorV2
from mss_ai_ppt_sample_assets.backend.modules.preview_generator import (
    PPTPreviewGenerator,
    sanitize_job_id,
)
from mss_ai_ppt_sample_assets.backend.modules.excel_handler import ExcelDataExtractor
from mss_ai_ppt_sample_assets.backend.services.rag_service import get_rag_service

logger = logging.getLogger(__name__)


class InputNotFoundError(Exception):
    pass


class SlideSpecNotFoundError(Exception):
    pass


class ReportService:
    """Orchestrates report generation for V2 (AI-driven) templates."""

    def __init__(self):
        self.template_repo = TemplateRepository()
        self.audit_logger = AuditLogger()
        self.preview_generator = PPTPreviewGenerator(
            cleanup_days=config.settings.preview_cleanup_days
        )
        self.inputs_catalog = self._load_inputs_catalog()
        self.session_manager = SessionManager(config.SESSIONS_DIR)
        self.rag_service = get_rag_service()

        # V2 (AI-driven) generators
        self.ppt_generator_v2 = PPTGeneratorV2(self.template_repo)
        self.llm_orchestrator_v2 = LLMOrchestratorV2(self.template_repo)

    def _load_inputs_catalog(self) -> Dict[str, Dict[str, Any]]:
        catalog_path = config.INPUTS_DIR / "catalog.json"
        with catalog_path.open("r", encoding="utf-8") as f:
            items = json.load(f).get("datasets", [])
        return {item["id"]: item for item in items}

    @staticmethod
    def _collect_structured_key_signatures(
        value: Any,
        path: str,
        out: Dict[str, Set[str]]
    ) -> None:
        if isinstance(value, list):
            for item in value:
                ReportService._collect_structured_key_signatures(item, f"{path}[]", out)
            return

        if not isinstance(value, dict):
            return

        signature = "|".join(sorted(value.keys()))
        out.setdefault(path, set()).add(signature)

        for key, child in value.items():
            ReportService._collect_structured_key_signatures(child, f"{path}.{key}", out)

    @staticmethod
    def _has_same_structured_keys(old_value: Any, new_value: Any) -> bool:
        old_map: Dict[str, Set[str]] = {}
        new_map: Dict[str, Set[str]] = {}
        ReportService._collect_structured_key_signatures(old_value, "$", old_map)
        ReportService._collect_structured_key_signatures(new_value, "$", new_map)
        return old_map == new_map

    @staticmethod
    def _strip_position_fields(value: Any) -> Any:
        if isinstance(value, list):
            return [ReportService._strip_position_fields(item) for item in value]
        if isinstance(value, dict):
            return {
                k: ReportService._strip_position_fields(v)
                for k, v in value.items()
                if k != "position"
            }
        return value

    @staticmethod
    def _set_nested_value(target: Dict[str, Any], path: str, value: Any) -> bool:
        """Set a nested value by dotted path, creating intermediate containers when needed."""
        if not path:
            return False

        parts = [part for part in path.split(".") if part]
        if not parts:
            return False

        current: Any = target
        for idx, part in enumerate(parts):
            is_last = idx == len(parts) - 1
            next_part = parts[idx + 1] if not is_last else None

            if part.isdigit():
                if not isinstance(current, list):
                    return False

                index = int(part)
                while len(current) <= index:
                    current.append({} if not next_part or not next_part.isdigit() else [])

                if is_last:
                    current[index] = value
                    return True

                if not isinstance(current[index], (dict, list)):
                    current[index] = {} if not next_part or not next_part.isdigit() else []
                current = current[index]
                continue

            if not isinstance(current, dict):
                return False

            if is_last:
                current[part] = value
                return True

            child = current.get(part)
            if not isinstance(child, (dict, list)):
                child = {} if not next_part or not next_part.isdigit() else []
                current[part] = child
            current = child

        return False

    def _get_token_source_map_by_slide(self, template_id: str) -> Dict[str, Dict[str, str]]:
        descriptor = self.template_repo.get_descriptor_v2(template_id)
        source_map: Dict[str, Dict[str, str]] = {}
        for slide in descriptor.slides:
            token_map: Dict[str, str] = {}
            for ph in slide.placeholders:
                if ph.source:
                    token_map[ph.token] = ph.source
            source_map[slide.slide_key] = token_map
        return source_map

    def _read_session_input_json(self, session_id: str) -> Dict[str, Any]:
        input_path = self.session_manager.get_input_path(session_id)
        with FileLock(input_path, timeout=30.0):
            with input_path.open("r", encoding="utf-8") as f:
                return json.load(f)

    def _write_session_input_json(self, session_id: str, payload: Dict[str, Any]) -> None:
        input_path = self.session_manager.get_input_path(session_id)
        with FileLock(input_path, timeout=30.0):
            with input_path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

    def _load_or_bootstrap_session_input(self, input_id: str, session_id: str, template_id: str) -> TenantInput:
        input_path = self.session_manager.get_input_path(session_id)
        if input_path.exists():
            return TenantInput(raw=self._read_session_input_json(session_id))
        return self._load_input_from_excel_runtime(input_id, session_id, template_id)

    def _persist_manual_updates_to_session_input(
        self,
        session_id: str,
        input_id: str,
        template_id: str,
        applied_updates: List[Dict[str, Any]],
    ) -> List[str]:
        """Sync editor-applied slide updates back into session input.json via placeholder source paths."""
        warnings: List[str] = []
        if not applied_updates:
            return warnings

        try:
            source_map_by_slide = self._get_token_source_map_by_slide(template_id)
        except Exception as e:
            logger.warning("Failed to build source mapping for template %s: %s", template_id, e)
            warnings.append("Unable to sync session input.json due to template mapping error.")
            return warnings

        try:
            tenant_input = self._load_or_bootstrap_session_input(input_id, session_id, template_id)
        except Exception as e:
            logger.warning("Failed to load/initialize session input.json for session %s: %s", session_id, e)
            warnings.append("Unable to sync session input.json for this session.")
            return warnings

        raw = deepcopy(tenant_input.raw)
        persisted_count = 0

        for slide_update in applied_updates:
            slide_key = slide_update.get("slide_key")
            new_content = slide_update.get("new_content")
            if not slide_key or not isinstance(new_content, dict):
                continue

            token_source_map = source_map_by_slide.get(slide_key, {})
            for token, edited_value in new_content.items():
                source_path = token_source_map.get(token)
                if not source_path:
                    # AI-only fields without source stay in slidespec only.
                    continue
                if self._set_nested_value(raw, source_path, edited_value):
                    persisted_count += 1
                else:
                    logger.warning(
                        "Failed to apply edited token to input.json: session=%s slide=%s token=%s source=%s",
                        session_id,
                        slide_key,
                        token,
                        source_path,
                    )

        if persisted_count > 0:
            self._write_session_input_json(session_id, raw)
            logger.info(
                "Persisted %s edited values to session input.json for session %s",
                persisted_count,
                session_id,
            )

        return warnings

    def _get_chart_tokens_by_slide(self, template_id: str) -> Dict[str, Set[str]]:
        descriptor = self.template_repo.get_descriptor_v2(template_id)
        chart_types = {
            "P11_bar", "P11_line", "P11_pie", "P13_pie", "P14_pie",
            "P15_pie_1", "P15_pie_2", "P15_line", "P15_bar",
            "P16_combo", "P26_line", "P27_bar", "P27_line", "P27_pie",
            "P28_pie_1", "P28_pie_2", "P28_line", "P28_bar",
            "P29_pie", "P29_line", "P30_combo",
        }
        result: Dict[str, Set[str]] = {}
        for slide in descriptor.slides:
            chart_tokens = {
                ph.token for ph in slide.placeholders
                if ph.type in chart_types
            }
            result[slide.slide_key] = chart_tokens
        return result

    def _slidespec_path(self, input_id: str, template_id: str) -> Path:
        return config.SLIDESPECS_DIR / f"{input_id}_{template_id}.json"

    def list_inputs(self):
        return list(self.inputs_catalog.values())

    def list_templates(self, include_deprecated: bool = False):
        """List available templates."""
        return self.template_repo.list_templates(include_deprecated=include_deprecated)

    def get_input_meta(self, input_id: str) -> Dict[str, Any]:
        entry = self.inputs_catalog.get(input_id)
        if not entry:
            raise InputNotFoundError(f"Input {input_id} not found")
        return entry

    def _get_input_path(self, input_id: str) -> Path:
        entry = self.inputs_catalog.get(input_id)
        if not entry:
            raise InputNotFoundError(f"Input {input_id} not found")
        return config.INPUTS_DIR / entry["file"]

    def load_input(self, input_id: str) -> TenantInput:
        path = self._get_input_path(input_id)
        return TenantInput.load_from_file(path)

    def _resolve_excel_source_path(self, input_id: str, session_id: str) -> Path | None:
        """Resolve preferred Excel source for runtime parsing.

        Priority:
        1) Session uploaded Excel (`outputs/sessions/{session_id}/uploaded.xlsx`)
        2) Catalog-provided excel_file (if configured)
        3) Built-in classic workbook (`data/data.xlsx`) for classic_ops input
        """
        session_dir = self.session_manager.get_session_dir(session_id)
        session_excel = session_dir / "uploaded.xlsx"
        if session_excel.exists():
            return session_excel

        entry = self.inputs_catalog.get(input_id) or {}
        excel_file = entry.get("excel_file")
        if excel_file:
            excel_path = Path(excel_file)
            if not excel_path.is_absolute():
                excel_path = (config.DATA_DIR / excel_path).resolve()
            if excel_path.exists():
                return excel_path

        if input_id == "classic_ops_dataxlsx":
            default_excel = config.DATA_DIR / "data.xlsx"
            if default_excel.exists():
                return default_excel

        return None

    def _load_input_from_excel_runtime(self, input_id: str, session_id: str, template_id: str) -> TenantInput:
        """Parse input from Excel at generation time and persist session intermediate JSON."""
        excel_path = self._resolve_excel_source_path(input_id, session_id)
        if not excel_path:
            raise InputNotFoundError(
                f"No Excel source found for input_id '{input_id}'. "
                "Expected session uploaded.xlsx or configured excel_file."
            )

        parsed = ExcelDataExtractor.extract_data(excel_path, template_id=template_id)

        # Keep JSON only as this-run intermediate artifact under session directory.
        input_path = self.session_manager.get_input_path(session_id)
        with FileLock(input_path, timeout=30.0):
            with input_path.open("w", encoding="utf-8") as f:
                json.dump(parsed, f, ensure_ascii=False, indent=2)

        logger.info(
            "Input parsed from Excel at runtime: template=%s, source=%s -> %s",
            template_id,
            excel_path,
            input_path,
        )
        return TenantInput(raw=parsed)

    def _should_parse_excel_runtime(self, input_id: str, template_id: str) -> bool:
        runtime_excel_templates = set(ExcelDataExtractor.TEMPLATE_EXTRACTORS.keys())
        runtime_excel_input_ids = {"classic_ops_dataxlsx"}
        return template_id in runtime_excel_templates or input_id in runtime_excel_input_ids

    def generate(
        self,
        input_id: str,
        template_id: str,
        use_mock: bool = False,
        focus_options: Optional[List[str]] = None,
        use_rag: bool = True,
        session_id: str = None,
        ws_manager=None,
        event_loop=None,
    ) -> Dict[str, Any]:
        """Generate report using V2 template.

        For V2 templates:
        - Raw TenantInput goes directly to LLM
        - AI generates content based on placeholder descriptions
        - Only key numbers are validated

        Args:
            input_id: Input data identifier
            template_id: Template identifier
            use_mock: Whether to use mock LLM generation
            focus_options: Optional report focus options for prompt augmentation
            session_id: Optional session ID for concurrent request isolation.
                       If None, a new session ID will be generated.
            ws_manager: WebSocket manager for real-time progress updates
            event_loop: Event loop for scheduling async tasks from sync code

        Returns:
            Dict with job_id, report_path, warnings, slidespec, etc.
        """
        logger.debug(f"Starting generation: input={input_id}, template={template_id}, mock={use_mock}, session={session_id}")

        # Generate session ID if not provided
        if session_id is None:
            session_id = self.session_manager.generate_session_id()
            logger.debug(f"Generated new session ID: {session_id}")

        if self._should_parse_excel_runtime(input_id, template_id):
            tenant_input = self._load_input_from_excel_runtime(input_id, session_id, template_id)
            logger.debug(
                "Loaded runtime Excel input: template=%s, input=%s, keys=%s",
                template_id,
                input_id,
                len(tenant_input.raw),
            )
        else:
            tenant_input = self.load_input(input_id)
            logger.debug(f"Loaded input data: {len(tenant_input.raw)} keys")

        return self._generate_v2(
            input_id,
            template_id,
            tenant_input,
            session_id=session_id,
            use_mock=use_mock,
            focus_options=focus_options,
            use_rag=use_rag,
            ws_manager=ws_manager,
            event_loop=event_loop,
        )

    def _generate_v2(
        self,
        input_id: str,
        template_id: str,
        tenant_input: TenantInput,
        session_id: str,
        use_mock: bool = False,
        focus_options: Optional[List[str]] = None,
        use_rag: bool = True,
        ws_manager=None,
        event_loop=None,
    ) -> Dict[str, Any]:
        """Generate report using V2 AI-driven flow.

        Args:
            input_id: Input data identifier
            template_id: Template identifier
            tenant_input: Parsed tenant input data
            session_id: Unique session ID for file isolation
            use_mock: Whether to use mock LLM generation
            focus_options: Optional report focus options for prompt augmentation
            ws_manager: WebSocket manager for real-time progress updates
            event_loop: Event loop for scheduling async tasks from sync code

        Returns:
            Dict with job_id, report_path, warnings, etc.
        """
        def send_progress(progress: int, message: str):
            if ws_manager and session_id and event_loop:
                import asyncio
                try:
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send_progress_update(session_id, progress, message),
                        event_loop
                    )
                except Exception:
                    pass

        # Clear template cache to ensure latest descriptor is loaded
        self.template_repo.clear_cache()
        logger.debug(f"Template cache cleared for: {template_id}")
        template_descriptor = self.template_repo.get_descriptor_v2(template_id)

        # V2: Direct to LLM with raw data
        # Pass ws_manager, session_id, and event_loop to enable real-time progress updates
        rag_context = None
        rag_context_by_slide: Dict[str, str] = {}
        retrieval_trace: List[Dict[str, Any]] = []
        retrieval_stats: Dict[str, Any] = {}
        rag_used = False
        rag_active = bool(use_rag and self.rag_service.enabled)
        if use_rag and not self.rag_service.enabled:
            logger.info("RAG requested but globally disabled (RAG_ENABLED=false), skip retrieval.")
        if rag_active:
            # Keep ASCII keywords for frontend stage classifier robustness.
            send_progress(26, "RAG retrieving knowledge...")
            try:
                rag_result = self.rag_service.retrieve_for_generation(
                    tenant_input=tenant_input,
                    input_id=input_id,
                    template_id=template_id,
                    focus_options=focus_options,
                    use_rag=use_rag,
                    template_descriptor=template_descriptor,
                    session_id=session_id,
                )
                rag_context = rag_result.context
                rag_context_by_slide = dict(rag_result.context_by_slide or {})
                retrieval_trace = rag_result.retrieval_trace
                retrieval_stats = dict(rag_result.retrieval_stats or {})
                rag_used = rag_result.rag_used
            except Exception as e:
                logger.warning("RAG retrieval failed in generate flow: %s", e)
                warnings = [f"RAG retrieval failed: {e}"]
            else:
                warnings = []
        else:
            warnings = []

        logger.debug(f"Generating slidespec via LLM orchestrator...")
        slidespec: SlideSpecV2 = self.llm_orchestrator_v2.generate_slidespec_v2(
            tenant_input=tenant_input,
            template_id=template_id,
            use_mock=use_mock,
            focus_options=focus_options,
            rag_context=rag_context,
            rag_context_by_slide=rag_context_by_slide,
            session_id=session_id,
            ws_manager=ws_manager,
            event_loop=event_loop,
        )
        logger.debug(f"Slidespec generated: {len(slidespec.slides)} slides")

        # Use session-isolated paths
        report_path = self.session_manager.get_report_path(session_id, template_id)
        slidespec_path = self.session_manager.get_slidespec_path(session_id, template_id)
        logger.debug(f"Output paths: report={report_path.name}, slidespec={slidespec_path.name}")

        # Send progress update for rendering
        send_progress(68, "渲染 PPT 文件...")

        # Render with file lock to prevent concurrent write conflicts
        logger.debug("Rendering PPT file with file lock...")
        with FileLock(report_path, timeout=60.0):
            self.ppt_generator_v2.render(slidespec, report_path)
        logger.debug(f"PPT rendered: {report_path.stat().st_size / 1024:.1f} KB")

        # Send progress update after rendering
        send_progress(72, "保存文件...")

        # Save slidespec with file lock
        with FileLock(slidespec_path, timeout=60.0):
            slidespec.save(slidespec_path)

        # PPT is ready; preview rendering continues in async job flow.
        send_progress(75, "PPT 生成完成，准备渲染预览图...")

        self.audit_logger.log(
            event="generate_v2",
            details={"template_id": template_id, "slides_count": len(slidespec.slides)},
            job_id=f"{session_id}:{template_id}",
        )

        return {
            "job_id": f"{session_id}:{template_id}",
            "session_id": session_id,
            "report_path": config.outputs_url_for(report_path),
            "warnings": warnings,
            "rag_used": rag_used,
            "retrieval_trace": retrieval_trace,
            "retrieval_stats": retrieval_stats,
            "slidespec": slidespec.model_dump(),
            "slidespec_path": config.outputs_url_for(slidespec_path),
            "version": "v2",
        }

    def _load_slidespec(self, session_id: str, template_id: str) -> SlideSpecV2:
        """Load slidespec from session directory, ensuring it is V2 format.

        Args:
            session_id: Unique session identifier
            template_id: Template identifier

        Returns:
            Loaded SlideSpecV2 object

        Raises:
            SlideSpecNotFoundError: If slidespec file doesn't exist
        """
        path = self.session_manager.get_slidespec_path(session_id, template_id)
        if not path.exists():
            raise SlideSpecNotFoundError(
                f"Slidespec for session {session_id} / template {template_id} not found. "
                "Please generate first."
            )

        with FileLock(path, timeout=30.0):
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)

        return SlideSpecV2.model_validate(data)

    def _get_input_id_for_job(self, job_id: str) -> str:
        """Resolve input_id from persisted job state using job_id."""
        safe_job_id = job_id.replace(":", "_").replace("/", "_").replace("\\", "_")
        state_path = config.JOBS_DIR / "states" / f"{safe_job_id}.json"

        if state_path.exists():
            with FileLock(state_path, timeout=10.0):
                with state_path.open("r", encoding="utf-8") as f:
                    job_state = json.load(f)
            input_id = job_state.get("input_id")
            if input_id:
                return input_id

        index_path = config.JOBS_DIR / "index.json"
        if index_path.exists():
            with FileLock(index_path, timeout=10.0):
                with index_path.open("r", encoding="utf-8") as f:
                    index = json.load(f)
            index_item = index.get(job_id, {})
            input_id = index_item.get("input_id")
            if input_id:
                return input_id

        raise ValueError(
            f"Cannot resolve input_id for job '{job_id}'. "
            "Job metadata may have been cleaned up."
        )

    def ai_rewrite_slide(
        self,
        job_id: str,
        slide_key: str,
        user_prompt: str,
        target_tokens: List[str] | None = None,
        use_rag: bool = True,
        ws_manager=None,
        event_loop=None,
        progress_callback=None,
    ) -> Dict[str, Any]:
        """AI rewrite for a single slide using user preference prompt."""
        def send_progress(progress: int, message: str):
            if progress_callback:
                try:
                    progress_callback(progress, message)
                except Exception:
                    pass
            if ws_manager and event_loop:
                import asyncio
                try:
                    session = job_id.split(":", 1)[0]
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send_progress_update(session, progress, message),
                        event_loop
                    )
                except Exception:
                    pass

        send_progress(10, "Loading slide for AI rewrite...")
        try:
            session_id, template_id = job_id.split(":", 1)
        except ValueError as e:
            raise ValueError("job_id must be formatted as session_id:template_id") from e

        if not slide_key:
            raise ValueError("slide_key is required")
        if not user_prompt or not user_prompt.strip():
            raise ValueError("user_prompt is required")

        if not config.settings.enable_llm:
            raise ValueError("LLM is disabled. Set ENABLE_LLM=true to use AI rewrite.")

        # Ensure latest template descriptor is used for prompt construction.
        self.template_repo.clear_cache()
        self.template_repo.get_descriptor_v2(template_id)

        slidespec = self._load_slidespec(session_id, template_id)
        target_slide = slidespec.get_slide(slide_key)
        if not target_slide:
            raise ValueError(f"Slide '{slide_key}' not found in current report")

        try:
            input_id = self._get_input_id_for_job(job_id)
        except ValueError:
            # Keep legacy rewrite flow functional even if old job metadata is missing.
            input_id = "classic_ops_dataxlsx"
            logger.warning(
                "Failed to resolve input_id for job %s during rewrite; fallback to %s",
                job_id,
                input_id,
            )
        tenant_input = self._load_or_bootstrap_session_input(
            input_id=input_id,
            session_id=session_id,
            template_id=template_id,
        )

        rag_context = None
        retrieval_trace: List[Dict[str, Any]] = []
        retrieval_stats: Dict[str, Any] = {}
        rag_used = False
        if use_rag:
            logger.info(
                "AI rewrite explicitly bypasses RAG retrieval to strictly follow user prompt."
            )

        send_progress(48, "AI generating content...")
        ai_result = self.llm_orchestrator_v2.rewrite_single_slide_v2(
            tenant_input=tenant_input,
            template_id=template_id,
            slide_key=slide_key,
            user_prompt=user_prompt,
            current_slide_content=dict(target_slide.placeholders or {}),
            target_tokens=target_tokens,
            rag_context=rag_context,
            session_id=session_id,
        )

        send_progress(58, "Applying AI rewrite result...")
        rewritten_placeholders = ai_result.get("placeholders", {})
        if rewritten_placeholders:
            target_slide.placeholders.update(rewritten_placeholders)

        # Use session-isolated paths
        report_path = self.session_manager.get_report_path(session_id, template_id)
        slidespec_path = self.session_manager.get_slidespec_path(session_id, template_id)

        # Persist rewritten slidespec and rerender report
        send_progress(66, "Saving slide specification...")
        with FileLock(slidespec_path, timeout=60.0):
            slidespec.save(slidespec_path)

        send_progress(72, "Rendering PPT...")
        with FileLock(report_path, timeout=60.0):
            self.ppt_generator_v2.render(slidespec, report_path)

        warnings = list(ai_result.get("warnings", []))
        if not rewritten_placeholders:
            warnings.append("AI rewrite returned no placeholders. Slide content unchanged.")

        updated_tokens = ai_result.get("updated_tokens", list(rewritten_placeholders.keys()))
        updated_count = 1 if rewritten_placeholders else 0
        updated_slides = [slide_key] if rewritten_placeholders else []

        self.audit_logger.log(
            event="ai_rewrite_v2",
            details={
                "slide_key": slide_key,
                "updated_tokens": updated_tokens,
                "updated_count": updated_count,
                "prompt_length": len(user_prompt.strip()),
                "requested_tokens": target_tokens or [],
                "warnings": warnings,
            },
            job_id=job_id,
        )

        # Keep progress below preview stage completion; final completion is handled by router after preview generation.
        send_progress(76, "AI rewrite applied...")
        return {
            "job_id": job_id,
            "session_id": session_id,
            "slide_key": slide_key,
            "report_path": config.outputs_url_for(report_path),
            "slidespec": slidespec.model_dump(),
            "version": "v2",
            "rag_used": rag_used,
            "retrieval_trace": retrieval_trace,
            "retrieval_stats": retrieval_stats,
            "updated_slides": updated_slides,
            "updated_count": updated_count,
            "updated_tokens": updated_tokens,
            "warnings": warnings,
        }

    def rewrite(
        self,
        job_id: str,
        slide_key: str = None,
        new_content: Dict[str, Any] = None,
        slides: list[Dict[str, Any]] = None,
        ws_manager=None,
        event_loop=None,
        progress_callback=None,
    ) -> Dict[str, Any]:
        """Rewrite one or multiple slides with new content.

        Supports two modes:
        1. Single slide mode (legacy): provide slide_key + new_content
        2. Batch mode: provide slides array [{"slide_key": "...", "new_content": {...}}, ...]

        Args:
            job_id: Job ID in format "{session_id}:{template_id}"
            slide_key: (Optional) Slide key to update (single mode)
            new_content: (Optional) New placeholder content to merge (single mode)
            slides: (Optional) List of slides to update (batch mode)

        Returns:
            Dict with job_id, updated_slides, report_path, etc.
        """
        def send_progress(progress: int, message: str):
            if progress_callback:
                try:
                    progress_callback(progress, message)
                except Exception:
                    pass
            if ws_manager and event_loop:
                import asyncio
                try:
                    session = job_id.split(":", 1)[0]
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.send_progress_update(session, progress, message),
                        event_loop
                    )
                except Exception:
                    pass

        send_progress(8, "Validating update request...")

        try:
            session_id, template_id = job_id.split(":", 1)
        except ValueError as e:
            raise ValueError("job_id must be formatted as session_id:template_id") from e

        # Validate input mode
        has_single = slide_key is not None and new_content is not None
        has_batch = slides is not None and len(slides) > 0

        if not has_single and not has_batch:
            raise ValueError("Must provide either (slide_key + new_content) or slides array")

        if has_single and has_batch:
            raise ValueError("Cannot provide both single mode and batch mode simultaneously")

        # Load slidespec
        send_progress(22, "Loading report content...")
        slidespec = self._load_slidespec(session_id, template_id)
        chart_tokens_by_slide = self._get_chart_tokens_by_slide(template_id)

        # Normalize to batch mode internally
        if has_single:
            slides_to_update = [{"slide_key": slide_key, "new_content": new_content}]
        else:
            slides_to_update = slides

        input_id = self._get_input_id_for_job(job_id)

        # Update all slides
        updated_slides = []
        not_found_slides = []
        applied_updates_for_input: List[Dict[str, Any]] = []

        for slide_update in slides_to_update:
            key = slide_update.get("slide_key")
            content = slide_update.get("new_content", {})
            total_slides = max(1, len(slides_to_update))
            current_idx = len(updated_slides) + len(not_found_slides) + 1
            current_progress = 28 + int((current_idx / total_slides) * 30)
            send_progress(current_progress, f"Applying updates ({current_idx}/{total_slides})...")

            slide = slidespec.get_slide(key)
            if slide:
                if not isinstance(content, dict):
                    raise ValueError(f"Slide '{key}' new_content must be a JSON object.")

                chart_tokens = chart_tokens_by_slide.get(key, set())
                normalized_updates: Dict[str, Any] = {}

                for token, edited_value in content.items():
                    if token not in slide.placeholders:
                        raise ValueError(
                            f"Slide '{key}' contains unknown token '{token}'. "
                            "Adding/removing placeholder keys is not allowed."
                        )

                    original_value = slide.placeholders.get(token)
                    if token in chart_tokens:
                        normalized_original = self._strip_position_fields(original_value)
                        normalized_edited = self._strip_position_fields(edited_value)
                        if not self._has_same_structured_keys(normalized_original, normalized_edited):
                            raise ValueError(
                                "Structured JSON keys are locked. "
                                "Only value changes are allowed; key add/remove/rename is forbidden."
                            )
                        normalized_updates[token] = normalized_edited
                    else:
                        normalized_updates[token] = edited_value

                slide.placeholders.update(normalized_updates)
                updated_slides.append(key)
                if normalized_updates:
                    applied_updates_for_input.append(
                        {
                            "slide_key": key,
                            "new_content": normalized_updates,
                        }
                    )
            else:
                not_found_slides.append(key)

        # Use session-isolated paths
        report_path = self.session_manager.get_report_path(session_id, template_id)
        slidespec_path = self.session_manager.get_slidespec_path(session_id, template_id)

        # Save with file locks
        send_progress(66, "Saving slide specification...")
        with FileLock(slidespec_path, timeout=60.0):
            slidespec.save(slidespec_path)

        send_progress(72, "Rendering PPT...")
        with FileLock(report_path, timeout=60.0):
            self.ppt_generator_v2.render(slidespec, report_path)

        # Log audit event
        self.audit_logger.log(
            event="rewrite_v2",
            details={
                "updated_slides": updated_slides,
                "not_found_slides": not_found_slides,
                "total_updated": len(updated_slides),
            },
            job_id=job_id,
        )

        result = {
            "job_id": job_id,
            "session_id": session_id,
            "report_path": config.outputs_url_for(report_path),
            "warnings": [],
            "slidespec": slidespec.model_dump(),
            "version": "v2",
            "updated_slides": updated_slides,
            "updated_count": len(updated_slides),
        }

        # Add warnings for not found slides
        if not_found_slides:
            result["warnings"].append(
                f"浠ヤ笅骞荤伅鐗囨湭鎵惧埌: {', '.join(not_found_slides)}"
            )
            result["not_found_slides"] = not_found_slides

        sync_warnings = self._persist_manual_updates_to_session_input(
            session_id=session_id,
            input_id=input_id,
            template_id=template_id,
            applied_updates=applied_updates_for_input,
        )
        if sync_warnings:
            result["warnings"].extend(sync_warnings)

        # Legacy compatibility: return slide_key for single mode
        if has_single:
            result["slide_key"] = slide_key

        # Keep progress below preview stage completion; final completion is handled by router after preview generation.
        send_progress(76, "Slide update applied...")
        return result

    def read_logs(self, limit: int = 100) -> str:
        path = self.audit_logger.log_path
        if not path.exists():
            return ""
        lines = path.read_text(encoding="utf-8").splitlines()
        if limit <= 0:
            return "\n".join(lines)
        return "\n".join(lines[-limit:])

    def preview(
        self,
        job_id: str,
        regenerate_if_missing: bool = True,
        force_regenerate: bool = False,
    ) -> Dict[str, Any]:
        """Generate preview images for a report.

        Args:
            job_id: Job ID in format "{session_id}:{template_id}"
            regenerate_if_missing: Whether to regenerate report if missing
            force_regenerate: Whether to force regenerate previews even if cached

        Returns:
            Dict with job_id and list of image URLs
        """
        try:
            session_id, template_id = job_id.split(":", 1)
        except ValueError as e:
            raise ValueError("job_id must be formatted as session_id:template_id") from e

        report_path = self.get_report_path(job_id, regenerate_if_missing=regenerate_if_missing)

        job_dir = sanitize_job_id(job_id)
        preview_dir = config.PREVIEWS_DIR / job_dir
        meta_path = preview_dir / "meta.json"
        base_url_prefix = f"/static/previews/{job_dir}"

        slides_count = None
        try:
            slidespec = self._load_slidespec(session_id, template_id)
            slides_count = len(slidespec.slides)
        except Exception:
            slides_count = None

        report_stat = report_path.stat()
        report_mtime_ns = report_stat.st_mtime_ns
        report_size = report_stat.st_size

        preview_start = time.perf_counter()

        # Serialize preview generation per job_id to avoid concurrent delete/regenerate races.
        lock_target = config.PREVIEWS_DIR / f"{job_dir}.preview"
        lock_target.parent.mkdir(parents=True, exist_ok=True)

        with FileLock(lock_target, timeout=120.0):
            images: list[Path] = []
            has_images = False
            cached = False
            timings: Dict[str, Any] = {}

            def _list_cached_images() -> list[Path]:
                if not preview_dir.exists():
                    return []
                files = list(preview_dir.glob("slide*.png"))

                def _num(p: Path) -> int:
                    s = p.stem.replace("slide", "")
                    try:
                        return int(s)
                    except Exception:
                        return 10**9

                return sorted(files, key=_num)

            if not force_regenerate:
                cached_images = _list_cached_images()
                meta = None
                if meta_path.exists():
                    try:
                        meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    except Exception:
                        meta = None

                cache_ok = (
                    bool(cached_images)
                    and isinstance(meta, dict)
                    and (
                        meta.get("report_mtime_ns") == report_mtime_ns
                        or meta.get("report_mtime") == report_stat.st_mtime
                    )
                    and meta.get("report_size") == report_size
                    and (slides_count is None or len(cached_images) >= slides_count)
                )
                if cache_ok:
                    images = cached_images
                    has_images = True
                    cached = True
                    if isinstance(meta, dict):
                        timings = meta.get("timings") or {}

            if not has_images:
                # Work on a temp copy to avoid locks on the report file
                tmp_dir = config.PREVIEWS_DIR / "tmp"
                tmp_dir.mkdir(parents=True, exist_ok=True)
                tmp_copy = tmp_dir / f"{job_dir}.pptx"

                # Use file lock when copying to prevent race conditions
                with FileLock(report_path, timeout=30.0):
                    shutil.copyfile(report_path, tmp_copy)

                # Generate physical image files for the PPTX (overwrites preview_dir)
                images, timings = self.preview_generator.to_images_with_timings(tmp_copy, job_id)
                has_images = True

                try:
                    preview_dir.mkdir(parents=True, exist_ok=True)
                    timings = dict(timings) if isinstance(timings, dict) else {}
                    timings["cached"] = False
                    meta_path.write_text(
                        json.dumps(
                            {
                                "job_id": job_id,
                                "report_mtime_ns": report_mtime_ns,
                                "report_size": report_size,
                                "slides_count": slides_count,
                                "timings": timings,
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                        encoding="utf-8",
                    )
                except Exception:
                    # Never fail preview generation due to cache metadata I/O.
                    pass

        end_to_end_ms = (time.perf_counter() - preview_start) * 1000
        if not isinstance(timings, dict):
            timings = {}
        timings = dict(timings)
        timings.setdefault("cached", cached)
        timings["preview_service_ms"] = end_to_end_ms
        try:
            logger.info(
                "Preview timings: cached=%s pptx_to_pdf_ms=%s pdf_to_images_ms=%s total_ms=%s service_ms=%.0f",
                timings.get("cached"),
                f"{timings.get('pptx_to_pdf_ms', ''):.0f}" if isinstance(timings.get("pptx_to_pdf_ms"), (int, float)) else "",
                f"{timings.get('pdf_to_images_ms', ''):.0f}" if isinstance(timings.get("pdf_to_images_ms"), (int, float)) else "",
                f"{timings.get('pptx_to_images_total_ms', ''):.0f}" if isinstance(timings.get("pptx_to_images_total_ms"), (int, float)) else "",
                end_to_end_ms,
            )
        except Exception:
            pass

        if slides_count is None:
            slides_count = len(images)

        urls: list[str] = []
        if slides_count <= 0:
            urls = [f"{base_url_prefix}/{img_path.name}" for img_path in images]
        else:
            for idx in range(slides_count):
                img_idx = idx if idx < len(images) else len(images) - 1
                img_path = images[img_idx]
                urls.append(f"{base_url_prefix}/{img_path.name}")

        return {"job_id": job_id, "images": urls, "timings": timings}

    def get_report_path(self, job_id: str, regenerate_if_missing: bool = True) -> Path:
        """Return the generated PPTX path for a job, optionally regenerating it from the saved SlideSpec.

        Args:
            job_id: Job ID in format "{session_id}:{template_id}"
            regenerate_if_missing: Whether to regenerate report if missing

        Returns:
            Path to the report file

        Raises:
            SlideSpecNotFoundError: If report doesn't exist and can't be regenerated
        """
        try:
            session_id, template_id = job_id.split(":", 1)
        except ValueError as e:
            raise ValueError("job_id must be formatted as session_id:template_id") from e

        report_path = self.session_manager.get_report_path(session_id, template_id)

        if not report_path.exists() and regenerate_if_missing:
            slidespec = self._load_slidespec(session_id, template_id)
            with FileLock(report_path, timeout=60.0):
                self.ppt_generator_v2.render(slidespec, report_path)

        if not report_path.exists():
            raise SlideSpecNotFoundError(f"PPT not found for {job_id}, generate first.")

        return report_path

    def get_pdf_path(self, job_id: str, regenerate_if_missing: bool = True) -> Path:
        """Return the PDF path for a job, generating it from the PPTX if needed.

        Args:
            job_id: Job ID in format "{session_id}:{template_id}"
            regenerate_if_missing: Whether to regenerate PDF if missing

        Returns:
            Path to the PDF file

        Raises:
            SlideSpecNotFoundError: If report doesn't exist and can't be generated
        """
        # First ensure the PPTX exists
        report_path = self.get_report_path(job_id, regenerate_if_missing=regenerate_if_missing)

        # Get or generate PDF using preview generator
        pdf_path = self.preview_generator.get_pdf_path(report_path, job_id)

        return pdf_path

    def cleanup_old_sessions(self, max_age_hours: int = 168) -> int:
        """Clean up old session directories.

        Args:
            max_age_hours: Maximum age in hours before cleanup

        Returns:
            Number of sessions cleaned up
        """
        return self.session_manager.cleanup_old_sessions(max_age_hours)
