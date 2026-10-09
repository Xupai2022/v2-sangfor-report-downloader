"""Retry policies for external API calls.

This module provides retry decorators for handling transient failures
in external API calls, particularly OpenAI LLM requests.
"""

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type, before_sleep_log, RetryError
from openai import RateLimitError, APIConnectionError, APITimeoutError
import logging

from mss_ai_ppt_sample_assets.backend import config

logger = logging.getLogger(__name__)


def is_retryable_llm_error(error: Exception) -> bool:
    """Return whether an LLM failure should be retried in generation flow."""
    # tenacity 可能将最终异常包成 RetryError，这里要解包成原始异常再判断类型。
    if isinstance(error, RetryError):
        last_exc = error.last_attempt.exception() if error.last_attempt else None
        if isinstance(last_exc, Exception):
            error = last_exc
    return isinstance(error, (RateLimitError, APIConnectionError, APITimeoutError))


def _build_llm_retry_policy(max_attempts: int):
    return retry(
        # 最大尝试次数（包含首次调用）。
        stop=stop_after_attempt(max_attempts),
        wait=wait_exponential(
            multiplier=1,
            # 指数退避等待区间 [min, max]，用于避免瞬时故障时的连续打满重试。
            min=max(0.0, config.settings.llm_retry_backoff_min_seconds),
            max=max(config.settings.llm_retry_backoff_min_seconds, config.settings.llm_retry_backoff_max_seconds),
        ),
        # 仅对可恢复异常重试：限流、网络连接失败、请求超时。
        retry=retry_if_exception_type((RateLimitError, APIConnectionError, APITimeoutError)),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        # 重试耗尽时抛原始异常（而不是 RetryError 包装），便于上层统一错误码映射。
        reraise=True,
    )


def with_llm_retry(func=None, *, max_attempts=None):
    """Decorator to add retry logic to LLM API calls.

    Automatically retries on rate limits, connection errors, and timeouts.
    Uses exponential backoff and configurable attempts.

    Example:
        @with_llm_retry
        def call_openai(prompt: str):
            response = client.chat.completions.create(...)
            return response

    Args:
        func: Function to wrap with retry logic

    Returns:
        Wrapped function with retry logic
    """
    resolved_attempts = max(1, int(max_attempts or config.settings.llm_retry_attempts))
    policy = _build_llm_retry_policy(resolved_attempts)
    if func is None:
        return policy
    return policy(func)
