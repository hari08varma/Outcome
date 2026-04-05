"""
Layerinfinite SDK — models.py
Pydantic v2 request/response models.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, List, Literal

from pydantic import BaseModel, Field, field_validator

TrustStatus = Literal["trusted", "probation", "sandbox", "suspended", "new"]


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
    policy: Literal["exploit", "explore", "escalate", "SANDBOX"] = "explore"
    cold_start: bool = False
    context_id: str = ""
    agent_id: str = ""
    served_from_cache: bool = False


class LogOutcomeRequest(BaseModel):
    agent_id: str
    action_name: str  # Required: API validates via validateActionMiddleware
    action_id: str | None = None   # kept for backward compat — ignored by API
    session_id: str | None = None
    context_id: str = ""
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
    trust_status: TrustStatus
    policy: str

    @field_validator("trust_status", mode="before")
    @classmethod
    def normalize_trust_status(cls, value: Any) -> TrustStatus:
        normalized = str(value or "").lower()
        if normalized == "degraded":
            return "sandbox"
        if normalized in {"trusted", "probation", "sandbox", "suspended", "new"}:
            return normalized  # type: ignore[return-value]
        return "probation"


@dataclass
class ActionEntry:
    """Internal registry entry for a registered action function."""

    fn: Callable
    name: str
    task: str
    score_fn: Callable[[Any], float | None] | None
    registered_via: str
    created_at: str


@dataclass
class RankedAction:
    """A single action in a ranked suggestion list."""

    action_name: str
    score: float
    confidence: float


@dataclass
class Suggestion:
    """
    Returned by li.suggest(task) in assist mode.
    Contains the recommended action and full ranked list.
    """

    action_name: str
    confidence: float
    reason: str
    ranked: List[RankedAction]


@dataclass
class Recommendation:
    """
    Returned by li.recommend(task) in all modes.
    Parsed from GET /v1/recommendations response.
    """

    task: str
    state: str
    problem: str | None = None
    recommendation: str | None = None
    expected_improvement: dict | None = None
    data_freshness: 'RecommendationDataFreshness | None' = None
    reason: str | None = None
    confidence: float | None = None


@dataclass
class RecommendationDataFreshness:
    source: Literal['mv', 'fact_fallback', 'unknown']
    last_seen_at: str | None
    age_hours: float | None
    is_stale: bool
    stale_threshold_hours: int


@dataclass
class ObservationSummary:
    """
    Returned by li.observe(task) in all modes.
    Parsed from GET /v1/observe response.
    """

    task: str
    total_runs: int
    success_rate: float
    actions_seen: List[str]
    best_performing: str | None = None
    worst_performing: str | None = None
    last_run: str | None = None
