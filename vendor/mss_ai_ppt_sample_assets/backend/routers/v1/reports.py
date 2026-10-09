"""Reports API endpoints - RESTful report generation and management."""

from fastapi import APIRouter, HTTPException, status, Request, Response
from fastapi.responses import FileResponse
from datetime import datetime, timezone
import asyncio
import logging
import uuid
from typing import Optional, Any, Dict
from tenacity import RetryError

from ... import config
from ...services.report_service import ReportService, SlideSpecNotFoundError as ServiceSlideSpecNotFoundError
from ...services.job_manager import JobManager
from ...models.job_state import JobStatus
from ...schemas.responses import SuccessResponse
from ...schemas.requests import CreateReportRequest, UpdateSlidesRequest, AISlideRewriteRequest
from ...exceptions import (
    InputNotFoundError,
    TemplateNotFoundError,
    SlideSpecNotFoundError,
    LLMGenerationError
)
from ...modules.llm_orchestrator import LLMGenerationError as OrchestratorLLMGenerationError
from ...modules.retry_policy import is_retryable_llm_error
from openai import RateLimitError, APIConnectionError, APITimeoutError

logger = logging.getLogger(__name__)

router = APIRouter()
service = ReportService()

# Browser-scoped identifiers and limits.
BROWSER_ID_COOKIE_NAME = "mss_browser_id"
BROWSER_ID_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60
BROWSER_ID_RUNNING_TASK_LIMIT = 1

# Dependencies initialized by app.py
ws_manager = None
llm_semaphore = None
MAX_CONCURRENT_LLM_REQUESTS = 3
job_manager: JobManager = None
_session_job_map: Dict[str, str] = {}
LLM_TIMEOUT_EXHAUSTED = "LLM_TIMEOUT_EXHAUSTED"
LLM_UPSTREAM_CONNECTION_FAILED = "LLM_UPSTREAM_CONNECTION_FAILED"
LLM_RATE_LIMIT_EXHAUSTED = "LLM_RATE_LIMIT_EXHAUSTED"
TASK_SUPERSEDED = "TASK_SUPERSEDED"


def init_dependencies(websocket_manager, semaphore, max_concurrent, manager):
    """Initialize dependencies from app module."""
    global ws_manager, llm_semaphore, MAX_CONCURRENT_LLM_REQUESTS, job_manager
    ws_manager = websocket_manager
    llm_semaphore = semaphore
    MAX_CONCURRENT_LLM_REQUESTS = max_concurrent
    job_manager = manager
    if ws_manager and hasattr(ws_manager, "set_progress_callback"):
        ws_manager.set_progress_callback(_sync_job_progress_from_session)


def _resolve_job_id_by_session(session_id: str) -> Optional[str]:
    """Resolve job_id from session_id using cache first, then store lookup."""
    if not job_manager:
        return None

    cached_job_id = _session_job_map.get(session_id)
    if cached_job_id:
        cached_job = job_manager.get_job(cached_job_id)
        if cached_job and cached_job.session_id == session_id:
            return cached_job_id
        _session_job_map.pop(session_id, None)

    for status_value in (JobStatus.RUNNING, JobStatus.PENDING, JobStatus.COMPLETED):
        jobs = job_manager.store.list_jobs(status=status_value, limit=0)
        for job in jobs:
            if job.session_id == session_id:
                _session_job_map[session_id] = job.job_id
                return job.job_id

    return None


def _sync_job_progress_from_session(session_id: str, progress: int, message: str):
    """Persist websocket progress updates into job status for polling clients."""
    if not job_manager:
        return

    job_id = _resolve_job_id_by_session(session_id)
    if not job_id:
        return

    job_manager.update_progress(job_id, progress, message)


def _get_or_create_browser_id(request: Request) -> str:
    """Get browser identifier from cookie, or create a new one."""
    raw = (request.cookies.get(BROWSER_ID_COOKIE_NAME) or "").strip().lower()
    if len(raw) == 32 and all(ch in "0123456789abcdef" for ch in raw):
        return raw
    return uuid.uuid4().hex


def _attach_browser_cookie(response: Response, browser_id: str):
    """Persist browser identifier as HttpOnly cookie."""
    response.set_cookie(
        key=BROWSER_ID_COOKIE_NAME,
        value=browser_id,
        max_age=BROWSER_ID_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=False,
        path="/",
    )


