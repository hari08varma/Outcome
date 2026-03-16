"""
Layerinfinite SDK — client.py
Synchronous HTTP client using httpx with retry logic.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from .exceptions import (
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
)
from .models import GetScoresResponse, LogOutcomeRequest, LogOutcomeResponse

logger = logging.getLogger("layerinfinite")


class LayerinfiniteClient:
    """
    Synchronous client for the Layerinfinite Decision Intelligence API.

    Usage::

        client = LayerinfiniteClient(api_key="layerinfinite_your_key")
        scores = client.get_scores(agent_id="my-agent", issue_type="billing")
        print(scores.top_action.action_name)
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://outcome-production.up.railway.app",
        timeout: float = 10.0,
        max_retries: int = 3,
    ) -> None:
        if not api_key.startswith("layerinfinite_"):
            raise ValueError(
                "Invalid API key format. Key must start with 'layerinfinite_'. "
                "Get your key from https://outcome-green.vercel.app/settings/api-keys"
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._session = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers={
                "X-API-Key": api_key,
                "User-Agent": "layerinfinite-python-sdk/0.1.6",
                "Accept": "application/json",
            },
        )

    # ── Context Manager ───────────────────────────────────────
    def __enter__(self) -> "LayerinfiniteClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self._session.close()

    # ── Internal helpers ──────────────────────────────────────
    def _raise_for_status(self, response: httpx.Response) -> None:
        """Map HTTP error codes to typed SDK exceptions."""
        code = response.status_code
        try:
            body = response.json()
        except Exception:
            body = {}

        if code == 401:
            raise LayerinfiniteAuthError(
                "Invalid or missing API key. Verify your X-API-Key header.",
                status_code=code,
                response_body=body,
            )
        if code == 404:
            raise LayerinfiniteNotFoundError(
                "Resource not found.",
                status_code=code,
                response_body=body,
            )
        if code == 429:
            retry_after = int(response.headers.get("Retry-After", 60))
            raise LayerinfiniteRateLimitError(
                f"Rate limit exceeded. Retry after {retry_after}s.",
                status_code=code,
                response_body=body,
                retry_after=retry_after,
            )
        if code >= 500:
            raise LayerinfiniteServerError(
                f"Layerinfinite server error [{code}]: {body.get('error', 'unknown error')}",
                status_code=code,
                response_body=body,
            )
        if code >= 400:
            raise LayerinfiniteError(
                f"Request error [{code}]: {body.get('error', 'unknown')}",
                status_code=code,
                response_body=body,
            )

    def _request_with_retry(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Execute an HTTP request with exponential backoff on 5xx errors and 429 waits."""
        last_exc: Exception | None = None

        for attempt in range(self._max_retries + 1):
            try:
                response = self._session.request(method, path, **kwargs)

                # 429 — wait then retry
                if response.status_code == 429 and attempt < self._max_retries:
                    retry_after = int(response.headers.get("Retry-After", 60))
                    logger.warning(
                        "Rate limited. Waiting %ds before retry (attempt %d/%d).",
                        retry_after, attempt + 1, self._max_retries,
                    )
                    time.sleep(retry_after)
                    continue

                # 5xx — exponential backoff
                if response.status_code >= 500 and attempt < self._max_retries:
                    wait = 2 ** attempt  # 1s, 2s, 4s
                    logger.warning(
                        "Server error %d. Backing off %ds (attempt %d/%d).",
                        response.status_code, wait, attempt + 1, self._max_retries,
                    )
                    time.sleep(wait)
                    continue

                # Non-retryable or final attempt
                self._raise_for_status(response)
                return response

            except (LayerinfiniteAuthError, LayerinfiniteNotFoundError, LayerinfiniteError) as exc:
                raise exc from None
            except (LayerinfiniteRateLimitError, LayerinfiniteServerError) as exc:
                last_exc = exc
                if attempt >= self._max_retries:
                    raise
            except httpx.TimeoutException as exc:
                last_exc = exc
                logger.warning("Request timeout (attempt %d/%d).", attempt + 1, self._max_retries)
                if attempt >= self._max_retries:
                    raise LayerinfiniteError(f"Request timed out after {self._timeout}s") from exc
            except httpx.RequestError as exc:
                last_exc = exc
                logger.warning("Request error: %s (attempt %d/%d).", exc, attempt + 1, self._max_retries)
                if attempt >= self._max_retries:
                    raise LayerinfiniteError(f"Network error: {exc}") from exc

        raise LayerinfiniteError("Max retries exceeded") from last_exc

    # ── Public API ────────────────────────────────────────────
    def get_scores(
        self,
        agent_id: str,
        issue_type: str,
        environment: str = "production",
    ) -> GetScoresResponse:
        """
        Fetch ranked action scores for the given agent and context.

        Args:
            agent_id: Unique agent identifier.
            issue_type: Context type (e.g. "billing_dispute").
            environment: Deployment environment (default "production").

        Returns:
            GetScoresResponse with ranked_actions, top_action, and policy.

        Raises:
            LayerinfiniteAuthError: Invalid API key.
            LayerinfiniteRateLimitError: Too many requests.
            LayerinfiniteServerError: Server-side error.
        """
        params = {
            "agent_id": agent_id,
            "issue_type": issue_type,
            "environment": environment,
        }
        logger.debug("GET /v1/get-scores agent_id=%s issue_type=%s", agent_id, issue_type)
        response = self._request_with_retry("GET", "/v1/get-scores", params=params)
        data = response.json()
        if "agent_id" not in data:
            data["agent_id"] = agent_id
        return GetScoresResponse.model_validate(data)

    def log_outcome(
        self,
        request: LogOutcomeRequest,
    ) -> LogOutcomeResponse:
        """
        Log the outcome of an action taken by the agent.

        Args:
            request: LogOutcomeRequest with all required fields.

        Returns:
            LogOutcomeResponse with trust_score and policy recommendation.

        Raises:
            LayerinfiniteAuthError: Invalid API key.
            LayerinfiniteRateLimitError: Too many requests.
            LayerinfiniteServerError: Server-side error.
        """
        logger.debug(
            "POST /v1/log-outcome agent_id=%s action_id=%s success=%s",
            request.agent_id, request.action_id, request.success,
        )
        response = self._request_with_retry(
            "POST",
            "/v1/log-outcome",
            json=request.model_dump(exclude_none=True),
            headers={"Content-Type": "application/json"},
        )
        return LogOutcomeResponse.model_validate(response.json())

    def health(self) -> dict:
        """
        Check the API health endpoint (no auth required).

        Returns:
            dict with keys 'status' and 'version'.
        """
        logger.debug("GET /health")
        response = self._session.get("/health", timeout=5.0)
        response.raise_for_status()
        return response.json()
