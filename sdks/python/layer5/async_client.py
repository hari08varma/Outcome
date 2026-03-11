"""
Layer5 Python SDK — async client (httpx.AsyncClient).

Identical interface to Layer5 sync client but all methods
are async/await. Uses asyncio.sleep for backoff.

Usage:
    async with AsyncLayer5(api_key="layer5_...") as l5:
        scores = await l5.get_scores(
            agent_id="my-agent",
            context={"issue_type": "payment_failed"}
        )
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Dict, Optional

import httpx

from ._version import __version__
from .exceptions import (
    Layer5AgentSuspendedError,
    Layer5AuthError,
    Layer5Error,
    Layer5NetworkError,
    Layer5RateLimitError,
    Layer5ServerError,
    Layer5TimeoutError,
    Layer5UnknownActionError,
    Layer5ValidationError,
)
from .models import (
    GetScoresResponse,
    LogOutcomeResponse,
    OutcomeFeedbackResponse,
    SimulateResponse,
)
from .retry import exponential_backoff

DEFAULT_BASE_URL = "https://api.layer5.dev"
DEFAULT_TIMEOUT = 10.0
DEFAULT_RETRIES = 3


class AsyncLayer5:
    """
    Layer5 Python SDK — async client.
    Use this with asyncio, FastAPI, LangChain async, etc.

    Usage:
        async with AsyncLayer5(api_key="layer5_...") as l5:
            scores = await l5.get_scores(
                agent_id="my-agent",
                context={"issue_type": "payment_failed"}
            )
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_RETRIES,
        agent_id: Optional[str] = None,
    ):
        resolved_key = api_key or os.environ.get("LAYER5_API_KEY")

        if not resolved_key:
            raise Layer5AuthError(
                "No API key provided. "
                "Pass api_key='layer5_...' or set "
                "LAYER5_API_KEY environment variable. "
                "Get your key at "
                "https://app.layer5.dev/settings/api-keys"
            )

        if not re.match(r"^layer5_[a-zA-Z0-9]{20,}$", resolved_key):
            raise Layer5AuthError(
                f"Invalid API key format: '{resolved_key[:12]}...'. "
                f"Keys must start with 'layer5_' followed by "
                f"at least 20 alphanumeric characters. "
                f"Check for extra spaces or truncation."
            )

        resolved_base = base_url or os.environ.get(
            "LAYER5_BASE_URL", DEFAULT_BASE_URL
        )

        self.api_key = resolved_key
        self.base_url = resolved_base.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.agent_id = agent_id

        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": f"layer5-python/{__version__}",
                "X-SDK-Version": __version__,
            },
            timeout=timeout,
        )

    # ── Response handler (sync — no I/O) ──────────────────────

    def _handle_response(self, response: httpx.Response) -> dict:
        if response.status_code in (200, 201):
            return response.json()

        try:
            error_body = response.json()
            error_code = error_body.get("code", "")
            error_msg = error_body.get(
                "error", error_body.get("message", "")
            )
        except Exception:
            error_body = {}
            error_code = ""
            error_msg = response.text[:200]

        request_id = response.headers.get("x-request-id")

        if response.status_code == 400:
            field = error_body.get("field")
            raise Layer5ValidationError(error_msg, field=field)
        elif response.status_code == 401:
            raise Layer5AuthError()
        elif response.status_code == 422:
            raise Layer5ValidationError(error_msg)
        elif response.status_code == 429:
            retry_after = int(response.headers.get("retry-after", "60"))
            raise Layer5RateLimitError(retry_after=retry_after)
        elif response.status_code == 404:
            if error_code == "UNKNOWN_ACTION":
                action = error_body.get("action_name", "unknown")
                raise Layer5UnknownActionError(action)
            raise Layer5Error(f"Resource not found: {error_msg}")
        elif response.status_code == 403:
            if error_code == "AGENT_SUSPENDED":
                agent = error_body.get("agent_id", "unknown")
                raise Layer5AgentSuspendedError(agent)
            raise Layer5AuthError(f"Access denied: {error_msg}")
        elif response.status_code >= 500:
            raise Layer5ServerError(
                response.status_code, request_id=request_id
            )
        else:
            raise Layer5Error(
                f"Unexpected status {response.status_code}: {error_msg}"
            )

    # ── Request with retries ──────────────────────────────────

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict:
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            try:
                response = await self._client.request(
                    method, path, **kwargs
                )
                return self._handle_response(response)

            except (Layer5ServerError, Layer5RateLimitError) as e:
                last_error = e
                if attempt < self.max_retries - 1:
                    if isinstance(e, Layer5RateLimitError):
                        await asyncio.sleep(min(e.retry_after, 1))
                    else:
                        await asyncio.sleep(exponential_backoff(attempt))
                    continue
                raise

            except httpx.TimeoutException as e:
                last_error = Layer5TimeoutError(
                    f"Request timed out after {self.timeout}s",
                    original=e,
                )
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(exponential_backoff(attempt))
                    continue
                raise last_error

            except httpx.NetworkError as e:
                last_error = Layer5NetworkError(str(e), original=e)
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(exponential_backoff(attempt))
                    continue
                raise last_error

            except (
                Layer5AuthError,
                Layer5ValidationError,
                Layer5UnknownActionError,
                Layer5AgentSuspendedError,
                Layer5Error,
            ):
                raise

            except Exception as e:
                raise Layer5NetworkError(str(e), original=e)

        if last_error is not None:
            raise last_error
        raise Layer5Error("Request failed after retries")  # pragma: no cover

    # ── Public API methods ────────────────────────────────────

    async def get_scores(
        self,
        context: Dict[str, Any],
        agent_id: Optional[str] = None,
        top_n: int = 10,
        refresh: bool = False,
        episode_id: Optional[str] = None,
        episode_history: Optional[list] = None,
    ) -> GetScoresResponse:
        """
        Get ranked actions for your agent to choose from.
        Async version — use ``await l5.get_scores(...)``.
        """
        resolved_agent = agent_id or self.agent_id
        if not resolved_agent:
            raise Layer5ValidationError(
                "agent_id is required. "
                "Pass it here or set it on the client: "
                "AsyncLayer5(api_key=..., agent_id='my-agent')",
                field="agent_id",
            )

        start_ms = time.time() * 1000

        params: Dict[str, str] = {"agent_id": resolved_agent}
        if "issue_type" in context:
            params["issue_type"] = str(context["issue_type"])
        if "context_id" in context:
            params["context_id"] = str(context["context_id"])
        if top_n != 10:
            params["top_n"] = str(top_n)
        if refresh:
            params["refresh"] = "true"
        if episode_id is not None:
            params["episode_id"] = episode_id
        if episode_history is not None:
            params["episode_history"] = json.dumps(episode_history)

        if "issue_type" not in params and "context_id" not in params:
            params["issue_type"] = json.dumps(context)

        data = await self._request("GET", "/v1/get-scores", params=params)

        latency = time.time() * 1000 - start_ms
        response = GetScoresResponse(**data)
        response.latency_ms = round(latency, 2)
        return response

    async def log_outcome(
        self,
        action_name: str,
        success: bool,
        session_id: str,
        issue_type: str,
        agent_id: Optional[str] = None,
        action_params: Optional[Dict[str, Any]] = None,
        response_time_ms: Optional[int] = None,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        raw_context: Optional[Dict[str, Any]] = None,
        environment: Optional[str] = None,
        customer_tier: Optional[str] = None,
        outcome_score: Optional[float] = None,
        business_outcome: Optional[str] = None,
        feedback_signal: Optional[str] = None,
        decision_id: Optional[str] = None,
        episode_history: Optional[list] = None,
    ) -> LogOutcomeResponse:
        """
        Log what happened after your agent took an action.
        Async version — use ``await l5.log_outcome(...)``.
        """
        resolved_agent = agent_id or self.agent_id
        if not resolved_agent:
            raise Layer5ValidationError(
                "agent_id is required.",
                field="agent_id",
            )

        if outcome_score is not None and not (0.0 <= outcome_score <= 1.0):
            raise Layer5ValidationError(
                f"outcome_score must be between 0.0 and 1.0, got {outcome_score}.",
                field="outcome_score",
            )

        payload: Dict[str, Any] = {
            "session_id": session_id,
            "action_name": action_name,
            "issue_type": issue_type,
            "success": success,
        }
        if action_params is not None:
            payload["action_params"] = action_params
        if response_time_ms is not None:
            payload["response_time_ms"] = response_time_ms
        if error_code is not None:
            payload["error_code"] = error_code
        if error_message is not None:
            payload["error_message"] = error_message
        if raw_context is not None:
            payload["raw_context"] = raw_context
        if environment is not None:
            payload["environment"] = environment
        if customer_tier is not None:
            payload["customer_tier"] = customer_tier
        if outcome_score is not None:
            payload["outcome_score"] = outcome_score
        if business_outcome is not None:
            payload["business_outcome"] = business_outcome
        if feedback_signal is not None:
            payload["feedback_signal"] = feedback_signal
        if decision_id is not None:
            payload["decision_id"] = decision_id
        if episode_history is not None:
            payload["episode_history"] = episode_history

        data = await self._request("POST", "/v1/log-outcome", json=payload)
        return LogOutcomeResponse(**data)

    async def simulate(
        self,
        proposed_sequence: list,
        context: Dict[str, Any],
        agent_id: Optional[str] = None,
        episode_history: Optional[list] = None,
        simulate_alternatives: int = 2,
        max_sequence_depth: int = 5,
    ) -> SimulateResponse:
        """
        Predict outcomes for a proposed action sequence.
        Async version — use ``await l5.simulate(...)``.

        Raises:
            Layer5ValidationError:  proposed_sequence is empty or > 5
            Layer5AuthError:        bad API key
            Layer5NetworkError:     connection failed after retries
        """
        if not proposed_sequence:
            raise Layer5ValidationError(
                "proposed_sequence cannot be empty. "
                "Provide at least one action name.",
                field="proposed_sequence",
            )

        if len(proposed_sequence) > 5:
            raise Layer5ValidationError(
                f"proposed_sequence max length is 5, "
                f"got {len(proposed_sequence)}. "
                f"Layer5 plans sequences up to 5 steps.",
                field="proposed_sequence",
            )

        resolved_agent = agent_id or self.agent_id
        if not resolved_agent:
            raise Layer5ValidationError(
                "agent_id is required.",
                field="agent_id",
            )

        payload: Dict[str, Any] = {
            "agent_id": resolved_agent,
            "context": context,
            "proposed_sequence": proposed_sequence,
        }
        if episode_history is not None:
            payload["episode_history"] = episode_history
        if simulate_alternatives != 2:
            payload["simulate_alternatives"] = simulate_alternatives
        if max_sequence_depth != 5:
            payload["max_sequence_depth"] = max_sequence_depth

        data = await self._request("POST", "/v1/simulate", json=payload)
        return SimulateResponse(**data)

    async def outcome_feedback(
        self,
        outcome_id: str,
        final_score: float,
        business_outcome: str,
        feedback_notes: Optional[str] = None,
    ) -> OutcomeFeedbackResponse:
        """
        Submit delayed feedback for a previously logged outcome.
        Async version — use ``await l5.outcome_feedback(...)``.
        """
        payload: Dict[str, Any] = {
            "outcome_id": outcome_id,
            "final_score": final_score,
            "business_outcome": business_outcome,
        }
        if feedback_notes:
            payload["feedback_notes"] = feedback_notes

        data = await self._request(
            "POST", "/v1/outcome-feedback", json=payload
        )
        return OutcomeFeedbackResponse(**data)

    # ── Context manager / cleanup ────────────────────────────

    async def close(self) -> None:
        """Close the async HTTP connection pool."""
        await self._client.aclose()

    async def __aenter__(self) -> AsyncLayer5:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
