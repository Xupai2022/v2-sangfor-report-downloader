"""Unified exception hierarchy for MSS AI PPT Backend.

This module defines a consistent exception hierarchy for the entire application,
providing clear error types and standardized error handling patterns.
"""

from typing import Optional, Dict, Any


class MSSAIException(Exception):
    """Base exception for all MSS AI PPT errors.

    Provides consistent error handling with optional error codes and context.

    Attributes:
        message: Human-readable error message
        error_code: Optional machine-readable error code
        context: Optional dictionary with additional error context
    """

    def __init__(
        self,
        message: str,
        error_code: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.error_code = error_code or self.__class__.__name__
        self.context = context or {}
        super().__init__(self.message)

    def to_dict(self) -> Dict[str, Any]:
        """Convert exception to dictionary for API responses."""
        return {
            "error": self.error_code,
            "message": self.message,
            "context": self.context
        }


# ============================================================================
# Resource Not Found Errors
# ============================================================================

class ResourceNotFoundError(MSSAIException):
    """Base class for resource not found errors."""
    pass


class InputNotFoundError(ResourceNotFoundError):
    """Raised when input data file is not found."""

    def __init__(self, input_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"Input data not found: {input_id}",
            error_code="INPUT_NOT_FOUND",
            context={"input_id": input_id}
        )


class TemplateNotFoundError(ResourceNotFoundError):
    """Raised when template is not found."""

    def __init__(self, template_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"Template not found: {template_id}",
            error_code="TEMPLATE_NOT_FOUND",
            context={"template_id": template_id}
        )


class SlideSpecNotFoundError(ResourceNotFoundError):
    """Raised when slide specification is not found."""

    def __init__(self, job_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"Slide specification not found: {job_id}",
            error_code="SLIDESPEC_NOT_FOUND",
            context={"job_id": job_id}
        )


class SessionNotFoundError(ResourceNotFoundError):
    """Raised when session is not found."""

    def __init__(self, session_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"Session not found: {session_id}",
            error_code="SESSION_NOT_FOUND",
            context={"session_id": session_id}
        )


# ============================================================================
# Validation Errors
# ============================================================================

class ValidationError(MSSAIException):
    """Base class for validation errors."""
    pass


class InvalidSessionIDError(ValidationError):
    """Raised when session ID format is invalid."""

    def __init__(self, session_id: str, message: Optional[str] = None):
        super().__init__(
            message or f"Invalid session ID format: {session_id}",
            error_code="INVALID_SESSION_ID",
            context={"session_id": session_id}
        )


class InvalidTemplateVersionError(ValidationError):
    """Raised when template version is invalid or unsupported."""

    def __init__(self, template_id: str, version: str, message: Optional[str] = None):
        super().__init__(
            message or f"Invalid template version '{version}' for {template_id}",
            error_code="INVALID_TEMPLATE_VERSION",
            context={"template_id": template_id, "version": version}
        )


class DataValidationError(ValidationError):
    """Raised when data validation fails."""

    def __init__(self, field: str, message: Optional[str] = None, **context):
        super().__init__(
            message or f"Validation failed for field: {field}",
            error_code="DATA_VALIDATION_ERROR",
            context={"field": field, **context}
        )


class FileValidationError(ValidationError):
    """Raised when file validation fails."""

    def __init__(self, filename: str, reason: str, message: Optional[str] = None):
        super().__init__(
            message or f"File validation failed for {filename}: {reason}",
            error_code="FILE_VALIDATION_ERROR",
            context={"filename": filename, "reason": reason}
        )


# ============================================================================
# Generation Errors
# ============================================================================

class GenerationError(MSSAIException):
    """Base class for content generation errors."""
    pass


class LLMGenerationError(GenerationError):
    """Raised when LLM content generation fails."""

    def __init__(self, message: str, slide_key: Optional[str] = None, **context):
        super().__init__(
            message,
            error_code="LLM_GENERATION_ERROR",
            context={"slide_key": slide_key, **context} if slide_key else context
        )


class PPTGenerationError(GenerationError):
    """Raised when PowerPoint generation fails."""

    def __init__(self, message: str, template_id: Optional[str] = None, **context):
        super().__init__(
            message,
            error_code="PPT_GENERATION_ERROR",
            context={"template_id": template_id, **context} if template_id else context
        )


class PreviewGenerationError(GenerationError):
    """Raised when preview generation fails."""

    def __init__(self, message: str, job_id: Optional[str] = None, **context):
        super().__init__(
            message,
            error_code="PREVIEW_GENERATION_ERROR",
            context={"job_id": job_id, **context} if job_id else context
        )


# ============================================================================
# File Operation Errors
# ============================================================================

class FileOperationError(MSSAIException):
    """Base class for file operation errors."""
    pass


class FileLockError(FileOperationError):
    """Raised when file locking fails."""

    def __init__(self, file_path: str, message: Optional[str] = None):
        super().__init__(
            message or f"Failed to acquire lock for file: {file_path}",
            error_code="FILE_LOCK_ERROR",
            context={"file_path": file_path}
        )


class FileLockTimeoutError(FileLockError):
    """Raised when file lock acquisition times out."""

    def __init__(self, file_path: str, timeout: float):
        super().__init__(
            file_path,
            message=f"Timeout acquiring lock for {file_path} after {timeout}s"
        )
        self.context["timeout"] = timeout
        self.error_code = "FILE_LOCK_TIMEOUT"


# ============================================================================
# External Service Errors
# ============================================================================

class ExternalServiceError(MSSAIException):
    """Base class for external service errors."""
    pass


class OpenAIAPIError(ExternalServiceError):
    """Raised when OpenAI API call fails."""

    def __init__(self, message: str, status_code: Optional[int] = None, **context):
        super().__init__(
            message,
            error_code="OPENAI_API_ERROR",
            context={"status_code": status_code, **context} if status_code else context
        )


class LibreOfficeError(ExternalServiceError):
    """Raised when LibreOffice conversion fails."""

    def __init__(self, message: str, **context):
        super().__init__(
            message,
            error_code="LIBREOFFICE_ERROR",
            context=context
        )


# ============================================================================
# Configuration Errors
# ============================================================================

class ConfigurationError(MSSAIException):
    """Raised when configuration is invalid or missing."""

    def __init__(self, message: str, config_key: Optional[str] = None):
        super().__init__(
            message,
            error_code="CONFIGURATION_ERROR",
            context={"config_key": config_key} if config_key else {}
        )