def _build_default_idempotency_key(
    browser_id: str,
    req: CreateReportRequest,
) -> str:
    """Build a stable idempotency key for refresh-safe report generation."""
    focus = ",".join(sorted(req.focus_options or []))
    return (
        f"browser:{browser_id}|"
        f"input:{req.input_id}|"
        f"template:{req.template_id}|"
        f"use_mock:{int(req.use_mock)}|"
        f"use_rag:{int(req.use_rag)}|"
        f"focus:{focus}"
    )


def _find_running_job_for_browser(browser_id: str) -> Optional[Any]:
    """Return running job for the browser, if any."""
    if not job_manager:
        return None

    running_jobs = job_manager.store.list_jobs(status=JobStatus.RUNNING, limit=0)
    for running_job in running_jobs:
        metadata = running_job.metadata or {}
        if metadata.get("browser_id") == browser_id:
            return running_job
    return None


def _classify_llm_error(error: Exception) -> str:
    if isinstance(error, RetryError):
        last_exc = error.last_attempt.exception() if error.last_attempt else None
        if isinstance(last_exc, Exception):
            error = last_exc
    if isinstance(error, APITimeoutError):
        return LLM_TIMEOUT_EXHAUSTED
    if isinstance(error, APIConnectionError):
        return LLM_UPSTREAM_CONNECTION_FAILED
    if isinstance(error, RateLimitError):
        return LLM_RATE_LIMIT_EXHAUSTED
    return "LLM_GENERATION_FAILED"


def _mark_job_running_for_rewrite(job_id: str, browser_id: str, message: str):
    """Mark an existing job as running for rewrite flows."""
    try:
        if not job_manager:
            return
        existing = job_manager.get_job(job_id)
        if not existing:
            return

        metadata = dict(existing.metadata or {})
        metadata["browser_id"] = browser_id

        job_manager.store.update_job(
            job_id,
            {
                "status": JobStatus.RUNNING,
                "started_at": datetime.now(timezone.utc),
                "completed_at": None,
                "progress": 0,
                "message": message,
                "metadata": metadata,
            },
        )
        _session_job_map[existing.session_id] = job_id
    except Exception as e:
        logger.warning("Failed to mark rewrite job as running: job_id=%s err=%s", job_id, e)


def _mark_job_completed_for_rewrite(job_id: str, result: Dict[str, Any], message: str):
    """Mark rewrite flow as completed without creating a new job."""
    try:
        if not job_manager:
            return
        existing = job_manager.get_job(job_id)
        if not existing:
            return

        metadata = dict(existing.metadata or {})
        metadata["warnings"] = result.get("warnings", [])
        metadata["version"] = result.get("version", metadata.get("version", "v2"))
        metadata["rag_used"] = bool(result.get("rag_used", False))
        metadata["retrieval_trace"] = result.get("retrieval_trace", [])
        preview_timings = result.get("preview_timings")
        if isinstance(preview_timings, dict):
            metadata["preview_timings"] = preview_timings

        update_payload = {
            "status": JobStatus.COMPLETED,
            "completed_at": datetime.now(timezone.utc),
            "progress": 100,
            "message": message,
            "report_path": result.get("report_path", existing.report_path),
            "slidespec_path": result.get("slidespec_path", existing.slidespec_path),
            "metadata": metadata,
        }
        if result.get("preview_urls") is not None:
            update_payload["preview_urls"] = result.get("preview_urls")

        job_manager.store.update_job(job_id, update_payload)
        _session_job_map.pop(existing.session_id, None)
    except Exception as e:
        logger.warning("Failed to mark rewrite job as completed: job_id=%s err=%s", job_id, e)


def _mark_job_failed_for_rewrite(job_id: str, error_message: str):
    """Mark rewrite flow as failed for polling fallback."""
    try:
        if not job_manager:
            return
        existing = job_manager.get_job(job_id)
        if not existing:
            return

        job_manager.store.update_job(
            job_id,
            {
                "status": JobStatus.FAILED,
                "completed_at": datetime.now(timezone.utc),
                "message": error_message,
                "last_error": error_message,
            },
        )
        _session_job_map.pop(existing.session_id, None)
    except Exception as e:
        logger.warning("Failed to mark rewrite job as failed: job_id=%s err=%s", job_id, e)


