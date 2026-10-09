"""Admin API endpoints for dashboard management."""

import logging
from fastapi import APIRouter, HTTPException, Depends, Request, Query, status
from typing import Optional
from datetime import datetime, timedelta, timezone

from mss_ai_ppt_sample_assets.backend.schemas.responses import SuccessResponse, ErrorResponse
from mss_ai_ppt_sample_assets.backend.schemas.admin import (
    LoginRequest,
    LoginResponse,
    VerifyResponse,
    PaginatedJobList,
    JobDetails,
    RateJobRequest,
    BulkDeleteRequest,
    BulkDeleteResponse,
    AdminStatistics
)
from mss_ai_ppt_sample_assets.backend.models.job_state import JobStatus
from mss_ai_ppt_sample_assets.backend.services.admin_service import AdminService
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore
from mss_ai_ppt_sample_assets.backend.modules.admin_auth import (
    verify_password,
    create_session,
    delete_session
)
from mss_ai_ppt_sample_assets.backend.config import settings, JOBS_DIR

logger = logging.getLogger(__name__)

router = APIRouter()

# Global admin service (will be initialized by app.py)
admin_service: Optional[AdminService] = None


def init_dependencies(job_store: JobStore):
    """Initialize dependencies from app module.

    Args:
        job_store: JobStore instance
    """
    global admin_service
    admin_service = AdminService(job_store)
    logger.info("Admin service initialized")


# ==================== Authentication Dependency ====================

async def require_admin_auth(request: Request) -> str:
    """Dependency to require admin authentication.

    Args:
        request: FastAPI request object

    Returns:
        Username if authenticated

    Raises:
        HTTPException: 401 if not authenticated
    """
    session_data = request.session.get("admin_authenticated")
    if not session_data or not isinstance(session_data, dict):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未认证，请先登录"
        )

    username = session_data.get("username")
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="会话无效"
        )

    return username


# ==================== Authentication Endpoints ====================

@router.post(
    "/login",
    response_model=SuccessResponse,
    summary="Admin Login",
    description="Authenticate admin user and create session",
    responses={
        200: {"description": "Login successful"},
        401: {"description": "Invalid credentials"}
    }
)
async def admin_login(request: Request, login_data: LoginRequest):
    """Admin login endpoint."""

    # Verify credentials
    if login_data.username != settings.admin_username:
        logger.warning(f"Failed login attempt: username={login_data.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误"
        )

    if not settings.admin_password_hash:
        logger.error("Admin password hash not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="管理员认证未配置"
        )

    if not verify_password(login_data.password, settings.admin_password_hash):
        logger.warning(f"Failed login attempt: invalid password for {login_data.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误"
        )

    # Create session
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=settings.admin_session_max_age)

    # Store in FastAPI session (managed by SessionMiddleware)
    request.session["admin_authenticated"] = {
        "username": login_data.username,
        "authenticated_at": now.isoformat(),
        "expires_at": expires_at.isoformat()
    }

    logger.info(f"Admin login successful: {login_data.username}")

    return SuccessResponse(data=LoginResponse(
        authenticated=True,
        username=login_data.username,
        expires_at=expires_at
    ))


@router.post(
    "/logout",
    response_model=SuccessResponse,
    summary="Admin Logout",
    description="Clear admin session"
)
async def admin_logout(request: Request):
    """Admin logout endpoint."""
    # Clear session
    request.session.clear()
    logger.info("Admin logout")

    return SuccessResponse(data={"success": True})


@router.get(
    "/verify",
    response_model=SuccessResponse,
    summary="Verify Session",
    description="Check if current session is authenticated"
)
async def verify_session(request: Request):
    """Verify admin session."""
    session_data = request.session.get("admin_authenticated")

    if not session_data or not isinstance(session_data, dict):
        return SuccessResponse(data=VerifyResponse(
            authenticated=False
        ))

    username = session_data.get("username")
    if not username:
        return SuccessResponse(data=VerifyResponse(
            authenticated=False
        ))

    return SuccessResponse(data=VerifyResponse(
        authenticated=True,
        username=username
    ))


# ==================== Job Management Endpoints ====================

