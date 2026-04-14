"""
Tests for the Layerinfinite Python SDK client.

Uses respx to mock httpx calls — no real network requests made.
Run with: pytest tests/test_client.py -v
"""

from __future__ import annotations

import inspect
import json
import httpx
import pytest
import respx

from layerinfinite import (
    LayerinfiniteClient,
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LowConfidenceError,
    LayerinfiniteRateLimitError,
    LogOutcomeRequest,
)
from layerinfinite.models import (
    DiscrepancyDriftSnapshot,
    GetScoresResponse,
    LogOutcomeResponse,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    PendingSignalRequest,
    PendingSignalResponse,
    ScoredAction,
)

BASE_URL = "https://test.layerinfinite.ai"
API_KEY = "layerinfinite_testkey123456789"

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

MOCK_RECOMMENDATION_RESPONSE = {
    "task": "billing_dispute",
    "state": "stable",
    "problem": "retry_with_backoff underperforms",
    "recommendation": "escalate_to_senior",
    "expected_improvement": {
        "baseline": "62.0%",
        "improved": "79.0%",
        "delta": "+17.0%",
    },
    "data_freshness": {
        "source": "mv",
        "last_seen_at": "2026-04-05T10:00:00.000Z",
        "age_hours": 4,
        "is_stale": False,
        "stale_threshold_hours": 72,
    },
    "reason": "historically strongest action",
    "confidence": 0.91,
    "confidence_source": "empirical_stable",
    "traceability": {
        "reason_code": "stable_recommendation",
        "stage": "decision",
        "gate": None,
        "detail": "Recommendation is stable under current reliability gates.",
    },
}

MOCK_PENDING_SIGNAL_RESPONSE = {
    "registration_id": "reg-uuid-1",
    "outcome_id": "out-uuid-1",
    "created_at": "2026-04-07T10:00:00.000Z",
    "idempotent_replay": False,
    "pending_state": {
        "signal_pending": True,
        "cross_event_status": "pending_signal",
    },
}

MOCK_OUTCOME_FEEDBACK_RESPONSE = {
    "updated": True,
    "outcome_id": "out-uuid-1",
    "final_score": 0.3,
    "business_outcome": "failed",
    "cross_event_status": "conflict",
    "cross_event_conflict": True,
}

MOCK_DISCREPANCY_DETECT_RESPONSE = {
    "detected": 8,
    "cases": {
        "expired": 2,
        "mismatch": 3,
        "low_confidence": 1,
    },
    "advanced_cases": {
        "cross_event_conflict": 2,
        "pending_state_mismatch": 0,
        "ingestion_inconsistency": 0,
    },
}

MOCK_DISCREPANCY_SUMMARY_RESPONSE = {
    "total": 20,
    "by_type": {
        "cross_event_conflict": 5,
        "outcome_mismatch": 9,
        "ingestion_inconsistency": 6,
    },
}