async def _process_report_async(
    job_id: str,
    input_id: str,
    template_id: str,
    use_mock: bool,
    focus_options=None,
    use_rag: bool = True,
):
    """Background task to process report generation.

    This runs asynchronously after returning response to client.
    Updates job state and sends WebSocket notifications.
    """
    job = job_manager.get_job(job_id)
    if not job:
        logger.error(f"Job not found in async processor: {job_id}")
        return
    _session_job_map[job.session_id] = job_id

    max_attempts = max(1, int(config.settings.llm_retry_attempts)) if not use_mock else 1
    for attempt in range(1, max_attempts + 1):
        try:
            # Acquire LLM semaphore if not using mock
            if not use_mock and llm_semaphore:
                async with llm_semaphore:
                    await _do_generation(
                        job,
                        input_id,
                        template_id,
                        use_mock,
                        focus_options=focus_options,
                        use_rag=use_rag,
                    )
            else:
                await _do_generation(
                    job,
                    input_id,
                    template_id,
                    use_mock,
                    focus_options=focus_options,
                    use_rag=use_rag,
                )
            return
        except Exception as e:
            if not use_mock and is_retryable_llm_error(e) and attempt < max_attempts:
                wait_time = max(0.0, float(config.settings.llm_retry_backoff_min_seconds)) * (2 ** (attempt - 1))
                wait_time = min(wait_time, float(config.settings.llm_retry_backoff_max_seconds))
                retry_message = f"AI request timeout/connection issue. Retrying ({attempt}/{max_attempts - 1})..."
                job_manager.update_progress(job_id, 30, retry_message)
                logger.warning(
                    "Retrying job due to transient LLM failure: job_id=%s attempt=%s/%s err=%s",
                    job_id,
                    attempt,
                    max_attempts,
                    e,
                )
                if ws_manager:
                    await ws_manager.send_progress_update(job.session_id, 30, retry_message)
                await asyncio.sleep(wait_time)
                continue

            logger.exception(f"Job {job_id} failed: {e}")
            _session_job_map.pop(job.session_id, None)

            error_code = _classify_llm_error(e) if is_retryable_llm_error(e) else None
            user_message = (
                "AI service timeout. Please regenerate a new task."
                if error_code in {LLM_TIMEOUT_EXHAUSTED, LLM_UPSTREAM_CONNECTION_FAILED}
                else str(e)
            )
            job_manager.fail_job(
                job_id,
                str(e),
                error_code=error_code,
                user_message=user_message,
                increment_retry=True,
            )

            # Send WebSocket failure notification
            if ws_manager:
                await ws_manager.send_completion(
                    job.session_id,
                    {"error": user_message, "error_code": error_code},
                    success=False,
                )
            return


