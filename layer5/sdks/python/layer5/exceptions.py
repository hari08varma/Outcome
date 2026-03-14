"""
Layer5 SDK — exceptions.py
Typed exception hierarchy for all API failure modes.
"""

from __future__ import annotations


class Layer5Error(Exception):
    """Base exception for all Layer5 SDK errors."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        response_body: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.response_body = response_body or {}

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, "
            f"status_code={self.status_code!r})"
        )


class Layer5AuthError(Layer5Error):
    """Raised on HTTP 401 — invalid or missing API key."""


class Layer5RateLimitError(Layer5Error):
    """Raised on HTTP 429 — rate limit exceeded."""

    def __init__(
        self,
        message: str,
        status_code: int | None = 429,
        response_body: dict | None = None,
        retry_after: int = 60,
    ) -> None:
        super().__init__(message, status_code, response_body)
        self.retry_after = retry_after


class Layer5NotFoundError(Layer5Error):
    """Raised on HTTP 404 — resource not found."""


class Layer5ServerError(Layer5Error):
    """Raised on HTTP 5xx — server-side error."""
