"""Tests for simulate(), decision_id threading, and new model fields."""

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from layer5 import Layer5
from layer5.exceptions import Layer5ValidationError
from layer5.models import (
    GetScoresResponse,
    LogOutcomeResponse,
    SequencePrediction,
    SimulateResponse,
)

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"
BASE_URL = "https://test.layer5.dev"

MOCK_SIMULATE_RESPONSE = {
    "primary": {
        "actions": ["clear_cache", "update_app"],
        "predicted_outcome": 0.83,
        "outcome_interval_low": 0.71,
        "outcome_interval_high": 0.92,
        "confidence": 0.85,
        "predicted_resolution": 0.80,
        "predicted_steps": 2.0,
        "better_than_proposed": False,
    },
    "alternatives": [
        {
            "actions": ["restart_service"],
            "predicted_outcome": 0.90,
            "outcome_interval_low": 0.80,
            "outcome_interval_high": 0.95,
            "confidence": 0.88,
            "predicted_resolution": 0.85,
            "predicted_steps": 1.0,
            "better_than_proposed": True,
        }
    ],
    "simulation_tier": 2,
    "tier_explanation": "LightGBM model used (tier 2)",
    "data_source": "world_model_v3",
    "episode_count": 500,
    "simulation_warning": None,
}

MOCK_SCORES_WITH_DECISION = {
    "ranked_actions": [
        {
            "action_name": "update_app",
            "score": 0.85,
            "confidence": 0.90,
            "trend": "improving",
            "rank": 1,
            "recommendation": "use",
        },
    ],
    "top_action": "update_app",
    "should_escalate": False,
    "cold_start": False,
    "context_id": "ctx-1",
    "customer_id": "cust-1",
    "issue_type": "payment_failed",
    "decision_id": "dec-abc-123",
}

MOCK_OUTCOME_WITH_COUNTERFACTUALS = {
    "success": True,
    "outcome_id": "out-789",
    "action_id": "act-456",
    "context_id": "ctx-1",
    "timestamp": "2026-03-11T00:00:00Z",
    "message": "Outcome logged",
    "recommendation": None,
    "next_actions": None,
    "counterfactuals_computed": True,
    "sequence_position": 2,
}


def make_client(**kwargs):
    defaults = {"api_key": VALID_KEY, "base_url": BASE_URL, "max_retries": 1}
    defaults.update(kwargs)
    return Layer5(**defaults)


def mock_response(status_code=200, json_data=None):
    content = json.dumps(json_data or {}).encode("utf-8")
    return httpx.Response(
        status_code=status_code,
        content=content,
        headers={"content-type": "application/json"},
    )


# ── simulate: validation ─────────────────────────────────────


class TestSimulateValidation:
    def test_empty_sequence_raises_validation_error(self):
        client = make_client(agent_id="test-agent")
        with pytest.raises(Layer5ValidationError, match="cannot be empty"):
            client.simulate(
                proposed_sequence=[],
                context={"issue_type": "payment_failed"},
            )

    def test_sequence_over_5_raises_validation_error(self):
        client = make_client(agent_id="test-agent")
        with pytest.raises(Layer5ValidationError, match="max length is 5"):
            client.simulate(
                proposed_sequence=["a", "b", "c", "d", "e", "f"],
                context={"issue_type": "test"},
            )


# ── simulate: success ────────────────────────────────────────


class TestSimulateResponse:
    def test_valid_request_returns_simulate_response(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache", "update_app"],
                context={"issue_type": "payment_failed"},
            )
            assert isinstance(result, SimulateResponse)

    def test_simulation_tier_in_range(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache"],
                context={"issue_type": "test"},
            )
            assert result.simulation_tier in (1, 2, 3)

    def test_primary_predicted_outcome_in_range(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache"],
                context={"issue_type": "test"},
            )
            assert 0.0 <= result.primary.predicted_outcome <= 1.0

    def test_interval_low_le_predicted_outcome(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache"],
                context={"issue_type": "test"},
            )
            assert result.primary.outcome_interval_low <= result.primary.predicted_outcome

    def test_alternatives_returned_when_requested(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache"],
                context={"issue_type": "test"},
                simulate_alternatives=2,
            )
            assert len(result.alternatives) >= 1
            assert result.alternatives[0].better_than_proposed is True

    def test_simulation_warning_null_or_string(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SIMULATE_RESPONSE),
        ):
            result = client.simulate(
                proposed_sequence=["clear_cache"],
                context={"issue_type": "test"},
            )
            assert result.simulation_warning is None or isinstance(
                result.simulation_warning, str
            )


# ── get_scores: decision_id ──────────────────────────────────


