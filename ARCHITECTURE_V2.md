# LayerInfinite — Gateway Architecture

> **The intelligent execution layer between every AI agent and every tool it uses.**
> Routes every decision to what historically works. Automatically. Invisibly. Without touching the agent.

---

## The Problem Nobody Has Solved

Every AI agent built today has the same fundamental flaw.

It makes a wrong decision. The developer reads the logs. The developer fixes it manually. Next session — same wrong decision. Different context. Same mistake.

**Every other tool in the market watches this happen and reports it.**

```
LangSmith    → Shows what happened. Does nothing.
AgentOps     → Replays the session. Does nothing.
Langfuse     → Evaluates the decision. Does nothing.
Datadog      → Measures the latency. Does nothing.
```

These tools answer: **"What did the agent do?"**

Nobody answers: **"What should the agent do next — and why?"**

LayerInfinite answers that question. Automatically. Before the agent decides anything. Without the developer doing anything.

---

## The Three Pains LI Solves

### Pain 1 — Repeated Wrong Decisions

```
Without LI:
Agent tries action A → fails
Agent tries action A next session → fails again
Same mistake. Forever. Until developer manually intervenes.

With LI:
Action A fails → outcome logged
Next similar situation → LI routes away from A
Routes to action B which historically succeeded
No developer involved. No manual fix. No redeployment.
```

### Pain 2 — Wasted Token Spend

```
Without LI:
Agent tries wrong action → fails → tokens consumed
Retries with similar wrong action → fails → tokens consumed
Eventually gets it right on attempt 3 or 4

With LI:
Agent routes to correct action immediately
One attempt. Not three.
Token cost cut by 40-60% on complex multi-step tasks.
Direct measurable reduction in OpenAI/Anthropic bill.
```

### Pain 3 — Hallucinated Decisions

```
Without LI:
LLM has no grounding for "which action works here"
Reasons from training data alone
Makes confident wrong decisions
= Hallucination at the decision level

With LI:
Historical outcome data injected pre-reasoning
LLM reasons from evidence: "action B worked 91% of the time"
Evidence-based reasoning replaces guessing
Decision hallucinations reduce dramatically
```

---

## The Architecture

### What LI Is

LI is not middleware. Not an SDK wrapper. Not an observability tool.

**LI is the MCP gateway that sits in front of every tool an agent uses.**

```
Before LI:
Agent decides which action to take
No memory of what worked before
Same wrong decision every session

After LI:
Agent requests available tools (tools/list)
LI intercepts the tool list and dynamically enriches tool descriptions
LI injects: "This action succeeded 91% historically
             This action failed 73% of the time"
Agent reasons with that context
Agent decides — now informed by real outcomes
Action executes via the gateway
Outcome logged async in background
Next decision even better

Every action the agent considers passes through LI.
Every outcome is logged by LI.
Every future decision is informed by LI.
```

### The Config Change That Does Everything

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

Four lines. That is the entire integration.

Every tool the agent uses now flows through LI. Every decision logged. Every outcome scored. Every future decision improved. Agent code unchanged. Agent logic unchanged. 

### Works With Every Agent — Existing And New

```
Every agent — existing or new — same integration:
  Claude Code  → add MCP config
  Cursor       → add MCP config
  OpenClaw     → add MCP config
  n8n          → add MCP config
  LangGraph    → add MCP config
  LangChain    → add MCP config
  AutoGen      → add MCP config
  Custom agent → add MCP config

No difference between existing and new agents.
No SDK. No decorators. No li_log().
Four lines of JSON. Always. For everyone.
```

LI is the judgment layer. Agent is the action layer. LI improves agent behavior without rewriting agent logic. The agent still reasons. LI routes to what works.

---

## How The Gateway Works — Step By Step

Since LI is a pure gateway, it uses **Tool Discovery Enrichment** to inject intelligence before the agent makes a decision.

```
Step 1: Agent boots up and asks for tools via LI gateway
        "What tools are available?" (tools/list request)

Step 2: LI intercepts the tool list request
        Checks outcome history for the current task:
        Available tools: push_fix, rollback, notify_team
        Historical data:
          push_fix on build_failed: 84% success (n=234)
          rollback on build_failed: 71% success (n=189)

Step 3: LI dynamically enriches the tool descriptions
        Returns:
        "push_fix: [LI Context: 84% historical success on build_failed] Pushes a code fix..."

Step 4: Agent reasons with historical context
        Agent reads the enriched descriptions. Makes informed decision.
        "I need to call push_fix"

Step 5: LI executes the tool call on the real MCP server
        Tool executes. Result returned to agent immediately.

Step 6: Outcome logged async in background
        Agent does not wait. Agent is not affected.
        Logging happens invisibly after result delivered.

Step 7: Probability model updated
        Next identical situation → better routing
        Loop continues. System improves. Automatically.
```

---

## How Outcome Logging Works — And Why It Never Crashes

This is the most critical engineering decision in the architecture.

### The Problem With Naive Logging

```
Naive approach:
Agent executes action
Gateway waits for logging/LLM coaching to complete
If logging fails → agent throws exception
If database slow → agent waits
If LLM call takes 5s → agent timeouts
This is unacceptable in production.
```

