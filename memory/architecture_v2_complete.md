---
name: architecture-v2-complete
description: "Complete ARCHITECTURE_V2 specification — gateway architecture, tool discovery enrichment, 3-layer outcome model, 3 modes, DB architecture, cold start loops, privacy model, safety features, biological analogy. The definitive implementation reference."
metadata: 
  node_type: memory
  type: project
  originSessionId: bad08b6b-9006-4a4b-acea-88f62b909625
---

# LayerInfinite — ARCHITECTURE_V2 (Complete)

## What LayerInfinite Is (V2)

LI is NOT middleware, NOT an SDK wrapper, NOT an observability tool.

**LI is the MCP gateway that sits in front of every tool an agent uses.**

The agent configures LI as its MCP server. LI proxies to the agent's real tools. LI intercepts `tools/list` and `tools/call` invisibly. LI enriches tool descriptions with historical outcome data. The agent decides informed by evidence. LI logs every outcome. LI improves every future decision. Agent code unchanged. Agent logic unchanged.

**Positioning**: The intelligent execution layer between every AI agent and every tool it uses. Routes every decision to what historically works. Automatically. Invisibly. Without touching the agent.

## The Three Pains LI Solves

1. **Repeated Wrong Decisions** — Agent tries action A, fails. Next session, same wrong decision. LI routes away from historically-failed actions automatically.
2. **Wasted Token Spend** — Wrong actions cost tokens on retries. LI routes to correct action first attempt. 40-60% token cost reduction.
3. **Hallucinated Decisions** — LLM has no grounding. LI injects historical evidence ("action B worked 91%"). Evidence-based reasoning replaces guessing.

## Integration — 4 Lines of JSON

```json
{
  "mcpServers": {
    "layerinfinite": {
      "url": "https://gateway.layerinfinite.app",
      "apiKey": "li_...",
      "tools": [
        {"name": "github", "url": "https://github.mcp"},
        {"name": "database", "url": "https://db.mcp"},
        {"name": "email", "url": "https://email.mcp"}
      ]
    }
  }
}
```

Works with: Claude Code, Cursor, OpenClaw, n8n, LangGraph, LangChain, AutoGen, custom agents. No SDK. No decorators. No li_log(). No system prompt changes (for Auto mode).

## The Gateway — How It Works (7 Steps)

1. Agent boots up, requests tools via LI gateway (`tools/list`)
2. LI forwards to real MCP servers, fetches actual tool lists
3. LI queries outcome history for current task. Available tools get enrichment
4. LI returns enriched tool list — natural language historical scores woven into descriptions
5. Agent reads enriched descriptions, reasons with historical context, decides
6. Agent calls chosen tool via LI gateway. LI optionally reroutes (Auto mode). Executes on real MCP server
7. Result returned to agent immediately. Outcome logged async in background

### The Key Architectural Insight

LI intercepts `tools/list` — which happens BEFORE the agent reasons about which tool to use. By enriching descriptions at discovery time, LI doesn't need to "intercept the decision" because the decision hasn't happened yet. This is architecturally sound in the MCP protocol.

## Tool Discovery Enrichment — The Format

### Natural Language Integration (Rock-Solid Design)

Metadata is NOT prepended as bracketed fields. Scores are woven into tool descriptions as natural language:

**Recommend Mode (informational):**
```
Pushes a code fix to the repository. Historically, this tool has resolved build_failed issues successfully 84% of the time (234 recorded outcomes).
```

**Assist Mode (directional):**
```
Pushes a code fix to the repository. This is the recommended tool for build_failed — it has succeeded 84% of the time. Use this unless you have a specific reason to choose otherwise.
```

**Assist Mode (warning — failing action):**
```
Rolls back the last deployment. WARNING: This tool has FAILED on build_failed 73% of the time (189 recorded outcomes). Strongly consider push_fix instead.
```

### Virtual `li_recommend` Tool — Explicit Safety Net

LI also adds one virtual tool to every tool list:
- Name: `li_recommend`
- Takes: `task` parameter
- Returns: ranked recommendation with scores and sample sizes
- Purpose: if agent ignores enriched descriptions, it can still explicitly ask LI

### Why Natural Language Instead of Structured Metadata

- No parsing required — reads like any other sentence
- Works if model ignores formatting
- Works if description is truncated (context is distributed)
- Works with non-English models (translates naturally)
- Works with small/weak models (natural language is their strength)
- Dual channel: enriched descriptions + li_recommend tool — no single point of failure

## The Three Modes

