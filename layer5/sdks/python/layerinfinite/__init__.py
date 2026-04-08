"""
Layerinfinite Python SDK
========================
Decision intelligence layer for AI agents.
Zero LLM dependency. Learns from your outcome data.

Quick start::

    from layerinfinite import Layerinfinite

    li = Layerinfinite(api_key="layerinfinite_xxx", agent_id="my-agent")

    @li.action("payment_failed")
    def retry_payment(ticket_id):
        return gateway.charge(ticket_id)

    @li.action("payment_failed")
    def switch_provider(ticket_id):
        return alt_gateway.charge(ticket_id)

    # Outcomes auto-logged on every call.
    retry_payment("t-001")

    # Get recommendation after data accumulates:
    rec = li.recommend("payment_failed")
    print(rec.recommendation)
"""

from __future__ import annotations

__version__ = "0.4.1"
__all__ = [
    "Layerinfinite",
    "Suggestion",
    "RankedAction",
    "Recommendation",
    "RecommendationDataFreshness",
    "ObservationSummary",
    "LayerinfiniteError",
    "LayerinfiniteAuthError",
    "LayerinfiniteRateLimitError",
    "LayerinfiniteNotFoundError",
    "LayerinfiniteServerError",
    "LowConfidenceError",
    "LayerinfiniteClient",
    "ScoredAction",
    "GetScoresResponse",
    "LogOutcomeRequest",
    "LogOutcomeResponse",
    "PendingSignalRequest",
    "PendingSignalResponse",
    "OutcomeFeedbackRequest",
    "OutcomeFeedbackResponse",
    "DiscrepancyDetectResponse",
    "DiscrepancySummaryResponse",
    "DiscrepancyDriftSnapshot",
]

from .client import Layerinfinite, LayerinfiniteClient
from .exceptions import (
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
    LowConfidenceError,
)
from .models import (
    DiscrepancyDetectResponse,
    DiscrepancyDriftSnapshot,
    DiscrepancySummaryResponse,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ObservationSummary,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    PendingSignalRequest,
    PendingSignalResponse,
    RankedAction,
    Recommendation,
    RecommendationDataFreshness,
    ScoredAction,
    Suggestion,
)