### The Solution — Async Fire And Forget (Background Queues)

```
Correct approach:
Agent calls tool via LI gateway
        ↓
LI executes tool on real MCP server
Returns result to agent IMMEDIATELY (e.g., 50ms latency)
Agent continues. No waiting.
        ↓
Simultaneously — in background queue:
  LLM coaching analysis runs (if cold start)
  Outcome logged async
  Probability model updated async
  Routing scores refreshed async

Agent never waits for any of this.
Agent never knows if logging succeeded.
Agent is never blocked.
```

### The Three-Layer Failure Protection

```
Layer 1 — If async logging fails:
  Write to local disk queue
  Retry automatically in background
  Zero data loss
  Agent completely unaffected

Layer 2 — If LI API is unreachable:
  Gateway fails open
  Agent executes action directly
  Queues telemetry to local disk
  Retries when connection restored
  Agent never blocks. Never crashes.

Layer 3 — If everything fails:
  Agent executes as if LI doesn't exist
  Degrades gracefully to zero footprint
  No exception. No timeout. No crash.
  Developer notified via webhook
```

### Decision IDs and Episode Tracking

**Decision ID (Single Action Tracking):**
Every recommendation LI makes gets a unique decision ID.
```
LI enriches tool with: "recommendation: push_fix, confidence: 0.84"
Agent executes action.
Outcome captured: { "decision_id": "dec_847x9k2m", "action_taken": "push_fix", "success": true }

LI tracks Adoption Rate: Did the agent follow the advice or ignore it?
```

**Episode ID (Multi-Tool Sequence Tracking):**
Agents chain actions (read_file → analyze → push_fix). LI generates an `episode_id` for related bursts of activity within a session. This allows LI to track and score the success of an entire sequence, identifying which specific tool in the chain caused the ultimate failure.

---

## The Three-Layer Database (Single Atomic Write)

To handle massive scale and reduce overhead (reducing 18 database writes to 1), LI relies on an **Atomic Append-Only Write with Async Fan-out**.

```
New outcome arrives via background queue:
        ↓
1. SINGLE ATOMIC WRITE to Cold Layer (Append-only Log).
        ↓
2. Async Fan-Out Process handles:
   - Updating Warm Layer (Postgres)
   - Updating Hot Layer (Redis)
   - Updating Trust Scores
   - Checking for Drift Detection
```

### Hot Layer — In-Memory Cache (Sub-millisecond)

```
What lives here:
  Current routing probabilities per task/action pair
  Recent outcome scores

Infrastructure:
  Enterprise: Managed Redis cluster
  Single-Server/Zero-Cost: Node.js lru-cache or Postgres UNLOGGED tables
  Multi-Tenant Isolation: Keys strictly namespaced by Customer ID

Why:
  Agent routing decisions served from memory.
  Agent never waits for a database query.
```

### Warm Layer — PostgreSQL (Materialized Views)

```
What lives here:
  Full outcome history per agent
  Probability models per task/action pair
  Multi-tenant isolated rows (Tenant ID)

Why materialized views:
  Pre-computed — no query time at routing
  SQL-queryable — fully auditable
```

### Cold Layer — Append-Only Log

```
What lives here:
  Every outcome ever logged (The Single Atomic Write)
  Complete immutable audit trail
  Full regulatory audit trail (EU AI Act compliance)
```

---

## The Three Modes

### Recommend Mode — Passive Observation

```
LI observes.
Builds probability model invisibly.
Injects historical context via tool descriptions as suggestion only.
Agent READS the enriched tools and knows LI is advising.
Agent can follow or ignore freely.

Use when: Just integrated LI, building confidence.
```

### Assist Mode — Advisory Guidance

```
LI injects recommendations strongly via tool descriptions.
Historical context presented with strong warnings if needed.
Agent READS the warnings and makes the final decision.
LI tracks whether recommendation followed.

Use when: Trust established, agent needs guidance but not control.
```

### Auto Mode — Autonomous Routing

```
LI silently reroutes to highest-probability action at the gateway layer.
Agent NEVER KNOWS LI exists. It thinks it executed its original plan.
Three-layer fallback if primary action fails:
  1. Route to second highest-probability action
  2. Route to third highest-probability action
  3. Raise structured exception agent can handle

Use when: Recommendations proven reliable, reversible actions only.
```

---

## Graduated Trust Model

LI never activates recommendations without evidence.

```
Phase 1 — Observation (no threshold met):
  Outcomes accumulate silently. No injection.

Phase 2 — Sufficient collective data available:
  Recommend mode available for that task type. Developer enables when ready.

Phase 3 — Recommendations proven:
  Developer switches specific task types to assist.

Phase 4 — Full confidence:
  Developer enables auto mode on trusted task types.
```

---

## No Cold Start Problem (The Real-Time Loop)

How does LI coach an agent on Day 1, Minute 1, with zero historical data?

### The Two Simultaneous Learning Loops