class TestExtractContext:
    """Tests for the _extract_context module-level helper."""

    def _dummy(self, amount, card_type, customer_tier='standard'):
        return None

    def test_binning_numeric(self):
        from layerinfinite.client import _extract_context

        ctx = _extract_context(self._dummy, (750, 'visa'), {})
        assert ctx['amount'] == '500-1k'
        assert ctx['card_type'] == 'visa'

    def test_pii_scrubbed_by_name(self):
        from layerinfinite.client import _extract_context

        def fn(email, amount):
            return None

        ctx = _extract_context(fn, ('user@x.com', 100), {})
        assert 'email' not in ctx
        assert ctx['amount'] == '50-200'

    def test_self_excluded(self):
        from layerinfinite.client import _extract_context

        ctx = _extract_context(TestExtractContext._dummy, (self, 50, 'amex'), {})
        assert 'self' not in ctx
        assert ctx['amount'] == '50-200'

    def test_default_applied(self):
        from layerinfinite.client import _extract_context

        ctx = _extract_context(self._dummy, (50, 'amex'), {})
        assert ctx.get('customer_tier') == 'standard'

    def test_callable_arg_skipped(self):
        from layerinfinite.client import _extract_context

        def fn(callback, amount):
            return None

        ctx = _extract_context(fn, (lambda: None, 100), {})
        assert 'callback' not in ctx
        assert ctx['amount'] == '50-200'

    def test_empty_on_error(self):
        from layerinfinite.client import _extract_context

        def fn(x):
            return None

        ctx = _extract_context(fn, (), {})
        assert ctx == {}

    def test_string_truncated(self):
        from layerinfinite.client import _extract_context

        def fn(label):
            return None

        ctx = _extract_context(fn, ('x' * 100,), {})
        assert len(ctx['label']) == 64

    def test_token_like_string_skipped(self):
        from layerinfinite.client import _extract_context

        def fn(region, token_value):
            return None

        ctx = _extract_context(
            fn,
            ('us-east', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc'),
            {},
        )
        assert 'region' in ctx
        assert 'token_value' not in ctx


# ── Test 1: get_scores returns typed GetScoresResponse ────────
@respx.mock
def test_get_scores_returns_typed_response():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(200, json=MOCK_GET_SCORES_RESPONSE)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    response = client.scores("billing_dispute")

    assert isinstance(response, GetScoresResponse)
    assert isinstance(response.top_action, ScoredAction)
    assert response.top_action.action_name == "escalate_to_senior"
    assert response.policy in ("exploit", "explore", "escalate", "SANDBOX", "abstain")
    assert response.top_action.composite_score == pytest.approx(0.87)


# ── Test 2: 401 raises LayerinfiniteAuthError ─────────────────
@respx.mock
def test_get_scores_401_raises_auth_error():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(401, json={"error": "Unauthorized"})
    )

    client = LayerinfiniteClient(api_key="layerinfinite_bad_key", agent_id='my-agent', base_url=BASE_URL)
    with pytest.raises(LayerinfiniteAuthError) as exc_info:
        client.scores("test")

    assert exc_info.value.status_code == 401


# ── Test 3: 429 raises LayerinfiniteRateLimitError with retry_after ──
@respx.mock
def test_get_scores_429_raises_rate_limit_error():
    respx.get(f"{BASE_URL}/v1/get-scores").mock(
        return_value=httpx.Response(
            429,
            json={"error": "Too Many Requests"},
            headers={"Retry-After": "30"},
        )
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL, max_retries=0)
    with pytest.raises(LayerinfiniteRateLimitError) as exc_info:
        client.scores("test")

    assert exc_info.value.status_code == 429
    assert exc_info.value.retry_after == 30


