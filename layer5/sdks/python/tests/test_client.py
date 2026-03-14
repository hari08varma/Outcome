"""
Tests for the Layer5 Python SDK client.

Uses respx to mock httpx calls — no real network requests made.
Run with: pytest tests/test_client.py -v
"""

from __future__ import annotations

import httpx
import pytest
import respx

from layer5 import (
    Layer5Client,
    Layer5AuthError,
    Layer5RateLimitError,
    LogOutcomeRequest,
)
from layer5.models import GetScoresResponse, LogOutcomeResponse, ScoredAction

BASE_URL = "https://test.layer5.ai"
API_KEY = "layer5_testkey123456789"

MOCK_SCORED_ACTION = {
    "action_id": "act-uuid-1",
    "action_name": "escalate_to_senior",
    "action_category": "escalation",
    "composite_score": 0.87,
    "confidence": 0.72,
    "total_attempts": 42,
    "policy_reason": "top_performer",
    "is_cold_start": False,
    "is_low_sample": False,
}

MOCK_GET_SCORES_RESPONSE = {
    "ranked_actions": [MOCK_SCORED_ACTION],
    "top_action": MOCK_SCORED_ACTION,
    "policy": "exploit",
    "cold_start": False,
    "context_id": "ctx-uuid-1",
    "agent_id": "my-agent",
    "served_from_cache": False,
}

MOCK_LOG_OUTCOME_RESPONSE = {
    "logged": True,
    "outcome_id": "out-uuid-1",
    "agent_trust_score": 0.74,
    "trust_status": "trusted",
    "policy": "exploit",
}


# ── Test 1: get_scores returns typed GetScoresResponse ────────
@respx.mock
def test_get_scores_returns_typed_response():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(200, json=MOCK_GET_SCORES_RESPONSE)
    )

    client = Layer5Client(api_key=API_KEY, base_url=BASE_URL)
    response = client.get_scores(agent_id="my-agent", issue_type="billing_dispute")

    assert isinstance(response, GetScoresResponse)
    assert isinstance(response.top_action, ScoredAction)
    assert response.top_action.action_name == "escalate_to_senior"
    assert response.policy in ("exploit", "explore", "escalate")
    assert response.top_action.composite_score == pytest.approx(0.87)


# ── Test 2: 401 raises Layer5AuthError ────────────────────────
@respx.mock
def test_get_scores_401_raises_auth_error():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(401, json={"error": "Unauthorized"})
    )

    client = Layer5Client(api_key="bad_key", base_url=BASE_URL)
    with pytest.raises(Layer5AuthError) as exc_info:
        client.get_scores(agent_id="agent-1", issue_type="test")

    assert exc_info.value.status_code == 401


# ── Test 3: 429 raises Layer5RateLimitError with retry_after ─
@respx.mock
def test_get_scores_429_raises_rate_limit_error():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Too Many Requests"},
            headers={"Retry-After": "30"},
        )
    )

    # max_retries=0 so we get the error immediately without waiting
    client = Layer5Client(api_key=API_KEY, base_url=BASE_URL, max_retries=0)
    with pytest.raises(Layer5RateLimitError) as exc_info:
        client.get_scores(agent_id="agent-1", issue_type="test")

    assert exc_info.value.status_code == 429
    assert exc_info.value.retry_after == 30


# ── Test 4: log_outcome returns LogOutcomeResponse ─────────────
@respx.mock
def test_log_outcome_returns_typed_response():
    respx.post(f"{BASE_URL}/v1/log-outcome").mock(
        return_value=httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)
    )

    client = Layer5Client(api_key=API_KEY, base_url=BASE_URL)
    request = LogOutcomeRequest(
        agent_id="my-agent",
        action_id="act-uuid-1",
        context_id="ctx-uuid-1",
        issue_type="billing_dispute",
        success=True,
        outcome_score=0.9,
        business_outcome="resolved",
    )
    response = client.log_outcome(request)

    assert isinstance(response, LogOutcomeResponse)
    assert response.logged is True
    assert isinstance(response.agent_trust_score, float)
    assert response.outcome_id == "out-uuid-1"


# ── Test 5: context manager properly closes session ────────────
def test_context_manager_closes_session():
    client_ref = None

    with Layer5Client(api_key=API_KEY, base_url=BASE_URL) as client:
        client_ref = client
        assert not client._session.is_closed

    assert client_ref is not None
    assert client_ref._session.is_closed
