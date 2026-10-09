"""Cross-platform file locking for concurrent file operations.

Provides a context manager for safe file operations in multi-threaded/multi-process
environments on both Windows and Unix-like systems.
"""

from __future__ import annotations

import os
import sys
import time
import logging
from pathlib import Path
from typing import Optional
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class FileLockError(Exception):
    """Error acquiring or releasing file lock."""
    pass


class FileLock:
    """Cross-platform file lock using OS-specific mechanisms.

    Usage:
        with FileLock(file_path):
            # Perform file operations safely
            ...
    """

    def __init__(
        self,
        file_path: Path | str,
        timeout: float = 30.0,
        check_interval: float = 0.1
    ):
        """Initialize file lock.

        Args:
            file_path: Path to file to lock
            timeout: Maximum time to wait for lock in seconds
            check_interval: Time between lock acquisition attempts in seconds
        """
        self.file_path = Path(file_path)
        self.lock_path = Path(str(file_path) + ".lock")
        self.timeout = timeout
        self.check_interval = check_interval
        self.fd: Optional[int] = None

    def __enter__(self):
        """Acquire lock with timeout."""
        start_time = time.time()

        while True:
            try:
                # Create lock file atomically
                # os.O_CREAT | os.O_EXCL ensures atomic creation (fails if exists)
                flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
                self.fd = os.open(str(self.lock_path), flags)

                # Write PID to lock file for debugging
                os.write(self.fd, f"{os.getpid()}\n".encode())

                logger.debug(f"Acquired lock: {self.lock_path}")
                return self

            except FileExistsError:
                # Lock file already exists, wait and retry
                elapsed = time.time() - start_time
                if elapsed >= self.timeout:
                    raise FileLockError(
                        f"Timeout waiting for lock on {self.file_path} "
                        f"after {self.timeout}s"
                    )

                time.sleep(self.check_interval)

            except Exception as e:
                raise FileLockError(f"Failed to acquire lock: {e}") from e

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Release lock."""
        if self.fd is not None:
            try:
                os.close(self.fd)
                self.fd = None
            except Exception as e:
                logger.warning(f"Error closing lock file descriptor: {e}")

        # Remove lock file
        try:
            if self.lock_path.exists():
                self.lock_path.unlink()
                logger.debug(f"Released lock: {self.lock_path}")
        except Exception as e:
            logger.warning(f"Error removing lock file: {e}")

        return False  # Don't suppress exceptions


@contextmanager
def safe_file_write(file_path: Path | str, timeout: float = 30.0):
    """Context manager for safe file writing with locking.

    Usage:
        with safe_file_write(path) as f:
            f.write(content)

    Args:
        file_path: Path to file to write
        timeout: Lock timeout in seconds

    Yields:
        File handle opened for writing
    """
    file_path = Path(file_path)

    with FileLock(file_path, timeout=timeout):
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, 'w', encoding='utf-8') as f:
            yield f


@contextmanager
def safe_file_read(file_path: Path | str, timeout: float = 30.0):
    """Context manager for safe file reading with locking.

    Usage:
        with safe_file_read(path) as f:
            content = f.read()

    Args:
        file_path: Path to file to read
        timeout: Lock timeout in seconds

    Yields:
        File handle opened for reading
    """
    file_path = Path(file_path)

    with FileLock(file_path, timeout=timeout):
        with open(file_path, 'r', encoding='utf-8') as f:
            yield f


def cleanup_stale_locks(directory: Path, max_age_seconds: int = 300):
    """Clean up stale lock files older than specified age.

    This is useful for cleaning up locks from crashed processes.

    Args:
        directory: Directory to scan for lock files
        max_age_seconds: Maximum age before considering lock stale
    """
    if not directory.exists():
        return

    current_time = time.time()
    cleaned_count = 0

    for lock_file in directory.rglob("*.lock"):
        try:
            stat = lock_file.stat()
            age = current_time - stat.st_mtime

            if age > max_age_seconds:
                lock_file.unlink()
                cleaned_count += 1
                logger.info(f"Cleaned up stale lock: {lock_file}")
        except Exception as e:
            logger.warning(f"Error cleaning lock {lock_file}: {e}")

    if cleaned_count > 0:
        logger.info(f"Cleaned up {cleaned_count} stale locks in {directory}")
