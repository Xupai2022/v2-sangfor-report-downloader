"""Sessions API endpoints - Session management and cleanup."""

from fastapi import APIRouter, HTTPException, status
from typing import Optional
import logging

from ...services.report_service import ReportService
from ...schemas.responses import SuccessResponse
from ...exceptions import SessionNotFoundError

logger = logging.getLogger(__name__)

router = APIRouter()
service = ReportService()


@router.delete(
    "",
    response_model=SuccessResponse,
    summary="Cleanup Old Sessions",
    description="""
    Clean up old session directories to free disk space.

    ## Query Parameters
    - `max_age_hours`: Maximum age in hours before cleanup (default: 168 / 7 days)

    ## Processing
    - Scans session directories in outputs/sessions/
    - Deletes sessions older than max_age_hours
    - Removes all files including reports, slidespecs, previews, and lock files

    ## Response
    Returns the number of sessions cleaned up.

    ## Use Cases
    - Scheduled cleanup task (cron job)
    - Manual disk space management
    - Development environment cleanup
    """,
    responses={
        200: {
            "description": "Cleanup completed successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "cleaned_count": 15,
                            "max_age_hours": 168
                        }
                    }
                }
            }
        }
    }
)
async def cleanup_sessions(max_age_hours: int = 168):
    """Clean up old session directories."""
    try:
        cleaned_count = service.cleanup_old_sessions(max_age_hours)
        logger.info(f"Cleaned up {cleaned_count} old sessions (max_age_hours={max_age_hours})")

        return SuccessResponse(data={
            "cleaned_count": cleaned_count,
            "max_age_hours": max_age_hours
        })
    except Exception as e:
        logger.exception(f"Cleanup failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete(
    "/{session_id}",
    response_model=SuccessResponse,
    summary="Delete Specific Session",
    description="""
    Delete a specific session directory and all its contents.

    ## Response
    Returns confirmation of deletion.

    ## Use Cases
    - Remove specific session after download
    - Clean up failed generation attempts
    - User-initiated data deletion
    """,
    responses={
        200: {
            "description": "Session deleted successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "deleted": True,
                            "session_id": "session_1769760502379_rh3o0q4ja"
                        }
                    }
                }
            }
        },
        404: {"description": "Session not found"}
    }
)
async def delete_session(session_id: str):
    """Delete a specific session directory."""
    try:
        # Get session directory
        from pathlib import Path
        from ... import config
        import shutil

        session_dir = config.SESSIONS_DIR / session_id

        if not session_dir.exists():
            raise SessionNotFoundError(f"Session '{session_id}' not found")

        # Delete session directory
        shutil.rmtree(session_dir)

        logger.info(f"Deleted session: {session_id}")
        return SuccessResponse(data={
            "deleted": True,
            "session_id": session_id
        })

    except SessionNotFoundError as e:
        logger.error(f"Session not found: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(f"Failed to delete session: {e}")
        raise HTTPException(status_code=500, detail=str(e))
