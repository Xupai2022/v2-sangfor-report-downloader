"""Admin API request/response schemas."""

from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from pydantic import BaseModel, Field

from mss_ai_ppt_sample_assets.backend.models.job_state import JobState, JobStatus, JobRating


# ==================== Authentication Schemas ====================

class LoginRequest(BaseModel):
    """Admin login request."""
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1)

    class Config:
        json_schema_extra = {
            "example": {
                "username": "admin",
                "password": "admin123"
            }
        }


class LoginResponse(BaseModel):
    """Admin login response."""
    authenticated: bool
    username: str
    expires_at: datetime

    class Config:
        json_schema_extra = {
            "example": {
                "authenticated": True,
                "username": "admin",
                "expires_at": "2026-02-04T10:00:00Z"
            }
        }


class VerifyResponse(BaseModel):
    """Session verification response."""
    authenticated: bool
    username: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "authenticated": True,
                "username": "admin"
            }
        }


# ==================== Job Management Schemas ====================

class JobSummary(BaseModel):
    """Lightweight job info for list view."""
    job_id: str
    session_id: str
    template_id: str
    input_id: str
    status: JobStatus
    rating: Optional[JobRating] = None
    created_at: datetime
    completed_at: Optional[datetime] = None
    generation_duration_ms: Optional[int] = None
    has_warnings: bool = False
    preview_thumbnail: Optional[str] = None  # First slide preview URL

    class Config:
        json_schema_extra = {
            "example": {
                "job_id": "abc123_20260203:mss_executive_v2",
                "session_id": "abc123_20260203",
                "template_id": "mss_executive_v2",
                "input_id": "tenant_demo_2025-01",
                "status": "completed",
                "rating": {"rating": "liked", "rated_at": "2026-02-03T10:30:00Z", "comment": "很好"},
                "created_at": "2026-02-03T10:00:00Z",
                "completed_at": "2026-02-03T10:00:15Z",
                "generation_duration_ms": 15000,
                "has_warnings": False,
                "preview_thumbnail": "/static/previews/abc123_20260203:mss_executive_v2/slide1.png"
            }
        }


class PaginatedJobList(BaseModel):
    """Paginated job list response."""
    jobs: List[JobSummary]
    total: int
    page: int
    limit: int
    has_next: bool
    has_prev: bool

    class Config:
        json_schema_extra = {
            "example": {
                "jobs": [],
                "total": 100,
                "page": 1,
                "limit": 50,
                "has_next": True,
                "has_prev": False
            }
        }


class JobDetails(BaseModel):
    """Full job details for detail view."""
    job: JobState
    preview_urls: List[str]
    report_url: Optional[str] = None
    slidespec_url: Optional[str] = None
    input_stats: Optional[Dict[str, Any]] = None

    class Config:
        json_schema_extra = {
            "example": {
                "job": {},
                "preview_urls": [
                    "/static/previews/job123/slide1.png",
                    "/static/previews/job123/slide2.png"
                ],
                "report_url": "/api/v1/reports/job123/download",
                "slidespec_url": None,
                "input_stats": {
                    "alerts_total": 150,
                    "incidents_total": 23,
                    "vulnerabilities_total": 45
                }
            }
        }


class RateJobRequest(BaseModel):
    """Request to rate a job."""
    rating: Optional[Literal["liked", "disliked"]] = Field(
        None,
        description="Rating value or None to clear rating"
    )
    comment: Optional[str] = Field(None, max_length=500)

    class Config:
        json_schema_extra = {
            "example": {
                "rating": "liked",
                "comment": "生成的图表很清晰，内容准确"
            }
        }


class BulkDeleteRequest(BaseModel):
    """Request to delete multiple jobs."""
    job_ids: List[str] = Field(..., min_items=1, max_items=100)

    class Config:
        json_schema_extra = {
            "example": {
                "job_ids": [
                    "session1:template1",
                    "session2:template2"
                ]
            }
        }


class BulkDeleteResponse(BaseModel):
    """Response from bulk delete operation."""
    deleted_count: int
    failed: List[str] = Field(default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "deleted_count": 5,
                "failed": ["session3:template3"]
            }
        }


class AdminStatistics(BaseModel):
    """Admin dashboard statistics."""
    total_jobs: int
    by_status: Dict[str, int]
    by_rating: Dict[str, int]
    success_rate: float
    avg_generation_time_ms: Optional[float] = None
    recent_errors: List[Dict[str, Any]] = Field(default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "total_jobs": 250,
                "by_status": {
                    "completed": 200,
                    "failed": 30,
                    "pending": 10,
                    "running": 5,
                    "cancelled": 5
                },
                "by_rating": {
                    "liked": 150,
                    "disliked": 20,
                    "unrated": 30
                },
                "success_rate": 0.87,
                "avg_generation_time_ms": 12500.0,
                "recent_errors": [
                    {
                        "job_id": "session_abc:template1",
                        "error": "API timeout",
                        "timestamp": "2026-02-03T09:00:00Z"
                    }
                ]
            }
        }
