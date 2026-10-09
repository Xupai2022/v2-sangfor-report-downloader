"""Admin service for dashboard operations."""

import logging
from typing import Optional, List, Dict, Any
from datetime import datetime
from pathlib import Path

from mss_ai_ppt_sample_assets.backend.models.job_state import JobState, JobStatus
from mss_ai_ppt_sample_assets.backend.modules.job_store import JobStore
from mss_ai_ppt_sample_assets.backend.schemas.admin import (
    JobSummary,
    PaginatedJobList,
    JobDetails,
    BulkDeleteResponse,
    AdminStatistics
)
from mss_ai_ppt_sample_assets.backend import config
from mss_ai_ppt_sample_assets.backend.modules.preview_generator import sanitize_job_id

logger = logging.getLogger(__name__)


class AdminService:
    """Business logic for admin dashboard operations."""

    def __init__(self, job_store: JobStore):
        """Initialize admin service.

        Args:
            job_store: Job storage instance
        """
        self.job_store = job_store

    def list_jobs_paginated(
        self,
        page: int = 1,
        limit: int = 50,
        status: Optional[JobStatus] = None,
        rating: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        sort_by: str = "created_at",
        sort_order: str = "desc"
    ) -> PaginatedJobList:
        """Get paginated job list with filtering.

        Args:
            page: Page number (1-indexed)
            limit: Jobs per page
            status: Filter by status
            rating: Filter by rating
            search: Search term
            date_from: Filter start date
            date_to: Filter end date
            sort_by: Sort field
            sort_order: Sort order

        Returns:
            Paginated job list
        """
        # Enforce max limit
        limit = min(limit, 100)

        # Get filtered jobs
        jobs, total = self.job_store.list_jobs_filtered(
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

        # Convert to job summaries
        summaries = []
        for job in jobs:
            summary = self._job_to_summary(job)
            summaries.append(summary)

        # Calculate pagination info
        has_next = (page * limit) < total
        has_prev = page > 1

        return PaginatedJobList(
            jobs=summaries,
            total=total,
            page=page,
            limit=limit,
            has_next=has_next,
            has_prev=has_prev
        )

    def get_job_details(self, job_id: str) -> Optional[JobDetails]:
        """Get detailed job information.

        Args:
            job_id: Job identifier

        Returns:
            Job details or None if not found
        """
        job = self.job_store.get_job(job_id)
        if not job:
            return None

        # Generate preview URLs
        preview_urls = self._get_preview_urls(job_id)

        # Generate download URLs
        report_url = f"/api/v1/reports/{job_id.replace(':', '_')}/download" if job.report_path else None
        slidespec_url = None  # Could add slidespec download endpoint later

        # Extract input stats from metadata
        input_stats = job.metadata.get("input_stats", {})

        return JobDetails(
            job=job,
            preview_urls=preview_urls,
            report_url=report_url,
            slidespec_url=slidespec_url,
            input_stats=input_stats
        )

    def rate_job(
        self,
        job_id: str,
        rating: Optional[str],
        comment: Optional[str] = None
    ) -> Optional[JobState]:
        """Rate a job.

        Args:
            job_id: Job identifier
            rating: Rating value
            comment: Optional comment

        Returns:
            Updated job state or None if not found
        """
        return self.job_store.update_rating(job_id, rating, comment)

    def bulk_delete_jobs(self, job_ids: List[str]) -> BulkDeleteResponse:
        """Delete multiple jobs.

        Args:
            job_ids: List of job IDs to delete

        Returns:
            Delete result with counts
        """
        deleted_count = 0
        failed = []

        for job_id in job_ids:
            try:
                if self.job_store.delete_job(job_id):
                    deleted_count += 1
                else:
                    failed.append(job_id)
            except Exception as e:
                logger.error(f"Failed to delete job {job_id}: {e}")
                failed.append(job_id)

        logger.info(f"Bulk delete: {deleted_count} succeeded, {len(failed)} failed")

        return BulkDeleteResponse(
            deleted_count=deleted_count,
            failed=failed
        )

    def get_statistics(self) -> AdminStatistics:
        """Get admin dashboard statistics.

        Returns:
            Statistics summary
        """
        # Get all jobs (unfiltered)
        all_jobs, total = self.job_store.list_jobs_filtered(
            page=1,
            limit=10000  # Get all for stats
        )

        # Calculate statistics
        by_status = {}
        by_rating = {"liked": 0, "disliked": 0, "unrated": 0}
        completed_jobs = []
        failed_jobs = []
        total_duration = 0
        duration_count = 0

        for job in all_jobs:
            # Status count
            status_str = job.status.value
            by_status[status_str] = by_status.get(status_str, 0) + 1

            # Rating count
            if job.rating and job.rating.rating:
                rating_val = job.rating.rating
                by_rating[rating_val] = by_rating.get(rating_val, 0) + 1
            else:
                by_rating["unrated"] += 1

            # Track completed/failed for success rate
            if job.status == JobStatus.COMPLETED:
                completed_jobs.append(job)
            elif job.status == JobStatus.FAILED:
                failed_jobs.append(job)

            # Calculate average duration
            duration = job.metadata.get("generation_duration_ms")
            if duration:
                total_duration += duration
                duration_count += 1

        # Success rate
        terminal_jobs = len(completed_jobs) + len(failed_jobs)
        success_rate = len(completed_jobs) / terminal_jobs if terminal_jobs > 0 else 0

        # Average generation time
        avg_duration = total_duration / duration_count if duration_count > 0 else None

        # Recent errors (last 5)
        recent_errors = []
        for job in sorted(failed_jobs, key=lambda j: j.completed_at or j.created_at, reverse=True)[:5]:
            recent_errors.append({
                "job_id": job.job_id,
                "error": job.last_error or "Unknown error",
                "timestamp": (job.completed_at or job.updated_at).isoformat()
            })

        return AdminStatistics(
            total_jobs=total,
            by_status=by_status,
            by_rating=by_rating,
            success_rate=round(success_rate, 2),
            avg_generation_time_ms=round(avg_duration, 1) if avg_duration else None,
            recent_errors=recent_errors
        )

    def _job_to_summary(self, job: JobState) -> JobSummary:
        """Convert JobState to JobSummary.

        Args:
            job: Job state

        Returns:
            Job summary
        """
        # Get generation duration from metadata
        duration = job.metadata.get("generation_duration_ms")

        # Check for warnings
        warnings = job.metadata.get("warnings", [])
        has_warnings = len(warnings) > 0

        # Get first preview URL as thumbnail
        thumbnail = None
        if job.status == JobStatus.COMPLETED:
            preview_urls = self._get_preview_urls(job.job_id)
            if preview_urls:
                thumbnail = preview_urls[0]

        return JobSummary(
            job_id=job.job_id,
            session_id=job.session_id,
            template_id=job.template_id,
            input_id=job.input_id,
            status=job.status,
            rating=job.rating,
            created_at=job.created_at,
            completed_at=job.completed_at,
            generation_duration_ms=duration,
            has_warnings=has_warnings,
            preview_thumbnail=thumbnail
        )

    def _get_preview_urls(self, job_id: str) -> List[str]:
        """Get preview image URLs for a job.

        Args:
            job_id: Job identifier

        Returns:
            List of preview URLs
        """
        preview_job_id = sanitize_job_id(job_id)
        preview_dir = config.PREVIEWS_DIR / preview_job_id

        if not preview_dir.exists():
            return []

        def _slide_num(path: Path) -> int:
            stem = path.stem
            if stem.startswith("slide"):
                suffix = stem[len("slide"):]
                try:
                    return int(suffix)
                except Exception:
                    return 10**9
            return 10**9

        preview_files = sorted(preview_dir.glob("slide*.png"), key=_slide_num)

        urls = []
        for preview_file in preview_files:
            url = f"/static/previews/{preview_job_id}/{preview_file.name}"
            urls.append(url)

        return urls
