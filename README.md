<div align="center">
  <img src="https://files.catbox.moe/hwoco4.png" width="120" height="120" alt="LayerInfinite Matrix Intersection Logo" />
  <h1>LayerInfinite</h1>
  <p><strong>Decision intelligence infrastructure for autonomous AI agents.</strong></p>
  <p>Agents learn from production outcomes. No retraining. No vector databases. No guessing.</p>

  <p>
    <a href="https://layerinfinite.app">Dashboard</a> ·
    <a href="https://pypi.org/project/layerinfinite-sdk/">PyPI</a> ·
    <a href="https://www.npmjs.com/package/@layerinfinite/sdk">npm</a> ·
    <a href="BENCHMARKS.md">Benchmarks</a> ·
    <a href="ARCHITECTURE.md">Architecture</a> ·
    <a href="CONTRIBUTING.md">Contributing</a>
  </p>
  <p>
    <a href="https://pypi.org/project/layerinfinite-sdk/"><img src="https://img.shields.io/pypi/v/layerinfinite-sdk" alt="PyPI" /></a>
    <a href="https://www.npmjs.com/package/@layerinfinite/sdk"><img src="https://img.shields.io/npm/v/@layerinfinite/sdk" alt="npm" /></a>
    <img src="https://img.shields.io/badge/latency-sub--5ms-00FF85" alt="Sub-5ms" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  </p>
</div>

---

## What is LayerInfinite?

LayerInfinite is an open-source decision layer that sits between your AI agent and your infrastructure. It intercepts every action your agent takes, records the outcome, and builds a real-time probability model of what works and what doesn't — per task type, per agent, across your entire fleet.

The next time your agent faces the same task, LayerInfinite routes it to the highest-probability action based on actual production data. Not benchmarks. Not embeddings. Real outcomes.

**The core problem it solves:** AI agents are stateless. Every session starts from zero. They retry failed actions, ignore production history, and have no mechanism to learn across deployments. LayerInfinite gives them persistent memory.

### Who is it for?

LayerInfinite is designed for engineering teams building autonomous agents that take real-world actions. It works best with:
- **DevOps & Infrastructure Agents:** Resolving CI/CD failures, applying hotfixes, auto-reverting bad deployments.
- **Customer Support Agents:** Retrying failed API requests, switching payment providers, applying account fixes.
- **Data Engineering Agents:** Healing broken pipelines, auto-resolving schema drifts, failing over to replica databases.

### Supported Frameworks

LayerInfinite is completely framework-agnostic. Because it instruments your Python or TypeScript functions directly using decorators, it works seamlessly alongside any agent framework:
- LangChain / LangGraph
- LlamaIndex
- AutoGen / AG2
- CrewAI
- Vercel AI SDK
- Custom-built agents in Plain Python / TypeScript

---

## Choose Your Starting Point

Your integration path depends on one question: **do you have existing agent logs?**

This is not a minor detail. Teams with production history get a fundamentally different — and dramatically more powerful — entry point than teams starting from scratch.

---

### Path A — You Have Existing Agent Logs

If your agent has been running in production — even if it was using LangChain, AutoGen, CrewAI, or a completely custom framework — you are not starting from zero.

```
1. Export logs from your current observability tool or database
2. Import them via the LayerInfinite Import API (one API call)
3. Open the Dashboard → Recommendations page
4. LayerInfinite has already normalized your messy logs into
   canonical task names and action names, ranked by success rate
5. Copy those exact names into your @li.action decorators
6. Deploy — your agent starts with a fully calibrated probability
   model on the very first production call
```

