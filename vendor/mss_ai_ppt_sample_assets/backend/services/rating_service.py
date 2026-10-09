"""Rating service for user feedback on generated reports."""

import logging
from typing import Optional, Dict
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore
from mss_ai_ppt_sample_assets.backend.models.job_state import JobState, JobStatus

logger = logging.getLogger(__name__)


class ValidationError(Exception):
    """Validation error exception."""
    pass


class RatingService:
    """Business logic for user rating operations."""

    def __init__(self, job_store: JobStore):
        """Initialize rating service.

        Args:
            job_store: Job storage instance
        """
        self.job_store = job_store

    def submit_rating(
        self,
        job_id: str,
        session_id: str,
        rating: str,
        comment: Optional[str] = None,
        user_ip: Optional[str] = None
    ) -> JobState:
        """Submit a user rating for a job.

        Args:
            job_id: Job identifier (session_id:template_id)
            session_id: Session identifier of the rater
            rating: Rating value ("liked" or "disliked")
            comment: Optional comment (required for "disliked")
            user_ip: User IP address (for analytics)

        Returns:
            Updated job state

        Raises:
            ValidationError: If validation fails
            ValueError: If job not found or already rated
        """
        # 1. Validate inputs
        if rating not in ["liked", "disliked"]:
            raise ValidationError("Rating must be 'liked' or 'disliked'")

        # 2. Check if job exists and is completed
        job = self.job_store.get_job(job_id)
        if not job:
            raise ValueError(f"Job {job_id} not found")

        if job.status != JobStatus.COMPLETED:
            raise ValidationError(f"Can only rate completed jobs (current status: {job.status})")

        # 3. Validate comment requirement for disliked
        if rating == "disliked":
            if not comment or len(comment.strip()) < 10:
                raise ValidationError("Comment is required for thumbs down (minimum 10 characters)")

        # 4. Check if already rated by this session (one rating per session)
        if self.job_store.check_session_has_rated(job_id, session_id):
            raise ValidationError("You have already rated this report")

        # 5. Submit rating
        try:
            updated_job = self.job_store.update_rating(
                job_id=job_id,
                rating=rating,
                comment=comment,
                rated_by_session=session_id,
                rated_by_ip=user_ip
            )

            if not updated_job:
                raise ValueError(f"Failed to update rating for job {job_id}")

            logger.info(f"Rating submitted: job={job_id}, session={session_id}, rating={rating}")
            return updated_job

        except ValueError as e:
            # Re-raise ValueError (job not found or already rated)
            raise
        except Exception as e:
            logger.error(f"Failed to submit rating: {e}")
            raise ValueError(f"Failed to submit rating: {str(e)}")

    def get_job_rating(self, job_id: str) -> Optional[Dict]:
        """Get rating information for a job.

        Args:
            job_id: Job identifier

        Returns:
            Rating dict or None if not rated
        """
        job = self.job_store.get_job(job_id)
        if not job or not job.rating:
            return None

        return {
            "rating": job.rating.rating,
            "comment": job.rating.comment,
            "rated_at": job.rating.rated_at.isoformat() if job.rating.rated_at else None
        }

    def can_rate(self, job_id: str, session_id: str) -> Dict[str, any]:
        """Check if a session can rate a job.

        Args:
            job_id: Job identifier
            session_id: Session identifier

        Returns:
            Dict with can_rate (bool) and reason (str)
        """
        job = self.job_store.get_job(job_id)

        if not job:
            return {"can_rate": False, "reason": "Job not found"}

        if job.status != JobStatus.COMPLETED:
            return {"can_rate": False, "reason": "Job is not completed"}

        if self.job_store.check_session_has_rated(job_id, session_id):
            return {"can_rate": False, "reason": "Already rated by this session"}

        return {"can_rate": True, "reason": ""}
