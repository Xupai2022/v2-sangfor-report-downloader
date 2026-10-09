"""Job management service for coordinating report generation jobs.

This module provides the main service layer for managing job lifecycle,
including creation, status tracking, progress updates, and cleanup.
"""

from __future__ import annotations

import logging
from typing import Optional, Dict, Any
from datetime import datetime, timezone

from mss_ai_ppt_sample_assets.backend.models.job_state import JobState, JobStatus
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore
from mss_ai_ppt_sample_assets.backend.services.report_service import ReportService

logger = logging.getLogger(__name__)

RESTART_INTERRUPTED_ERROR_PREFIX = "SERVER_RESTART_INTERRUPTED"
RESTART_INTERRUPTED_ERROR_CODE = "RESTART_INTERRUPTED"
RESTART_INTERRUPTED_ERROR_MESSAGE = (
    f"{RESTART_INTERRUPTED_ERROR_PREFIX}: Service restarted during processing. "
    "Please regenerate a new task."
)


class JobManager:
    """Manages report generation job lifecycle.

    Coordinates between JobStore (persistence) and ReportService (generation),
    handling job creation, status updates, and cleanup.
    """

    def __init__(self, job_store: JobStore, report_service: ReportService):
        """Initialize job manager.

        Args:
            job_store: Job state storage instance
            report_service: Report generation service instance
        """
        self.store = job_store
        self.report_service = report_service
        self.logger = logging.getLogger(__name__)

    def create_job(
        self,
        input_id: str,
        template_id: str,
        idempotency_key: Optional[str] = None,
        session_id: Optional[str] = None,
        max_retries: int = 3,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> JobState:
        """Create a new job or return existing one (idempotency).

        Args:
            input_id: Input data identifier
            template_id: Template identifier
            idempotency_key: Optional idempotency key to prevent duplicates
            session_id: Optional session ID (generated if not provided)
            max_retries: Maximum retry attempts for this job
            metadata: Optional metadata to persist with the job

        Returns:
            JobState: Created or existing job state
        """
        def is_restart_interrupted_failed(job: JobState) -> bool:
            return (
                job.status == JobStatus.FAILED
                and (
                    job.error_code == RESTART_INTERRUPTED_ERROR_CODE
                    or (
                        isinstance(job.last_error, str)
                        and job.last_error.startswith(RESTART_INTERRUPTED_ERROR_PREFIX)
                    )
                )
            )

        # Check for existing job via idempotency key
        if idempotency_key:
            existing = self.store.find_by_idempotency_key(idempotency_key)
            if existing:
                if is_restart_interrupted_failed(existing):
                    # Force a fresh task when previous run was interrupted by restart.
                    self.logger.info(
                        f"Idempotent job {existing.job_id} was restart-interrupted; creating a new job"
                    )
                    session_id = None
                else:
                    self.logger.info(
                        f"Found existing job for idempotency_key={idempotency_key}: {existing.job_id}"
                    )
                    return existing

        # Generate session ID if not provided
        if not session_id:
            session_id = self.report_service.session_manager.generate_session_id()

        # Create new job
        job_state = JobState(
            job_id=f"{session_id}:{template_id}",
            session_id=session_id,
            template_id=template_id,
            input_id=input_id,
            status=JobStatus.PENDING,
            idempotency_key=idempotency_key,
            max_retries=max_retries,
            metadata=metadata or {},
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc)
        )

        created_job = self.store.create_job(job_state)
        self.logger.info(f"Created new job: {created_job.job_id}")
        return created_job

    def start_job(self, job_id: str):
        """Mark job as started.

        Args:
            job_id: Job identifier
        """
        try:
            self.store.update_job(job_id, {
                "status": JobStatus.RUNNING,
                "started_at": datetime.now(timezone.utc)
            })
            self.logger.info(f"Job started: {job_id}")
        except Exception as e:
            self.logger.error(f"Failed to mark job as started: {e}")

    def complete_job(self, job_id: str, result: Dict[str, Any]):
        """Mark job as completed with results.

        Args:
            job_id: Job identifier
            result: Generation result dictionary with paths and metadata
        """
        try:
            # Calculate generation duration
            job = self.store.get_job(job_id)
            generation_duration_ms = None
            if job and job.started_at:
                duration = datetime.now(timezone.utc) - job.started_at
                generation_duration_ms = int(duration.total_seconds() * 1000)

            # Get AI model from config
            from mss_ai_ppt_sample_assets.backend.config import settings
            ai_model = settings.openai_model if settings.enable_llm else "mock"

            # Update job state
            self.store.update_job(job_id, {
                "status": JobStatus.COMPLETED,
                "completed_at": datetime.now(timezone.utc),
                "progress": 100,
                "message": "完成",
                "report_path": result.get("report_path"),
                "slidespec_path": result.get("slidespec_path"),
                "preview_urls": result.get("preview_urls"),
                "metadata": {
                    "warnings": result.get("warnings", []),
                    "version": result.get("version", "v2"),
                    "generation_duration_ms": generation_duration_ms,
                    "ai_model": ai_model,
                    "preview_timings": result.get("preview_timings"),
                    "rag_used": bool(result.get("rag_used", False)),
                    "retrieval_trace": result.get("retrieval_trace", []),
                }
            })
            self.logger.info(f"Job completed: {job_id} (duration: {generation_duration_ms}ms)")
        except Exception as e:
            self.logger.error(f"Failed to mark job as completed: {e}")

    def fail_job(
        self,
        job_id: str,
        error_message: str,
        error_code: Optional[str] = None,
        user_message: Optional[str] = None,
        increment_retry: bool = True,
    ):
        """Mark job as failed with error message.

        Args:
            job_id: Job identifier
            error_message: Raw error details for diagnosis
            error_code: Optional machine-readable error code
            user_message: Optional user-facing message
            increment_retry: Whether to increase retry_count
        """
        try:
            job = self.store.get_job(job_id)
            if not job:
                self.logger.error(f"Job not found: {job_id}")
                return

            updates = {
                "status": JobStatus.FAILED,
                "completed_at": datetime.now(timezone.utc),
                "last_error": error_message,
                "message": user_message or error_message,
                "error_code": error_code,
            }
            if increment_retry:
                updates["retry_count"] = job.retry_count + 1

            self.store.update_job(job_id, {
                **updates
            })
            self.logger.warning(
                "Job failed: %s - code=%s error=%s",
                job_id,
                error_code or "-",
                error_message,
            )
        except Exception as e:
            self.logger.error(f"Failed to mark job as failed: {e}")

    def cancel_job(
        self,
        job_id: str,
        *,
        message: Optional[str] = None,
        error_code: Optional[str] = None,
        metadata_patch: Optional[Dict[str, Any]] = None,
    ):
        """Mark job as cancelled.

        Args:
            job_id: Job identifier
        """
        try:
            existing = self.store.get_job(job_id)
            metadata = dict((existing.metadata if existing else {}) or {})
            if metadata_patch:
                metadata.update(metadata_patch)
            self.store.update_job(job_id, {
                "status": JobStatus.CANCELLED,
                "completed_at": datetime.now(timezone.utc),
                "message": message or ("Cancelled" if not existing else existing.message),
                "error_code": error_code,
                "metadata": metadata,
            })
            self.logger.info(f"Job cancelled: {job_id}")
        except Exception as e:
            self.logger.error(f"Failed to cancel job: {e}")

    def should_retry(self, job_id: str) -> bool:
        """Check if job should be retried after failure.

        Args:
            job_id: Job identifier

        Returns:
            True if job can be retried, False otherwise
        """
        job = self.store.get_job(job_id)
        if not job:
            return False

        return job.can_retry()

    def update_progress(self, job_id: str, progress: int, message: str):
        """Update job progress.

        Args:
            job_id: Job identifier
            progress: Progress percentage (0-100)
            message: Progress message
        """
        try:
            self.store.update_progress(job_id, progress, message)
        except Exception as e:
            # Log but don't fail - progress updates are non-critical
            self.logger.debug(f"Failed to update progress for {job_id}: {e}")

    def get_job(self, job_id: str) -> Optional[JobState]:
        """Get job state by ID.

        Args:
            job_id: Job identifier

        Returns:
            Job state if found, None otherwise
        """
        return self.store.get_job(job_id)

    def delete_job(self, job_id: str) -> bool:
        """Delete job and associated files.

        Args:
            job_id: Job identifier

        Returns:
            True if deleted, False if not found
        """
        job = self.store.get_job(job_id)
        if not job:
            return False

        # Delete session files
        try:
            self.report_service.session_manager.delete_session(job.session_id)
            self.logger.info(f"Deleted session files for job: {job_id}")
        except Exception as e:
            self.logger.warning(f"Failed to delete session files: {e}")

        # Delete job state
        return self.store.delete_job(job_id)
