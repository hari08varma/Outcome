"""
Layerinfinite SDK — models.py
Pydantic v2 request/response models.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ScoredAction(BaseModel):
    action_id: str
    action_name: str
    action_category: str
    composite_score: float
    confidence: float
    total_attempts: int
    policy_reason: str | None = None
    is_cold_start: bool = False
    is_low_sample: bool = False


class GetScoresResponse(BaseModel):
    ranked_actions: list[ScoredAction]
    top_action: ScoredAction | None = None
    policy: Literal["exploit", "explore", "escalate"] = "explore"
    cold_start: bool = False
    context_id: str = ""
    agent_id: str = ""
    served_from_cache: bool = False


class LogOutcomeRequest(BaseModel):
    agent_id: str
    action_id: str
    context_id: str
    issue_type: str
    success: bool
    outcome_score: float = Field(ge=0.0, le=1.0)
    # API accepts any string; normalizes to: resolved | partial | failed | unknown
    # NOTE: "pending" (previous SDK value) is not canonical — maps to "unknown".
    # Use "partial" for partial outcomes.
    business_outcome: str | None = None
    episode_id: str | None = None
    response_ms: int | None = None
    # API accepts any string; known values: immediate | delayed | none
    # Unknown values normalize to "none" (no clear feedback signal).
    feedback_signal: str = "immediate"


class LogOutcomeResponse(BaseModel):
    logged: bool
    outcome_id: str
    agent_trust_score: float
    trust_status: str
    policy: str
