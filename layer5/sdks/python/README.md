# Layer5 Python SDK

Layer5 is a decision intelligence middleware for AI agents — it records action outcomes, computes composite trust scores, and recommends the highest-performing next action so your agents learn from every decision. Drop it between any LLM agent and your production infrastructure in minutes.

## Installation

```bash
pip install layer5-sdk
```

## Quick Start

```python
from layer5 import Layer5Client, LogOutcomeRequest

client = Layer5Client(api_key="layer5_your_key")

# Ask Layer5 which action to take
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
with Layer5Client(api_key="layer5_your_key") as client:
    scores = client.get_scores(agent_id="agent-1", issue_type="payment_failed")
    # Session is automatically closed on exit
```

## LangChain Integration

```python
from layer5 import Layer5Client, LogOutcomeRequest
from langchain_core.tools import tool

l5 = Layer5Client(api_key="layer5_your_key")

@tool
def resolve_ticket(agent_id: str, issue_type: str) -> str:
    """Resolve a support ticket using Layer5-guided action."""
    scores = l5.get_scores(agent_id=agent_id, issue_type=issue_type)
    action = scores.top_action.action_name
    # ... run the action ...
    l5.log_outcome(LogOutcomeRequest(
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
from layer5 import Layer5Client, Layer5AuthError, Layer5RateLimitError
import time

client = Layer5Client(api_key="layer5_your_key")
try:
    scores = client.get_scores(agent_id="agent-1", issue_type="billing")
except Layer5AuthError:
    print("Invalid API key — check LAYER5_API_KEY")
except Layer5RateLimitError as e:
    print(f"Rate limited — retry after {e.retry_after}s")
    time.sleep(e.retry_after)
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `api_key` | required | Your Layer5 API key |
| `base_url` | `https://your-app.railway.app` | API base URL |
| `timeout` | `10.0` | Request timeout in seconds |
| `max_retries` | `3` | Max retries on 429/5xx |

## Links

- **PyPI**: [pypi.org/project/layer5-sdk](https://pypi.org/project/layer5-sdk)
- **Docs**: [docs.layer5.ai](https://docs.layer5.ai)
- **GitHub**: [github.com/hari08varma/Outcome](https://github.com/hari08varma/Outcome)
