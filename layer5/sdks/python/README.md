# Layerinfinite Python SDK

Layerinfinite is a decision intelligence middleware for AI agents — it records action outcomes, computes composite trust scores, and recommends the highest-performing next action so your agents learn from every decision. Drop it between any LLM agent and your production infrastructure in minutes.

## Installation

```bash
pip install layerinfinite-sdk
```

## Quick Start

```python
from layerinfinite import LayerinfiniteClient, LogOutcomeRequest

client = LayerinfiniteClient(api_key="layerinfinite_your_key")

# Ask Layerinfinite which action to take
scores = client.get_scores(
    agent_id="my-agent",
    issue_type="billing_dispute"
)
print(scores.top_action.action_name)   # e.g. "escalate_to_senior"
print(f"Policy: {scores.policy}")      # exploit | explore | escalate

# Log the outcome after the action runs
client.log_outcome(LogOutcomeRequest(
    agent_id="my-agent",
    action_id=scores.top_action.action_id,
    context_id=scores.context_id,
    issue_type="billing_dispute",
    success=True,
    outcome_score=0.9,
    business_outcome="resolved"
))
```

## Context Manager

```python
with LayerinfiniteClient(api_key="layerinfinite_your_key") as client:
    scores = client.get_scores(agent_id="agent-1", issue_type="payment_failed")
    # Session is automatically closed on exit
```

## LangChain Integration

```python
from layerinfinite import LayerinfiniteClient, LogOutcomeRequest
from langchain_core.tools import tool

layerinfinite = LayerinfiniteClient(api_key="layerinfinite_your_key")

@tool
def resolve_ticket(agent_id: str, issue_type: str) -> str:
    """Resolve a support ticket using Layerinfinite-guided action."""
    scores = layerinfinite.get_scores(agent_id=agent_id, issue_type=issue_type)
    action = scores.top_action.action_name
    # ... run the action ...
    layerinfinite.log_outcome(LogOutcomeRequest(
        agent_id=agent_id,
        action_id=scores.top_action.action_id,
        context_id=scores.context_id,
        issue_type=issue_type,
        success=True, outcome_score=0.85, business_outcome="resolved"
    ))
    return action
```

## Error Handling

```python
from layerinfinite import LayerinfiniteClient, LayerinfiniteAuthError, LayerinfiniteRateLimitError
import time

client = LayerinfiniteClient(api_key="layerinfinite_your_key")
try:
    scores = client.get_scores(agent_id="agent-1", issue_type="billing")
except LayerinfiniteAuthError:
    print("Invalid API key — check LAYERINFINITE_API_KEY")
except LayerinfiniteRateLimitError as e:
    print(f"Rate limited — retry after {e.retry_after}s")
    time.sleep(e.retry_after)
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `api_key` | required | Your Layerinfinite API key |
| `base_url` | `https://api.layerinfinite.app` | Primary API base URL |
| `timeout` | `10.0` | Request timeout in seconds |
| `max_retries` | `3` | Max retries on 429/5xx/timeouts/network errors |

For fallback endpoints, set a comma-separated environment variable:

`LAYERINFINITE_BASE_URLS="https://layerinfinite-api-production.up.railway.app,https://layerinfinite-api.vercel.app"`

## Production Runbook (Railway/Vercel)

Use this endpoint order in production:

1. Primary: stable custom domain (example: `https://api.layerinfinite.app`)
2. Fallback 1: Railway deployment URL
3. Fallback 2: Vercel deployment URL

Recommended client setup:

```python
import os
from layerinfinite import LayerinfiniteClient

os.environ["LAYERINFINITE_BASE_URLS"] = (
    "https://layerinfinite-api-production.up.railway.app,"
    "https://layerinfinite-api.vercel.app"
)

client = LayerinfiniteClient(
    api_key=os.environ["LAYERINFINITE_API_KEY"],
    base_url="https://api.layerinfinite.app",
    timeout=10.0,
    max_retries=3,
)
```

Production checklist:

- Keep all endpoints on the same backend version and schema.
- Point all endpoints to the same production database/project.
- Do not use preview URLs as fallbacks.
- Keep `max_retries` low (2-3) to reduce latency spikes.
- Run a failover drill weekly by temporarily blocking the primary URL and confirming fallback succeeds.

## Links

- **PyPI**: [pypi.org/project/layerinfinite-sdk](https://pypi.org/project/layerinfinite-sdk)
- **Docs**: [docs.layerinfinite.ai](https://docs.layerinfinite.ai)
- **GitHub**: [github.com/hari08varma/Outcome](https://github.com/hari08varma/Outcome)
