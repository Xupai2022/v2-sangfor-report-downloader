"""Unified response models for API endpoints."""

from pydantic import BaseModel, Field
from typing import Any, Optional


class SuccessResponse(BaseModel):
    """Standard success response wrapper.

    Example:
        {
            "data": {
                "job_id": "tenant_acme:mss_executive_v2",
                "session_id": "abc123",
                "status": "success"
            }
        }
    """
    data: Any = Field(..., description="Response data payload")

    class Config:
        json_schema_extra = {
            "example": {
                "data": {
                    "job_id": "tenant_acme:mss_executive_v2",
                    "session_id": "abc123",
                    "status": "success"
                }
            }
        }


class ErrorDetail(BaseModel):
    """Error details structure."""
    code: str = Field(..., description="Error code (e.g., RESOURCE_NOT_FOUND)")
    message: str = Field(..., description="Human-readable error message")
    details: Optional[dict] = Field(None, description="Additional error context")

    class Config:
        json_schema_extra = {
            "example": {
                "code": "RESOURCE_NOT_FOUND",
                "message": "报告不存在",
                "details": {"report_id": "invalid_id"}
            }
        }


class ErrorResponse(BaseModel):
    """Standard error response wrapper.

    Example:
        {
            "error": {
                "code": "RESOURCE_NOT_FOUND",
                "message": "报告不存在",
                "details": {"report_id": "invalid_id"}
            }
        }
    """
    error: ErrorDetail = Field(..., description="Error information")

    class Config:
        json_schema_extra = {
            "example": {
                "error": {
                    "code": "RESOURCE_NOT_FOUND",
                    "message": "报告不存在",
                    "details": {"report_id": "invalid_id"}
                }
            }
        }
