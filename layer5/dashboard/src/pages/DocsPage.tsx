import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

const README_MD = `
## What is LayerInfinite?

LayerInfinite is an open-source decision layer that sits between your AI agent and your infrastructure. It intercepts every action your agent takes, records the outcome, and builds a real-time probability model of what works and what doesn't — per task type, per agent, across your entire fleet.

The next time your agent faces the same task, LayerInfinite routes it to the highest-probability action based on actual production data. Not benchmarks. Not embeddings. Real outcomes.

**The core problem it solves:** AI agents are stateless. Every session starts from zero. They retry failed actions, ignore production history, and have no mechanism to learn across deployments. LayerInfinite gives them persistent memory.

### Who is it for?

- **DevOps & Infrastructure Agents:** Resolving CI/CD failures, applying hotfixes, auto-reverting bad deployments.
- **Customer Support Agents:** Retrying failed API requests, switching payment providers, applying account fixes.
- **Data Engineering Agents:** Healing broken pipelines, auto-resolving schema drifts, failing over to replica databases.

### Supported Frameworks

LayerInfinite is completely framework-agnostic:
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

### Path A — You Have Existing Agent Logs

If your agent has been running in production — even if it was using LangChain, AutoGen, CrewAI, or a completely custom framework — you are not starting from zero.

\\\`\\\`\\\`
1. Export logs from your current observability tool or database
2. Import them directly from the Dashboard — upload your log file 
   and LayerInfinite normalizes them automatically.
3. Open the Dashboard → Recommendations page
4. Identify the canonical task names and action names, now ranked 
   by success rate
5. Copy those exact names into your SDK integration
6. Deploy — your agent starts with a fully calibrated probability
   model on the very first production call
\\\`\\\`\\\`

> 🚨 **CRITICAL: The Golden Rule of Integration**
> 
> **The names on the Recommendations page are canonical.** They are the keys the routing engine uses to map live SDK calls to historical outcomes. If you use different names in your code, you break the link — and your agent starts cold, as if it had no history at all.

**What you get immediately:** The routing engine enters production already knowing which actions succeed for which task types — across your entire history. Benchmark data shows this delivers 94% success rate from scenario #1, versus 48% for a cold-start agent learning from scratch.

### Path B — You Are Starting Fresh

No existing logs. This is a clean integration.

\\\`\\\`\\\`
1. Install the SDK (pip or npm — see Quick Start below)
2. Decorate your action functions with @li.action("your_task_name")
3. Choose task names that describe the problem category your
   agent is solving, not the action itself
4. Run in Recommend mode — LayerInfinite observes outcomes
   without interfering with your agent's decisions
5. After 50–100 logged outcomes, the probability model has
   enough signal to start making useful recommendations
6. Switch to Auto mode — routing is now data-driven
\\\`\\\`\\\`

**What you get:** A learning system that improves with every production call. The routing engine starts exploring, builds a probability model from your real outcomes, and converges to near-optimal routing by the time you have ~100 logged outcomes per task type.

---

## Quick Start

### Python

\\\`\\\`\\\`bash
pip install layerinfinite-sdk
\\\`\\\`\\\`

\\\`\\\`\\\`python
from layerinfinite import Layerinfinite

li = Layerinfinite(
    api_key="layerinfinite_...",
    agent_id="my-agent",
    mode="auto"
)

@li.action("deploy_failure")
def rollback_release(deploy_id):
    return ci.rollback(deploy_id)

@li.action("deploy_failure")
def hotfix_forward(deploy_id):
    return ci.apply_hotfix(deploy_id)

@li.action("deploy_failure")
def scale_canary(deploy_id):
    return infra.scale_canary(deploy_id, replicas=1)

# Outcomes are logged automatically.
rollback_release("deploy-4821")
\\\`\\\`\\\`

### TypeScript / JavaScript

\\\`\\\`\\\`bash
npm install layerinfinite-sdk
\\\`\\\`\\\`

\\\`\\\`\\\`typescript
import { Layerinfinite } from 'layerinfinite-sdk';

const li = new Layerinfinite({
    apiKey: 'layerinfinite_...',
    agentId: 'my-agent',
    mode: 'auto'
});

const rollbackRelease = li.action('deploy_failure', 'rollback_release', async (deployId: string) => {
    return await ci.rollback(deployId);
});

const hotfixForward = li.action('deploy_failure', 'hotfix_forward', async (deployId: string) => {
    return await ci.applyHotfix(deployId);
});

await rollbackRelease('deploy-4821');
\\\`\\\`\\\`

> **Why the wrapper instead of a decorator?**
> Python has native support for function decorators. TypeScript's decorator support is largely restricted to classes. To provide maximum type safety for standard \\\`async\\\` functions, the TS SDK uses the \\\`li.action()\\\` wrapper pattern. They accomplish the exact same outcome logging and routing.

### How \\\`@li.action\\\` works

| Concept | What it means | Example |
|---------|---------------|---------|
| **Task** | The category of problem your agent is solving | \\\`"deploy_failure"\\\`, \\\`"data_quality_check"\\\`, \\\`"payment_retry"\\\` |
| **Action** | The specific strategy the agent uses to solve it | \\\`rollback_release\\\`, \\\`hotfix_forward\\\`, \\\`scale_canary\\\` |
| **Outcome** | Whether the action succeeded or failed | Captured automatically by the decorator |

You define the task and register multiple actions for it. LayerInfinite tracks which actions succeed and fail for each task, then routes future decisions to the highest-performing action.

---

## Modes

LayerInfinite operates in three modes, each giving your agent a different level of autonomy.

### \\\`recommend\\\` (default)
**Passive observation.** LayerInfinite watches every decorated action call, logs outcomes, and builds scoring models — but never interferes with your agent's decisions.

\\\`\\\`\\\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="recommend")

scores = li.scores("deploy_failure")        # Ranked actions by success probability
rec = li.recommend("deploy_failure")        # Single recommendation with reasoning
\\\`\\\`\\\`

### \\\`assist\\\`
**Advisory mode.** LayerInfinite provides suggestions via \\\`li.suggest()\\\`, but your agent decides whether to follow them.

\\\`\\\`\\\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="assist")

suggestion = li.suggest("deploy_failure")
# suggestion.action_name  → "rollback_release"
# suggestion.confidence   → 0.87
# suggestion.reason       → "rollback_release has 87% success rate across 142 outcomes."
\\\`\\\`\\\`

### \\\`auto\\\`
**Fully autonomous.** LayerInfinite picks the highest-probability action and executes it directly. If the action fails and \\\`auto_fallback=True\\\`, it tries the next best action.

> **If the LayerInfinite API is unreachable**, the SDK fails open — it executes the first registered action for the task and queues all telemetry locally for background retry, so your agent never blocks on our infrastructure.

\\\`\\\`\\\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="auto")

result = li.run("deploy_failure", deploy_id="deploy-4821")
\\\`\\\`\\\`

---

## The Zero Cold-Start Advantage

Most decision systems require weeks of live traffic to build confidence. **LayerInfinite bypasses the cold-start problem entirely.**

If you have existing logs of agent successes and failures — whether from custom databases, raw server logs, or other observability platforms — you can bulk-load them into LayerInfinite via the Dashboard upload. 

> 🚨 **CRITICAL: The Golden Rule of Integration** 
> 
> When you import raw historical logs from LangChain, AutoGen, or any custom framework, LayerInfinite's semantic engine cleans the messy data and generates **canonical Task and Action names** on your Dashboard. 
> 
> To achieve the "Zero Cold-Start" advantage, your SDK integration **must perfectly mirror** those dashboard names.
>
> **The 3-Step Integration Rule:**
> 1. **Check the Dashboard:** Open the Recommendations page and identify the canonical task (e.g., \\\`"stripe_refund_issue"\\\`) and action (e.g., \\\`"process_full_refund"\\\`).
> 2. **Map the Task:** Use that exact string in your integration: \\\`@li.action("stripe_refund_issue")\\\`
> 3. **Map the Action:** Ensure your underlying function name matches the action string: \\\`def process_full_refund(...):\\\`
> 
> **Why this matters:** If you invent new names in your code instead of using the dashboard's canonical names, the SDK will treat them as brand-new tools with zero history—completely destroying your historical data advantage!

---

## Why LayerInfinite? — Competitive Analysis

LayerInfinite is **not** an observability tool. It is a **decision layer**.

| Capability | LayerInfinite | Langfuse | AgentOps | Braintrust | Manual RL |
|------------|:---:|:---:|:---:|:---:|:---:|
| **Outcome-based action routing** | ✅ | ❌ | ❌ | ❌ | ⚠️ |
| **Auto-fallback on failure** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Cross-session learning** | ✅ | ❌ | ❌ | ❌ | ⚠️ |
| **Decision latency** | Sub-5ms | N/A | N/A | N/A | Variable |
| **Decorator-based instrumentation** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Cold-start prior injection** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Agent trust scoring** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **No LLM dependency** | ✅ | N/A | N/A | N/A | ❌ |

### The Moat

**Observability tools** (Langfuse, AgentOps, Braintrust) answer *"what happened?"* — they log traces, show you dashboards, and let you replay sessions.

**LayerInfinite** answers *"what should the agent do next?"* — it takes the outcome data, computes action-level success probabilities in real-time, and actively routes your agent's next decision.

This is the difference between a dashcam and an autopilot.

### 🔒 Zero-LLM Architecture & Absolute Data Privacy

Unlike other observability and evaluation tools that rely on "LLM-as-a-judge" to score outcomes, **LayerInfinite does not use external LLMs to make routing decisions.**

- **100% Deterministic SQL:** Decisions are calculated using mathematical probabilities in PostgreSQL materialized views. There are no black-box hallucinations.
- **Strict Data Privacy:** Because we don't use LLMs to evaluate your logs, **your production data is never sent to OpenAI, Anthropic, or any third-party API.**
- **Automatic PII Scrubbing:** The SDK strips sensitive parameters before they ever leave your infrastructure.

Your data stays in your database, and the math stays transparent.

### 🛡️ Agent Trust Scoring

LayerInfinite doesn't just route actions; it tracks the overall reliability of your agents.

**What is a Trust Score?**
Every agent receives a real-time Trust Score (0.0 to 1.0) calculated from its recent rolling success rate across all tasks. 

*   **0.9+ (High Trust):** The agent is performing optimally.
*   **0.6 - 0.8 (Degraded):** The agent is struggling with certain tasks. LayerInfinite will fire a degradation alert.
*   **< 0.6 (Critical):** The agent is failing consistently.

If an agent's trust score drops below your configured threshold, LayerInfinite can **auto-suspend** the agent (failing closed or returning a safe fallback) to prevent catastrophic cascading failures in production.

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

LayerInfinite is built on PostgreSQL materialized views, not vector databases. Decisions are deterministic and SQL-queryable.

**Key design decisions:**
- **Append-only storage** — No outcome is ever deleted or overwritten. Required for EU AI Act compliance.
- **Deterministic scoring** — \\\`success_count / total_count * recency_weight\\\`. No black-box model weights.
- **PII scrubbing** — The SDK automatically strips sensitive parameters before logging.
- **Durable queue** — Failed outcome submissions are persisted to disk and retried automatically.

---

## License

MIT.
`;

