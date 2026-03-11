"""Tests for Layer5 sync client — init, get_scores, log_outcome, response handling."""

import json
import os
from unittest.mock import patch

import httpx
import pytest

from layer5 import Layer5
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
from layer5.models import GetScoresResponse, LogOutcomeResponse

# ── Fixtures ──────────────────────────────────────────────────

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"
BASE_URL = "https://test.layer5.dev"


def make_client(**kwargs):
    """Create a Layer5 client with test defaults."""
    defaults = {
        "api_key": VALID_KEY,
        "base_url": BASE_URL,
        "max_retries": 1,
    }
    defaults.update(kwargs)
    return Layer5(**defaults)


def mock_response(
    status_code: int = 200,
    json_data: dict | None = None,
    headers: dict | None = None,
    text: str = "",
) -> httpx.Response:
    """Build a fake httpx.Response."""
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
    "context_match": None,
    "context_warning": None,
    "policy": "exploit",
    "policy_reason": "high confidence",
    "agent_trust": {"score": 0.95, "status": "trusted"},
    "meta": {"total_actions_scored": 5, "top_n_returned": 1, "scoring_version": "1.0"},
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


# ══════════════════════════════════════════════════════════════
# CLIENT INIT
# ══════════════════════════════════════════════════════════════


class TestClientInit:
    def test_no_api_key_raises_auth_error(self):
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("LAYER5_API_KEY", None)
            with pytest.raises(Layer5AuthError, match="No API key provided"):
                Layer5()

    def test_wrong_key_format_raises_auth_error(self):
        with pytest.raises(Layer5AuthError, match="Invalid API key format"):
            Layer5(api_key="bad_key_123")

    def test_short_key_raises_auth_error(self):
        with pytest.raises(Layer5AuthError, match="Invalid API key format"):
            Layer5(api_key="layer5_short")

    def test_env_var_used_if_no_explicit_key(self):
        with patch.dict(os.environ, {"LAYER5_API_KEY": VALID_KEY}):
            client = Layer5(base_url=BASE_URL)
            assert client.api_key == VALID_KEY

    def test_explicit_key_overrides_env_var(self):
        other_key = "layer5_ZZZZZZZZZZZZZZZZZZZZZZZZZZZ12345"
        with patch.dict(os.environ, {"LAYER5_API_KEY": other_key}):
            client = Layer5(api_key=VALID_KEY, base_url=BASE_URL)
            assert client.api_key == VALID_KEY

    def test_default_agent_id_stored(self):
        client = make_client(agent_id="test-agent")
        assert client.agent_id == "test-agent"

    def test_context_manager(self):
        with make_client() as client:
            assert client.api_key == VALID_KEY


# ══════════════════════════════════════════════════════════════
# GET SCORES
# ══════════════════════════════════════════════════════════════


