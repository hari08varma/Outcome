"""Tests for LlamaIndex integration."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5Error, Layer5NetworkError

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


@pytest.fixture
def mock_llamaindex_available():
    """Patch LLAMAINDEX_AVAILABLE to True for testing."""
    import layer5.integrations.llamaindex as li_mod

    original = li_mod.LLAMAINDEX_AVAILABLE
    li_mod.LLAMAINDEX_AVAILABLE = True
    yield
    li_mod.LLAMAINDEX_AVAILABLE = original


@pytest.fixture
def handler(mock_llamaindex_available):
    """Create a Layer5CallbackHandler with mocked HTTP."""
    from layer5.integrations.llamaindex import Layer5CallbackHandler

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
        h = Layer5CallbackHandler(
            api_key=VALID_KEY,
            agent_id="test-agent",
            base_url="https://test.layer5.dev",
            silent_errors=True,
        )
        h._mock_request = mock_request
        yield h


class TestLayer5CallbackHandler:
    def test_on_event_start_tracks_function_call(self, handler):
        from layer5.integrations.llamaindex import CBEventType, EventPayload

        handler.on_event_start(
            event_type=CBEventType.FUNCTION_CALL,
            payload={EventPayload.FUNCTION_CALL: {"name": "search", "arguments": "{}"}},
            event_id="ev-1",
        )

        assert "ev-1" in handler._calls
        assert handler._calls["ev-1"]["func_name"] == "search"

    def test_on_event_start_ignores_non_function_call(self, handler):
        """Non-FUNCTION_CALL events should be ignored."""
        from layer5.integrations.llamaindex import CBEventType

        result = handler.on_event_start(
            event_type="llm",  # Not FUNCTION_CALL
            payload={},
            event_id="ev-2",
        )

        assert "ev-2" not in handler._calls

    def test_on_event_end_logs_outcome(self, handler):
        from layer5.integrations.llamaindex import CBEventType, EventPayload

        handler._calls["ev-3"] = {
            "func_name": "search",
            "context": {"issue_type": "search"},
            "start": datetime.now(),
        }

        handler.on_event_end(
            event_type=CBEventType.FUNCTION_CALL,
            payload={EventPayload.FUNCTION_OUTPUT: "search results"},
            event_id="ev-3",
        )

        assert "ev-3" not in handler._calls

    def test_on_event_end_detects_failure_in_output(self, handler):
        """If output contains 'error' or 'failed', success=False."""
        from layer5.integrations.llamaindex import CBEventType, EventPayload

        handler._calls["ev-4"] = {
            "func_name": "db_query",
            "context": {"issue_type": "db_query"},
            "start": datetime.now(),
        }

        handler.on_event_end(
            event_type=CBEventType.FUNCTION_CALL,
            payload={EventPayload.FUNCTION_OUTPUT: "Error: connection failed"},
            event_id="ev-4",
        )

        assert "ev-4" not in handler._calls

    def test_layer5_error_in_start_does_not_crash(self, mock_llamaindex_available):
        from layer5.integrations.llamaindex import Layer5CallbackHandler, CBEventType, EventPayload

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")
            h = Layer5CallbackHandler(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )

            # Should NOT raise
            h.on_event_start(
                event_type=CBEventType.FUNCTION_CALL,
                payload={EventPayload.FUNCTION_CALL: {"name": "tool", "arguments": "{}"}},
                event_id="ev-5",
            )

    def test_layer5_error_in_end_does_not_crash(self, mock_llamaindex_available):
        from layer5.integrations.llamaindex import Layer5CallbackHandler, CBEventType, EventPayload

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")
            h = Layer5CallbackHandler(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )
            h._calls["ev-6"] = {
                "func_name": "tool",
                "context": {"issue_type": "tool"},
                "start": datetime.now(),
            }

            # Should NOT raise
            h.on_event_end(
                event_type=CBEventType.FUNCTION_CALL,
                payload={EventPayload.FUNCTION_OUTPUT: "ok"},
                event_id="ev-6",
            )

    def test_silent_errors_false_raises(self, mock_llamaindex_available):
        from layer5.integrations.llamaindex import Layer5CallbackHandler, CBEventType, EventPayload

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("down")
            h = Layer5CallbackHandler(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=False,
            )

            with pytest.raises(Layer5NetworkError):
                h.on_event_start(
                    event_type=CBEventType.FUNCTION_CALL,
                    payload={EventPayload.FUNCTION_CALL: {"name": "t", "arguments": "{}"}},
                    event_id="ev-7",
                )

    def test_missing_event_id_in_end_is_noop(self, handler):
        from layer5.integrations.llamaindex import CBEventType

        # Should not raise
        handler.on_event_end(
            event_type=CBEventType.FUNCTION_CALL,
            payload={},
            event_id="nonexistent",
        )

    def test_start_trace_and_end_trace_are_noop(self, handler):
        handler.start_trace("trace-1")
        handler.end_trace("trace-1", {})
