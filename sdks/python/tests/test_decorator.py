"""Tests for @track decorator integration."""

from unittest.mock import MagicMock, patch

import pytest

from layer5.exceptions import Layer5NetworkError

VALID_KEY = "layer5_abcdefghijklmnopqrstuvwxyz1234"


class TestTrackDecorator:
    def test_decorated_function_returns_original_value(self):
        from layer5.integrations.decorator import track

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

            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(client=client, agent_id="test-agent", issue_type="test")
            def my_func(x: int) -> int:
                return x * 2

            result = my_func(5)
            assert result == 10

    def test_exception_in_function_logs_failure(self):
        from layer5.integrations.decorator import track

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

            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(client=client, agent_id="test-agent", issue_type="test")
            def failing_func():
                raise ValueError("oops")

            with pytest.raises(ValueError, match="oops"):
                failing_func()

    def test_score_fn_applied_to_return_value(self):
        from layer5.integrations.decorator import track

        captured_payloads = []

        def capture_request(method, path, **kwargs):
            captured_payloads.append(kwargs.get("json"))
            return {
                "ranked_actions": [],
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture_request):
            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(
                client=client,
                agent_id="test-agent",
                issue_type="test",
                score_fn=lambda r: 0.9 if r else 0.0,
            )
            def my_func():
                return True

            my_func()

        # Find the log_outcome call (POST to /v1/log-outcome)
        log_payloads = [p for p in captured_payloads if p and "outcome_score" in p]
        assert len(log_payloads) == 1
        assert log_payloads[0]["outcome_score"] == 0.9

    def test_layer5_error_does_not_crash_decorated_function(self):
        from layer5.integrations.decorator import track

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.side_effect = Layer5NetworkError("offline")

            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(
                client=client,
                agent_id="test-agent",
                issue_type="test",
                silent_errors=True,
            )
            def my_func():
                return "works"

            # Should not crash even with Layer5 down
            result = my_func()
            assert result == "works"

    def test_custom_action_name(self):
        from layer5.integrations.decorator import track

        captured_payloads = []

        def capture_request(method, path, **kwargs):
            captured_payloads.append(kwargs.get("json"))
            return {
                "ranked_actions": [],
                "success": True,
                "outcome_id": "out-1",
                "action_id": "act-1",
                "context_id": "ctx-1",
                "timestamp": "2026-03-09T00:00:00Z",
                "message": "ok",
            }

        with patch("layer5.client.Layer5._request", side_effect=capture_request):
            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(
                client=client,
                agent_id="test-agent",
                issue_type="test",
                action_name="custom_action",
            )
            def my_func():
                return True

            my_func()

        log_payloads = [p for p in captured_payloads if p and "action_name" in p]
        assert any(p["action_name"] == "custom_action" for p in log_payloads)

    def test_preserves_function_name(self):
        from layer5.integrations.decorator import track

        with patch("layer5.client.Layer5._request") as mock_req:
            mock_req.return_value = {"ranked_actions": []}

            from layer5 import Layer5

            client = Layer5(
                api_key=VALID_KEY,
                base_url="https://test.layer5.dev",
                agent_id="test-agent",
            )

            @track(client=client, agent_id="test-agent", issue_type="test")
            def my_special_func():
                return True

            assert my_special_func.__name__ == "my_special_func"
