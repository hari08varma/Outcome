"""Tests for LangChain integration."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5Error, Layer5NetworkError

# We test the callback even without langchain installed,
# by mocking the import.

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


@pytest.fixture
def mock_langchain_available():
    """Patch LANGCHAIN_AVAILABLE to True for testing."""
    import layer5.integrations.langchain as lc_mod

    original = lc_mod.LANGCHAIN_AVAILABLE
    lc_mod.LANGCHAIN_AVAILABLE = True
    yield
    lc_mod.LANGCHAIN_AVAILABLE = original


@pytest.fixture
def callback(mock_langchain_available):
    """Create a Layer5Callback with mocked HTTP."""
    from layer5.integrations.langchain import Layer5Callback

    with patch("layer5.client.Layer5._request") as mock_request:
        mock_request.return_value = {
            "ranked_actions": [],
            "success": True,
            "outcome_id": "out-1",
            "action_id": "act-1",
            "context_id": "ctx-1",
            "timestamp": "2026-03-09T00:00:00Z",
            "message": "ok",
        }
        cb = Layer5Callback(
            api_key=VALID_KEY,
            agent_id="test-agent",
            base_url="https://test.layer5.dev",
            silent_errors=True,
        )
        cb._mock_request = mock_request
        yield cb


class TestLayer5Callback:
    def test_on_tool_start_calls_get_scores(self, callback):
        callback.on_tool_start(
            serialized={"name": "search_tool"},
            input_str='{"query": "test"}',
            run_id="run-1",
        )

        assert "run-1" in callback._active_calls
        assert callback._active_calls["run-1"]["tool_name"] == "search_tool"

    def test_on_tool_end_calls_log_outcome_success(self, callback):
        # First, start a tool
        callback._active_calls["run-2"] = {
            "tool_name": "search_tool",
            "start_time": datetime.now(),
            "context": {"issue_type": "search_tool"},
            "scores": None,
        }

        callback.on_tool_end(output="result text", run_id="run-2")

        # Call should be removed
        assert "run-2" not in callback._active_calls

    def test_on_tool_error_calls_log_outcome_failure(self, callback):
        callback._active_calls["run-3"] = {
            "tool_name": "db_tool",
            "start_time": datetime.now(),
            "context": {"issue_type": "db_tool"},
            "scores": None,
        }

        callback.on_tool_error(
            error=RuntimeError("db connection failed"),
            run_id="run-3",
        )

        assert "run-3" not in callback._active_calls

    def test_layer5_error_in_on_tool_start_does_not_crash(
        self, mock_langchain_available
    ):
        """Layer5 errors in callbacks should never crash the agent."""
        from layer5.integrations.langchain import Layer5Callback

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("network down")
            cb = Layer5Callback(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )

            # This should NOT raise
            cb.on_tool_start(
                serialized={"name": "tool"},
                input_str="{}",
                run_id="run-4",
            )

    def test_layer5_error_in_on_tool_end_does_not_crash(
        self, mock_langchain_available
    ):
        from layer5.integrations.langchain import Layer5Callback

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("network down")
            cb = Layer5Callback(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )
            cb._active_calls["run-5"] = {
                "tool_name": "tool",
                "start_time": datetime.now(),
                "context": {"issue_type": "tool"},
                "scores": None,
            }

            # This should NOT raise
            cb.on_tool_end(output="ok", run_id="run-5")

    def test_missing_run_id_in_on_tool_end_is_noop(self, callback):
        """on_tool_end for unknown run_id should be safe."""
        callback.on_tool_end(output="ok", run_id="nonexistent")
