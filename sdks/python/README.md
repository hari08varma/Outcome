# Layer5 Python SDK

Outcome-ranked decision intelligence for AI agents.

## Install

```bash
pip install layer5
```

With framework integrations:
```bash
pip install layer5[langchain]
pip install layer5[crewai]
pip install layer5[autogen]
pip install layer5[all]      # everything
```

## Quick Start

```python
from layer5 import Layer5

l5 = Layer5(api_key="layer5_your_key_here")

# Get ranked actions before your agent acts
scores = l5.get_scores(
    agent_id="my-agent",
    context={"issue_type": "payment_failed"}
)
best_action = scores.ranked_actions[0].action_name

# Log what happened after
l5.log_outcome(
    agent_id="my-agent",
    action_name=best_action,
    session_id="sess-123",
    issue_type="payment_failed",
    success=True,
    response_time_ms=241,
)
```

## Async Support

```python
from layer5 import AsyncLayer5

async with AsyncLayer5(api_key="layer5_...") as l5:
    scores = await l5.get_scores(
        agent_id="my-agent",
        context={"issue_type": "payment_failed"}
    )
```

## LangChain Integration

```python
from layer5.integrations.langchain import Layer5Callback

callback = Layer5Callback(
    api_key="layer5_...",
    agent_id="my-langchain-agent"
)

agent = AgentExecutor(
    agent=agent,
    tools=tools,
    callbacks=[callback]
)
# Layer5 now scores every tool call automatically.
```

## CrewAI Integration

```python
from layer5.integrations.crewai import layer5_tool

tracked_tool = layer5_tool(
    tool=my_tool,
    api_key="layer5_...",
    agent_id="my-crew-agent"
)
```

## Decorator Integration

```python
from layer5 import Layer5
from layer5.integrations.decorator import track

l5 = Layer5(api_key="layer5_...")

@track(client=l5, agent_id="my-agent", issue_type="refund")
def process_refund(amount: float) -> bool:
    return True
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LAYER5_API_KEY` | API key (overrides parameter) |
| `LAYER5_BASE_URL` | Base URL (for self-hosted) |

## Error Handling

Every error has a specific exception with actionable messages:

```python
from layer5 import (
    Layer5AuthError,         # bad/missing API key
    Layer5RateLimitError,    # rate limit exceeded
    Layer5ValidationError,   # invalid request data
    Layer5NetworkError,      # connection failed
    Layer5TimeoutError,      # request timed out
    Layer5ServerError,       # 5xx server error
    Layer5UnknownActionError,# action not registered
    Layer5AgentSuspendedError,# agent suspended
)
```

## License

MIT
