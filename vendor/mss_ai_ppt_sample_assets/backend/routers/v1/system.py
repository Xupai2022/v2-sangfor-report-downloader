"""System API endpoints - Health checks and logs."""

from fastapi import APIRouter, HTTPException, status
from typing import Optional
import logging

from ...services.report_service import ReportService
from ...schemas.responses import SuccessResponse
from ...health_check import health_checker

logger = logging.getLogger(__name__)

router = APIRouter()
service = ReportService()


@router.get(
    "/health",
    response_model=SuccessResponse,
    summary="Basic Health Check",
    description="""
    Basic health check endpoint with LLM concurrency status.

    ## Response
    Returns:
    - status: System status ("ok" if healthy)
    - llm_concurrency: LLM request concurrency information
      - max_concurrent_requests: Maximum allowed concurrent LLM requests
      - available_slots: Number of available slots
      - active_requests: Number of currently active requests
      - is_saturated: Whether all slots are occupied

    ## Use Cases
    - Load balancer health checks
    - Monitoring system integration
    - Quick system status verification
    """,
    responses={
        200: {
            "description": "System is healthy",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "status": "ok",
                            "llm_concurrency": {
                                "max_concurrent_requests": 3,
                                "available_slots": 2,
                                "active_requests": 1,
                                "is_saturated": False
                            }
                        }
                    }
                }
            }
        }
    }
)
async def health():
    """Basic health check with LLM concurrency status."""
    try:
        # Import semaphore from app module
        from ...app import llm_semaphore, MAX_CONCURRENT_LLM_REQUESTS

        # Get current semaphore state
        available_slots = llm_semaphore._value if hasattr(llm_semaphore, '_value') else MAX_CONCURRENT_LLM_REQUESTS

        health_data = {
            "status": "ok",
            "llm_concurrency": {
                "max_concurrent_requests": MAX_CONCURRENT_LLM_REQUESTS,
                "available_slots": available_slots,
                "active_requests": MAX_CONCURRENT_LLM_REQUESTS - available_slots,
                "is_saturated": available_slots == 0
            }
        }

        return SuccessResponse(data=health_data)
    except Exception as e:
        logger.exception(f"Health check failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get(
    "/health/detailed",
    response_model=SuccessResponse,
    summary="Detailed Health Check",
    description="""
    Comprehensive health check with all system components.

    ## Response
    Returns detailed status of:
    - Disk space (free space, usage percentage)
    - OpenAI API (connectivity, model availability)
    - LibreOffice (installation, version)
    - Active sessions (count, oldest session age)
    - File locks (active locks count)
    - LLM concurrency (same as basic health check)

    ## Use Cases
    - System diagnostics
    - Pre-deployment verification
    - Troubleshooting issues
    - Monitoring dashboards
    """,
    responses={
        200: {
            "description": "Detailed health status",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "status": "healthy",
                            "components": {
                                "disk": {
                                    "status": "ok",
                                    "free_space_gb": 50.5,
                                    "usage_percent": 65.2
                                },
                                "openai": {
                                    "status": "ok",
                                    "model": "gpt-4o-mini",
                                    "api_available": True
                                },
                                "libreoffice": {
                                    "status": "ok",
                                    "installed": True,
                                    "version": "7.6.4.1"
                                },
                                "sessions": {
                                    "active_count": 5,
                                    "oldest_age_hours": 12.5
                                }
                            }
                        }
                    }
                }
            }
        },
        503: {"description": "System unhealthy"}
    }
)
async def health_detailed():
    """Detailed health check with all system components."""
    try:
        health_result = await health_checker.check_all()
        return SuccessResponse(data=health_result)
    except Exception as e:
        logger.exception(f"Detailed health check failed: {e}")
        raise HTTPException(status_code=503, detail=str(e))


@router.get(
    "/logs",
    response_model=SuccessResponse,
    summary="View System Logs",
    description="""
    Retrieve recent system logs for debugging and monitoring.

    ## Query Parameters
    - `limit`: Maximum number of log lines to return (default: 100, max: 1000)
    - `level`: Filter by log level (e.g., "ERROR", "WARNING", "INFO")

    ## Response
    Returns an array of log lines (most recent first).

    ## Use Cases
    - Debugging errors
    - Monitoring system activity
    - Audit trail review
    - Performance analysis

    ## Security Note
    This endpoint may expose sensitive information. In production, consider:
    - Adding authentication/authorization
    - Filtering sensitive data
    - Rate limiting
    """,
    responses={
        200: {
            "description": "Log lines retrieved successfully",
            "content": {
                "application/json": {
                    "example": {
                        "data": {
                            "lines": [
                                "2026-02-02 10:30:15 INFO Report generated: tenant_acme:mss_executive_v2",
                                "2026-02-02 10:29:50 INFO Excel uploaded: session_1769760502379",
                                "2026-02-02 10:28:30 WARNING LLM request queue saturated"
                            ],
                            "count": 3,
                            "limit": 100
                        }
                    }
                }
            }
        }
    }
)
async def logs(limit: int = 100, level: Optional[str] = None):
    """View system logs."""
    try:
        # Enforce maximum limit
        if limit > 1000:
            limit = 1000

        content = service.read_logs(limit=limit)
        lines = content.splitlines() if content else []

        # Filter by level if specified
        if level:
            level_upper = level.upper()
            lines = [line for line in lines if level_upper in line]

        logger.info(f"Retrieved {len(lines)} log lines (limit={limit}, level={level})")
        return SuccessResponse(data={
            "lines": lines,
            "count": len(lines),
            "limit": limit
        })
    except Exception as e:
        logger.exception(f"Failed to read logs: {e}")
        raise HTTPException(status_code=500, detail=str(e))
