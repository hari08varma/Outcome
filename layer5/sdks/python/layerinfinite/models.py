"""
Layerinfinite SDK — models.py
Pydantic v2 request/response models.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Literal

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
    policy: Literal["exploit", "explore", "escalate", "SANDBOX", "abstain"] = "explore"
    policy_abstain_message: str | None = None
    cold_start: bool = False
    # How many more outcomes to log before LI activates recommendations.
    # 0 when not cold-starting. Surfaced directly from the API.
    outcomes_needed: int = 0
    # Decision id emitted by /v1/get-scores for counterfactual linkage.
    decision_id: str | None = None
    # Source that determined the primary confidence shown in response.
    confidence_source: str | None = None
    # Machine-readable policy + gating explanation envelope.
    traceability: Dict[str, Any] | None = None
    context_id: str = ""
    agent_id: str = ""
    served_from_cache: bool = False


class LogOutcomeRequest(BaseModel):
    agent_id: str
    action_name: str | None = None
    action_id: str | None = None
    action_id_input: str | None = None
    session_id: str | None = None
    context_id: str = ""
    issue_type: str
    success: bool
    # Optional: when omitted, backend infers score from binary + soft signals.
    outcome_score: float | None = Field(default=None, ge=0.0, le=1.0)
    # API accepts any string; normalizes to: resolved | partial | failed | unknown
    # NOTE: "pending" (previous SDK value) is not canonical — maps to "unknown".
    # Use "partial" for partial outcomes.
    business_outcome: str | None = None
    decision_id: str | None = None
    episode_id: str | None = None
    response_ms: int | None = None
    # API accepts any string; known values: immediate | delayed | none
    # Unknown values normalize to "none" (no clear feedback signal).
    feedback_signal: str = "immediate"
    execution_status: Literal["COMPLETED", "FAILED"] | None = None
    failure_reason_code: str | None = None
    failure_stage: str | None = None
    idempotency_key: str | None = None


class IngestionQuality(BaseModel):
    """Ingestion quality metadata returned in every log-outcome 201 response."""
    # 0.0–1.0 completeness score for this event.
    data_quality: float
    # 'provided' = developer sent outcome_score; 'inferred' = absent, fell back to binary.
    score_origin: Literal["provided", "inferred"]
    # TRUE when success=True but outcome_score < inconsistency threshold.
    is_inconsistent: bool
    # Exact tier from issue_type → task_name resolution.
    mapping_tier: str
    # Confidence (0.0–1.0) of issue_type → task_name mapping.
    mapping_confidence: float
    inconsistency_type: str | None = None
    inconsistency_reason: str | None = None
    inconsistency_rule_version: str | None = None
    inference_confidence: float | None = None
    outcome_class: str | None = None
    execution_status: Literal["COMPLETED", "FAILED"] | None = None
    failure_reason_code: str | None = None
    failure_stage: str | None = None
    status_origin: Literal[
        "explicit",
        "inferred_from_success",
        "inferred_from_score",
        "reconciled_feedback",
    ] | None = None
    semantic_cluster: Dict[str, Any] | None = None
    retry_chain: Dict[str, Any] | None = None
    cross_event_status: str | None = None


class LogOutcomeResponse(BaseModel):
    logged: bool
    outcome_id: str
    agent_trust_score: float
    trust_status: TrustStatus
    policy: str
    # Ingestion quality metadata for this event. Present on all 201 responses.
    ingestion_quality: IngestionQuality | None = None

    @field_validator("trust_status", mode="before")
    @classmethod
    def normalize_trust_status(cls, value: Any) -> TrustStatus:
        normalized = str(value or "").lower()
        if normalized == "degraded":
            return "sandbox"
        if normalized in {"trusted", "probation", "sandbox", "suspended", "new"}:
            return normalized  # type: ignore[return-value]
        return "probation"


class PendingSignalRequest(BaseModel):
    outcome_id: str
    action_name: str
    provider_hint: Literal['stripe', 'sendgrid', 'generic'] | None = None
    feedback_signal: Literal['delayed'] = 'delayed'


class PendingSignalState(BaseModel):
    signal_pending: bool
    cross_event_status: str


class PendingSignalResponse(BaseModel):
    registration_id: str
    outcome_id: str
    created_at: str
    idempotent_replay: bool = False
    pending_state: PendingSignalState | None = None


class OutcomeFeedbackRequest(BaseModel):
    outcome_id: str
    final_score: float = Field(ge=0.0, le=1.0)
    business_outcome: str
    feedback_notes: str | None = None


class OutcomeFeedbackResponse(BaseModel):
    updated: bool
    outcome_id: str
    final_score: float
    business_outcome: str
    cross_event_status: str
    cross_event_conflict: bool


class DiscrepancyDetectCases(BaseModel):
    expired: int = 0
    mismatch: int = 0
    low_confidence: int = 0


class DiscrepancyDetectAdvancedCases(BaseModel):
    cross_event_conflict: int = 0
    pending_state_mismatch: int = 0
    ingestion_inconsistency: int = 0


class DiscrepancyDetectResponse(BaseModel):
    detected: int = 0
    cases: DiscrepancyDetectCases = Field(default_factory=DiscrepancyDetectCases)
    advanced_cases: DiscrepancyDetectAdvancedCases = Field(default_factory=DiscrepancyDetectAdvancedCases)


class DiscrepancySummaryResponse(BaseModel):
    total: int = 0
    by_type: Dict[str, int] = Field(default_factory=dict)


class DiscrepancyDriftSnapshot(BaseModel):
    open_total_discrepancies: int
    open_conflict_discrepancies: int
    open_conflict_share: float
    discrepancy_rate: float | None = None
    conflict_rate: float | None = None
    detected_now: int | None = None
    detected_conflicts_now: int | None = None
    by_type: Dict[str, int] = Field(default_factory=dict)


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

    Fix 3 — Trust UX:
      outcomes_needed: how many more outcomes to log before LI activates (0 = active).
      cold_start: True when LI has no data yet for this task.
    """

    action_name: str
    confidence: float
    reason: str
    ranked: List[RankedAction]
    outcomes_needed: int = 0
    cold_start: bool = False
    decision_id: str | None = None  # link suggestion → actual action executed


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
    confidence_source: str | None = None
    traceability: Dict[str, Any] | None = None


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