### Recommend Mode — Passive Observation
- LI enriches tool descriptions with historical context as SUGGESTIONS
- Agent READS enrichment and knows LI is advising
- Agent can follow or ignore freely
- Use when: just integrated LI, building confidence

### Assist Mode — Advisory Guidance
- LI enriches descriptions with STRONG recommendations
- Warnings for historically-failed actions
- Agent READS warnings and makes final decision
- LI tracks whether recommendation was followed (adoption rate)
- Use when: trust established, agent needs guidance but not control

### Auto Mode — Autonomous Routing
- LI silently reroutes to highest-probability tool at gateway layer
- Agent NEVER KNOWS LI exists — thinks it executed original plan
- 3-layer fallback: 2nd best → 3rd best → structured exception
- Only on reversible actions, only when recommendations proven reliable
- Use when: full confidence in routing for specific task types

## Graduated Trust Model

```
Phase 1 — Observation: Outcomes accumulate silently. No injection. Pure data accumulation.
Phase 2 — Recommend available: Sufficient data exists. Developer enables Recommend per task type.
Phase 3 — Assist available: Recommendations proven reliable. Developer switches specific tasks to Assist.
Phase 4 — Auto available: Full confidence. Developer enables Auto on trusted task types.
```

Per-task-type granularity. Different tasks can be in different modes simultaneously.

## The Three-Layer Database (Single Atomic Write)

```
New outcome arrives via background queue:
  ↓
1. SINGLE ATOMIC WRITE to Cold Layer (Append-only Log)
  ↓
2. Async Fan-Out Process handles:
   - Updating Warm Layer (Postgres materialized views)
   - Updating Hot Layer (Redis/memory cache)
   - Updating Trust Scores
   - Drift Detection
   - Counterfactual IPS scoring
   - Reward backpropagation
   - Sequence tracking
   - Cache invalidation
```

### Hot Layer — In-Memory Cache (Sub-millisecond)
- Current routing probabilities per (task, action) pair
- Recent outcome scores
- Infrastructure: Redis cluster (enterprise) or Node.js lru-cache / Postgres UNLOGGED tables (single-server)
- Keys strictly namespaced by Customer ID
- Agent routing decisions served from memory — no DB query

### Warm Layer — PostgreSQL (Materialized Views)
- Full outcome history per agent
- Probability models per (task, action) pair
- Multi-tenant isolated rows (Tenant ID)
- Pre-computed materialized views — no query time at routing
- SQL-queryable — fully auditable

### Cold Layer — Append-Only Log
- Every outcome ever logged (the single atomic write target)
- Complete immutable audit trail
- Full regulatory audit trail (EU AI Act compliance)
- INSERT-only permissions
- Source of truth for model recomputation

## The Three-Layer Outcome Model

### Layer 1 — Technical (Immediate, Gateway-Captured)
- Captured at execution time at the gateway
- Data: `action_taken, task_type, context, success/failure, error_message, latency_ms`
- Success inferred from HTTP status codes and MCP response structure
- Confidence: medium (inferred, not explicit)
- Logged immediately with `decision_id`

### Layer 2 — Session (Minutes to Hours, Webhook Callback)
- External systems POST delayed outcomes back to LI Webhook API
- Linked via original `decision_id`
- Payload: `{"decision_id": "dec_123", "business_success": false, "reason": "memory_leak"}`
- Confidence: high (explicit signal from known external system)
- SCORE OVERWRITTEN

### Layer 3 — Business (Days to Months, Webhook Callback)
- Same webhook mechanism, longer delay
- Examples: revenue impact, customer churn, uptime SLA
- Confidence: highest
- SCORE OVERWRITTEN AGAIN

### The Score Overwrite Principle
Later layers OVERWRITE earlier layers. Layer 1 is a placeholder. Layer 2 is the correction. Layer 3 is the ground truth. The cold append-only log preserves the full timeline. The model can be recomputed from any point.

### The Decision ID Anchor
Every recommendation LI makes gets a unique `decision_id`. The ID is:
- Generated by LI at gateway edge before proxying
- Logged with the Layer 1 outcome
- Injected into the tool payload (if the tool supports metadata)
- Used by external systems to link callbacks
- Enables: adoption tracking, outcome correction, audit trail

## The Two Simultaneous Learning Loops

### Loop 1 — Within Session (Real-Time LLM Coaching)
- Minute 1: Agent acts, fails. LI observes.
- Minute 2: Background LLM (gpt-4o-mini) analyzes failure. LI injects coaching into next tool description: "LI Note: Your last action failed due to timeout. Try fallback."
- Agent corrects itself mid-task. Current session benefits.
- Coaching only fires on FAILURES (not every action), reducing call volume ~70%
- Capped at 3 coaching injections per session
- Retires automatically as historical data accumulates