async def _do_generation(
    job,
    input_id: str,
    template_id: str,
    use_mock: bool,
    focus_options=None,
    use_rag: bool = True,
):
    """Execute the actual generation (called with semaphore acquired)."""
    job_id = job.job_id

    # Send WebSocket progress updates
    if ws_manager:
        await ws_manager.send_progress_update(
            job.session_id, 5, "Loading template and input data..."
        )

    # Get the current event loop to pass to synchronous code
    loop = asyncio.get_running_loop()

    # Run synchronous generation in thread pool, passing the loop
    result = await loop.run_in_executor(
        None,
        lambda: service.generate(
            input_id,
            template_id,
            use_mock=use_mock,
            focus_options=focus_options,
            use_rag=use_rag,
            session_id=job.session_id,
            ws_manager=ws_manager,
            event_loop=loop  # Pass the main event loop
        )
    )

    logger.info(f"Generation successful: {job_id}")

    # Continue generation flow with preview rendering before marking job completed.
    if ws_manager:
        await ws_manager.send_progress_update(
            job.session_id, 78, "Rendering preview images..."
        )

    try:
        preview_result = await loop.run_in_executor(
            None,
            lambda: service.preview(
                job_id,
                regenerate_if_missing=True,
                force_regenerate=False,
            )
        )
        preview_urls = preview_result.get("preview_urls") or preview_result.get("images") or []
        if preview_urls:
            result["preview_urls"] = preview_urls
        preview_timings = preview_result.get("timings")
        if isinstance(preview_timings, dict):
            result["preview_timings"] = preview_timings

        if ws_manager:
            await ws_manager.send_progress_update(
                job.session_id, 95, "Preview rendering completed..."
            )
    except Exception as preview_error:
        logger.warning("Preview generation failed for job %s: %s", job_id, preview_error)
        warnings = result.get("warnings")
        if not isinstance(warnings, list):
            warnings = []
            result["warnings"] = warnings
        warnings.append(f"Preview generation failed: {preview_error}")

        if ws_manager:
            await ws_manager.send_progress_update(
                job.session_id, 95, "Report generated. Preview can be retried later."
            )

    if ws_manager:
        await ws_manager.send_progress_update(
            job.session_id, 99, "Finalizing report..."
        )

    latest_job = job_manager.get_job(job_id)
    if latest_job and latest_job.status == JobStatus.CANCELLED and latest_job.error_code == TASK_SUPERSEDED:
        logger.info("Skip completion for superseded job: %s", job_id)
        _session_job_map.pop(job.session_id, None)
        return

    # Mark job as completed
    job_manager.complete_job(job_id, result)
    _session_job_map.pop(job.session_id, None)

    # Send WebSocket completion
    if ws_manager:
        await ws_manager.send_completion(job.session_id, result, success=True)


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,  # Changed to 202 for async processing
    response_model=SuccessResponse,
    summary="Create Report",
    description="""
    Create a new PowerPoint report (async processing with idempotency support).

    ## New Features
    - **Idempotency**: Use `idempotency_key` to prevent duplicate processing
    - **Async Processing**: Returns immediately with job_id, check status via GET /api/v1/jobs/{job_id}/status
    - **Progress Tracking**: Monitor progress via WebSocket or status API

    ## Processing Flow
    1. Create or find existing job (idempotency check)
    2. Return job_id immediately (202 Accepted)
    3. Process generation in background
    4. Client queries job status to get results

    ## Idempotency
    If you provide an `idempotency_key`, subsequent requests with the same key will:
    - Return existing job if already completed
    - Return current progress if still running
    - Not create duplicate jobs

    ## Response Codes
    - `202`: Job created/found, processing started/continuing
    - `404`: Input data or template not found
    """,
    responses={
        202: {
            "description": "Job created and processing started",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "job_id": "abc123_20260202110000:mss_executive_v2",
                            "status": "running",
                            "message": "Generating report, please wait..."
                        }
                    }
                }
            }
        },
        404: {"description": "Input or template not found"},
    }
)
async def create_report(request: Request, response: Response, req: CreateReportRequest):
    """Create a new report with async processing and idempotency support."""
    browser_id = _get_or_create_browser_id(request)
    _attach_browser_cookie(response, browser_id)
    client_ip = request.client.host if request.client else "unknown"
    forced_new_task = bool(req.force_new_task)
    effective_idempotency_key = (
        f"force:{uuid.uuid4().hex}"
        if forced_new_task
        else (req.idempotency_key or _build_default_idempotency_key(browser_id=browser_id, req=req))
    )

    logger.info(
        f"=== POST /api/v1/reports: browser_id={browser_id}, client_ip={client_ip}, input_id={req.input_id}, "
        f"template_id={req.template_id}, use_mock={req.use_mock}, idempotency_key={effective_idempotency_key}, "
        f"use_rag={req.use_rag}, client_id={req.client_id}, "
        f"session_id={req.session_id}, focus_options={req.focus_options}, force_new_task={forced_new_task} ==="
    )

    if not job_manager:
        raise HTTPException(status_code=500, detail="Job manager not initialized")

    try:
        running_job = _find_running_job_for_browser(browser_id)
        if running_job and not forced_new_task and BROWSER_ID_RUNNING_TASK_LIMIT >= 1:
            _session_job_map[running_job.session_id] = running_job.job_id
            if ws_manager and req.client_id:
                ws_manager.register_session(running_job.session_id, req.client_id)

            logger.info(
                "Browser has running job; reusing existing task: browser_id=%s job_id=%s",
                browser_id,
                running_job.job_id,
            )
            running_message = (running_job.message or "").strip() or "Generating report, please wait..."
            return SuccessResponse(data={
                "job_id": running_job.job_id,
                "session_id": running_job.session_id,
                "status": "running",
                "progress": running_job.progress,
                "existing_job": True,
                "message": running_message,
                "check_status_url": f"/api/v1/jobs/{running_job.job_id}/status",
            })

        superseded_job_id = None
        if forced_new_task and running_job:
            superseded_job_id = running_job.job_id
            job_manager.cancel_job(
                running_job.job_id,
                message="Task superseded by a newer regenerate request.",
                error_code=TASK_SUPERSEDED,
            )
            _session_job_map.pop(running_job.session_id, None)
            logger.info(
                "Superseded running job with forced new task: browser_id=%s old_job_id=%s",
                browser_id,
                running_job.job_id,
            )

        # Create or find existing job (idempotency)
        job = job_manager.create_job(
            input_id=req.input_id,
            template_id=req.template_id,
            idempotency_key=effective_idempotency_key,
            session_id=None if forced_new_task else req.session_id,
            metadata={
                "browser_id": browser_id,
                "client_ip": client_ip,
            },
        )

        if superseded_job_id:
            try:
                job_manager.cancel_job(
                    superseded_job_id,
                    message="Task superseded by a newer regenerate request.",
                    error_code=TASK_SUPERSEDED,
                    metadata_patch={
                        "superseded_by_job_id": job.job_id,
                        "superseded_at": datetime.now(timezone.utc).isoformat(),
                    },
                )
            except Exception:
                logger.warning("Failed to patch superseded metadata for %s", superseded_job_id)

        # Register WebSocket if provided
        if ws_manager and req.client_id:
            ws_manager.register_session(job.session_id, req.client_id)
            logger.info(f"Registered WebSocket: session={job.session_id}, client={req.client_id}")
        else:
            logger.warning(f"WebSocket NOT registered: ws_manager={ws_manager is not None}, client_id={req.client_id}")

        # If job already completed, return cached result
        if job.status == JobStatus.COMPLETED:
            logger.info(f"Job already completed (idempotency): {job.job_id}")
            return SuccessResponse(data={
                "job_id": job.job_id,
                "status": "completed",
                "report_path": job.report_path,
                "slidespec_path": job.slidespec_path,
                "from_cache": True,
                "is_new_task": forced_new_task,
                "superseded_job_id": superseded_job_id,
                "message": "Job already completed (using cached result).",
            })

        # If job is running, return current progress
        if job.status == JobStatus.RUNNING:
            logger.info(f"Job already running: {job.job_id}")
            # Format message based on progress
            if job.progress > 0:
                message = f"Job is running ({job.progress}%)"
            else:
                message = "Job is running, please wait..."

            return SuccessResponse(data={
                "job_id": job.job_id,
                "status": "running",
                "progress": job.progress,
                "is_new_task": forced_new_task,
                "superseded_job_id": superseded_job_id,
                "message": message,
                "check_status_url": f"/api/v1/jobs/{job.job_id}/status"
            })

        # Start new job
        job_manager.start_job(job.job_id)

        # Send initial WebSocket notification
        if ws_manager and req.client_id:
            await ws_manager.send_progress_update(
                job.session_id, 0, "Request accepted, queued for processing...",
                {"template": req.template_id}
            )

        # Launch background task
        asyncio.create_task(
            _process_report_async(
                job.job_id,
                req.input_id,
                req.template_id,
                req.use_mock,
                focus_options=req.focus_options,
                use_rag=req.use_rag,
            )
        )
        _session_job_map[job.session_id] = job.job_id

        logger.info(f"Job created and processing started: {job.job_id}")
        return SuccessResponse(data={
            "job_id": job.job_id,
            "session_id": job.session_id,
            "status": "running",
            "is_new_task": forced_new_task,
            "superseded_job_id": superseded_job_id,
            "message": "Generating report, please wait...",
            "check_status_url": f"/api/v1/jobs/{job.job_id}/status"
        })

    except InputNotFoundError as e:
        logger.error(f"Input not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except TemplateNotFoundError as e:
        logger.error(f"Template not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to create job: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/{report_id}/download",
    summary="Download Report",
    description="""
    Download the generated PowerPoint report file.

    The `report_id` is the job_id returned from POST /api/v1/reports.
    """,
    responses={
        200: {
            "description": "Report file downloaded successfully",
            "content": {"application/vnd.openxmlformats-officedocument.presentationml.presentation": {}}
        },
        404: {"description": "Report not found"}
    }
)
async def download_report(
    report_id: str,
    regenerate_if_missing: bool = True
):
    """Download report file."""
    try:
        report_path = service.get_report_path(report_id, regenerate_if_missing=regenerate_if_missing)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        download_name = f"{ts}_{report_path.name}"

        logger.info(f"Downloading report: {report_id}")
        return FileResponse(
            path=report_path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            filename=download_name,
        )
    except SlideSpecNotFoundError as e:
        logger.error(f"Report not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        logger.error(f"Invalid request: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Download failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/{report_id}/download-pdf",
    summary="Download Report as PDF",
    description="""
    Download the generated report as a continuous PDF file.

    The system converts the PowerPoint report to PDF using LibreOffice.
    The PDF file is cached and reused if available.

    The `report_id` is the job_id returned from POST /api/v1/reports.
    """,
    responses={
        200: {
            "description": "PDF file downloaded successfully",
            "content": {"application/pdf": {}}
        },
        404: {"description": "Report not found"}
    }
)
async def download_report_pdf(
    report_id: str,
    regenerate_if_missing: bool = True
):
    """Download report as PDF file."""
    try:
        pdf_path = service.get_pdf_path(report_id, regenerate_if_missing=regenerate_if_missing)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Extract base name without extension from original report
        base_name = pdf_path.stem.replace(".pdf", "")
        download_name = f"{ts}_{base_name}.pdf"

        logger.info(f"Downloading PDF: {report_id}")
        return FileResponse(
            path=pdf_path,
            media_type="application/pdf",
            filename=download_name,
        )
    except SlideSpecNotFoundError as e:
        logger.error(f"Report not found for PDF: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        logger.error(f"Invalid request: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"PDF download failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/{report_id}/preview",
    response_model=SuccessResponse,
    summary="Get Report Preview",
    description="""
    Get preview images (PNG) for all slides in the report.

    The system converts PPT -> PDF -> PNG for preview generation.
    Preview images are cached and reused if available.
    """,
    responses={
        200: {
            "description": "Preview images generated successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "preview_urls": [
                                "/static/previews/job123/slide1.png",
                                "/static/previews/job123/slide2.png"
                            ]
                        }
                    }
                }
            }
        },
        404: {"description": "Report not found"}
    }
)
async def preview_report(
    report_id: str,
    regenerate_if_missing: bool = True,
    force_regenerate: bool = False,
):
    """Get report preview images."""
    try:
        result = service.preview(
            report_id,
            regenerate_if_missing=regenerate_if_missing,
            force_regenerate=force_regenerate,
        )
        logger.info(f"Preview generated for: {report_id}")
        return SuccessResponse(data=result)
    except SlideSpecNotFoundError as e:
        logger.error(f"Report not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Preview generation failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch(
    "/{report_id}/slides",
    response_model=SuccessResponse,
    summary="Update Report Slides",
    description="""
    Batch update multiple slides in an existing report.

    This endpoint allows you to modify specific placeholders in one or more slides
    without regenerating the entire report.
    """,
    responses={
        200: {
            "description": "Slides updated successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "job_id": "tenant_acme:mss_executive_v2",
                            "updated_slides": ["cover", "summary"],
                            "updated_count": 2,
                            "warnings": [],
                            "report_path": "outputs/sessions/abc123/report.pptx"
                        }
                    }
                }
            }
        },
        404: {"description": "Report not found"},
        400: {"description": "Invalid request"}
    }
)
async def update_slides(report_id: str, req: UpdateSlidesRequest, request: Request):
    """Batch update report slides."""
    try:
        browser_id = _get_or_create_browser_id(request)
        _mark_job_running_for_rewrite(
            report_id,
            browser_id,
            "Rewriting slides, please wait...",
        )

        if ws_manager and req.client_id:
            session_id = report_id.split(":", 1)[0]
            ws_manager.register_session(session_id, req.client_id)

        # Convert UpdateSlidesRequest to service format
        slides_data = [{"slide_key": s.slide_key, "new_content": s.new_content} for s in req.slides]

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: service.rewrite(
                job_id=report_id,
                slides=slides_data,
                ws_manager=ws_manager,
                event_loop=loop,
                progress_callback=(lambda progress, message: job_manager.update_progress(report_id, progress, message)) if job_manager else None,
            )
        )

        # Keep rewrite job in RUNNING state until preview generation finishes.
        session_id = report_id.split(":", 1)[0]
        if job_manager:
            job_manager.update_progress(report_id, 78, "Rendering preview images...")
        if ws_manager:
            await ws_manager.send_progress_update(session_id, 78, "Rendering preview images...")
        preview_result = await loop.run_in_executor(
            None,
            lambda: service.preview(
                report_id,
                regenerate_if_missing=True,
                force_regenerate=True,
            ),
        )
        preview_urls = preview_result.get("preview_urls") or preview_result.get("images") or []
        if isinstance(preview_urls, list):
            result["preview_urls"] = preview_urls
        if isinstance(preview_result.get("timings"), dict):
            result["preview_timings"] = preview_result.get("timings")

        _mark_job_completed_for_rewrite(report_id, result, "Slide rewrite completed")
        logger.info(f"Updated {len(req.slides)} slides in report: {report_id}")
        return SuccessResponse(data=result)
    except SlideSpecNotFoundError as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.error(f"Report not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.error(f"Invalid request: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.exception(f"Slide update failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{report_id}/slides/ai-rewrite",
    response_model=SuccessResponse,
    summary="AI Rewrite Single Slide",
    description="""
    Rewrite one slide using AI with user preference instructions.

    The endpoint updates only AI-generated placeholders for the selected slide,
    then re-renders the report and returns updated slidespec.
    """,
    responses={
        200: {
            "description": "AI rewrite completed",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "job_id": "tenant_acme:mss_executive_v2",
                            "slide_key": "summary",
                            "updated_slides": ["summary"],
                            "updated_count": 1,
                            "updated_tokens": ["HEADLINE", "KEY_POINTS"],
                            "warnings": []
                        }
                    }
                }
            }
        },
        404: {"description": "Report not found"},
        400: {"description": "Invalid request"},
        500: {"description": "AI generation failed"}
    }
)
async def ai_rewrite_slide(report_id: str, req: AISlideRewriteRequest, request: Request):
    """AI rewrite a single slide with user preference prompt."""
    try:
        browser_id = _get_or_create_browser_id(request)
        _mark_job_running_for_rewrite(
            report_id,
            browser_id,
            "AI rewriting slide, please wait...",
        )

        if ws_manager and req.client_id:
            session_id = report_id.split(":", 1)[0]
            ws_manager.register_session(session_id, req.client_id)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: service.ai_rewrite_slide(
                job_id=report_id,
                slide_key=req.slide_key,
                user_prompt=req.user_prompt,
                target_tokens=req.target_tokens,
                use_rag=req.use_rag,
                ws_manager=ws_manager,
                event_loop=loop,
                progress_callback=(lambda progress, message: job_manager.update_progress(report_id, progress, message)) if job_manager else None,
            )
        )

        # Keep rewrite job in RUNNING state until preview generation finishes.
        session_id = report_id.split(":", 1)[0]
        if job_manager:
            job_manager.update_progress(report_id, 78, "Rendering preview images...")
        if ws_manager:
            await ws_manager.send_progress_update(session_id, 78, "Rendering preview images...")
        preview_result = await loop.run_in_executor(
            None,
            lambda: service.preview(
                report_id,
                regenerate_if_missing=True,
                force_regenerate=True,
            ),
        )
        preview_urls = preview_result.get("preview_urls") or preview_result.get("images") or []
        if isinstance(preview_urls, list):
            result["preview_urls"] = preview_urls
        if isinstance(preview_result.get("timings"), dict):
            result["preview_timings"] = preview_result.get("timings")

        _mark_job_completed_for_rewrite(report_id, result, "AI rewrite completed")
        logger.info(f"AI rewrite completed: report={report_id}, slide={req.slide_key}")
        return SuccessResponse(data=result)
    except (SlideSpecNotFoundError, ServiceSlideSpecNotFoundError) as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.error(f"Report not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.error(f"Invalid AI rewrite request: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except (LLMGenerationError, OrchestratorLLMGenerationError, RateLimitError) as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.error(f"AI rewrite failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        _mark_job_failed_for_rewrite(report_id, str(e))
        logger.exception(f"AI rewrite failed unexpectedly: {e}")
        raise HTTPException(status_code=500, detail=str(e))
