"""Jobs API endpoints - Job state management and queries."""

from fastapi import APIRouter, HTTPException, status, Query
from typing import Optional
import logging

from ...schemas.responses import SuccessResponse
from ...models.job_state import JobStatus
from ...exceptions import SessionNotFoundError

logger = logging.getLogger(__name__)

router = APIRouter()

# Job manager will be initialized by app.py
job_manager = None


def init_dependencies(manager):
    """Initialize dependencies from app module.

    Args:
        manager: JobManager instance
    """
    global job_manager
    job_manager = manager


@router.get(
    "/{job_id}/status",
    response_model=SuccessResponse,
    summary="Get Job Status",
    description="""
    Query the current status and progress of a report generation job.

    ## Use Cases
    - Check progress after submitting a report request
    - Resume monitoring after WebSocket disconnection
    - Verify job completion before downloading

    ## Response Fields
    - `status`: Current job status (pending/running/completed/failed/cancelled)
    - `progress`: Percentage complete (0-100)
    - `message`: Current progress message
    - `created_at`, `started_at`, `completed_at`: Timestamps
    - `report_path`, `slidespec_path`: File paths when completed
    - `last_error`: Error message if failed
    """,
    responses={
        200: {
            "description": "Job status retrieved successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "job_id": "abc123_20260202110000:mss_executive_v2",
                            "status": "running",
                            "progress": 45,
                            "message": "正在生成第 5/10 张幻灯片...",
                            "created_at": "2026-02-02T11:00:00Z",
                            "started_at": "2026-02-02T11:00:01Z"
                        }
                    }
                }
            }
        },
        404: {"description": "Job not found"}
    }
)
async def get_job_status(job_id: str):
    """Get job status and progress."""
    if not job_manager:
        raise HTTPException(
            status_code=500,
            detail="Job manager not initialized"
        )

    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail=f"Job not found: {job_id}"
        )

    logger.debug(f"Retrieved job status: {job_id} ({job.status})")
    return SuccessResponse(data=job.dict())


@router.get(
    "",
    response_model=SuccessResponse,
    summary="List Jobs",
    description="""
    List recent jobs with optional filtering by status.

    ## Query Parameters
    - `status`: Filter by job status (pending/running/completed/failed/cancelled)
    - `limit`: Maximum number of jobs to return (default: 100)

    ## Use Cases
    - Monitor all active jobs
    - View job history
    - Check for failed jobs
    """,
    responses={
        200: {
            "description": "Jobs list retrieved successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "jobs": [
                                {
                                    "job_id": "abc123:mss_executive_v2",
                                    "status": "completed",
                                    "progress": 100
                                }
                            ],
                            "count": 1
                        }
                    }
                }
            }
        }
    }
)
async def list_jobs(
    status: Optional[JobStatus] = Query(None, description="Filter by status"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of jobs")
):
    """List jobs with optional filtering."""
    if not job_manager:
        raise HTTPException(
            status_code=500,
            detail="Job manager not initialized"
        )

    jobs = job_manager.store.list_jobs(status=status, limit=limit)

    logger.info(f"鉁?Listed {len(jobs)} jobs (status={status}, limit={limit})")
    return SuccessResponse(data={
        "jobs": [j.dict() for j in jobs],
        "count": len(jobs),
        "filter": {
            "status": status,
            "limit": limit
        }
    })


@router.post(
    "/{job_id}/cancel",
    response_model=SuccessResponse,
    summary="Cancel Job",
    description="""
    Mark a job as cancelled.

    **Note**: This only updates the job status. It does not stop a currently
    running generation process. For true cancellation, a task queue system
    would be needed.

    ## Use Cases
    - User wants to cancel a pending/running job
    - Cleanup after client disconnect
    """,
    responses={
        200: {
            "description": "Job cancelled successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "cancelled": True,
                            "job_id": "abc123:mss_executive_v2"
                        }
                    }
                }
            }
        },
        404: {"description": "Job not found"}
    }
)
async def cancel_job(job_id: str):
    """Cancel a job (mark as cancelled)."""
    if not job_manager:
        raise HTTPException(
            status_code=500,
            detail="Job manager not initialized"
        )

    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail=f"Job not found: {job_id}"
        )

    # Only cancel if not already in terminal state
    if job.is_terminal():
        return SuccessResponse(data={
            "cancelled": False,
            "job_id": job_id,
            "message": f"Job already in terminal state: {job.status}"
        })

    job_manager.cancel_job(job_id)

    logger.info(f"鉁?Cancelled job: {job_id}")
    return SuccessResponse(data={
        "cancelled": True,
        "job_id": job_id
    })


@router.delete(
    "/{job_id}",
    response_model=SuccessResponse,
    summary="Delete Job",
    description="""
    Delete a job and all associated files.

    This will:
    1. Delete the job state file
    2. Delete the session directory (reports, slidespecs, previews)
    3. Remove idempotency mappings

    ## Use Cases
    - Cleanup after download
    - Remove failed jobs
    - Free disk space
    """,
    responses={
        200: {
            "description": "Job deleted successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "deleted": True,
                            "job_id": "abc123:mss_executive_v2"
                        }
                    }
                }
            }
        },
        404: {"description": "Job not found"}
    }
)
async def delete_job(job_id: str):
    """Delete job and associated files."""
    if not job_manager:
        raise HTTPException(
            status_code=500,
            detail="Job manager not initialized"
        )

    deleted = job_manager.delete_job(job_id)

    if not deleted:
        raise HTTPException(
            status_code=404,
            detail=f"Job not found: {job_id}"
        )

    logger.info(f"鉁?Deleted job: {job_id}")
    return SuccessResponse(data={
        "deleted": True,
        "job_id": job_id
    })

