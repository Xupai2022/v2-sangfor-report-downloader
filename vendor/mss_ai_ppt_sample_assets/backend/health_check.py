"""Enhanced health check system for monitoring dependencies and resources.

Provides comprehensive health checks for:
- Disk space
- External dependencies (OpenAI API, LibreOffice)
- System resources
- Application state
"""

import asyncio
import shutil
import time
import logging
from pathlib import Path
from typing import Dict, Any, Optional
from dataclasses import dataclass, asdict
from enum import Enum

import httpx
from mss_ai_ppt_sample_assets.backend import config

logger = logging.getLogger(__name__)


class HealthStatus(str, Enum):
    """Health check status."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


@dataclass
class HealthCheck:
    """Individual health check result."""
    name: str
    status: HealthStatus
    message: str
    details: Optional[Dict[str, Any]] = None
    checked_at: Optional[float] = None

    def __post_init__(self):
        if self.checked_at is None:
            self.checked_at = time.time()

    def to_dict(self):
        data = asdict(self)
        data['status'] = self.status.value
        return data


class HealthChecker:
    """Comprehensive health checker for the application."""

    def __init__(self):
        self.checks_cache: Dict[str, HealthCheck] = {}
        self.cache_ttl = 30  # Cache results for 30 seconds

    async def check_all(self) -> Dict[str, Any]:
        """Run all health checks and return aggregated results."""
        checks = await asyncio.gather(
            self.check_disk_space(),
            self.check_openai_api(),
            self.check_libreoffice(),
            self.check_sessions(),
            self.check_file_locks(),
            return_exceptions=True
        )

        # Filter out exceptions
        valid_checks = []
        for check in checks:
            if isinstance(check, Exception):
                logger.error(f"Health check failed: {check}")
                valid_checks.append(HealthCheck(
                    name="unknown",
                    status=HealthStatus.UNHEALTHY,
                    message=f"Check failed: {check}"
                ))
            else:
                valid_checks.append(check)

        # Determine overall status
        overall_status = HealthStatus.HEALTHY
        for check in valid_checks:
            if check.status == HealthStatus.UNHEALTHY:
                overall_status = HealthStatus.UNHEALTHY
                break
            elif check.status == HealthStatus.DEGRADED:
                overall_status = HealthStatus.DEGRADED

        return {
            "status": overall_status.value,
            "timestamp": time.time(),
            "checks": {check.name: check.to_dict() for check in valid_checks}
        }

    async def check_disk_space(self) -> HealthCheck:
        """Check disk space availability."""
        try:
            outputs_dir = config.OUTPUTS_DIR
            stat = shutil.disk_usage(outputs_dir)

            free_gb = stat.free / (1024 ** 3)
            total_gb = stat.total / (1024 ** 3)
            usage_percent = (stat.used / stat.total) * 100

            # Thresholds
            if free_gb < 1:
                status = HealthStatus.UNHEALTHY
                message = f"Critical: Only {free_gb:.1f}GB free"
            elif free_gb < 5:
                status = HealthStatus.DEGRADED
                message = f"Warning: Only {free_gb:.1f}GB free"
            else:
                status = HealthStatus.HEALTHY
                message = f"{free_gb:.1f}GB available"

            return HealthCheck(
                name="disk_space",
                status=status,
                message=message,
                details={
                    "free_gb": round(free_gb, 2),
                    "total_gb": round(total_gb, 2),
                    "usage_percent": round(usage_percent, 1),
                    "path": str(outputs_dir)
                }
            )
        except Exception as e:
            logger.error(f"Disk space check failed: {e}")
            return HealthCheck(
                name="disk_space",
                status=HealthStatus.UNHEALTHY,
                message=f"Check failed: {e}"
            )

    async def check_openai_api(self) -> HealthCheck:
        """Check OpenAI API availability."""
        if not config.settings.enable_llm:
            return HealthCheck(
                name="openai_api",
                status=HealthStatus.HEALTHY,
                message="LLM disabled (using mock mode)",
                details={"enabled": False}
            )

        try:
            from openai import OpenAI

            client_kwargs = {"api_key": config.settings.openai_api_key}
            if config.settings.openai_base_url:
                client_kwargs["base_url"] = config.settings.openai_base_url
            client_kwargs["http_client"] = httpx.Client(trust_env=False)

            client = OpenAI(**client_kwargs)

            # Try to list models as a lightweight check
            start_time = time.time()
            models = client.models.list()
            latency_ms = (time.time() - start_time) * 1000

            return HealthCheck(
                name="openai_api",
                status=HealthStatus.HEALTHY,
                message="API reachable",
                details={
                    "enabled": True,
                    "latency_ms": round(latency_ms, 2),
                    "model": config.settings.openai_model,
                    "base_url": config.settings.openai_base_url or "default"
                }
            )
        except Exception as e:
            logger.error(f"OpenAI API check failed: {e}")
            return HealthCheck(
                name="openai_api",
                status=HealthStatus.UNHEALTHY,
                message=f"API unreachable: {type(e).__name__}",
                details={
                    "enabled": True,
                    "error": str(e)
                }
            )

    async def check_libreoffice(self) -> HealthCheck:
        """Check LibreOffice availability."""
        try:
            from mss_ai_ppt_sample_assets.backend.modules.preview_generator import PPTPreviewGenerator

            generator = PPTPreviewGenerator()
            soffice_path = generator._find_soffice()

            # Check if path exists
            if Path(soffice_path).exists() or shutil.which(soffice_path):
                return HealthCheck(
                    name="libreoffice",
                    status=HealthStatus.HEALTHY,
                    message="LibreOffice found",
                    details={
                        "path": soffice_path,
                        "installed": True
                    }
                )
            else:
                return HealthCheck(
                    name="libreoffice",
                    status=HealthStatus.DEGRADED,
                    message="LibreOffice not found (preview generation unavailable)",
                    details={
                        "path": soffice_path,
                        "installed": False
                    }
                )
        except Exception as e:
            logger.error(f"LibreOffice check failed: {e}")
            return HealthCheck(
                name="libreoffice",
                status=HealthStatus.DEGRADED,
                message=f"Check failed: {e}",
                details={"error": str(e)}
            )

    async def check_sessions(self) -> HealthCheck:
        """Check session directory health."""
        try:
            sessions_dir = config.SESSIONS_DIR

            if not sessions_dir.exists():
                return HealthCheck(
                    name="sessions",
                    status=HealthStatus.HEALTHY,
                    message="No sessions yet",
                    details={"count": 0}
                )

            # Count session directories
            session_dirs = [d for d in sessions_dir.iterdir() if d.is_dir()]
            total_count = len(session_dirs)

            # Find old sessions (older than configured retention period)
            current_time = time.time()
            retention_hours = config.settings.session_retention_days * 24
            old_sessions = []
            for session_dir in session_dirs:
                age_hours = (current_time - session_dir.stat().st_mtime) / 3600
                if age_hours > retention_hours:
                    old_sessions.append((session_dir.name, age_hours))

            # Check for orphaned sessions
            orphaned_count = len(old_sessions)

            if orphaned_count > 50:
                status = HealthStatus.DEGRADED
                message = f"{orphaned_count} old sessions need cleanup"
            else:
                status = HealthStatus.HEALTHY
                message = f"{total_count} active sessions"

            return HealthCheck(
                name="sessions",
                status=status,
                message=message,
                details={
                    "total_count": total_count,
                    "orphaned_count": orphaned_count,
                    "oldest_age_hours": round(max([age for _, age in old_sessions], default=0), 1)
                }
            )
        except Exception as e:
            logger.error(f"Sessions check failed: {e}")
            return HealthCheck(
                name="sessions",
                status=HealthStatus.UNHEALTHY,
                message=f"Check failed: {e}"
            )

    async def check_file_locks(self) -> HealthCheck:
        """Check for stale file locks."""
        try:
            outputs_dir = config.OUTPUTS_DIR

            if not outputs_dir.exists():
                return HealthCheck(
                    name="file_locks",
                    status=HealthStatus.HEALTHY,
                    message="No locks found",
                    details={"count": 0}
                )

            # Find all lock files
            lock_files = list(outputs_dir.rglob("*.lock"))
            total_locks = len(lock_files)

            # Check for stale locks (>5 minutes)
            current_time = time.time()
            stale_locks = []
            for lock_file in lock_files:
                age_seconds = current_time - lock_file.stat().st_mtime
                if age_seconds > 300:  # 5 minutes
                    stale_locks.append((lock_file.name, age_seconds))

            stale_count = len(stale_locks)

            if stale_count > 0:
                status = HealthStatus.DEGRADED
                message = f"{stale_count} stale locks detected"
            else:
                status = HealthStatus.HEALTHY
                message = f"{total_locks} active locks"

            return HealthCheck(
                name="file_locks",
                status=status,
                message=message,
                details={
                    "total_count": total_locks,
                    "stale_count": stale_count,
                    "max_age_seconds": round(max([age for _, age in stale_locks], default=0), 1)
                }
            )
        except Exception as e:
            logger.error(f"File locks check failed: {e}")
            return HealthCheck(
                name="file_locks",
                status=HealthStatus.UNHEALTHY,
                message=f"Check failed: {e}"
            )


# Singleton instance
health_checker = HealthChecker()