### Loop 2 — Across Sessions (Historical Scoring)
- As data accumulates, LI gracefully retires LLM coaching
- Switches entirely to mathematically fast statistical scoring
- Future sessions benefit instantly from cache
- 6-factor composite scoring, 11-branch policy tree, 3-tier simulation

## Cold Start Solutions

### Path A — Historical Logs Exist
Upload historical logs to LI dashboard. Semantic engine normalizes messy logs. Agent starts with Day 1 routing accuracy equivalent to months of learning.

### Path B — Cross-Agent Learning (3-Tier Privacy)
1. **Workspace Level**: Full sharing of context and raw outcomes between agents in same customer workspace
2. **Organization Level (Opt-in)**: Different divisions can share patterns with explicit admin approval
3. **Global Benchmark Level (K-Anonymity)**: No raw data or specific agent histories EVER shared. Only heavily anonymized statistics (minimum 50+ identical occurrences across different organizations) contribute to global routing baselines.

## Key Safety Features

### Shadow Mode (Dry Run)
- LI purely observes and runs background queues
- Does NOT inject scores into tool descriptions
- Dashboard shows "Agent chose A, LI would have recommended B"
- Proves value with zero risk before enabling enrichment

### Environment Isolation
- Agents connect with `env: staging` or `env: production` tag
- Staging outcomes strictly isolated — never pollute production probability models
- Purge-staging-data control in dashboard

### Versioning and Rollback
- Probability models fully versioned
- Developer can instantly rollback routing logic in dashboard
- Can permanently pin specific task types to specific rules
- Model History page with version diff, rollback button, pin-to-version control

### Drift Detection
- LI monitors success rate trends
- Sudden drops (e.g., 84% → 31%) trigger automatic pause
- Webhook to PagerDuty/Slack
- Awaits developer instruction before re-enabling

### Human-In-The-Loop
- For high-stakes decisions, LI identifies best action
- Sends approval request to Slack/Teams
- Waits for human to approve or override
- Full audit log per decision

### Confidence Thresholds
- Configured per agent per task type in dashboard
- `minimum_success_rate: 0.65`
- `fallback_behavior: defer_to_agent_reasoning`
- Below threshold → agent reasons freely. Above → LI injects recommendations

## What LI Does Not Do

- Rewrite agent logic ❌
- Modify agent code ❌
- Block the agent ❌
- Crash the agent ❌
- Define what success means ❌

## What LI DOES

- Route to what historically works ✅
- Log every outcome automatically ✅
- Inject historical context ✅
- Reduce wrong actions ✅
- Cut wasted token spend ✅

## Three-Layer Failure Protection

- **Layer 1**: If async logging fails → write to local disk queue → retry automatically → zero data loss → agent unaffected
- **Layer 2**: If LI API unreachable → gateway fails open → agent executes directly → queues telemetry → retries when connection restored → agent never blocks
- **Layer 3**: If everything fails → agent executes as if LI doesn't exist → degrades gracefully → no exception, no timeout, no crash → developer notified via webhook

## The Biological Analogy

- Agent = the body
- LLM = the brain (intelligence and reasoning)
- Memory layers = the hippocampus (episodic history)
- LayerInfinite = the cerebellum (learned behavior)

The cerebellum is not conscious. You don't think about how to walk. You just walk. The cerebellum makes it correct. Automatically. Invisibly.

## Dashboard Overview

- Overview: agent health scores, outcome volume and velocity
- Actions: per-action success rate by task type, recommendation adoption rate
- Alerts: drift detection notifications, confidence threshold breaches
- Cost Tracking: token spend before vs after LI routing, monthly savings
- Model History: version diff, rollback, pin-to-version
- Mode Management: per-task-type mode selector, confidence threshold slider
- Webhook Configuration: endpoint URLs, secrets, event type mapping, delivery log
- Human-in-Loop: approval queue, approve/override buttons, audit log
- Environment: environment tag management, staging/production separation

## Why Nobody Else Built This

- OpenAI/Anthropic: charge per token. LI reduces failed attempts = fewer tokens = less revenue. Conflict of interest.
- LangSmith/Langfuse/AgentOps: observability tools outside the agent. Watch. Report. Cannot become execution layer.
- Agent platforms (Claude Code, Cursor): they ARE the agent. Cannot be the layer below themselves.

LI works for everyone because LI belongs to no one. Platform-agnostic by design.
