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

## Quick Start

### Python

\`\`\`bash
pip install layerinfinite-sdk
\`\`\`

\`\`\`python
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

# Outcomes are logged automatically.
rollback_release("deploy-4821")
\`\`\`

### TypeScript / JavaScript

\`\`\`bash
npm install layerinfinite-sdk
\`\`\`

\`\`\`typescript
import { Layerinfinite } from 'layerinfinite-sdk';

const li = new Layerinfinite({
    apiKey: 'layerinfinite_...',
    agentId: 'my-agent',
    mode: 'auto'
});

const rollbackRelease = li.action('deploy_failure', 'rollback_release', async (deployId: string) => {
    return await ci.rollback(deployId);
});

await rollbackRelease('deploy-4821');
\`\`\`

### How \`@li.action\` works

| Concept | What it means | Example |
|---------|---------------|---------|
| **Task** | The category of problem your agent is solving | \`"deploy_failure"\`, \`"payment_retry"\` |
| **Action** | The specific strategy the agent uses | \`rollback_release\`, \`hotfix_forward\` |
| **Outcome** | Whether the action succeeded or failed | Captured automatically by the decorator |

---

## Modes

### \`recommend\` (default)
**Passive observation.** LayerInfinite watches every decorated action call, logs outcomes, and builds scoring models — but never interferes with your agent's decisions.

\`\`\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="recommend")

scores = li.scores("deploy_failure")
rec = li.recommend("deploy_failure")
\`\`\`

### \`assist\`
**Advisory mode.** LayerInfinite provides suggestions via \`li.suggest()\`, but your agent decides whether to follow them.

\`\`\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="assist")

suggestion = li.suggest("deploy_failure")
# suggestion.action_name  → "rollback_release"
# suggestion.confidence   → 0.87
\`\`\`

### \`auto\`
**Fully autonomous.** LayerInfinite picks the highest-probability action and executes it directly.

> **If the LayerInfinite API is unreachable**, the SDK fails open — it executes the first registered action and queues telemetry locally for background retry.

\`\`\`python
li = Layerinfinite(api_key="...", agent_id="my-agent", mode="auto")

result = li.run("deploy_failure", deploy_id="deploy-4821")
\`\`\`

---

## The Zero Cold-Start Advantage

Most decision systems require weeks of live traffic. **LayerInfinite bypasses the cold-start problem entirely.**

Import existing logs via the Import API and the routing engine enters production already knowing which actions succeed.

> **The Golden Rule: Semantic Consistency**
>
> When you import historical logs, LayerInfinite generates **canonical Task and Action names** on your Dashboard.
> Your SDK integration **must mirror** those dashboard names exactly.
>
> 1. **Check the Dashboard** → Recommendations page for canonical names
> 2. **Map the Task:** \`@li.action("stripe_refund_issue")\`
> 3. **Map the Action:** \`def process_full_refund(...):\`

---

## Why LayerInfinite?

| Capability | LayerInfinite | Langfuse | AgentOps | Braintrust |
|------------|:---:|:---:|:---:|:---:|
| **Outcome-based routing** | ✅ | ❌ | ❌ | ❌ |
| **Auto-fallback** | ✅ | ❌ | ❌ | ❌ |
| **Cross-session learning** | ✅ | ❌ | ❌ | ❌ |
| **Decision latency** | Sub-5ms | N/A | N/A | N/A |
| **Cold-start injection** | ✅ | ❌ | ❌ | ❌ |
| **Agent trust scoring** | ✅ | ❌ | ❌ | ❌ |
| **No LLM dependency** | ✅ | N/A | N/A | N/A |

**Observability tools** answer *"what happened?"*

**LayerInfinite** answers *"what should the agent do next?"*

This is the difference between a dashcam and an autopilot.

### Zero-LLM Architecture

- **100% Deterministic SQL:** Decisions calculated using mathematical probabilities in PostgreSQL materialized views.
- **Strict Data Privacy:** Your production data is never sent to OpenAI, Anthropic, or any third-party API.
- **Automatic PII Scrubbing:** The SDK strips sensitive parameters before they leave your infrastructure.

---

## Dashboard

LayerInfinite ships with a production dashboard at [layerinfinite.app](https://layerinfinite.app):

- **Overview** — Agent health scores, outcome volume, success rate trends
- **Actions** — Per-action success rates, sample counts, confidence scores
- **Alerts** — Degradation detection, trust score drops
- **Discrepancies** — Cross-event conflicts, expired signals
- **Recommendations** — Data-driven action replacement suggestions

---

## Architecture

LayerInfinite is built on PostgreSQL materialized views, not vector databases. Decisions are deterministic and SQL-queryable.

- **Append-only storage** — No outcome is ever deleted or overwritten.
- **Deterministic scoring** — \`success_count / total_count * recency_weight\`
- **PII scrubbing** — Automatic before logging.
- **Durable queue** — Failed submissions persisted to disk and retried automatically.

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
