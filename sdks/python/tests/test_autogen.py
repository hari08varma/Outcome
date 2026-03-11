"""Tests for AutoGen integration."""

from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5NetworkError

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


class TestLayer5AutoGenHook:
    def test_attach_wraps_function_map(self):
        from layer5.integrations.autogen import Layer5AutoGenHook

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

            hook = Layer5AutoGenHook(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            agent = MagicMock()
            agent.function_map = {
                "search": MagicMock(return_value="found it"),
                "calculate": MagicMock(return_value=42),
            }
            original_search = agent.function_map["search"]

            hook.attach(agent)

            # Wrapped functions should still work
            result = agent.function_map["search"]()
            assert result == "found it"

    def test_attached_function_logs_failure(self):
        from layer5.integrations.autogen import Layer5AutoGenHook

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

            hook = Layer5AutoGenHook(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            def failing_fn():
                raise ValueError("bad input")

            agent = MagicMock()
            agent.function_map = {"broken": failing_fn}

            hook.attach(agent)

            with pytest.raises(ValueError, match="bad input"):
                agent.function_map["broken"]()

    def test_attach_no_function_map_warns(self):
        from layer5.integrations.autogen import Layer5AutoGenHook

        with patch("layer5.client.Layer5._request"):
            hook = Layer5AutoGenHook(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
            )

            agent = MagicMock(spec=[])  # no function_map
            agent.name = "simple-agent"

            with pytest.warns(match="no function_map"):
                hook.attach(agent)

    def test_layer5_error_does_not_crash_function(self):
        from layer5.integrations.autogen import Layer5AutoGenHook

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")

            hook = Layer5AutoGenHook(
                api_key=VALID_KEY,
                agent_id="test-agent",
                base_url="https://test.layer5.dev",
                silent_errors=True,
            )

            agent = MagicMock()
            agent.function_map = {"search": MagicMock(return_value="ok")}

            hook.attach(agent)

            # Should still work even with Layer5 down
            result = agent.function_map["search"]()
            assert result == "ok"
