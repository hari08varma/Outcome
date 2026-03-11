"""
Layer5 SDK — Retry logic with exponential backoff and jitter.

Retries on:
  - Layer5ServerError (5xx)
  - Layer5NetworkError (connection failures)
  - Layer5TimeoutError (request timed out)
  - Layer5RateLimitError (429 — respects retry_after header)

Does NOT retry on:
  - Layer5AuthError (401) — won't succeed on retry
  - Layer5ValidationError (400) — won't succeed on retry
  - Layer5UnknownActionError — won't succeed on retry
  - Layer5AgentSuspendedError — won't succeed on retry
"""

from __future__ import annotations

import random
import time
from typing import Callable, Tuple, TypeVar

from .exceptions import (
    Layer5NetworkError,
    Layer5RateLimitError,
    Layer5ServerError,
    Layer5TimeoutError,
)

T = TypeVar("T")

# Errors that should be retried
RETRYABLE_EXCEPTIONS: Tuple[type, ...] = (
    Layer5NetworkError,
    Layer5TimeoutError,
    Layer5ServerError,
)

# HTTP status codes that should be retried
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def exponential_backoff(
    attempt: int,
    base_delay: float = 0.5,
    max_delay: float = 30.0,
    jitter: bool = True,
) -> float:
    """
    Calculate delay for attempt N.
    attempt=0: ~0.5s
    attempt=1: ~1.0s
    attempt=2: ~2.0s
    attempt=3: ~4.0s
    Capped at max_delay.
    Jitter prevents thundering herd.
    """
    delay = min(base_delay * (2**attempt), max_delay)
    if jitter:
        # Add up to 25% random jitter
        delay = delay * (0.75 + random.random() * 0.5)
    return delay


def with_retry(
    func: Callable[..., T],
    max_attempts: int = 3,
    retryable_exceptions: Tuple[type, ...] = RETRYABLE_EXCEPTIONS,
) -> Callable[..., T]:
    """
    Decorator that retries on transient failures.
    Uses exponential backoff with jitter.
    Does NOT retry on auth errors, validation errors,
    or unknown action errors — those won't succeed on retry.
    """

    def wrapper(*args, **kwargs):  # type: ignore[no-untyped-def]
        last_exception: Exception | None = None

        for attempt in range(max_attempts):
            try:
                return func(*args, **kwargs)
            except Layer5RateLimitError as e:
                # Respect the retry_after from server
                if attempt < max_attempts - 1:
                    time.sleep(e.retry_after)
                    last_exception = e
                    continue
                raise
            except retryable_exceptions as e:
                last_exception = e
                if attempt < max_attempts - 1:
                    delay = exponential_backoff(attempt)
                    time.sleep(delay)
                    continue
                raise
            except Exception:
                # Non-retryable — raise immediately
                raise

        if last_exception is not None:
            raise last_exception

    return wrapper
