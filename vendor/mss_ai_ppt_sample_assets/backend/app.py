from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from pathlib import Path
import logging
import asyncio
import mimetypes
import shutil
import time

from mss_ai_ppt_sample_assets.backend.services.report_service import ReportService
from mss_ai_ppt_sample_assets.backend.services.job_manager import (
    JobManager,
    RESTART_INTERRUPTED_ERROR_MESSAGE,
)
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore
from mss_ai_ppt_sample_assets.backend.modules.preview_generator import sanitize_job_id
from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.websocket_support import WebSocketManager
from mss_ai_ppt_sample_assets.backend.routers import v1_router

# Import new modules
from mss_ai_ppt_sample_assets.backend.logging_config import setup_logging
from mss_ai_ppt_sample_assets.backend.middleware import RequestIdMiddleware, ErrorLoggingMiddleware

# Setup enhanced logging with file persistence and rotation
setup_logging(
    log_level=config.settings.log_level,
    log_dir=config.LOGS_DIR,
    max_bytes=config.settings.log_max_bytes,
    backup_count=config.settings.log_backup_count
)
logger = logging.getLogger(__name__)

# Ensure SVG static files are served with the standard MIME type.
mimetypes.add_type("image/svg+xml", ".svg")

app = FastAPI(
    title="MSS AI PPT API",
    version="1.0.0",
    description="Intelligent Report Generation Platform - RESTful API",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Add middleware for request tracking and logging
app.add_middleware(ErrorLoggingMiddleware)
app.add_middleware(RequestIdMiddleware)

# Add session middleware for admin authentication
app.add_middleware(
    SessionMiddleware,
    secret_key=config.settings.admin_session_secret,
    session_cookie="admin_session",
    max_age=config.settings.admin_session_max_age,
    same_site="lax",
    https_only=False  # Set to True in production with HTTPS
)

# Configuration
MAX_CONCURRENT_LLM_REQUESTS = 5
llm_semaphore = asyncio.Semaphore(MAX_CONCURRENT_LLM_REQUESTS)

# Compact startup log with key configuration
logger.info(
    f"MSS AI PPT Backend | "
    f"LLM: {config.settings.openai_model} ({config.settings.openai_base_url}) | "
    f"Concurrency: {MAX_CONCURRENT_LLM_REQUESTS} | "
    f"Log: {config.settings.log_level} "
    f"({config.settings.log_max_bytes / (1024*1024):.0f}MB x {config.settings.log_backup_count})"
)

# Services
service = ReportService()
ws_manager = WebSocketManager()

# Job management
job_store = JobStore(config.JOBS_DIR)
job_manager = JobManager(job_store, service)

logger.info(f"Services initialized | Job retention: {config.settings.job_retention_days}d | Max retries: {config.settings.job_max_retries}")

app.mount("/static/previews", StaticFiles(directory=config.PREVIEWS_DIR), name="previews")

# Expose outputs directory (sessions/reports/jobs, etc.) for development/admin use.
# In production, prefer downloading via authenticated endpoints.
app.mount(config.OUTPUTS_URL_PREFIX, StaticFiles(directory=config.OUTPUTS_DIR), name="outputs")

# Register v1 API router
app.include_router(v1_router)

# Initialize dependencies for reports router (WebSocket and semaphore)
from mss_ai_ppt_sample_assets.backend.routers.v1 import reports, jobs, admin, ratings
reports.init_dependencies(ws_manager, llm_semaphore, MAX_CONCURRENT_LLM_REQUESTS, job_manager)
jobs.init_dependencies(job_manager)
admin.init_dependencies(job_store)
ratings.init_dependencies(job_store)

logger.info("API routes registered | WebSocket, JobManager, AdminService, RatingService initialized")

# 简单的前端静态页面（无需 npm），挂载在 /ui
FRONTEND_DIR = Path(__file__).parent / "frontend"
if FRONTEND_DIR.exists():
    app.mount("/ui", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
    ASSETS_DIR = FRONTEND_DIR / "assets"
    if ASSETS_DIR.exists():
        app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")

# Mount i18n directory for translation files
I18N_DIR = FRONTEND_DIR / "i18n"
if I18N_DIR.exists():
    app.mount("/i18n", StaticFiles(directory=I18N_DIR), name="i18n")


# ==================== WebSocket Endpoint ====================

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """WebSocket connection for real-time progress updates."""
    await ws_manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(client_id)


# ==================== Root Endpoint ====================

@app.get("/")
def root():
    """Redirect root to the frontend UI."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/ui/index.html")


@app.get("/api")
def api_root():
    """API root endpoint with service information."""
    return {
        "message": "MSS AI PPT API v1.0",
        "description": "Intelligent Report Generation Platform",
        "documentation": "/docs",
        "redoc": "/redoc",
        "api_version": "v1",
        "api_prefix": "/api/v1",
        "endpoints": {
            "reports": "/api/v1/reports",
            "templates": "/api/v1/templates",
            "inputs": "/api/v1/inputs",
            "sessions": "/api/v1/sessions",
            "system": "/api/v1/system",
            "rag": "/api/v1/rag",
            "websocket": "/ws/{client_id}"
        }
    }


# ==================== Startup Event ====================

def _cleanup_preview_tmp() -> int:
    """Remove transient preview workspace left behind by previous runs."""
    tmp_dir = config.PREVIEWS_DIR / "tmp"
    if not tmp_dir.exists():
        return 0

    removed_count = 0
    for item in tmp_dir.iterdir():
        try:
            if item.is_dir():
                shutil.rmtree(item, ignore_errors=True)
            else:
                item.unlink(missing_ok=True)
            removed_count += 1
        except Exception as exc:
            logger.warning("Preview tmp cleanup failed for %s: %s", item, exc)

    try:
        if tmp_dir.exists() and not any(tmp_dir.iterdir()):
            tmp_dir.rmdir()
    except Exception:
        pass

    return removed_count


def _cleanup_preview_artifacts() -> int:
    """Remove old or orphaned preview directories and stale preview PDFs."""
    previews_dir = config.PREVIEWS_DIR
    if not previews_dir.exists():
        return 0

    index = job_store._load_index()
    known_preview_dirs = {sanitize_job_id(job_id) for job_id in index.keys()}
    known_sessions = {
        path.name
        for path in config.SESSIONS_DIR.iterdir()
        if path.is_dir()
    } if config.SESSIONS_DIR.exists() else set()
    cutoff_time = time.time() - (config.settings.preview_cleanup_days * 24 * 60 * 60)
    removed_count = 0

    for item in previews_dir.iterdir():
        name = item.name

        if name == "tmp":
            continue
        if name.startswith("template_"):
            continue

        try:
            if item.is_dir() and (name == ".staging" or ".bak_" in name):
                shutil.rmtree(item, ignore_errors=True)
                removed_count += 1
                continue

            if not item.is_dir():
                continue

            session_prefix = name.split("_", 1)[0]
            is_known_job_preview = name in known_preview_dirs
            session_exists = session_prefix in known_sessions
            is_old_preview = (
                config.settings.preview_cleanup_days > 0
                and item.stat().st_mtime < cutoff_time
            )

            if (not is_known_job_preview and not session_exists) or is_old_preview:
                shutil.rmtree(item, ignore_errors=True)
                removed_count += 1
                continue

            for pdf_file in item.glob("*.pdf"):
                try:
                    pdf_file.unlink(missing_ok=True)
                    removed_count += 1
                except Exception as exc:
                    logger.warning("Preview PDF cleanup failed for %s: %s", pdf_file, exc)
        except Exception as exc:
            logger.warning("Preview cleanup failed for %s: %s", item, exc)

    return removed_count

@app.on_event("startup")
async def startup_cleanup():
    """Clean up old sessions, stale locks, previews, and old jobs when server starts."""
    if config.settings.rag_preload_on_startup:
        try:
            rag_warmup = service.rag_service.warm_up()
            if rag_warmup.get("ok"):
                logger.info(
                    "RAG preload completed in %.2f ms | deps=%.2f ms | collection=%.2f ms | reranker=%.2f ms | reranker_status=%s",
                    float(rag_warmup.get("total_ms", 0)),
                    float(rag_warmup.get("load_dependencies_ms", 0)),
                    float(rag_warmup.get("ensure_collection_ms", 0)),
                    float(rag_warmup.get("load_reranker_ms", 0)),
                    rag_warmup.get("reranker_status"),
                )
            else:
                logger.warning(
                    "RAG preload failed in %.2f ms | reason=%s | error=%s",
                    float(rag_warmup.get("total_ms", 0)),
                    rag_warmup.get("reason"),
                    rag_warmup.get("error"),
                )
        except Exception as exc:
            logger.warning("RAG preload failed during startup: %s", exc)
    else:
        logger.info("RAG preload skipped on startup (RAG_PRELOAD_ON_STARTUP=false)")

    try:
        cleaned_count = service.cleanup_old_sessions(
            max_age_hours=config.settings.session_retention_days * 24
        )
        if cleaned_count > 0:
            logger.info("Startup cleanup: removed %s old sessions", cleaned_count)
    except Exception as exc:
        logger.warning("Startup session cleanup failed: %s", exc)

    try:
        tmp_cleaned_count = _cleanup_preview_tmp()
        if tmp_cleaned_count > 0:
            logger.info("Startup cleanup: removed %s preview tmp artifacts", tmp_cleaned_count)
    except Exception as exc:
        logger.warning("Startup preview tmp cleanup failed: %s", exc)

    try:
        preview_cleaned_count = _cleanup_preview_artifacts()
        if preview_cleaned_count > 0:
            logger.info("Startup cleanup: removed %s preview artifacts", preview_cleaned_count)
    except Exception as exc:
        logger.warning("Startup preview cleanup failed: %s", exc)

    try:
        from mss_ai_ppt_sample_assets.backend.modules.file_lock import cleanup_stale_locks
        cleanup_stale_locks(config.OUTPUTS_DIR, max_age_seconds=300)  # 5 minutes
        logger.info("Startup cleanup: stale locks cleaned")
    except Exception as exc:
        logger.warning("Startup stale lock cleanup failed: %s", exc)

    try:
        interrupted_count = job_store.mark_running_jobs_failed(
            RESTART_INTERRUPTED_ERROR_MESSAGE
        )
        if interrupted_count > 0:
            logger.info(
                "Startup recovery: marked %s interrupted running jobs as failed",
                interrupted_count,
            )
    except Exception as exc:
        logger.warning("Startup job recovery failed: %s", exc)

    try:
        job_cleaned_count = job_store.cleanup_old_jobs(days=config.settings.job_retention_days)
        if job_cleaned_count > 0:
            logger.info("Startup cleanup: removed %s old jobs", job_cleaned_count)
    except Exception as exc:
        logger.warning("Startup job cleanup failed: %s", exc)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
