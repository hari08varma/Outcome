"""Tests for Layer5 async client — mirrors test_client.py with async/await."""

import json
import os
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from layer5 import AsyncLayer5
from layer5.exceptions import (
    Layer5AgentSuspendedError,
    Layer5AuthError,
    Layer5NetworkError,
    Layer5RateLimitError,
    Layer5ServerError,
    Layer5TimeoutError,
    Layer5UnknownActionError,
    Layer5ValidationError,
)
from layer5.models import GetScoresResponse, LogOutcomeResponse, OutcomeFeedbackResponse

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"
BASE_URL = "https://test.layer5.dev"


def make_client(**kwargs):
    defaults = {
        "api_key": VALID_KEY,
        "base_url": BASE_URL,
        "max_retries": 1,
    }
    defaults.update(kwargs)
    return AsyncLayer5(**defaults)


def mock_response(
    status_code: int = 200,
    json_data: dict | None = None,
    headers: dict | None = None,
    text: str = "",
) -> httpx.Response:
    if json_data is not None:
        content = json.dumps(json_data).encode("utf-8")
        h = {"content-type": "application/json"}
        h.update(headers or {})
        return httpx.Response(
            status_code=status_code,
            content=content,
            headers=h,
        )
    return httpx.Response(
        status_code=status_code,
        text=text,
        headers=headers or {},
    )


SCORES_RESPONSE = {
    "ranked_actions": [
        {
            "action_name": "restart_service",
            "score": 0.92,
            "confidence": 0.85,
            "trend": "improving",
            "rank": 1,
            "recommendation": "use",
        }
    ],
    "top_action": "restart_service",
    "should_escalate": False,
    "cold_start": False,
    "context_id": "ctx-1",
    "customer_id": "cust-1",
    "issue_type": "payment_failed",
    "policy": "exploit",
    "policy_reason": "high confidence",
    "agent_trust": {"score": 0.95, "status": "trusted"},
    "meta": {"total_actions_scored": 5},
}

LOG_OUTCOME_RESPONSE = {
    "success": True,
    "outcome_id": "out-123",
    "action_id": "act-456",
    "context_id": "ctx-1",
    "timestamp": "2026-03-09T00:00:00Z",
    "message": 'Outcome logged. Action "restart_service" — SUCCESS',
    "recommendation": "exploit",
    "next_actions": {
        "policy": "exploit",
        "reason": "high confidence",
        "selected_action": "restart_service",
        "exploration_target": None,
    },
}

FEEDBACK_RESPONSE = {
    "updated": True,
    "outcome_id": "out-123",
    "final_score": 0.1,
    "business_outcome": "failed",
}


# ══════════════════════════════════════════════════════════════
# CLIENT INIT
# ══════════════════════════════════════════════════════════════


