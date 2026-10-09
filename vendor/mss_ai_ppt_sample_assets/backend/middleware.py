"""FastAPI middleware for request tracking and logging.

Provides:
- Request ID injection and tracking
- Request/response logging
- Timing information
"""

import time
import uuid
import logging
from typing import Callable

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from mss_ai_ppt_sample_assets.backend.logging_config import set_request_id, clear_request_id

logger = logging.getLogger(__name__)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Middleware to inject and track request IDs across the application."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Generate or extract request ID
        request_id = request.headers.get("X-Request-ID")
        if not request_id:
            request_id = str(uuid.uuid4())

        # Store in context for logging
        set_request_id(request_id)

        # Store in request state for access in route handlers
        request.state.request_id = request_id

        try:
            # Process request
            start_time = time.time()

            response = await call_next(request)

            # Calculate duration
            duration_ms = (time.time() - start_time) * 1000

            # Log request completion
            # Use WARNING for slow requests (>1s), DEBUG for normal requests
            if duration_ms > 1000:
                logger.warning(
                    f"Slow request: {request.method} {request.url.path} - {response.status_code} in {duration_ms:.0f}ms",
                    extra={
                        "request_method": request.method,
                        "request_path": request.url.path,
                        "status_code": response.status_code,
                        "duration_ms": duration_ms
                    }
                )
            else:
                logger.debug(
                    f"{request.method} {request.url.path} - {response.status_code} ({duration_ms:.2f}ms)",
                    extra={
                        "request_method": request.method,
                        "request_path": request.url.path,
                        "status_code": response.status_code,
                        "duration_ms": duration_ms
                    }
                )

            # Add request ID to response headers
            response.headers["X-Request-ID"] = request_id

            return response

        except Exception as e:
            # Log exception with request ID
            logger.exception(f"Request failed with exception: {e}")
            raise

        finally:
            # Clear request ID from context
            clear_request_id()


class ErrorLoggingMiddleware(BaseHTTPMiddleware):
    """Middleware to catch and log unhandled exceptions."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        try:
            return await call_next(request)
        except Exception as e:
            logger.exception(
                f"Unhandled exception: {type(e).__name__}",
                extra={
                    "exception_type": type(e).__name__,
                    "exception_message": str(e),
                    "request_method": request.method,
                    "request_path": request.url.path
                }
            )
            raise