class TestGetScores:
    def test_valid_response_returns_model(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, SCORES_RESPONSE)
            result = client.get_scores(context={"issue_type": "payment_failed"})

        assert isinstance(result, GetScoresResponse)
        assert result.ranked_actions[0].action_name == "restart_service"
        assert result.ranked_actions[0].score == 0.92
        assert result.latency_ms is not None and result.latency_ms >= 0

    def test_no_agent_id_raises_validation_error(self):
        client = make_client()  # no agent_id
        with pytest.raises(Layer5ValidationError, match="agent_id is required"):
            client.get_scores(context={"issue_type": "test"})

    def test_401_response_raises_auth_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                401, {"error": "Unauthorized", "code": "AUTH_ERROR"}
            )
            with pytest.raises(Layer5AuthError):
                client.get_scores(context={"issue_type": "test"})

    def test_429_response_raises_rate_limit_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                429,
                {"error": "Rate limit exceeded"},
                headers={"retry-after": "30"},
            )
            with pytest.raises(Layer5RateLimitError) as exc_info:
                client.get_scores(context={"issue_type": "test"})
            assert exc_info.value.retry_after == 30

    def test_500_response_raises_server_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                500,
                {"error": "Internal Server Error"},
                headers={"x-request-id": "req-789"},
            )
            with pytest.raises(Layer5ServerError) as exc_info:
                client.get_scores(context={"issue_type": "test"})
            assert exc_info.value.status_code == 500
            assert exc_info.value.request_id == "req-789"

    def test_network_timeout_raises_timeout_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = httpx.ReadTimeout("timed out")
            with pytest.raises(Layer5TimeoutError):
                client.get_scores(context={"issue_type": "test"})

    def test_retries_on_503_before_raising(self):
        client = make_client(agent_id="agent-1", max_retries=3)

        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return mock_response(503, {"error": "Service Unavailable"})

        with patch.object(client._client, "request", side_effect=side_effect):
            with patch("layer5.client.exponential_backoff", return_value=0.001):
                with pytest.raises(Layer5ServerError):
                    client.get_scores(context={"issue_type": "test"})

        assert call_count == 3

    def test_does_not_retry_on_400(self):
        client = make_client(agent_id="agent-1", max_retries=3)

        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return mock_response(400, {"error": "Bad Request", "code": "VALIDATION_ERROR"})

        with patch.object(client._client, "request", side_effect=side_effect):
            with pytest.raises(Layer5ValidationError):
                client.get_scores(context={"issue_type": "test"})

        assert call_count == 1

    def test_does_not_retry_on_401(self):
        client = make_client(agent_id="agent-1", max_retries=3)

        call_count = 0

        def side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return mock_response(401, {"error": "Unauthorized"})

        with patch.object(client._client, "request", side_effect=side_effect):
            with pytest.raises(Layer5AuthError):
                client.get_scores(context={"issue_type": "test"})

        assert call_count == 1

    def test_context_passed_as_query_params(self):
        client = make_client(agent_id="agent-1")

        captured_kwargs = {}

        def capture(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return mock_response(200, SCORES_RESPONSE)

        with patch.object(client._client, "request", side_effect=capture):
            client.get_scores(context={"issue_type": "payment_failed"})

        assert captured_kwargs["params"]["issue_type"] == "payment_failed"
        assert captured_kwargs["params"]["agent_id"] == "agent-1"


# ══════════════════════════════════════════════════════════════
# LOG OUTCOME
# ══════════════════════════════════════════════════════════════


class TestLogOutcome:
    def test_valid_response_returns_model(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(201, LOG_OUTCOME_RESPONSE)
            result = client.log_outcome(
                action_name="restart_service",
                success=True,
                session_id="sess-1",
                issue_type="payment_failed",
                response_time_ms=241,
            )

        assert isinstance(result, LogOutcomeResponse)
        assert result.outcome_id == "out-123"
        assert result.success is True

    def test_outcome_score_out_of_range_raises_before_request(self):
        client = make_client(agent_id="agent-1")

        with pytest.raises(Layer5ValidationError, match="outcome_score"):
            client.log_outcome(
                action_name="test",
                success=True,
                session_id="sess-1",
                issue_type="test",
                outcome_score=1.5,
            )

    def test_outcome_score_valid_sent_correctly(self):
        client = make_client(agent_id="agent-1")

        captured_kwargs = {}

        def capture(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return mock_response(201, LOG_OUTCOME_RESPONSE)

        with patch.object(client._client, "request", side_effect=capture):
            client.log_outcome(
                action_name="restart_service",
                success=True,
                session_id="sess-1",
                issue_type="test",
                outcome_score=0.7,
            )

        assert captured_kwargs["json"]["outcome_score"] == 0.7

    def test_unknown_action_raises_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                404,
                {
                    "error": "Action not found",
                    "code": "UNKNOWN_ACTION",
                    "action_name": "fantasy_action",
                },
            )
            with pytest.raises(Layer5UnknownActionError) as exc_info:
                client.log_outcome(
                    action_name="fantasy_action",
                    success=True,
                    session_id="sess-1",
                    issue_type="test",
                )
            assert exc_info.value.action_name == "fantasy_action"

    def test_agent_suspended_raises_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(
                403,
                {
                    "error": "Agent suspended",
                    "code": "AGENT_SUSPENDED",
                    "agent_id": "agent-1",
                },
            )
            with pytest.raises(Layer5AgentSuspendedError) as exc_info:
                client.log_outcome(
                    action_name="test",
                    success=False,
                    session_id="sess-1",
                    issue_type="test",
                )
            assert exc_info.value.agent_id == "agent-1"

    def test_no_agent_id_raises_validation_error(self):
        client = make_client()  # no agent_id
        with pytest.raises(Layer5ValidationError, match="agent_id"):
            client.log_outcome(
                action_name="test",
                success=True,
                session_id="sess-1",
                issue_type="test",
            )


# ══════════════════════════════════════════════════════════════
# OUTCOME FEEDBACK
# ══════════════════════════════════════════════════════════════


class TestOutcomeFeedback:
    def test_valid_feedback(self):
        client = make_client(agent_id="agent-1")
        feedback_resp = {
            "updated": True,
            "outcome_id": "out-123",
            "final_score": 0.1,
            "business_outcome": "failed",
        }

        with patch.object(client._client, "request") as mock_req:
            mock_req.return_value = mock_response(200, feedback_resp)
            result = client.outcome_feedback(
                outcome_id="out-123",
                final_score=0.1,
                business_outcome="failed",
                feedback_notes="Customer called back",
            )

        assert result.updated is True
        assert result.final_score == 0.1


# ══════════════════════════════════════════════════════════════
# NETWORK ERROR HANDLING
# ══════════════════════════════════════════════════════════════


class TestNetworkErrors:
    def test_connection_error_wraps_in_layer5_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = httpx.ConnectError("Connection refused")
            with pytest.raises(Layer5NetworkError, match="Connection refused"):
                client.get_scores(context={"issue_type": "test"})

    def test_generic_exception_wraps_in_network_error(self):
        client = make_client(agent_id="agent-1")

        with patch.object(client._client, "request") as mock_req:
            mock_req.side_effect = RuntimeError("something unexpected")
            with pytest.raises(Layer5NetworkError, match="something unexpected"):
                client.get_scores(context={"issue_type": "test"})
