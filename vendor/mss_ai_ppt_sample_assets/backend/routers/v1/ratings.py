"""User rating API endpoints for report feedback."""

import logging
from fastapi import APIRouter, HTTPException, Request, status
from typing import Optional

from mss_ai_ppt_sample_assets.backend.schemas.responses import SuccessResponse
from mss_ai_ppt_sample_assets.backend.schemas.requests import SubmitRatingRequest
from mss_ai_ppt_sample_assets.backend.services.rating_service import RatingService, ValidationError
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore

logger = logging.getLogger(__name__)

router = APIRouter()

# Global rating service (will be initialized by app.py)
rating_service: Optional[RatingService] = None


def init_dependencies(job_store: JobStore):
    """Initialize dependencies from app module.

    Args:
        job_store: JobStore instance
    """
    global rating_service
    rating_service = RatingService(job_store)
    logger.info("Rating service initialized")


@router.post(
    "/jobs/{job_id}/rating",
    response_model=SuccessResponse,
    summary="Submit Rating",
    description="Submit user rating for a completed job",
    responses={
        200: {"description": "Rating submitted successfully"},
        400: {"description": "Validation error"},
        404: {"description": "Job not found"}
    }
)
async def submit_rating(
    job_id: str,
    rating_data: SubmitRatingRequest,
    request: Request
):
    """Submit user rating for a job.

    Validation rules:
    - Job must be completed
    - One rating per session
    - Thumbs down requires comment (min 10 chars)
    - Thumbs up comment is optional
    """
    if not rating_service:
        raise HTTPException(
            status_code=500,
            detail="Rating service not initialized"
        )

    # Extract session_id from job_id (format: session_id:template_id)
    try:
        session_id = job_id.split(":")[0]
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid job_id format"
        )

    # Get user IP for analytics
    user_ip = request.client.host if request.client else None

    try:
        updated_job = rating_service.submit_rating(
            job_id=job_id,
            session_id=session_id,
            rating=rating_data.rating,
            comment=rating_data.comment,
            user_ip=user_ip
        )

        logger.info(f"User rating submitted: job={job_id}, rating={rating_data.rating}")

        return SuccessResponse(data={
            "job_id": updated_job.job_id,
            "rating": updated_job.rating.rating if updated_job.rating else None,
            "message": "Rating submitted successfully"
        })

    except ValidationError as e:
        logger.warning(f"Rating validation failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except ValueError as e:
        logger.warning(f"Rating submission failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Unexpected error submitting rating: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to submit rating"
        )


@router.get(
    "/jobs/{job_id}/rating",
    response_model=SuccessResponse,
    summary="Get Job Rating",
    description="Get rating information for a job"
)
async def get_job_rating(job_id: str):
    """Get rating for a specific job."""
    if not rating_service:
        raise HTTPException(
            status_code=500,
            detail="Rating service not initialized"
        )

    rating = rating_service.get_job_rating(job_id)

    return SuccessResponse(data={
        "job_id": job_id,
        "rating": rating
    })


@router.get(
    "/jobs/{job_id}/can-rate",
    response_model=SuccessResponse,
    summary="Check if Can Rate",
    description="Check if current session can rate this job"
)
async def check_can_rate(job_id: str):
    """Check if a session can rate a job."""
    if not rating_service:
        raise HTTPException(
            status_code=500,
            detail="Rating service not initialized"
        )

    # Extract session_id from job_id
    try:
        session_id = job_id.split(":")[0]
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid job_id format"
        )

    result = rating_service.can_rate(job_id, session_id)

    return SuccessResponse(data=result)