# ── Test 4: log_outcome returns LogOutcomeResponse ─────────────
@respx.mock
def test_log_outcome_returns_typed_response():
    respx.post(f"{BASE_URL}/v1/log-outcome").mock(
        return_value=httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    request = LogOutcomeRequest(
        agent_id="my-agent",
        action_name="escalate_to_senior",
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


@respx.mock
def test_log_outcome_normalizes_legacy_degraded_status_to_sandbox():
    legacy_response = {
        "logged": True,
        "outcome_id": "out-uuid-legacy",
        "agent_trust_score": 0.21,
        "trust_status": "degraded",
        "policy": "SANDBOX",
    }

    respx.post(f"{BASE_URL}/v1/log-outcome").mock(
        return_value=httpx.Response(200, json=legacy_response)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    request = LogOutcomeRequest(
        agent_id="my-agent",
        action_name="escalate_to_senior",
        action_id="act-uuid-legacy",
        context_id="ctx-uuid-legacy",
        issue_type="billing_dispute",
        success=False,
        outcome_score=0.2,
        business_outcome="failed",
    )

    response = client.log_outcome(request)

    assert isinstance(response, LogOutcomeResponse)
    assert response.outcome_id == "out-uuid-legacy"
    assert response.trust_status == "sandbox"


def test_log_outcome_auto_populates_idempotency_key_when_missing(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    request = LogOutcomeRequest(
        agent_id="my-agent",
        action_name="escalate_to_senior",
        issue_type="billing_dispute",
        success=True,
        outcome_score=0.91,
    )
    client.log_outcome(request)

    assert isinstance(captured_payload.get('idempotency_key'), str)
    assert len(captured_payload.get('idempotency_key', '')) > 0


def test_log_outcome_accepts_missing_outcome_score_and_maps_action_id_alias(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    request = LogOutcomeRequest(
        agent_id='my-agent',
        action_name='escalate_to_senior',
        action_id='act-uuid-legacy-alias',
        issue_type='billing_dispute',
        success=True,
    )
    response = client.log_outcome(request)

    assert isinstance(response, LogOutcomeResponse)
    assert 'outcome_score' not in captured_payload
    assert captured_payload.get('action_id') == 'act-uuid-legacy-alias'
    assert captured_payload.get('action_id_input') == 'act-uuid-legacy-alias'


def test_log_outcome_accepts_action_id_only_payload(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    request = LogOutcomeRequest(
        agent_id='my-agent',
        action_id='act-uuid-only',
        issue_type='billing_dispute',
        success=True,
    )
    response = client.log_outcome(request)

    assert isinstance(response, LogOutcomeResponse)
    assert captured_payload.get('action_id') == 'act-uuid-only'
    assert captured_payload.get('action_id_input') == 'act-uuid-only'


def test_log_outcome_queues_and_replays_after_network_recovery(tmp_path, monkeypatch):
    pending_file = tmp_path / "pending_outcomes.jsonl"
    monkeypatch.setenv("LAYERINFINITE_PENDING_OUTCOMES_FILE", str(pending_file))

    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        log_async=False,
        auto_register=False,
    )

    network_up = {'value': False}
    posted_session_ids: list[str] = []

    def fake_request(method, path, **kwargs):
        if method == 'POST' and path == '/v1/log-outcome':
            payload = kwargs.get('json', {})
            posted_session_ids.append(payload.get('session_id', ''))
            if not network_up['value']:
                raise LayerinfiniteError("Network error: getaddrinfo failed")
            return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)
    client._pending_replay_interval_seconds = 0

    client._log_outcome(
        task='billing_dispute',
        action_name='first_attempt',
        success=True,
        session_id='session-1',
        latency_ms=120,
        outcome_score=0.82,
    )

    assert pending_file.exists()
    queued_payloads = [
        json.loads(line)
        for line in pending_file.read_text(encoding='utf-8').splitlines()
        if line.strip()
    ]
    assert len(queued_payloads) == 1
    assert queued_payloads[0]['session_id'] == 'session-1'

    network_up['value'] = True

    client._log_outcome(
        task='billing_dispute',
        action_name='second_attempt',
        success=True,
        session_id='session-2',
        latency_ms=80,
        outcome_score=0.91,
    )

    if pending_file.exists():
        assert pending_file.read_text(encoding='utf-8').strip() == ''

    assert posted_session_ids.count('session-1') == 2
    assert posted_session_ids.count('session-2') == 1


# ── Test 5: context manager properly closes session ────────────
def test_context_manager_closes_session():
    client_ref = None

    with LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL) as client:
        client_ref = client
        assert not client._http.is_closed

    assert client_ref is not None
    assert client_ref._http.is_closed


@respx.mock
def test_get_scores_fails_over_to_secondary_endpoint_on_dns_error(monkeypatch):
    primary_base = "https://primary.layerinfinite.ai"
    secondary_base = "https://secondary.layerinfinite.ai"

    monkeypatch.setenv("LAYERINFINITE_BASE_URLS", secondary_base)

    primary_route = respx.get(f"{primary_base}/v1/get-scores").mock(
        side_effect=httpx.ConnectError("getaddrinfo failed")
    )
    secondary_route = respx.get(f"{secondary_base}/v1/get-scores").mock(
        return_value=httpx.Response(200, json=MOCK_GET_SCORES_RESPONSE)
    )

    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=primary_base,
        max_retries=2,
    )

    response = client.scores("billing_dispute")

    assert isinstance(response, GetScoresResponse)
    assert response.top_action is not None
    assert response.top_action.action_name == "escalate_to_senior"
    assert primary_route.called
    assert secondary_route.called


def test_fetch_scores_uses_recent_cache_on_network_error(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    calls = {'scores': 0}

    def fake_request(method, path, **kwargs):
        if method == 'GET' and path == '/v1/get-scores':
            calls['scores'] += 1
            if calls['scores'] == 1:
                return httpx.Response(200, json=MOCK_GET_SCORES_RESPONSE)
            raise LayerinfiniteError("Network error: getaddrinfo failed")
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)

    first = client.scores('billing_dispute')
    second = client.scores('billing_dispute')

    assert first.top_action is not None
    assert first.top_action.action_name == 'escalate_to_senior'
    assert second.top_action is not None
    assert second.top_action.action_name == 'escalate_to_senior'
    assert calls['scores'] == 2


def test_run_uses_cached_ranking_when_get_scores_temporarily_unreachable(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        mode='auto',
        auto_register=False,
    )

    executed: list[str] = []

    def first_action(**kwargs):
        executed.append('first_action')
        return {'ok': True, 'action': 'first_action'}

    def best_action(**kwargs):
        executed.append('best_action')
        return {'ok': True, 'action': 'best_action'}

    client.register_action('billing_dispute', 'first_action', first_action)
    client.register_action('billing_dispute', 'best_action', best_action)

    ranked_payload = {
        **MOCK_GET_SCORES_RESPONSE,
        'ranked_actions': [
            {**MOCK_SCORED_ACTION, 'action_name': 'best_action', 'composite_score': 0.93},
            {**MOCK_SCORED_ACTION, 'action_name': 'first_action', 'composite_score': 0.21},
        ],
        'top_action': {**MOCK_SCORED_ACTION, 'action_name': 'best_action', 'composite_score': 0.93},
    }

    calls = {'scores': 0}

    def fake_request(method, path, **kwargs):
        if method == 'GET' and path == '/v1/get-scores':
            calls['scores'] += 1
            if calls['scores'] == 1:
                return httpx.Response(200, json=ranked_payload)
            raise LayerinfiniteError("Network error: getaddrinfo failed")
        if method == 'POST' and path == '/v1/log-outcome':
            return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)

    # Prime cache while scoring endpoint is reachable.
    primed = client.scores('billing_dispute')
    assert primed.top_action is not None
    assert primed.top_action.action_name == 'best_action'

    result = client.run('billing_dispute', ticket_id='t-1')

    assert result['action'] == 'best_action'
    assert executed[0] == 'best_action'


def test_run_raises_low_confidence_on_policy_abstain_and_skips_execution(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        mode='auto',
        auto_register=False,
    )

    executed: list[str] = []

    def candidate_action(**kwargs):
        executed.append('candidate_action')
        return {'ok': True}

    client.register_action('billing_dispute', 'candidate_action', candidate_action)

    abstain_scores = GetScoresResponse.model_validate({
        'ranked_actions': [
            {
                'action_id': 'act-uuid-1',
                'action_name': 'candidate_action',
                'action_category': 'remediation',
                'composite_score': 0.59,
                'confidence': 0.58,
                'total_attempts': 12,
                'policy_reason': 'near_tie',
                'is_cold_start': False,
            }
        ],
        'top_action': {
            'action_id': 'act-uuid-1',
            'action_name': 'candidate_action',
            'action_category': 'remediation',
            'composite_score': 0.59,
            'confidence': 0.58,
            'total_attempts': 12,
            'policy_reason': 'near_tie',
            'is_cold_start': False,
        },
        'policy': 'abstain',
        'policy_abstain_message': 'Top actions are statistically indistinguishable.',
        'cold_start': False,
        'context_id': 'ctx-uuid-abstain',
        'agent_id': 'my-agent',
        'served_from_cache': False,
    })

    monkeypatch.setattr(client, '_build_execution_order', lambda task: ['candidate_action'])
    monkeypatch.setattr(client, '_fetch_scores', lambda task: abstain_scores)
    monkeypatch.setattr(client, '_log_outcome', lambda **kwargs: pytest.fail('_log_outcome should not be called'))

    with pytest.raises(LowConfidenceError) as exc_info:
        client.run('billing_dispute', ticket_id='t-2')

    assert 'Policy abstain for task' in str(exc_info.value)
    assert exc_info.value.suggestion.action_name == 'candidate_action'
    assert exc_info.value.suggestion.reason == 'Top actions are statistically indistinguishable.'
    assert executed == []


def test_recommend_uses_cached_snapshot_on_network_error(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    calls = {'recommend': 0}
    recommendation_payload = {
        'state': 'high_confidence',
        'problem': 'billing_dispute is recurring',
        'recommendation': 'escalate_to_senior',
        'expected_improvement': {'baseline': '62%', 'improved': '79%', 'delta': '+17%'},
        'reason': 'historically strongest action',
        'confidence': 0.91,
    }

    def fake_request(method, path, **kwargs):
        if method == 'GET' and path.startswith('/v1/recommendations'):
            calls['recommend'] += 1
            if calls['recommend'] == 1:
                return httpx.Response(200, json=recommendation_payload)
            raise LayerinfiniteError('Network error: getaddrinfo failed')
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)

    first = client.recommend('billing_dispute')
    second = client.recommend('billing_dispute')

    assert first.recommendation == 'escalate_to_senior'
    assert second.recommendation == 'escalate_to_senior'
    assert second.state == 'high_confidence'
    assert calls['recommend'] == 2


def test_observe_uses_cached_snapshot_on_network_error(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    calls = {'observe': 0}
    observe_payload = {
        'task': 'billing_dispute',
        'total_runs': 25,
        'success_rate': 0.84,
        'actions_seen': ['escalate_to_senior', 'retry_with_context'],
        'best_performing': 'escalate_to_senior',
        'worst_performing': 'retry_with_context',
        'last_run': '2026-04-05T02:00:00+00:00',
    }

    def fake_request(method, path, **kwargs):
        if method == 'GET' and path.startswith('/v1/observe'):
            calls['observe'] += 1
            if calls['observe'] == 1:
                return httpx.Response(200, json=observe_payload)
            raise LayerinfiniteError('Network error: getaddrinfo failed')
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)

    first = client.observe('billing_dispute')
    second = client.observe('billing_dispute')

    assert first.task == 'billing_dispute'
    assert second.task == 'billing_dispute'
    assert second.total_runs == 25
    assert second.best_performing == 'escalate_to_senior'
    assert calls['observe'] == 2


@respx.mock
def test_recommend_maps_data_freshness():
    respx.get(f"{BASE_URL}/v1/recommendations").mock(
        return_value=httpx.Response(200, json=MOCK_RECOMMENDATION_RESPONSE)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    rec = client.recommend('billing_dispute')

    assert rec.task == 'billing_dispute'
    assert rec.recommendation == 'escalate_to_senior'
    assert rec.data_freshness is not None
    assert rec.data_freshness.source == 'mv'
    assert rec.data_freshness.age_hours == pytest.approx(4.0)
    assert rec.data_freshness.is_stale is False
    assert rec.data_freshness.stale_threshold_hours == 72
    assert rec.confidence_source == 'empirical_stable'
    assert rec.traceability is not None
    assert rec.traceability.get('reason_code') == 'stable_recommendation'


def test_run_uses_entry_score_fn_for_outcome_score(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        mode='auto',
        auto_register=False,
    )

    client.register_action(
        'billing_dispute',
        'resolve_now',
        lambda amount: {'ok': True, 'amount': amount},
        score_fn=lambda result: 0.91 if result['ok'] else 0.15,
    )

    monkeypatch.setattr(client, '_build_execution_order', lambda task: ['resolve_now'])
    monkeypatch.setattr(client, '_fetch_scores', lambda task: None)

    logged: dict = {}
    monkeypatch.setattr(client, '_log_outcome', lambda **kwargs: logged.update(kwargs))

    result = client.run('billing_dispute', amount=42)

    assert result == {'ok': True, 'amount': 42}
    assert logged['task'] == 'billing_dispute'
    assert logged['action_name'] == 'resolve_now'
    assert logged['success'] is True
    assert logged['outcome_score'] == pytest.approx(0.91)


def test_action_wrapper_skips_score_fn_for_async_result(monkeypatch, caplog):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
    )

    logged: dict = {}
    monkeypatch.setattr(client, '_log_outcome', lambda **kwargs: logged.update(kwargs))

    @client.action(
        'billing_dispute',
        score_fn=lambda result: 0.8 if result.get('ok') else 0.2,
    )
    async def async_handler(amount: int):
        return {'ok': amount > 0}

    with caplog.at_level('DEBUG'):
        coro = async_handler(100)

    assert inspect.iscoroutine(coro)
    coro.close()
    assert logged['success'] is True
    assert logged['outcome_score'] is None
    assert "is async - score callback skipped" in caplog.text


def test_action_wrapper_logs_response_ms_payload(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
        log_async=False,
    )

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    @client.action('billing_dispute', score_fn=lambda result: 0.75)
    def resolve_incident(*, incident):
        return {'ok': True, 'incident': incident}

    resolve_incident(incident={'id': 'INC-TEST'})

    if 'response_ms' in captured_payload:
        assert isinstance(captured_payload['response_ms'], int)
        assert captured_payload['response_ms'] > 0
    assert 'latency_ms' not in captured_payload


def test_log_outcome_omits_nonpositive_response_ms(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
        log_async=False,
    )

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    client._log_outcome(
        task='billing_dispute',
        action_name='resolve_incident',
        success=True,
        session_id='session-zero',
        latency_ms=0,
        outcome_score=0.91,
    )

    assert 'response_ms' not in captured_payload


def test_log_outcome_does_not_queue_non_retryable_4xx(tmp_path, monkeypatch):
    pending_file = tmp_path / 'pending_outcomes.jsonl'
    monkeypatch.setenv('LAYERINFINITE_PENDING_OUTCOMES_FILE', str(pending_file))

    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
        log_async=False,
    )

    def fake_request(method, path, **kwargs):
        if method == 'POST' and path == '/v1/log-outcome':
            raise LayerinfiniteError(
                'Request error [400]: Invalid request body',
                status_code=400,
                response_body={'details': 'response_ms must be a positive integer'},
            )
        raise AssertionError(f'Unexpected request: {method} {path}')

    monkeypatch.setattr(client, '_request', fake_request)

    client._log_outcome(
        task='billing_dispute',
        action_name='resolve_incident',
        success=True,
        session_id='session-bad-payload',
        latency_ms=120,
        outcome_score=0.9,
    )

    # Non-retryable 4xx payload errors should not be queued.
    assert not pending_file.exists()