> [!IMPORTANT]
> **The names on the Recommendations page are canonical.** They are the keys the routing engine uses to map live SDK calls to historical outcomes. If you use different names in your decorators, you break the link — and your agent starts cold, as if it had no history at all.
>
> See the [Zero Cold-Start section](#️-the-zero-cold-start-advantage-historical-data-imports) for the full integration rule.

**What you get immediately:** The routing engine enters production already knowing which actions succeed for which task types — across your entire history. The [benchmark data](BENCHMARKS.md) shows this delivers 94% success rate from scenario #1, versus 48% for a cold-start agent learning from scratch.

---

### Path B — You Are Starting Fresh

No existing logs. This is a clean integration.

```
1. Install the SDK (pip or npm — see Quick Start below)
2. Decorate your action functions with @li.action("your_task_name")
3. Choose task names that describe the problem category your
   agent is solving, not the action itself
4. Run in Recommend mode — LayerInfinite observes outcomes
   without interfering with your agent's decisions
5. After 50–100 logged outcomes, the probability model has
   enough signal to start making useful recommendations
6. Switch to Auto mode — routing is now data-driven
```

**What you get:** A learning system that improves with every production call. The routing engine starts exploring, builds a probability model from your real outcomes, and converges to near-optimal routing by the time you have ~100 logged outcomes per task type.

---

## Quick Start

### Python

```bash
pip install layerinfinite-sdk
```

```python
from layerinfinite import Layerinfinite

# Initialize with your API key and a unique agent identifier.
# The "task" parameter in @li.action maps to the problem your agent is solving (e.g., an issue type).
# The function name becomes the "action" — the strategy being attempted.
li = Layerinfinite(
    api_key="layerinfinite_...",
    agent_id="my-agent",
    mode="auto"  # or "recommend" or "assist"
)

# Register actions for a task type.
# "task" is the category of work (e.g., "deploy_failure", "data_quality_check", "infra_scaling").
# The decorated function is the action — what the agent actually does.
@li.action("deploy_failure")
def rollback_release(deploy_id):
    return ci.rollback(deploy_id)

@li.action("deploy_failure")
def hotfix_forward(deploy_id):
    return ci.apply_hotfix(deploy_id)

@li.action("deploy_failure")
def scale_canary(deploy_id):
    return infra.scale_canary(deploy_id, replicas=1)

# That's it. When your agent calls any of these functions,
# LayerInfinite automatically logs the outcome (success/failure, latency, error type).
# No manual log_outcome() calls needed.
rollback_release("deploy-4821")
```

### TypeScript / JavaScript

```bash
npm install layerinfinite-sdk
```

```typescript
import { Layerinfinite } from 'layerinfinite-sdk';

const li = new Layerinfinite({
    apiKey: 'layerinfinite_...',
    agentId: 'my-agent',
    mode: 'auto'
});

// Register actions for a task type
const rollbackRelease = li.action('deploy_failure', 'rollback_release', async (deployId: string) => {
    return await ci.rollback(deployId);
});

const hotfixForward = li.action('deploy_failure', 'hotfix_forward', async (deployId: string) => {
    return await ci.applyHotfix(deployId);
});

// Outcomes are logged automatically on every call
await rollbackRelease('deploy-4821');
```

### How `@li.action` works

| Concept | What it means | Example |
|---------|---------------|---------|
| **Task** | The category of problem your agent is solving | `"deploy_failure"`, `"data_quality_check"`, `"payment_retry"` |
| **Action** | The specific strategy the agent uses to solve it | `rollback_release`, `hotfix_forward`, `scale_canary` |
| **Outcome** | Whether the action succeeded or failed | Captured automatically by the decorator |

You define the task and register multiple actions for it. LayerInfinite tracks which actions succeed and fail for each task, then routes future decisions to the highest-performing action.

---

## Modes

LayerInfinite operates in three modes, each giving your agent a different level of autonomy.

### `recommend` (default)
**Passive observation.** LayerInfinite watches every decorated action call, logs outcomes, and builds scoring models — but never interferes with your agent's decisions. Use this when you want to collect data before handing over control.

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="recommend")

# Your agent makes its own decisions. LayerInfinite just watches and learns.
scores = li.scores("deploy_failure")        # Get ranked actions by success probability
rec = li.recommend("deploy_failure")        # Get a single recommendation with reasoning
```

### `assist`
**Advisory mode.** LayerInfinite provides explicit suggestions via `li.suggest()`, but your agent decides whether to follow them. The suggestion includes the recommended action, its confidence score, and a plain-language explanation.

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="assist")

suggestion = li.suggest("deploy_failure")
# suggestion.action_name  → "rollback_release"
# suggestion.confidence   → 0.87
# suggestion.reason       → "rollback_release has 87% success rate across 142 outcomes."
```

### `auto`
**Fully autonomous.** LayerInfinite picks the highest-probability action and executes it directly. If the action fails and `auto_fallback=True`, it automatically tries the next best action in the ranked list.

```python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="auto")

# LayerInfinite picks the best action, executes it, and handles fallbacks.
result = li.run("deploy_failure", deploy_id="deploy-4821")
```

---


## ⚡️ The Zero Cold-Start Advantage: Historical Data Imports

Most decision systems require weeks of live traffic to build confidence. **LayerInfinite bypasses the cold-start problem entirely.**

If you have existing logs of agent successes and failures — whether from custom databases, raw server logs, or other observability platforms — you can bulk-load them into LayerInfinite via the Import API. 