class TestAsyncClientInit:
    def test_no_api_key_raises_auth_error(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("LAYER5_API_KEY", None)
            with pytest.raises(Layer5AuthError, match="No API key provided"):
                AsyncLayer5()

    def test_wrong_key_format_raises_auth_error(self):
        with pytest.raises(Layer5AuthError, match="Invalid API key format"):
            AsyncLayer5(api_key="bad_key_123")

    def test_env_var_used_if_no_explicit_key(self):
        with patch.dict(os.environ, {"LAYER5_API_KEY": VALID_KEY}):
            client = AsyncLayer5(base_url=BASE_URL)
            assert client.api_key == VALID_KEY

    def test_valid_key_creates_client(self):
        client = make_client()
        assert client.api_key == VALID_KEY

    @pytest.mark.asyncio
    async def test_async_context_manager(self):
        async with make_client() as client:
            assert client.api_key == VALID_KEY


# ══════════════════════════════════════════════════════════════
# GET SCORES (async)
# ══════════════════════════════════════════════════════════════


class TestAsyncGetScores:
    @pytest.mark.asyncio
    async def test_valid_response_returns_model(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(200, SCORES_RESPONSE)
            result = await client.get_scores(context={"issue_type": "payment_failed"})

        assert isinstance(result, GetScoresResponse)
        assert result.ranked_actions[0].action_name == "restart_service"
        assert result.latency_ms is not None and result.latency_ms >= 0

    @pytest.mark.asyncio
    async def test_no_agent_id_raises_validation_error(self):
        client = make_client()
        with pytest.raises(Layer5ValidationError, match="agent_id is required"):
            await client.get_scores(context={"issue_type": "test"})

    @pytest.mark.asyncio
    async def test_401_raises_auth_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(
                401, {"error": "Unauthorized"}
            )
            with pytest.raises(Layer5AuthError):
                await client.get_scores(context={"issue_type": "test"})

    @pytest.mark.asyncio
    async def test_429_raises_rate_limit_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(
                429, {"error": "Rate limit"}, headers={"retry-after": "30"}
            )
            with pytest.raises(Layer5RateLimitError) as exc_info:
                await client.get_scores(context={"issue_type": "test"})
            assert exc_info.value.retry_after == 30

    @pytest.mark.asyncio
    async def test_500_raises_server_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(
                500, {"error": "Server Error"}, headers={"x-request-id": "req-1"}
            )
            with pytest.raises(Layer5ServerError) as exc_info:
                await client.get_scores(context={"issue_type": "test"})
            assert exc_info.value.status_code == 500
            assert exc_info.value.request_id == "req-1"

    @pytest.mark.asyncio
    async def test_timeout_raises_timeout_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = httpx.ReadTimeout("timed out")
            with pytest.raises(Layer5TimeoutError):
                await client.get_scores(context={"issue_type": "test"})

    @pytest.mark.asyncio
    async def test_retries_on_503(self):
        client = make_client(agent_id="agent-1", max_retries=3)
        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return mock_response(503, {"error": "Unavailable"})

        with patch.object(client._client, "request", side_effect=side_effect):
            with patch("layer5.async_client.exponential_backoff", return_value=0.001):
                with patch("layer5.async_client.asyncio.sleep", new_callable=AsyncMock):
                    with pytest.raises(Layer5ServerError):
                        await client.get_scores(context={"issue_type": "test"})

        assert call_count == 3

    @pytest.mark.asyncio
    async def test_does_not_retry_on_401(self):
        client = make_client(agent_id="agent-1", max_retries=3)
        call_count = 0

        async def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return mock_response(401, {"error": "Unauthorized"})

        with patch.object(client._client, "request", side_effect=side_effect):
            with pytest.raises(Layer5AuthError):
                await client.get_scores(context={"issue_type": "test"})

        assert call_count == 1

    @pytest.mark.asyncio
    async def test_unknown_action_404(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(
                404,
                {"error": "Unknown", "code": "UNKNOWN_ACTION", "action_name": "ghost"},
            )
            with pytest.raises(Layer5UnknownActionError) as exc_info:
                await client.get_scores(context={"issue_type": "test"})
            assert exc_info.value.action_name == "ghost"


# ══════════════════════════════════════════════════════════════
# LOG OUTCOME (async)
# ══════════════════════════════════════════════════════════════


class TestAsyncLogOutcome:
    @pytest.mark.asyncio
    async def test_valid_response(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(201, LOG_OUTCOME_RESPONSE)
            result = await client.log_outcome(
                action_name="restart_service",
                success=True,
                session_id="sess-1",
                issue_type="payment_failed",
                response_time_ms=241,
            )

        assert isinstance(result, LogOutcomeResponse)
        assert result.outcome_id == "out-123"

    @pytest.mark.asyncio
    async def test_outcome_score_out_of_range(self):
        client = make_client(agent_id="agent-1")

        with pytest.raises(Layer5ValidationError, match="outcome_score"):
            await client.log_outcome(
                action_name="test",
                success=True,
                session_id="sess-1",
                issue_type="test",
                outcome_score=1.5,
            )

    @pytest.mark.asyncio
    async def test_no_agent_id_raises(self):
        client = make_client()
        with pytest.raises(Layer5ValidationError, match="agent_id"):
            await client.log_outcome(
                action_name="test",
                success=True,
                session_id="s",
                issue_type="t",
            )

    @pytest.mark.asyncio
    async def test_agent_suspended_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(
                403,
                {"error": "Suspended", "code": "AGENT_SUSPENDED", "agent_id": "agent-1"},
            )
            with pytest.raises(Layer5AgentSuspendedError) as exc_info:
                await client.log_outcome(
                    action_name="test",
                    success=False,
                    session_id="s",
                    issue_type="t",
                )
            assert exc_info.value.agent_id == "agent-1"


# ══════════════════════════════════════════════════════════════
# OUTCOME FEEDBACK (async)
# ══════════════════════════════════════════════════════════════


class TestAsyncOutcomeFeedback:
    @pytest.mark.asyncio
    async def test_valid_feedback(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = mock_response(200, FEEDBACK_RESPONSE)
            result = await client.outcome_feedback(
                outcome_id="out-123",
                final_score=0.1,
                business_outcome="failed",
                feedback_notes="Customer called back",
            )

        assert isinstance(result, OutcomeFeedbackResponse)
        assert result.updated is True
        assert result.final_score == 0.1


# ══════════════════════════════════════════════════════════════
# NETWORK ERRORS (async)
# ══════════════════════════════════════════════════════════════


class TestAsyncNetworkErrors:
    @pytest.mark.asyncio
    async def test_connection_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = httpx.ConnectError("Connection refused")
            with pytest.raises(Layer5NetworkError, match="Connection refused"):
                await client.get_scores(context={"issue_type": "test"})

    @pytest.mark.asyncio
    async def test_generic_exception_wraps(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = RuntimeError("unexpected")
            with pytest.raises(Layer5NetworkError, match="unexpected"):
                await client.get_scores(context={"issue_type": "test"})