def test_action_wrapper_auto_captures_raw_context(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
        log_async=False,
    )

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    @client.action('payment_failed')
    def retry_payment(amount, card_type, customer_tier='standard'):
        return {'ok': True, 'amount': amount, 'card_type': card_type, 'tier': customer_tier}

    retry_payment(750, 'visa', customer_tier='premium')

    assert 'raw_context' in captured_payload
    assert captured_payload['raw_context']['amount'] == '500-1k'
    assert captured_payload['raw_context']['card_type'] == 'visa'
    assert captured_payload['raw_context']['customer_tier'] == 'premium'


def test_action_wrapper_omits_empty_raw_context(monkeypatch):
    client = LayerinfiniteClient(
        api_key=API_KEY,
        agent_id='my-agent',
        base_url=BASE_URL,
        auto_register=False,
        log_async=False,
    )

    captured_payload: dict = {}

    def fake_request(method, path, **kwargs):
        captured_payload.update(kwargs.get('json', {}))
        return httpx.Response(200, json=MOCK_LOG_OUTCOME_RESPONSE)

    monkeypatch.setattr(client, '_request', fake_request)

    @client.action('payment_failed')
    def run_sensitive(password, token):
        return {'ok': True}

    run_sensitive('hunter2', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc')

    assert 'raw_context' not in captured_payload


@respx.mock
def test_register_pending_signal_returns_typed_response_and_delayed_payload():
    route = respx.post(f"{BASE_URL}/v1/pending-signals").mock(
        return_value=httpx.Response(201, json=MOCK_PENDING_SIGNAL_RESPONSE)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    response = client.register_pending_signal(PendingSignalRequest(
        outcome_id='8fc5b70f-3d48-4dc8-a937-5464248f22f8',
        action_name='retry_payment',
        provider_hint='stripe',
    ))

    assert isinstance(response, PendingSignalResponse)
    assert response.registration_id == 'reg-uuid-1'
    sent_json = json.loads(route.calls[0].request.content.decode('utf-8'))
    assert sent_json['feedback_signal'] == 'delayed'


@respx.mock
def test_submit_outcome_feedback_returns_typed_response():
    respx.post(f"{BASE_URL}/v1/outcome-feedback").mock(
        return_value=httpx.Response(200, json=MOCK_OUTCOME_FEEDBACK_RESPONSE)
    )

    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)
    response = client.submit_outcome_feedback(OutcomeFeedbackRequest(
        outcome_id='out-uuid-1',
        final_score=0.3,
        business_outcome='failed',
        feedback_notes='webhook callback final state failed',
    ))

    assert isinstance(response, OutcomeFeedbackResponse)
    assert response.updated is True
    assert response.cross_event_status == 'conflict'
    assert response.cross_event_conflict is True


def test_monitor_discrepancy_drift_computes_rates(monkeypatch):
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    def fake_request(method, path, **kwargs):
        if method == 'POST' and path == '/v1/discrepancies/detect':
            return httpx.Response(200, json=MOCK_DISCREPANCY_DETECT_RESPONSE)
        if method == 'GET' and path == '/v1/discrepancies/summary':
            return httpx.Response(200, json=MOCK_DISCREPANCY_SUMMARY_RESPONSE)
        raise AssertionError(f"Unexpected request: {method} {path}")

    monkeypatch.setattr(client, '_request', fake_request)

    drift = client.monitor_discrepancy_drift(observed_outcomes=200)

    assert isinstance(drift, DiscrepancyDriftSnapshot)
    assert drift.open_total_discrepancies == 20
    assert drift.open_conflict_discrepancies == 5
    assert drift.discrepancy_rate == pytest.approx(0.1)
    assert drift.conflict_rate == pytest.approx(0.025)
    assert drift.detected_now == 8
    assert drift.detected_conflicts_now == 2


def test_build_delayed_signal_metadata_maps_provider_fields():
    client = LayerinfiniteClient(api_key=API_KEY, agent_id='my-agent', base_url=BASE_URL)

    metadata = client.build_delayed_signal_metadata('out-123')

    assert metadata['stripe']['metadata']['layerinfinite_outcome_id'] == 'out-123'
    assert metadata['sendgrid']['unique_args']['outcome_id'] == 'out-123'
    assert metadata['generic']['outcome_id'] == 'out-123'
