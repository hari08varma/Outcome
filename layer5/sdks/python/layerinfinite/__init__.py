"""
Layerinfinite Python SDK
========================
Decision intelligence layer for AI agents.

Usage::

    from layerinfinite import LayerinfiniteClient, LogOutcomeRequest

    client = LayerinfiniteClient(api_key="layerinfinite_your_key")
    scores = client.get_scores(agent_id="agent-1", issue_type="billing_dispute")
    print(scores.top_action.action_name)
"""

from __future__ import annotations

__version__ = "0.1.0"
__all__ = [
    "LayerinfiniteClient",
    "ScoredAction",
    "GetScoresResponse",
    "LogOutcomeRequest",
    "LogOutcomeResponse",
    "LayerinfiniteError",
    "LayerinfiniteAuthError",
    "LayerinfiniteRateLimitError",
    "LayerinfiniteNotFoundError",
    "LayerinfiniteServerError",
]

from .client import LayerinfiniteClient
from .exceptions import (
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
)
from .models import (
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ScoredAction,
)
from .instrument import instrument
from .tracing.traced_response import TracedResponse
