"""Logging configuration with file persistence and rotation.

This module provides centralized logging configuration with:
- Console output for development
- Rotating file handler for production
- Configurable log levels via environment variable
- Request ID support (via context vars)
"""

import logging
import sys
from pathlib import Path
from logging.handlers import RotatingFileHandler
from contextvars import ContextVar
from typing import Optional

from mss_ai_ppt_sample_assets.backend import config

# Context variable for request ID tracking
request_id_var: ContextVar[Optional[str]] = ContextVar('request_id', default=None)


class RequestIdFilter(logging.Filter):
    """Add request_id to log records."""

    def filter(self, record):
        record.request_id = request_id_var.get() or "N/A"
        return True


class SensitiveDataFilter(logging.Filter):
    """Redact sensitive information from logs."""

    import re

    PATTERNS = [
        # API keys
        (re.compile(r'(api[-_]?key["\s:=]+)([a-zA-Z0-9-]{20,})'), r'\1***REDACTED***'),
        # Passwords
        (re.compile(r'(password["\s:=]+)([^\s"]+)'), r'\1***REDACTED***'),
        # Bearer tokens
        (re.compile(r'(Bearer\s+)([a-zA-Z0-9._-]+)'), r'\1***REDACTED***'),
        # OpenAI API keys
        (re.compile(r'(sk-[a-zA-Z0-9]{20,})'), r'sk-***REDACTED***'),
    ]

    def filter(self, record):
        msg = record.getMessage()
        for pattern, replacement in self.PATTERNS:
            msg = pattern.sub(replacement, msg)
        record.msg = msg
        record.args = ()  # Clear args to prevent duplicate formatting
        return True


class CompactFormatter(logging.Formatter):
    """Formatter with compact module names for better readability.

    Transforms:
        mss_ai_ppt_sample_assets.backend.app -> backend.app
        mss_ai_ppt_sample_assets.backend.routers.v1.reports -> v1.reports
    """

    def format(self, record):
        # Shorten module name to last 2 segments for better readability
        parts = record.name.split('.')
        if len(parts) > 2:
            # Keep last 2 parts (e.g., backend.app, v1.reports)
            record.name = '.'.join(parts[-2:])
        return super().format(record)


class SafeStreamHandler(logging.StreamHandler):
    """Stream handler that won't crash on UnicodeEncodeError (common on Windows GBK consoles)."""

    def emit(self, record):
        try:
            msg = self.format(record)
            try:
                self.stream.write(msg + self.terminator)
            except UnicodeEncodeError:
                safe = msg.encode("ascii", errors="backslashreplace").decode("ascii")
                self.stream.write(safe + self.terminator)
            self.flush()
        except Exception:
            self.handleError(record)


def setup_logging(
    log_level: Optional[str] = None,
    log_dir: Optional[Path] = None,
    max_bytes: int = 50 * 1024 * 1024,  # 50MB
    backup_count: int = 10
):
    """Setup application logging with file rotation and sensitive data filtering.

    Args:
        log_level: Log level (DEBUG, INFO, WARNING, ERROR). Defaults to env var LOG_LEVEL or INFO.
        log_dir: Directory for log files. Defaults to outputs/logs.
        max_bytes: Maximum size of each log file before rotation.
        backup_count: Number of backup log files to keep.
    """
    # Determine log level
    if log_level is None:
        import os
        log_level = os.getenv("LOG_LEVEL", "INFO").upper()

    numeric_level = getattr(logging, log_level, logging.INFO)

    # Ensure log directory exists
    if log_dir is None:
        log_dir = config.LOGS_DIR
    log_dir.mkdir(parents=True, exist_ok=True)

    # Create formatters with compact module names
    detailed_formatter = CompactFormatter(
        fmt='%(asctime)s - [%(request_id)s] - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    console_formatter = CompactFormatter(
        fmt='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%H:%M:%S'
    )

    # Create filters
    request_id_filter = RequestIdFilter()
    sensitive_filter = SensitiveDataFilter()

    # Console handler (development)
    console_handler = SafeStreamHandler(sys.stdout)
    console_handler.setLevel(numeric_level)
    console_handler.setFormatter(console_formatter)
    console_handler.addFilter(sensitive_filter)

    # Rotating file handler (production)
    file_handler = RotatingFileHandler(
        filename=log_dir / "app.log",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    file_handler.setLevel(numeric_level)
    file_handler.setFormatter(detailed_formatter)
    file_handler.addFilter(request_id_filter)
    file_handler.addFilter(sensitive_filter)

    # Error log file (ERROR and above only)
    error_handler = RotatingFileHandler(
        filename=log_dir / "error.log",
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding='utf-8'
    )
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(detailed_formatter)
    error_handler.addFilter(request_id_filter)
    error_handler.addFilter(sensitive_filter)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)

    # Remove existing handlers to avoid duplicates
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    # Add our handlers
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(error_handler)

    # Log configuration
    logger = logging.getLogger(__name__)
    logger.info(f"Logging configured: level={log_level}, log_dir={log_dir}")
    logger.info(f"Log rotation: max_size={max_bytes/(1024*1024):.1f}MB, backups={backup_count}")

    return root_logger


def get_request_id() -> Optional[str]:
    """Get current request ID from context."""
    return request_id_var.get()


def set_request_id(request_id: str):
    """Set request ID in context."""
    request_id_var.set(request_id)


def clear_request_id():
    """Clear request ID from context."""
    request_id_var.set(None)
