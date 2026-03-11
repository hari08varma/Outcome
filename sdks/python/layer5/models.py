"""
Layer5 SDK — Pydantic models for request/response payloads.

Models are derived from the actual API contracts in:
  api/routes/get-scores.ts
  api/routes/log-outcome.ts
  api/routes/outcome-feedback.ts
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


# ── Enums ──────────────────────────────────────────────────────

class BusinessOutcome(str, Enum):
    RESOLVED = "resolved"
    PARTIAL = "partial"
    FAILED = "failed"
    UNKNOWN = "unknown"


class FeedbackSignal(str, Enum):
    IMMEDIATE = "immediate"
    DELAYED = "delayed"
    NONE = "none"


class PolicyDecision(str, Enum):
    EXPLOIT = "exploit"
    EXPLORE = "explore"
    ESCALATE = "escalate"


# ── Response sub-models ────────────────────────────────────────

class RankedAction(BaseModel):
    """A single scored action from get-scores."""
    action_name: str
    score: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    trend: str  # "improving" | "stable" | "degrading"
    rank: int
    recommendation: str  # "use" | "consider" | "avoid"


class PolicyResult(BaseModel):
    """Policy engine recommendation."""
    decision: PolicyDecision
    reason: str
    top_action: Optional[str] = None
    explore_action: Optional[str] = None


class ContextWarning(BaseModel):
    """Context drift warning from get-scores."""
    type: str
    message: str
    recommendation: str
    confidence_cap: float


class AgentTrust(BaseModel):
    """Agent trust info returned by the API."""
    score: float
    status: str


class NextActions(BaseModel):
    """Policy + selection info from log-outcome."""
    policy: str
    reason: str
    selected_action: Optional[str] = None
    exploration_target: Optional[str] = None


# ── GET /v1/get-scores ─────────────────────────────────────────

class GetScoresRequest(BaseModel):
    """Parameters for get-scores (sent as query params)."""
    agent_id: str = Field(..., min_length=1)
    issue_type: Optional[str] = None
    context_id: Optional[str] = None
    top_n: int = Field(default=10, ge=1, le=50)
    refresh: bool = False

    @field_validator("agent_id")
    @classmethod
    def agent_id_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("agent_id cannot be empty or whitespace")
        return v.strip()


class GetScoresResponse(BaseModel):
    """
    Response from GET /v1/get-scores.
    Matches the JSON returned by the API.
    """
    ranked_actions: List[RankedAction] = Field(default_factory=list)
    top_action: Optional[str] = None
    should_escalate: Optional[bool] = None
    cold_start: Optional[bool] = None
    context_id: Optional[str] = None
    customer_id: Optional[str] = None
    issue_type: Optional[str] = None
    context_match: Optional[float] = None
    context_warning: Optional[ContextWarning] = None
    view_refreshed_at: Optional[str] = None
    served_from_cache: Optional[bool] = None
    policy: Optional[str] = None
    policy_reason: Optional[str] = None
    agent_trust: Optional[AgentTrust] = None
    meta: Optional[Dict[str, Any]] = None
    decision_id: Optional[str] = None
    recommended_sequence: Optional["SequencePrediction"] = None
    # SDK-enriched fields (not from API)
    latency_ms: Optional[float] = None


# ── POST /v1/log-outcome ──────────────────────────────────────

class LogOutcomeRequest(BaseModel):
    """
    Body for POST /v1/log-outcome.
    Matches the Zod schema in log-outcome.ts.
    """
    session_id: str = Field(..., min_length=1)
    action_name: str = Field(..., min_length=1, max_length=255)
    action_params: Optional[Dict[str, Any]] = None
    issue_type: str = Field(..., min_length=1, max_length=255)
    success: bool
    response_time_ms: Optional[int] = Field(None, gt=0)
    error_code: Optional[str] = Field(None, max_length=100)
    error_message: Optional[str] = Field(None, max_length=1000)
    raw_context: Optional[Dict[str, Any]] = None
    environment: Optional[str] = "production"
    customer_tier: Optional[str] = None
    outcome_score: Optional[float] = Field(None, ge=0.0, le=1.0)
    business_outcome: Optional[BusinessOutcome] = None
    feedback_signal: Optional[FeedbackSignal] = None

    @field_validator("outcome_score")
    @classmethod
    def score_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 1.0):
            raise ValueError(
                f"outcome_score must be between 0.0 and 1.0, "
                f"got {v}. "
                f"Use 0.0 for complete failure, "
                f"1.0 for perfect success."
            )
        return v


class LogOutcomeResponse(BaseModel):
    """
    Response from POST /v1/log-outcome.
    Matches the 201 JSON returned by log-outcome.ts.
    """
    success: bool
    outcome_id: str
    action_id: str
    context_id: str
    timestamp: str
    message: str
    recommendation: Optional[str] = None
    next_actions: Optional[NextActions] = None
    counterfactuals_computed: bool = False
    sequence_position: Optional[int] = None


# ── POST /v1/outcome-feedback ─────────────────────────────────

class OutcomeFeedbackRequest(BaseModel):
    """Body for POST /v1/outcome-feedback."""
    outcome_id: str = Field(..., min_length=1)
    final_score: float = Field(..., ge=0.0, le=1.0)
    business_outcome: BusinessOutcome
    feedback_notes: Optional[str] = Field(None, max_length=2000)


class OutcomeFeedbackResponse(BaseModel):
    """Response from POST /v1/outcome-feedback."""
    updated: bool
    outcome_id: str
    final_score: float
    business_outcome: str


# ── Simulation models ─────────────────────────────────────────

class SequencePrediction(BaseModel):
    """Prediction for a proposed action sequence."""
    actions: List[str]
    predicted_outcome: float = Field(ge=0.0, le=1.0)
    outcome_interval_low: float = Field(ge=0.0, le=1.0)
    outcome_interval_high: float = Field(ge=0.0, le=1.0)
    confidence: float = Field(ge=0.0, le=1.0)
    predicted_resolution: float = Field(ge=0.0, le=1.0)
    predicted_steps: float = Field(ge=0.0)
    better_than_proposed: bool = False


class SimulateResponse(BaseModel):
    """Response from POST /v1/simulate."""
    primary: SequencePrediction
    alternatives: List[SequencePrediction]
    simulation_tier: int = Field(ge=1, le=3)
    tier_explanation: str
    data_source: str
    episode_count: int
    simulation_warning: Optional[str] = None