class TestDecisionId:
    def test_decision_id_in_get_scores_response(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SCORES_WITH_DECISION),
        ):
            result = client.get_scores(context={"issue_type": "payment_failed"})
            assert result.decision_id == "dec-abc-123"

    def test_episode_history_passed_when_provided(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(200, MOCK_SCORES_WITH_DECISION),
        ) as mock_req:
            client.get_scores(
                context={"issue_type": "test"},
                episode_history=["action_a", "action_b"],
            )
            call_kwargs = mock_req.call_args
            # episode_history should be in the params
            params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params", {})
            assert "episode_history" in params


# ── log_outcome: decision_id ─────────────────────────────────


class TestLogOutcomeDecisionId:
    def test_decision_id_passed_when_provided(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(201, MOCK_OUTCOME_WITH_COUNTERFACTUALS),
        ) as mock_req:
            client.log_outcome(
                action_name="update_app",
                success=True,
                session_id="sess-1",
                issue_type="payment_failed",
                decision_id="dec-abc-123",
            )
            call_kwargs = mock_req.call_args
            body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json", {})
            assert body["decision_id"] == "dec-abc-123"

    def test_counterfactuals_computed_in_response(self):
        client = make_client(agent_id="test-agent")
        with patch.object(
            client._client,
            "request",
            return_value=mock_response(201, MOCK_OUTCOME_WITH_COUNTERFACTUALS),
        ):
            result = client.log_outcome(
                action_name="update_app",
                success=True,
                session_id="sess-1",
                issue_type="test",
            )
            assert result.counterfactuals_computed is True
            assert result.sequence_position == 2


# ── langchain: decision_id threading ─────────────────────────


class TestLangchainDecisionIdThreading:
    def test_decision_id_threaded_from_get_scores_to_log_outcome(self):
        from layer5.integrations.langchain import Layer5Callback, LANGCHAIN_AVAILABLE

        if not LANGCHAIN_AVAILABLE:
            pytest.skip("langchain not installed")

        callback = Layer5Callback(
            api_key=VALID_KEY,
            agent_id="test-agent",
            base_url=BASE_URL,
            silent_errors=False,
        )

        scores_resp = GetScoresResponse(
            ranked_actions=[],
            decision_id="dec-thread-1",
        )

        with patch.object(callback.client, "get_scores", return_value=scores_resp):
            callback.on_tool_start(
                serialized={"name": "my_tool"},
                input_str="{}",
                run_id="run-1",
            )

        call_info = callback._active_calls.get("run-1")
        assert call_info is not None
        assert call_info["decision_id"] == "dec-thread-1"

        with patch.object(callback.client, "log_outcome") as mock_log:
            callback.on_tool_end(output="done", run_id="run-1")
            mock_log.assert_called_once()
            assert mock_log.call_args.kwargs.get("decision_id") == "dec-thread-1"


# ── crewai: decision_id threading ────────────────────────────


class TestCrewaiDecisionIdThreading:
    def test_decision_id_threaded_correctly(self):
        from layer5.integrations.crewai import layer5_tool

        mock_tool = MagicMock()
        mock_tool.name = "test_tool"
        mock_tool._run = MagicMock(return_value="ok")

        scores_resp = GetScoresResponse(
            ranked_actions=[],
            decision_id="dec-crew-1",
        )

        with patch("layer5.integrations.crewai.Layer5") as MockLayer5:
            mock_client = MockLayer5.return_value
            mock_client.get_scores.return_value = scores_resp
            mock_client.log_outcome.return_value = LogOutcomeResponse(
                success=True,
                outcome_id="out-1",
                action_id="act-1",
                context_id="ctx-1",
                timestamp="2026-01-01T00:00:00Z",
                message="ok",
            )

            wrapped = layer5_tool(
                tool=mock_tool,
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url=BASE_URL,
            )

            mock_tool._run("arg1")

            mock_client.log_outcome.assert_called_once()
            assert mock_client.log_outcome.call_args.kwargs.get("decision_id") == "dec-crew-1"


# ── decorator: decision_id threading ─────────────────────────


class TestDecoratorDecisionIdThreading:
    def test_decision_id_threaded_correctly(self):
        from layer5.integrations.decorator import track

        mock_client = MagicMock()
        scores_resp = GetScoresResponse(
            ranked_actions=[],
            decision_id="dec-deco-1",
        )
        mock_client.get_scores.return_value = scores_resp
        mock_client.log_outcome.return_value = None

        @track(client=mock_client, agent_id="test", issue_type="test")
        def my_action():
            return True

        my_action()

        mock_client.log_outcome.assert_called_once()
        assert mock_client.log_outcome.call_args.kwargs.get("decision_id") == "dec-deco-1"
