"""
Layer5 — Outcome-ranked decision intelligence for AI agents.

Quick start:
    from layer5 import Layer5

    l5 = Layer5(api_key="layer5_your_key_here")

    scores = l5.get_scores(
        agent_id="my-agent",
        context={"issue_type": "payment_failed"}
    )

    l5.log_outcome(
        agent_id="my-agent",
        action_name=scores.ranked_actions[0].action_name,
        session_id="sess-123",
        issue_type="payment_failed",
        success=True,
    )
"""

from .async_client import AsyncLayer5
from .client import Layer5
from .exceptions import (
    Layer5AgentSuspendedError,
    Layer5AuthError,
    Layer5Error,
    Layer5NetworkError,
    Layer5RateLimitError,
    Layer5ServerError,
    Layer5TimeoutError,
    Layer5UnknownActionError,
    Layer5ValidationError,
)
from .models import (
    BusinessOutcome,
    FeedbackSignal,
    GetScoresRequest,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    PolicyDecision,
    PolicyResult,
    RankedAction,
    SequencePrediction,
    SimulateResponse,
)
from ._version import __version__

__all__ = [
    # Clients
    "Layer5",
    "AsyncLayer5",
    # Exceptions
    "Layer5Error",
    "Layer5AuthError",
    "Layer5RateLimitError",
    "Layer5ValidationError",
    "Layer5NetworkError",
    "Layer5TimeoutError",
    "Layer5ServerError",
    "Layer5UnknownActionError",
    "Layer5AgentSuspendedError",
    # Models
    "GetScoresRequest",
    "GetScoresResponse",
    "LogOutcomeRequest",
    "LogOutcomeResponse",
    "OutcomeFeedbackRequest",
    "OutcomeFeedbackResponse",
    "RankedAction",
    "PolicyResult",
    "BusinessOutcome",
    "FeedbackSignal",
    "PolicyDecision",
    "SequencePrediction",
    "SimulateResponse",
    # Version
    "__version__",
]
