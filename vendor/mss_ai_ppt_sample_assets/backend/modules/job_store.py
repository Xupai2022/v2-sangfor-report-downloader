"""Job state storage using file system persistence.

This module provides file-based job state persistence using JSON files
and the existing FileLock mechanism for concurrency control.

Storage Structure:
    outputs/jobs/
      ├── states/              # Job state files
      │   ├── {job_id}.json    # One JSON file per job
      │   └── ...
      ├── index.json           # Fast lookup index
      └── idempotency/         # Idempotency key mappings
          └── {key_hash}.json  # Maps idempotency key -> job_id
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
from pathlib import Path
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta, timezone

from mss_ai_ppt_sample_assets.backend.models.job_state import JobState, JobStatus
from mss_ai_ppt_sample_assets.backend.modules.file_lock import FileLock

logger = logging.getLogger(__name__)
RESTART_INTERRUPTED_ERROR_CODE = "RESTART_INTERRUPTED"


class JobStore:
    """File system-based job state storage.

    Uses JSON files for persistence with FileLock for concurrency control.
    Provides fast lookups via an in-memory index and supports idempotency.
    """

    def __init__(self, base_dir: Path):
        """Initialize job store.

        Args:
            base_dir: Base directory for all job state files
        """
        self.base_dir = base_dir
        self.states_dir = base_dir / "states"
        self.idempotency_dir = base_dir / "idempotency"
        self.index_file = base_dir / "index.json"

        # Create directory structure
        self.states_dir.mkdir(parents=True, exist_ok=True)
        self.idempotency_dir.mkdir(parents=True, exist_ok=True)

        # Initialize index
        if not self.index_file.exists():
            self._save_index({})

        logger.info(f"Initialized JobStore at {base_dir}")

    def _get_state_path(self, job_id: str) -> Path:
        """Get file path for job state.

        Args:
            job_id: Job identifier (format: session_id:template_id)

        Returns:
            Path to job state JSON file
        """
        # Use safe filename (replace : with _)
        safe_id = job_id.replace(":", "_").replace("/", "_").replace("\\", "_")
        return self.states_dir / f"{safe_id}.json"

    def _get_idempotency_path(self, key: str) -> Path:
        """Get file path for idempotency key mapping.

        Args:
            key: Idempotency key

        Returns:
            Path to idempotency mapping JSON file
        """
        # Use hash to avoid special characters in filename
        key_hash = hashlib.sha256(key.encode()).hexdigest()[:16]
        return self.idempotency_dir / f"{key_hash}.json"

    def _atomic_write_json(
        self,
        path: Path,
        payload: Any,
        default: Any = None,
    ) -> None:
        """Atomically write JSON to a file in the same directory."""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            with tmp_path.open("w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2, default=default)
            os.replace(tmp_path, path)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass

    def _read_json_unlocked(self, path: Path) -> Any:
        """Read JSON from file while caller holds the relevant lock."""
        if not path.exists():
            return None
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def _load_index_unlocked(self) -> Dict[str, Any]:
        """Load index while caller already holds index lock."""
        data = self._read_json_unlocked(self.index_file)
        return data if isinstance(data, dict) else {}

    def _save_index_unlocked(self, index: Dict[str, Any]) -> None:
        """Save index while caller already holds index lock."""
        self._atomic_write_json(self.index_file, index)

    def _load_job_unlocked(self, state_path: Path) -> Optional[JobState]:
        """Load a job from state file while caller already holds state lock."""
        data = self._read_json_unlocked(state_path)
        if data is None:
            return None
        return JobState(**data)

    def _save_job_unlocked(self, state_path: Path, job_state: JobState) -> None:
        """Save a job to state file while caller already holds state lock."""
        self._atomic_write_json(
            state_path,
            job_state.model_dump(),
            default=self._json_default,
        )

    def _load_index(self) -> Dict[str, Any]:
        """Load job index from file.

        Returns:
            Dictionary mapping job_id -> metadata
        """
        try:
            with FileLock(self.index_file, timeout=10.0):
                return self._load_index_unlocked()
        except Exception as e:
            logger.error(f"Failed to load index: {e}")
            return {}

    def _save_index(self, index: Dict[str, Any]):
        """Save job index to file.

        Args:
            index: Index dictionary to save
        """
        try:
            with FileLock(self.index_file, timeout=10.0):
                self._save_index_unlocked(index)
        except Exception as e:
            logger.error(f"Failed to save index: {e}")

    @staticmethod
    def _json_default(value: Any):
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)

    @staticmethod
    def _ensure_utc(value: Optional[datetime]) -> Optional[datetime]:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value

    def _update_index(self, job_state: JobState):
        """Update index with job metadata.

        Args:
            job_state: Job state to index
        """
        try:
            with FileLock(self.index_file, timeout=10.0):
                index = self._load_index_unlocked()
                index[job_state.job_id] = {
                    "status": job_state.status,
                    "created_at": job_state.created_at.isoformat(),
                    "updated_at": job_state.updated_at.isoformat(),
                    "completed_at": job_state.completed_at.isoformat() if job_state.completed_at else None,
                    "session_id": job_state.session_id,
                    "template_id": job_state.template_id,
                    "input_id": job_state.input_id,
                    "rating": job_state.rating.rating if job_state.rating else None
                }
                self._save_index_unlocked(index)
        except Exception as e:
            logger.error(f"Failed to update index for {job_state.job_id}: {e}")
            raise

    def _remove_index_entry(self, job_id: str) -> None:
        """Remove one job from index using atomic read-modify-write."""
        with FileLock(self.index_file, timeout=10.0):
            index = self._load_index_unlocked()
            if job_id in index:
                del index[job_id]
                self._save_index_unlocked(index)

    def create_job(self, job_state: JobState) -> JobState:
        """Create a new job.

        Args:
            job_state: Job state to create

        Returns:
            Created job state (or existing if already exists)
        """
        state_path = self._get_state_path(job_state.job_id)

        try:
            with FileLock(state_path, timeout=10.0):
                existing = self._load_job_unlocked(state_path)
                if existing:
                    logger.warning(f"Job {job_state.job_id} already exists, returning existing")
                    return existing
                self._save_job_unlocked(state_path, job_state)
        except Exception as e:
            logger.error(f"Failed to create job {job_state.job_id}: {e}")
            raise

        # Update index
        self._update_index(job_state)

        # Save idempotency mapping
        if job_state.idempotency_key:
            idem_path = self._get_idempotency_path(job_state.idempotency_key)
            try:
                with FileLock(idem_path, timeout=10.0):
                    self._atomic_write_json(idem_path, {"job_id": job_state.job_id})
            except Exception as e:
                logger.error(f"Failed to save idempotency mapping: {e}")

        logger.info(f"Created job: {job_state.job_id}")
        return job_state

    def get_job(self, job_id: str) -> Optional[JobState]:
        """Get job state by ID.

        Args:
            job_id: Job identifier

        Returns:
            Job state if found, None otherwise
        """
        state_path = self._get_state_path(job_id)

        if not state_path.exists():
            return None

        try:
            with FileLock(state_path, timeout=10.0):
                return self._load_job_unlocked(state_path)
        except Exception as e:
            logger.error(f"Failed to load job {job_id}: {e}")
            return None

    def update_job(self, job_id: str, updates: Dict[str, Any]) -> JobState:
        """Update job state.

        Args:
            job_id: Job identifier
            updates: Dictionary of fields to update

        Returns:
            Updated job state

        Raises:
            ValueError: If job not found
        """
        state_path = self._get_state_path(job_id)
        job: Optional[JobState] = None
        try:
            with FileLock(state_path, timeout=10.0):
                job = self._load_job_unlocked(state_path)
                if not job:
                    raise ValueError(f"Job {job_id} not found")

                # Update fields
                for key, value in updates.items():
                    if hasattr(job, key):
                        setattr(job, key, value)

                job.updated_at = datetime.now(timezone.utc)
                self._save_job_unlocked(state_path, job)
        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to update job {job_id}: {e}")
            raise

        # Update index
        if not job:
            raise ValueError(f"Job {job_id} not found")
        self._update_index(job)

        return job

    def update_progress(self, job_id: str, progress: int, message: str):
        """Update job progress.

        Args:
            job_id: Job identifier
            progress: Progress percentage (0-100)
            message: Progress message
        """
        try:
            self.update_job(job_id, {
                "progress": progress,
                "message": message
            })
        except Exception as e:
            logger.warning(f"Failed to update progress for {job_id}: {e}")

    def find_by_idempotency_key(self, key: str) -> Optional[JobState]:
        """Find job by idempotency key.

        Args:
            key: Idempotency key

        Returns:
            Job state if found, None otherwise
        """
        idem_path = self._get_idempotency_path(key)

        if not idem_path.exists():
            return None

        try:
            with FileLock(idem_path, timeout=10.0):
                with idem_path.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                    job_id = data.get("job_id")
        except Exception as e:
            logger.error(f"Failed to load idempotency mapping: {e}")
            return None

        return self.get_job(job_id) if job_id else None

    def list_jobs(
        self,
        status: Optional[JobStatus] = None,
        limit: int = 100
    ) -> List[JobState]:
        """List jobs with optional filtering.

        Args:
            status: Filter by job status (None = all)
            limit: Maximum number of jobs to return

        Returns:
            List of job states, sorted by creation time (newest first)
        """
        index = self._load_index()
        jobs = []

        # Sort by creation time (newest first)
        sorted_items = sorted(
            index.items(),
            key=lambda x: x[1].get("created_at", ""),
            reverse=True
        )

        for job_id, meta in sorted_items:
            if limit and len(jobs) >= limit:
                break

            if status and meta.get("status") != status:
                continue

            job = self.get_job(job_id)
            if job:
                jobs.append(job)

        return jobs

    def delete_job(self, job_id: str) -> bool:
        """Delete job state and related files.

        Args:
            job_id: Job identifier

        Returns:
            True if deleted, False if not found
        """
        state_path = self._get_state_path(job_id)

        job: Optional[JobState] = None
        try:
            with FileLock(state_path, timeout=10.0):
                job = self._load_job_unlocked(state_path)
                if not job:
                    return False
                if state_path.exists():
                    state_path.unlink()
        except Exception as e:
            logger.error(f"Failed to delete job state: {e}")
            return False

        # Delete idempotency mapping if exists
        if job and job.idempotency_key:
            idem_path = self._get_idempotency_path(job.idempotency_key)
            if idem_path.exists():
                try:
                    with FileLock(idem_path, timeout=10.0):
                        data = self._read_json_unlocked(idem_path) or {}
                        if data.get("job_id") == job_id and idem_path.exists():
                            idem_path.unlink()
                except Exception as e:
                    logger.warning(f"Failed to delete idempotency mapping: {e}")

        # Update index
        try:
            self._remove_index_entry(job_id)
        except Exception as e:
            logger.warning(f"Failed to remove index entry for {job_id}: {e}")

        logger.info(f"Deleted job: {job_id}")
        return True

    def cleanup_old_jobs(self, days: int = 7) -> int:
        """Clean up old completed/failed jobs.

        Args:
            days: Delete jobs older than this many days

        Returns:
            Number of jobs cleaned up
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cleaned_count = 0

        index = self._load_index()
        jobs_to_delete = []

        for job_id, meta in index.items():
            try:
                created_at_str = meta.get("created_at", "")
                if not created_at_str:
                    continue
                created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                created_at = self._ensure_utc(created_at)
                status = meta.get("status")

                # Only clean up terminal states
                if status in [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]:
                    if created_at < cutoff:
                        jobs_to_delete.append(job_id)
            except Exception as e:
                logger.warning(f"Error checking job {job_id} for cleanup: {e}")

        for job_id in jobs_to_delete:
            if self.delete_job(job_id):
                cleaned_count += 1

        if cleaned_count > 0:
            logger.info(f"Cleaned up {cleaned_count} old jobs (older than {days} days)")

        return cleaned_count

    def mark_running_jobs_failed(self, error_message: str) -> int:
        """Mark all running jobs as failed.

        Useful during startup recovery after an unclean shutdown/restart.

        Args:
            error_message: Failure reason to persist in job state

        Returns:
            Number of jobs marked as failed
        """
        running_jobs = self.list_jobs(status=JobStatus.RUNNING, limit=0)
        failed_count = 0

        for job in running_jobs:
            try:
                self.update_job(
                    job.job_id,
                    {
                        "status": JobStatus.FAILED,
                        "completed_at": datetime.now(timezone.utc),
                        "last_error": error_message,
                        "error_code": RESTART_INTERRUPTED_ERROR_CODE,
                        "message": "Task interrupted by service restart. Please regenerate."
                    },
                )
                failed_count += 1
            except Exception as e:
                logger.warning(f"Failed to mark running job as failed: {job.job_id}, error={e}")

        if failed_count > 0:
            logger.info(f"Marked {failed_count} running jobs as failed during startup recovery")

        return failed_count

    def list_jobs_filtered(
        self,
        page: int = 1,
        limit: int = 50,
        status: Optional[JobStatus] = None,
        rating: Optional[str] = None,  # "liked", "disliked", "unrated", or None for all
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None,
        sort_by: str = "created_at",
        sort_order: str = "desc"
    ) -> tuple[List[JobState], int]:
        """List jobs with filtering, searching, and pagination.

        Args:
            page: Page number (1-indexed)
            limit: Jobs per page (max 100)
            status: Filter by job status
            rating: Filter by rating ("liked", "disliked", "unrated", or None for all)
            search: Search in job_id, input_id, template_id
            date_from: Filter jobs created after this date
            date_to: Filter jobs created before this date
            sort_by: Field to sort by ("created_at", "completed_at", "updated_at")
            sort_order: Sort order ("asc" or "desc")

        Returns:
            Tuple of (job_list, total_count)
        """
        index = self._load_index()
        filtered_jobs = []
        date_from = self._ensure_utc(date_from)
        date_to = self._ensure_utc(date_to)

        # 1. Apply filters
        for job_id, meta in index.items():
            # Status filter
            if status and meta.get("status") != status:
                continue

            # Rating filter
            if rating:
                job_rating = meta.get("rating")
                if rating == "unrated":
                    if job_rating is not None:
                        continue
                elif rating in ["liked", "disliked"]:
                    if job_rating != rating:
                        continue

            # Search filter
            if search:
                search_lower = search.lower()
                searchable_text = " ".join([
                    job_id.lower(),
                    meta.get("input_id", "").lower(),
                    meta.get("template_id", "").lower()
                ])
                if search_lower not in searchable_text:
                    continue

            # Date range filter
            try:
                created_at_str = meta.get("created_at", "")
                # Handle both formats: with and without 'Z' suffix
                if created_at_str:
                    if not created_at_str.endswith('Z') and '+' not in created_at_str:
                        # Add 'Z' for UTC if missing
                        created_at_str = created_at_str + 'Z'
                    created_at = datetime.fromisoformat(created_at_str.replace('Z', '+00:00'))
                    created_at = self._ensure_utc(created_at)

                    if date_from and created_at < date_from:
                        continue
                    if date_to and created_at > date_to:
                        continue
            except (ValueError, TypeError) as e:
                logger.warning(f"Invalid date format for job {job_id}: {e}")
                continue

            filtered_jobs.append((job_id, meta))

        # 2. Sort
        def get_sort_key(item):
            _, meta = item
            sort_value = meta.get(sort_by, "")
            # Handle None values
            if sort_value is None:
                return "" if sort_order == "asc" else "9999-12-31"
            return sort_value

        filtered_jobs.sort(
            key=get_sort_key,
            reverse=(sort_order == "desc")
        )

        total_count = len(filtered_jobs)

        # 3. Paginate
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        paginated_items = filtered_jobs[start_idx:end_idx]

        # 4. Load full job objects
        result_jobs = []
        for job_id, _ in paginated_items:
            job = self.get_job(job_id)
            if job:
                result_jobs.append(job)

        return result_jobs, total_count

    def update_rating(
        self,
        job_id: str,
        rating: Optional[str],
        comment: Optional[str] = None,
        rated_by_session: Optional[str] = None,
        rated_by_ip: Optional[str] = None
    ) -> Optional[JobState]:
        """Update job rating with session tracking.

        Args:
            job_id: Job identifier
            rating: Rating value ("liked", "disliked", or None to clear rating)
            comment: Optional comment
            rated_by_session: Session ID of the rater
            rated_by_ip: IP address of the rater

        Returns:
            Updated job state, or None if job not found

        Raises:
            ValueError: If job already rated by this session
        """
        job = self.get_job(job_id)
        if not job:
            logger.warning(f"Cannot update rating: job {job_id} not found")
            return None

        # Import here to avoid circular dependency
        from mss_ai_ppt_sample_assets.backend.models.job_state import JobRating

        # Check if already rated by this session (one rating per session enforcement)
        if rated_by_session and job.rating and job.rating.rated_by_session == rated_by_session:
            raise ValueError(f"Session {rated_by_session} has already rated job {job_id}")

        # Create or update rating
        if rating is None:
            # Clear rating
            job.rating = None
        else:
            job.rating = JobRating(
                rating=rating,
                rated_at=datetime.now(timezone.utc),
                comment=comment,
                rated_by_session=rated_by_session,
                rated_by_ip=rated_by_ip
            )

        # Update job state
        try:
            updated_job = self.update_job(job_id, {"rating": job.rating})
            logger.info(f"Updated rating for job {job_id}: {rating} by session {rated_by_session}")
            return updated_job
        except Exception as e:
            logger.error(f"Failed to update rating for job {job_id}: {e}")
            return None

    def check_session_has_rated(self, job_id: str, session_id: str) -> bool:
        """Check if a session has already rated a job.

        Args:
            job_id: Job identifier
            session_id: Session identifier

        Returns:
            True if session has rated this job, False otherwise
        """
        job = self.get_job(job_id)
        if not job or not job.rating:
            return False
        return job.rating.rated_by_session == session_id
