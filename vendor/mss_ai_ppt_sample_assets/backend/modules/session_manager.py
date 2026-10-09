"""Session management for concurrent request handling.

Provides unique session IDs and isolated file paths to prevent
concurrent users from overwriting each other's files.
"""

from __future__ import annotations

import uuid
import time
import shutil
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import logging

logger = logging.getLogger(__name__)

# Session ID format: {uuid8}_{timestamp20}
# Example: a3f2c5d8_20250129143025123456
# - uuid8: 8-character hexadecimal UUID for uniqueness
# - timestamp20: YYYYMMDDHHMMSSffffff (year-month-day-hour-minute-second-microsecond)
SESSION_ID_PATTERN = re.compile(r'^[a-f0-9]{8}_\d{20}$')


class SessionManager:
    """Manages unique session IDs and isolated file paths for concurrent requests."""

    def __init__(self, base_dir: Path):
        """Initialize session manager.

        Args:
            base_dir: Base directory for all session outputs
        """
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def generate_session_id(self) -> str:
        """Generate a unique session ID.

        Format: {uuid8}_{timestamp}
        Example: a3f2c5d8_20250129143025123456

        Returns:
            Unique session ID string
        """
        uuid_part = uuid.uuid4().hex[:8]
        timestamp_part = datetime.now().strftime('%Y%m%d%H%M%S%f')
        return f"{uuid_part}_{timestamp_part}"

    def validate_session_id(self, session_id: str) -> bool:
        """Validate session ID format for security.

        Prevents path traversal attacks by ensuring session_id matches expected format.

        Args:
            session_id: Session ID to validate

        Returns:
            True if valid, False otherwise

        Raises:
            ValueError: If session_id is invalid (contains path traversal or wrong format)
        """
        if not session_id:
            raise ValueError("Session ID cannot be empty")

        # Check for path traversal attempts
        if '..' in session_id or '/' in session_id or '\\' in session_id:
            raise ValueError(f"Invalid session ID (path traversal detected): {session_id}")

        # Validate format: {uuid8}_{timestamp20}
        if not SESSION_ID_PATTERN.match(session_id):
            raise ValueError(
                f"Invalid session ID format: {session_id}. "
                f"Expected format: 8-char-hex_20-digit-timestamp (e.g., a3f2c5d8_20250129143025123456)"
            )

        return True

    def get_session_dir(self, session_id: str) -> Path:
        """Get isolated directory for a session.

        Args:
            session_id: Unique session ID

        Returns:
            Path to session directory

        Raises:
            ValueError: If session_id format is invalid
        """
        # Validate session ID for security
        self.validate_session_id(session_id)

        session_dir = self.base_dir / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        return session_dir

    def get_report_path(self, session_id: str, template_id: str) -> Path:
        """Get report file path for a session.

        Args:
            session_id: Unique session ID
            template_id: Template identifier

        Returns:
            Path to report file
        """
        session_dir = self.get_session_dir(session_id)
        return session_dir / f"report_{template_id}.pptx"

    def get_slidespec_path(self, session_id: str, template_id: str) -> Path:
        """Get slidespec file path for a session.

        Args:
            session_id: Unique session ID
            template_id: Template identifier

        Returns:
            Path to slidespec file
        """
        session_dir = self.get_session_dir(session_id)
        return session_dir / f"slidespec_{template_id}.json"

    def get_input_path(self, session_id: str) -> Path:
        """Get input JSON file path for a session.

        Args:
            session_id: Unique session ID

        Returns:
            Path to input JSON file
        """
        session_dir = self.get_session_dir(session_id)
        return session_dir / "input.json"

    def get_excel_path(self, session_id: str, original_filename: str) -> Path:
        """Get uploaded Excel file path for a session.

        Args:
            session_id: Unique session ID
            original_filename: Original uploaded filename

        Returns:
            Path to Excel file
        """
        session_dir = self.get_session_dir(session_id)
        return session_dir / original_filename

    def cleanup_old_sessions(self, max_age_hours: int = 168) -> int:
        """Clean up session directories older than specified age.

        Args:
            max_age_hours: Maximum age in hours before cleanup

        Returns:
            Number of sessions cleaned up
        """
        if not self.base_dir.exists():
            return 0

        cutoff_time = datetime.now() - timedelta(hours=max_age_hours)
        cleaned_count = 0

        for session_dir in self.base_dir.iterdir():
            if not session_dir.is_dir():
                continue

            # Check directory modification time
            try:
                mtime = datetime.fromtimestamp(session_dir.stat().st_mtime)
                if mtime < cutoff_time:
                    logger.info(f"Cleaning up old session: {session_dir.name}")
                    shutil.rmtree(session_dir, ignore_errors=True)
                    cleaned_count += 1
            except Exception as e:
                logger.warning(f"Failed to cleanup session {session_dir.name}: {e}")

        if cleaned_count > 0:
            logger.info(f"Cleaned up {cleaned_count} old sessions")

        return cleaned_count

    def session_exists(self, session_id: str) -> bool:
        """Check if a session directory exists.

        Args:
            session_id: Session ID to check

        Returns:
            True if session exists, False otherwise
        """
        session_dir = self.base_dir / session_id
        return session_dir.exists()

    def delete_session(self, session_id: str) -> bool:
        """Delete a specific session directory.

        Args:
            session_id: Session ID to delete

        Returns:
            True if deleted successfully, False otherwise
        """
        session_dir = self.base_dir / session_id
        if session_dir.exists():
            try:
                shutil.rmtree(session_dir)
                logger.info(f"Deleted session: {session_id}")
                return True
            except Exception as e:
                logger.error(f"Failed to delete session {session_id}: {e}")
                return False
        return False
