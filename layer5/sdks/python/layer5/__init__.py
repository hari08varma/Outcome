"""
Layer5 Python SDK
=================
Decision intelligence layer for AI agents.

Usage::

    from layer5 import Layer5Client, LogOutcomeRequest

    client = Layer5Client(api_key="layer5_your_key")
    scores = client.get_scores(agent_id="agent-1", issue_type="billing_dispute")
    print(scores.top_action.action_name)
"""

from __future__ import annotations

__version__ = "0.1.0"
__all__ = [
    "Layer5Client",
    "ScoredAction",
    "GetScoresResponse",
    "LogOutcomeRequest",
    "LogOutcomeResponse",
    "Layer5Error",
    "Layer5AuthError",
    "Layer5RateLimitError",
    "Layer5NotFoundError",
    "Layer5ServerError",
]

from .client import Layer5Client
from .exceptions import (
    Layer5AuthError,
    Layer5Error,
    Layer5NotFoundError,
    Layer5RateLimitError,
    Layer5ServerError,
)
from .models import (
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ScoredAction,
)