```
Loop 1 — Within session (real-time LLM coaching):
  Minute 1: Agent acts, fails. LI observes.
  Minute 2: Background LLM analyzes failure. LI injects coaching for the next step:
            "LI Note: Your last action failed due to timeout. Try fallback."
  Agent corrects itself mid-task. Current session benefits.

Loop 2 — Across sessions (historical scoring):
  Minute 50: As data accumulates, LI gracefully retires LLM coaching.
  Switches entirely to mathematically fast statistical scoring (85% success rate).
  Future sessions benefit instantly from cache.
```

### Path A — Historical Logs Exist
Upload historical logs to the LI dashboard. The semantic engine normalizes messy logs, and the agent starts with Day 1 routing accuracy equivalent to months of learning.

### Path B — Cross-Agent Learning (3-Tier Privacy)
Agents benefit from collective intelligence, governed by strict privacy rules:
1. **Workspace Level:** Full sharing of context and raw outcomes between agents in the same customer workspace.
2. **Organization Level (Opt-in):** Different divisions can share patterns with explicit admin approval.
3. **Global Benchmark Level (K-Anonymity):** No raw data or specific agent histories are EVER shared. Only heavily anonymized statistics (minimum 50+ identical occurrences across different organizations) contribute to global routing baselines.

---

## Key Safety Features & Testing

### Testing and Staging
Developers must test LI without risking production logic.
1. **Shadow Mode (Dry Run):** LI purely observes and runs background queues. It does NOT inject scores into tool descriptions. Developers use the dashboard to see *"Agent chose A, LI would have recommended B"*, proving value with zero risk.
2. **Environment Isolation:** Agents connect with an environment tag (`env: staging`). Staging outcomes are strictly isolated and never pollute the production probability models.

### Versioning and Rollback
Probability models are fully versioned. If a new routing pattern fails, developers can instantly rollback the routing logic in the dashboard, or permanently pin specific task types to specific rules.

### Confidence Thresholds
Configured in the LI dashboard per agent per task type:
```yaml
minimum_success_rate: 0.65
fallback_behavior: defer_to_agent_reasoning
```
Below threshold → agent reasons freely. Above threshold → LI injects recommendations.

### Drift Detection
Silent drift is the most dangerous failure mode. LI monitors success rate trends (e.g., 84% drops to 31%). LI automatically pauses routing to this action, triggers a webhook to PagerDuty/Slack, and awaits developer instruction.

### Human In The Loop Mode
For high-stakes decisions, LI identifies the best action, sends an approval request to Slack/Teams, and waits for a human to approve or override.

---

## What LI Captures — Complete Picture

LI captures two layers of outcome data per action.

### Technical Layer — Immediate
Captured at execution time at the gateway:
`action_taken, task_type, context, success/failure, error_message, latency_ms`

### Business Layer — Downstream
Technical success ≠ business success (e.g., push_fix succeeds, but deployment fails 20 mins later).

**Capture Mechanism:** 
LI relies on **Webhooks and API Polling**. External systems (Datadog, CRM, GitHub Actions) POST delayed outcomes back to the LI Webhook API, linking them via the original `decision_id`.

If a technically successful action results in a delayed business failure, LI stops recommending it and routes future agents away from that action.

---

## What LI Does Not Do

Being clear about scope builds trust.

```
LI does NOT:
  Rewrite agent logic          ❌
  Modify agent code            ❌
  Block the agent              ❌
  Crash the agent              ❌
  Define what success means    ❌

LI DOES:
  Route to what historically works  ✅
  Log every outcome automatically   ✅
  Inject historical context         ✅
  Reduce wrong actions              ✅
  Cut wasted token spend            ✅
```

---

## Why Nobody Else Built This

```
OpenAI/Anthropic:
  Charge per token
  LI reduces failed attempts = fewer tokens
  = less revenue for them
  Conflict of interest. Will never build it.

LangSmith/Langfuse/AgentOps:
  Observability tools — outside the agent
  Watch decisions. Report decisions.
  Cannot become the execution layer without abandoning their architecture.

Agent platforms (Claude Code, Cursor):
  They ARE the agent
  Cannot be the layer below themselves
  A brain cannot be its own cerebellum.
```

LI works for everyone because LI belongs to no one. Platform-agnostic by design. That independence is the moat.

---

## The Dashboard

Everything LI learns is visible and controllable.

```
Overview:
  Agent health scores across all agents
  Outcome volume and velocity

Actions:
  Per-action success rate by task type
  Recommendation adoption rate

Alerts:
  Drift detection notifications
  Confidence threshold breaches

Cost Tracking:
  Token spend before vs after LI routing
  Monthly savings calculation
```

---

## The Biological Analogy

Every other tool is a doctor standing outside the room watching through a window. They see what went wrong. They write a report. They hand it to the developer. The developer fixes it. Next week — same problem.

LayerInfinite is the cerebellum.

```
The agent is the body.
The LLM is the brain — intelligence and reasoning.
Memory layers are the hippocampus — episodic history.
LayerInfinite is the cerebellum — learned behavior.

The cerebellum is not conscious.
You don't think about how to walk. You just walk. 
The cerebellum makes it correct. Automatically. Invisibly.
```

---

*LayerInfinite — Not middleware. Not an observability tool. The intelligent execution layer the agent ecosystem was missing.*
