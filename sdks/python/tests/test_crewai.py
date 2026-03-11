"""Tests for CrewAI integration."""

from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5NetworkError

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


class TestLayer5Tool:
    def test_wrapped_tool_calls_original_and_returns_result(self):
        from layer5.integrations.crewai import layer5_tool

        # Create a mock tool
        tool = MagicMock()
        tool.name = "search"
        tool._run = MagicMock(return_value="search result")

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.return_value = {
                "ranked_actions": [],
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }
            tracked = layer5_tool(
                tool=tool,
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            result = tracked._run("query")

        assert result == "search result"

    def test_tool_error_still_logs_failure(self):
        from layer5.integrations.crewai import layer5_tool

        tool = MagicMock()
        tool.name = "failing_tool"
        tool._run = MagicMock(side_effect=RuntimeError("tool broke"))

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.return_value = {
                "ranked_actions": [],
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }
            tracked = layer5_tool(
                tool=tool,
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            with pytest.raises(RuntimeError, match="tool broke"):
                tracked._run("arg")

    def test_layer5_error_does_not_crash_tool(self):
        from layer5.integrations.crewai import layer5_tool

        tool = MagicMock()
        tool.name = "search"
        tool._run = MagicMock(return_value="ok")

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")
            tracked = layer5_tool(
                tool=tool,
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )

            # Tool should still work even if Layer5 is down
            result = tracked._run("query")
            assert result == "ok"

    def test_tool_without_underscore_run_uses_run(self):
        from layer5.integrations.crewai import layer5_tool

        tool = MagicMock(spec=[])  # no _run attribute
        tool.name = "simple_tool"
        tool.run = MagicMock(return_value="done")

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.return_value = {
                "ranked_actions": [],
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }
            tracked = layer5_tool(
                tool=tool,
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            result = tracked.run("input")
            assert result == "done"