export default function DocsPage(): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Load marked.js from CDN
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
    script.onload = () => {
      if (containerRef.current && (window as any).marked) {
        containerRef.current.innerHTML = (window as any).marked.parse(README_MD);
        setReady(true);
      }
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  return (
    <div className="bg-black text-white min-h-screen">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 border-b border-[#1a1a24] bg-black/85 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="text-xl font-bold tracking-tight">
            layer<span className="text-[#00FF85]">infinite</span>
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm font-medium text-[#888888]">
            <span className="text-[#00FF85] font-semibold">Docs</span>
            <Link className="hover:text-white transition-colors" to="/">Home</Link>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/auth?mode=login" className="text-sm font-medium text-[#888888] hover:text-white transition-colors">Sign In</Link>
            <Link to="/auth?mode=signup" className="bg-[#00FF85] text-black px-5 py-2 text-sm font-bold tracking-tight hover:bg-white transition-all">Get Started Free</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-28 pb-12 border-b border-[#1a1a24]" style={{ background: 'linear-gradient(to bottom, rgba(0,255,133,0.03), black)' }}>
        <div className="max-w-[820px] mx-auto px-6 text-center">
          {/* SVG Logo */}
          <div className="flex justify-center mb-8">
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="80" height="80" rx="4" fill="#111118" />
              {/* 4x4 grid */}
              {[0,1,2,3].map(r => [0,1,2,3].map(c => (
                <rect
                  key={`${r}-${c}`}
                  x={8 + c * 16}
                  y={8 + r * 16}
                  width="15"
                  height="15"
                  rx="1.5"
                  fill={r === 1 && c === 2 ? '#00FF85' : 'transparent'}
                  stroke={r === 1 && c === 2 ? '#00FF85' : '#333333'}
                  strokeWidth="0.8"
                />
              )))}
            </svg>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter mb-4">Documentation</h1>
          <p className="text-[#888888] text-lg max-w-xl mx-auto">
            Decision intelligence infrastructure for autonomous AI agents. Everything you need to integrate, configure, and ship.
          </p>
        </div>
      </section>

      {/* Markdown Content */}
      <main className="px-6 py-16">
        <article ref={containerRef} className="docs-md-body max-w-[820px] mx-auto" />
        {!ready && (
          <div className="max-w-[820px] mx-auto text-center text-[#555555] py-20">Loading documentation...</div>
        )}
      </main>

      {/* Footer */}
      <footer className="py-12 border-t border-[#1a1a24] bg-black">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-8">
          <span className="text-xl font-bold tracking-tight">layer<span className="text-[#00FF85]">infinite</span></span>
          <div className="flex gap-8 text-[11px] font-bold uppercase tracking-widest text-[#888888]">
            <Link className="hover:text-[#00FF85] transition-colors" to="/privacy">Privacy</Link>
            <Link className="hover:text-[#00FF85] transition-colors" to="/terms">Terms</Link>
            <a className="hover:text-[#00FF85] transition-colors" href="mailto:team@layerinfinite.app">Contact</a>
          </div>
        </div>
      </footer>

      {/* Markdown styles */}
      <style>{`
        .docs-md-body h2 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin-top: 3rem; margin-bottom: 1rem; color: #fff; border-bottom: 1px solid #1a1a24; padding-bottom: 0.5rem; }
        .docs-md-body h3 { font-size: 1.25rem; font-weight: 600; margin-top: 2rem; margin-bottom: 0.75rem; color: #e5e5e5; }
        .docs-md-body p { color: #a3a3a3; line-height: 1.75; margin-bottom: 1rem; }
        .docs-md-body strong { color: #fff; }
        .docs-md-body a { color: #00FF85; text-decoration: none; border-bottom: 1px solid rgba(0,255,133,0.3); }
        .docs-md-body a:hover { border-color: #00FF85; }
        .docs-md-body ul, .docs-md-body ol { color: #a3a3a3; margin-bottom: 1rem; padding-left: 1.5rem; }
        .docs-md-body li { margin-bottom: 0.35rem; line-height: 1.7; }
        .docs-md-body code { font-family: 'JetBrains Mono', monospace; background: rgba(255,255,255,0.06); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.875em; color: #e5e5e5; }
        .docs-md-body pre { background: #0a0a0a; border: 1px solid #1a1a24; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; overflow-x: auto; }
        .docs-md-body pre code { background: none; padding: 0; font-size: 0.85rem; color: #d4d4d4; line-height: 1.6; }
        .docs-md-body hr { border: none; border-top: 1px solid #1a1a24; margin: 2.5rem 0; }
        .docs-md-body table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.9rem; }
        .docs-md-body thead th { text-align: left; padding: 0.75rem; border-bottom: 2px solid #1a1a24; color: #00FF85; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
        .docs-md-body tbody td { padding: 0.75rem; border-bottom: 1px solid rgba(26,26,26,0.5); color: #a3a3a3; }
        .docs-md-body tbody tr:hover { background: rgba(0,255,133,0.03); }
        .docs-md-body blockquote { border-left: 3px solid #00FF85; padding: 1rem 1.25rem; margin: 1.5rem 0; background: rgba(0,255,133,0.04); border-radius: 0 6px 6px 0; }
        .docs-md-body blockquote p { color: #d4d4d4; margin-bottom: 0.5rem; }
        .docs-md-body blockquote p:last-child { margin-bottom: 0; }
      `}</style>
    </div>
  );
}
