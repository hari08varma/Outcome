# Layerinfinite Python SDK

Decision intelligence middleware for AI agents. Records action outcomes, learns which actions work best per task, and recommends the highest-performing action — with zero LLM dependency.

Drop it into any agent in minutes. It learns silently in the background and gets smarter with every run.

## Installation

```bash
pip install layerinfinite-sdk
```

Get your API key at [layerinfinite.ai](https://layerinfinite.ai).

## Quick Start

```python
from layerinfinite import Layerinfinite

li = Layerinfinite(api_key="layerinfinite_xxx", agent_id="my-agent")

@li.action("payment_failed")
def retry_payment(ticket_id):
    return gateway.charge(ticket_id)

@li.action("payment_failed")
def switch_provider(ticket_id):
    return alt_gateway.charge(ticket_id)

# That's it. Every call is logged automatically.
retry_payment("t-001")
```

LI records success/failure and latency on every call. After ~50 outcomes it starts recommending the best action per task.

## Modes

### recommend (default) — observe and learn

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="recommend")

# Your agent runs normally. LI logs every outcome silently.
# After enough data, ask for a recommendation:
rec = li.recommend("payment_failed")
print(rec.recommendation)   # "switch_provider has 82% success vs 51% for retry_payment"
print(rec.state)            # "active_recommendation"
```

### assist — LI suggests, you decide

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="assist")

suggestion = li.suggest("payment_failed")
print(suggestion.action_name)   # "switch_provider"
print(suggestion.confidence)    # 0.87
print(suggestion.outcomes_needed)  # 0 — fully active

# You still decide what to execute.
```

### auto — LI picks and executes

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="auto")

# One line. LI picks the best action, runs it, logs the outcome.
result = li.run("payment_failed")
```

## All Methods

| Method | Modes | Description |
|--------|-------|-------------|
| `@li.action(task, name=None)` | all | Decorator — auto-logs every call's outcome |
| `li.run(task)` | auto | Pick, execute, log — fully autonomous |
| `li.suggest(task)` | assist | Best action suggestion without executing |
| `li.recommend(task)` | all | Plain-English recommendation from outcome data |
| `li.scores(task)` | all | Raw ranked action scores |
| `li.observe(task)` | all | Quick outcome stats (total runs, success rate, best/worst) |
| `li.log_outcome(request)` | all | Manual outcome logging for power users |
| `li.list_actions(task)` | all | List registered actions |
| `Layerinfinite.normalize_task(value)` | — | `"Payment Failed"` → `"payment_failed"` |
| `Layerinfinite.normalize_business_outcome(value)` | — | `"ok"` → `"resolved"`, `"error"` → `"failed"` |

## Constructor Parameters

```python
Layerinfinite(
    api_key="layerinfinite_xxx",     # required — from layerinfinite.ai
    agent_id="my-agent",             # required — identifies your agent
    mode="recommend",                # recommend | assist | auto
    confidence_threshold=0.7,        # minimum confidence before LI acts
    auto_fallback=True,              # fall back to next action on failure (auto mode)
    min_observations_per_action=0,   # exploration floor — try each action N times first
    base_url="https://api.layerinfinite.app",
    timeout=10.0,
    max_retries=3,
    log_async=True,                  # non-blocking outcome logging (default)
)
```

### Exploration Floor

If your LLM fallback always picks the same action, LI never sees the others. Set `min_observations_per_action` to force exploration:

```python
li = Layerinfinite(
    api_key="...",
    agent_id="my-agent",
    mode="auto",
    min_observations_per_action=20,  # try every action at least 20 times
)
```

## Manual Outcome Logging

For cases where you can't use the decorator:

```python
from layerinfinite import Layerinfinite, LogOutcomeRequest

li = Layerinfinite(api_key="...", agent_id="my-agent")

li.log_outcome(LogOutcomeRequest(
    agent_id="my-agent",
    action_name="switch_provider",
    issue_type="payment_failed",
    success=True,
    # optional: if omitted, LI infers score from success/failure + soft signals
    outcome_score=0.82,
    business_outcome=li.normalize_business_outcome("ok"),  # -> "resolved"
))
```

## Error Handling

```python
from layerinfinite import Layerinfinite, LowConfidenceError
from layerinfinite.exceptions import LayerinfiniteAuthError, LayerinfiniteRateLimitError

li = Layerinfinite(api_key="...", agent_id="my-agent", mode="auto")

try:
    result = li.run("payment_failed")
except LowConfidenceError as e:
    # LI doesn't have enough confidence yet — handle manually
    print(e.confidence)         # 0.38
    print(e.threshold)          # 0.70
    print(e.suggestion.action_name)       # best candidate so far
    print(e.suggestion.outcomes_needed)   # how many more outcomes to log
except LayerinfiniteAuthError:
    print("Invalid API key")
except LayerinfiniteRateLimitError as e:
    print(f"Rate limited — retry after {e.retry_after}s")
```

## Pending Outcomes Queue

If a network error occurs during `_log_outcome`, the SDK queues the outcome locally and replays it automatically on the next call. Queue location:

```
~/.layerinfinite/pending_outcomes.jsonl
```

Override with env var: `LAYERINFINITE_PENDING_OUTCOMES_FILE`

## Fallback Endpoints

```bash
export LAYERINFINITE_BASE_URLS="https://fallback1.example.com,https://fallback2.example.com"
```

## Context Manager

```python
with Layerinfinite(api_key="...", agent_id="my-agent") as li:
    result = li.run("payment_failed")
# HTTP connections closed automatically
```

## Links

- **PyPI**: [pypi.org/project/layerinfinite-sdk](https://pypi.org/project/layerinfinite-sdk)
- **Docs**: [docs.layerinfinite.ai](https://docs.layerinfinite.ai)
- **GitHub**: [github.com/hari08varma/Outcome](https://github.com/hari08varma/Outcome)
- **API keys**: [layerinfinite.ai/settings/api-keys](https://layerinfinite.ai/settings/api-keys)