@router.get(
    "/jobs",
    response_model=SuccessResponse,
    summary="List Jobs",
    description="Get paginated list of jobs with filtering and search",
    dependencies=[Depends(require_admin_auth)]
)
async def list_jobs(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    status: Optional[JobStatus] = Query(None, description="Filter by status"),
    rating: Optional[str] = Query(None, description="Filter by rating (liked/disliked/unrated)"),
    search: Optional[str] = Query(None, description="Search in job_id, input_id, template_id"),
    date_from: Optional[datetime] = Query(None, description="Filter from date"),
    date_to: Optional[datetime] = Query(None, description="Filter to date"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order (asc/desc)")
):
    """List jobs with pagination and filtering."""
    if not admin_service:
        raise HTTPException(
            status_code=500,
            detail="Admin service not initialized"
        )

    try:
        result = admin_service.list_jobs_paginated(
            page=page,
            limit=limit,
            status=status,
            rating=rating,
            search=search,
            date_from=date_from,
            date_to=date_to,
            sort_by=sort_by,
            sort_order=sort_order
        )

        logger.info(f"Admin: Listed jobs (page={page}, total={result.total})")
        return SuccessResponse(data=result)

    except Exception as e:
        logger.error(f"Failed to list jobs: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"获取任务列表失败: {str(e)}"
        )


@router.get(
    "/jobs/{job_id}",
    response_model=SuccessResponse,
    summary="Get Job Details",
    description="Get detailed information for a specific job",
    dependencies=[Depends(require_admin_auth)]
)
async def get_job_details(job_id: str):
    """Get detailed job information."""
    if not admin_service:
        raise HTTPException(
            status_code=500,
            detail="Admin service not initialized"
        )

    # URL decode job_id (replace _ back to :)
    actual_job_id = job_id.replace("_", ":", 1) if "_" in job_id else job_id

    details = admin_service.get_job_details(actual_job_id)
    if not details:
        raise HTTPException(
            status_code=404,
            detail=f"任务未找到: {job_id}"
        )

    logger.info(f"Admin: Retrieved job details for {actual_job_id}")
    return SuccessResponse(data=details)


@router.patch(
    "/jobs/{job_id}/rating",
    response_model=SuccessResponse,
    summary="Rate Job",
    description="Add or update rating for a job",
    dependencies=[Depends(require_admin_auth)]
)
async def rate_job(job_id: str, rating_data: RateJobRequest):
    """Rate a job."""
    if not admin_service:
        raise HTTPException(
            status_code=500,
            detail="Admin service not initialized"
        )

    # URL decode job_id
    actual_job_id = job_id.replace("_", ":", 1) if "_" in job_id else job_id

    updated_job = admin_service.rate_job(
        actual_job_id,
        rating_data.rating,
        rating_data.comment
    )

    if not updated_job:
        raise HTTPException(
            status_code=404,
            detail=f"任务未找到: {job_id}"
        )

    logger.info(f"Admin: Rated job {actual_job_id} as {rating_data.rating}")
    return SuccessResponse(data=updated_job)


@router.delete(
    "/jobs",
    response_model=SuccessResponse,
    summary="Bulk Delete Jobs",
    description="Delete multiple jobs at once",
    dependencies=[Depends(require_admin_auth)]
)
async def bulk_delete_jobs(delete_request: BulkDeleteRequest):
    """Delete multiple jobs."""
    if not admin_service:
        raise HTTPException(
            status_code=500,
            detail="Admin service not initialized"
        )

    # Decode job IDs
    actual_job_ids = [
        job_id.replace("_", ":", 1) if "_" in job_id else job_id
        for job_id in delete_request.job_ids
    ]

    result = admin_service.bulk_delete_jobs(actual_job_ids)

    logger.info(f"Admin: Bulk delete {result.deleted_count} jobs, {len(result.failed)} failed")
    return SuccessResponse(data=result)


@router.get(
    "/statistics",
    response_model=SuccessResponse,
    summary="Get Statistics",
    description="Get admin dashboard statistics",
    dependencies=[Depends(require_admin_auth)]
)
async def get_statistics():
    """Get admin statistics."""
    if not admin_service:
        raise HTTPException(
            status_code=500,
            detail="Admin service not initialized"
        )

    try:
        stats = admin_service.get_statistics()
        logger.info("Admin: Retrieved statistics")
        return SuccessResponse(data=stats)

    except Exception as e:
        logger.error(f"Failed to get statistics: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"获取统计信息失败: {str(e)}"
        )
