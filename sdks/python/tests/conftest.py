"""Shared fixtures for Layer5 SDK tests."""

import json

import httpx
import pytest

VALID_API_KEY = "layer5_testkey12345678901234567890"
BASE_URL = "https://test.layer5.dev"


@pytest.fixture
def api_key():
    return VALID_API_KEY


@pytest.fixture
def mock_scores_response():
    return {
        "ranked_actions": [
            {
                "action_name": "update_app",
                "score": 0.85,
                "confidence": 0.90,
                "trend": "improving",
                "rank": 1,
                "recommendation": "use",
            },
            {
                "action_name": "restart_service",
                "score": 0.07,
                "confidence": 0.80,
                "trend": "degrading",
                "rank": 2,
                "recommendation": "avoid",
            },
        ],
        "top_action": "update_app",
        "should_escalate": False,
        "cold_start": False,
        "context_id": "ctx-1",
        "customer_id": "cust-1",
        "issue_type": "payment_failed",
        "policy": "exploit",
        "policy_reason": "high_confidence_score",
        "agent_trust": {"score": 0.85, "status": "trusted"},
    }


@pytest.fixture
def mock_outcome_response():
    return {
        "success": True,
        "outcome_id": "test-uuid-123",
        "action_id": "act-456",
        "context_id": "ctx-1",
        "timestamp": "2026-03-09T00:00:00Z",
        "message": 'Outcome logged. Action "update_app" — SUCCESS',
        "recommendation": "exploit",
        "next_actions": {
            "policy": "exploit",
            "reason": "score_improved",
            "selected_action": "update_app",
            "exploration_target": None,
        },
    }


@pytest.fixture
def mock_feedback_response():
    return {
        "updated": True,
        "outcome_id": "test-uuid-123",
        "final_score": 0.1,
        "business_outcome": "failed",
    }
