"""Tests for OpenAI SDK integration."""

from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5Error, Layer5NetworkError

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


def _make_tool_call(name: str, arguments: str = "{}"):
    """Build a mock OpenAI ToolCall object."""
    tc = MagicMock()
    tc.function.name = name
    tc.function.arguments = arguments
    return tc


class TestTrackToolCalls:
    def test_logs_all_tool_calls(self):
        from layer5.integrations.openai import track_tool_calls

        captured = []

        def capture(method, path, **kwargs):
            captured.append(kwargs.get("json"))
            return {
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture):
            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            tool_calls = [
                _make_tool_call("search", '{"q": "test"}'),
                _make_tool_call("calculate", '{"expr": "2+2"}'),
            ]
            results = [
                {"success": True, "response_ms": 100},
                {"success": False, "response_ms": 50},
            ]

            track_tool_calls(
                layer5_client=client,
                agent_id="test-agent",
                tool_calls=tool_calls,
                results=results,
            )

        # Should have 2 log_outcome calls (ignore get_scores)
        log_calls = [c for c in captured if c and "action_name" in c]
        assert len(log_calls) == 2
        assert log_calls[0]["action_name"] == "search"
        assert log_calls[0]["success"] is True
        assert log_calls[1]["action_name"] == "calculate"
        assert log_calls[1]["success"] is False

    def test_mismatched_lengths_raises_value_error(self):
        from layer5.integrations.openai import track_tool_calls

        with patch("layer5.client.Layer5._request"):
            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            with pytest.raises(ValueError, match="must match"):
                track_tool_calls(
                    layer5_client=client,
                    agent_id="test-agent",
                    tool_calls=[_make_tool_call("a")],
                    results=[],
                )

    def test_layer5_error_silent_by_default(self):
        from layer5.integrations.openai import track_tool_calls

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")

            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            # Should NOT raise with silent_errors=True
            track_tool_calls(
                layer5_client=client,
                agent_id="test-agent",
                tool_calls=[_make_tool_call("search")],
                results=[{"success": True}],
                silent_errors=True,
            )

    def test_outcome_score_passed_through(self):
        from layer5.integrations.openai import track_tool_calls

        captured = []

        def capture(method, path, **kwargs):
            captured.append(kwargs.get("json"))
            return {
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture):
            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            track_tool_calls(
                layer5_client=client,
                agent_id="test-agent",
                tool_calls=[_make_tool_call("search")],
                results=[{"success": True, "outcome_score": 0.85}],
            )

        log_calls = [c for c in captured if c and "outcome_score" in c]
        assert len(log_calls) == 1
        assert log_calls[0]["outcome_score"] == 0.85


class TestLayer5OpenAIWrapper:
    def test_chat_completion_returns_response(self):
        from layer5.integrations.openai import Layer5OpenAIWrapper

        # Mock OpenAI client
        openai_client = MagicMock()
        message = MagicMock()
        message.tool_calls = None
        choice = MagicMock()
        choice.message = message
        response = MagicMock()
        response.choices = [choice]
        openai_client.chat.completions.create.return_value = response

        with patch("layer5.client.Layer5._request"):
            from layer5 import Layer5

            l5 = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            wrapper = Layer5OpenAIWrapper(
                openai_client=openai_client,
                layer5_client=l5,
                agent_id="test-agent",
            )

            result = wrapper.chat_completion(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hello"}],
            )

        assert result is response

    def test_tool_executor_tracks_calls(self):
        from layer5.integrations.openai import Layer5OpenAIWrapper

        # Mock OpenAI response with tool calls
        tc = _make_tool_call("search", '{"q": "test"}')
        message = MagicMock()
        message.tool_calls = [tc]
        choice = MagicMock()
        choice.message = message
        response = MagicMock()
        response.choices = [choice]
        openai_client = MagicMock()
        openai_client.chat.completions.create.return_value = response

        captured = []

        def capture(method, path, **kwargs):
            captured.append(kwargs.get("json"))
            return {
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture):
            from layer5 import Layer5

            l5 = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            executor = MagicMock()

            wrapper = Layer5OpenAIWrapper(
                openai_client=openai_client,
                layer5_client=l5,
                agent_id="test-agent",
                tool_executor=executor,
            )

            result = wrapper.chat_completion(
                model="gpt-4o",
                messages=[{"role": "user", "content": "search"}],
                tools=[],
            )

        assert result is response
        executor.assert_called_once_with(tc)

    def test_tool_executor_exception_logs_failure(self):
        from layer5.integrations.openai import Layer5OpenAIWrapper

        tc = _make_tool_call("bad_tool")
        message = MagicMock()
        message.tool_calls = [tc]
        choice = MagicMock()
        choice.message = message
        response = MagicMock()
        response.choices = [choice]
        openai_client = MagicMock()
        openai_client.chat.completions.create.return_value = response

        captured = []

        def capture(method, path, **kwargs):
            captured.append(kwargs.get("json"))
            return {
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture):
            from layer5 import Layer5

            l5 = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            executor = MagicMock(side_effect=RuntimeError("tool broke"))

            wrapper = Layer5OpenAIWrapper(
                openai_client=openai_client,
                layer5_client=l5,
                agent_id="test-agent",
                tool_executor=executor,
            )

            wrapper.chat_completion(
                model="gpt-4o",
                messages=[],
            )

        log_calls = [c for c in captured if c and "success" in c and "action_name" in c]
        assert len(log_calls) == 1
        assert log_calls[0]["success"] is False
