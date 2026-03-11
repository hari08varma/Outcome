"""Tests for Pydantic models."""

import pytest
from pydantic import ValidationError

from layer5.models import (
    BusinessOutcome,
    GetScoresRequest,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    RankedAction,
)


class TestGetScoresRequest:
    def test_valid_request(self):
        req = GetScoresRequest(agent_id="my-agent", issue_type="payment")
        assert req.agent_id == "my-agent"

    def test_empty_agent_id_rejected(self):
        with pytest.raises(ValidationError, match="agent_id"):
            GetScoresRequest(agent_id="   ")

    def test_strips_whitespace(self):
        req = GetScoresRequest(agent_id="  my-agent  ")
        assert req.agent_id == "my-agent"


class TestLogOutcomeRequest:
    def test_valid_request(self):
        req = LogOutcomeRequest(
            session_id="sess-1",
            action_name="restart",
            issue_type="payment",
            success=True,
        )
        assert req.action_name == "restart"
        assert req.success is True

    def test_outcome_score_out_of_range(self):
        with pytest.raises(ValidationError, match="outcome_score"):
            LogOutcomeRequest(
                session_id="sess-1",
                action_name="test",
                issue_type="test",
                success=True,
                outcome_score=1.5,
            )

    def test_outcome_score_valid(self):
        req = LogOutcomeRequest(
            session_id="sess-1",
            action_name="test",
            issue_type="test",
            success=True,
            outcome_score=0.7,
        )
        assert req.outcome_score == 0.7

    def test_optional_fields_default_none(self):
        req = LogOutcomeRequest(
            session_id="s",
            action_name="a",
            issue_type="i",
            success=False,
        )
        assert req.response_time_ms is None
        assert req.outcome_score is None
        assert req.business_outcome is None


class TestGetScoresResponse:
    def test_parses_full_response(self):
        data = {
            "ranked_actions": [
                {
                    "action_name": "restart",
                    "score": 0.9,
                    "confidence": 0.85,
                    "trend": "improving",
                    "rank": 1,
                    "recommendation": "use",
                }
            ],
            "policy": "exploit",
            "agent_trust": {"score": 0.95, "status": "trusted"},
        }
        resp = GetScoresResponse(**data)
        assert len(resp.ranked_actions) == 1
        assert resp.ranked_actions[0].score == 0.9
        assert resp.policy == "exploit"

    def test_empty_ranked_actions(self):
        resp = GetScoresResponse(ranked_actions=[])
        assert resp.ranked_actions == []


class TestRankedAction:
    def test_score_bounds(self):
        with pytest.raises(ValidationError):
            RankedAction(
                action_name="x",
                score=1.5,
                confidence=0.5,
                trend="stable",
                rank=1,
                recommendation="use",
            )


class TestOutcomeFeedbackRequest:
    def test_valid(self):
        req = OutcomeFeedbackRequest(
            outcome_id="out-1",
            final_score=0.1,
            business_outcome=BusinessOutcome.FAILED,
        )
        assert req.final_score == 0.1

    def test_final_score_out_of_range(self):
        with pytest.raises(ValidationError):
            OutcomeFeedbackRequest(
                outcome_id="out-1",
                final_score=2.0,
                business_outcome=BusinessOutcome.RESOLVED,
            )


class TestBusinessOutcome:
    def test_all_values(self):
        assert BusinessOutcome.RESOLVED == "resolved"
        assert BusinessOutcome.PARTIAL == "partial"
        assert BusinessOutcome.FAILED == "failed"
        assert BusinessOutcome.UNKNOWN == "unknown"