> [!IMPORTANT]
> **The Golden Rule of Integration: Semantic Consistency** 
> 
> When you import raw historical logs from LangChain, AutoGen, or any custom framework, LayerInfinite's semantic engine cleans the messy data and generates **canonical Task and Action names** on your Dashboard. 
> 
> To achieve the "Zero Cold-Start" advantage, your SDK integration **must perfectly mirror** those dashboard names.
>
> **The 3-Step Integration Rule:**
> 1. **Check the Dashboard:** Open the Recommendations page and identify the canonical task (e.g., `"stripe_refund_issue"`) and action (e.g., `"process_full_refund"`).
> 2. **Map the Task:** Use that exact string in your decorator: `@li.action("stripe_refund_issue")`.
> 3. **Map the Action:** Ensure your underlying function name matches the action string: `def process_full_refund(...):`.
> 
> **Why this matters:** If you invent new names in your code instead of using the dashboard's canonical names, the SDK will treat them as brand-new tools with zero history—completely destroying your historical data advantage!

---

## Why LayerInfinite? — Competitive Analysis

LayerInfinite is **not** an observability tool. It is a **decision layer**. Here's how it compares to existing solutions:

| Capability | LayerInfinite | Langfuse | AgentOps | Braintrust | Manual RL |
|------------|:------------:|:--------:|:--------:|:----------:|:---------:|
| **Outcome-based action routing** | ✅ | ❌ | ❌ | ❌ | ⚠️ Complex |
| **Auto-fallback on failure** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Cross-session learning** | ✅ | ❌ | ❌ | ❌ | ⚠️ Retraining |
| **Decision latency** | Sub-5ms | N/A | N/A | N/A | Variable |
| **Decorator-based auto-instrumentation** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Trace & log visualization** | ✅ Dashboard | ✅ | ✅ | ✅ | ❌ |
| **Compliance audit trail (SQL)** | ✅ Append-only | ✅ | ❌ | ❌ | ❌ |
| **Cold-start prior injection** | ✅ Day 1 | ❌ | ❌ | ❌ | ❌ |
| **Agent trust scoring & auto-suspend** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **No LLM dependency for decisions** | ✅ Deterministic SQL | N/A | N/A | N/A | ❌ |

### The moat

**Observability tools** (Langfuse, AgentOps, Braintrust) answer *"what happened?"* — they log traces, show you dashboards, and let you replay sessions.

**LayerInfinite** answers *"what should the agent do next?"* — it takes the outcome data, computes action-level success probabilities in real-time, and actively routes your agent's next decision. 

This is the difference between a dashcam and an autopilot.

### 🔒 Zero-LLM Architecture & Absolute Data Privacy

Unlike other observability and evaluation tools that rely on "LLM-as-a-judge" to score outcomes, **LayerInfinite does not use external LLMs to make routing decisions.**

- **100% Deterministic SQL:** Decisions are calculated using mathematical probabilities in PostgreSQL materialized views. There are no black-box hallucinations.
- **Strict Data Privacy:** Because we don't use LLMs to evaluate your logs, **your production data is never sent to OpenAI, Anthropic, or any third-party API.**
- **Automatic PII Scrubbing:** The SDK strips sensitive parameters before they ever leave your infrastructure. 

Your data stays in your database, and the math stays transparent.

---

## Dashboard

LayerInfinite ships with a production dashboard at [layerinfinite.app](https://layerinfinite.app):

- **Overview** — Agent health scores, outcome volume, success rate trends
- **Actions** — Per-action success rates, sample counts, confidence scores
- **Alerts** — Degradation detection, trust score drops
- **Discrepancies** — Cross-event conflicts, expired signals, ingestion inconsistencies
- **Recommendations** — Data-driven action replacement suggestions with reasoning

---

## Architecture

LayerInfinite is built on PostgreSQL materialized views, not vector databases. Decisions are deterministic and SQL-queryable. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full deep dive.

**Key design decisions:**
- **Append-only storage** — No outcome is ever deleted or overwritten. Required for EU AI Act compliance.
- **Deterministic scoring** — `success_count / total_count * recency_weight`. No black-box model weights.
- **PII scrubbing** — The SDK automatically strips sensitive parameters (emails, tokens, API keys) before logging.
- **Durable queue** — Failed outcome submissions are persisted to disk and retried automatically.

---

## Contributing

We welcome contributions to the open-source SDKs. See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- SDK development setup (Python & TypeScript)
- Testing guidelines
- PR process

## License

MIT. See [LICENSE](LICENSE.md).
