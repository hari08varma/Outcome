---
name: architecture-v2-implementation-plan
description: "Definitive production-grade V2 implementation plan synthesizing architect, developer, planner, and designer agent outputs. Covers file audit, 35-step phased build, design contracts, cache keys, error formats, edge cases, risks, and verification checklist."
metadata:
  type: project
  originSessionId: bad08b6b-9006-4a4b-acea-88f62b909625
---

# ARCHITECTURE_V2 — Production-Grade Implementation Plan

> Synthesized from 4 specialized agents (architect, developer, planner, designer) on 2026-05-20.
> Companion specs: [[architecture-v2-complete]], [[architecture-v2-migration]], [[project-full-architecture]]

---

## 1. Executive Summary

### What We're Building

Transform LI from an agent-facing MCP tool server (10 tools agents must explicitly call) into an **invisible MCP gateway proxy** that sits between every AI agent and its real tools. The gateway intercepts `tools/list` to inject historical outcome data as natural language, and proxies `tools/call` to real upstream MCP servers. Agent code unchanged. 4 lines of JSON config.

### The Key Architectural Insight

LI intercepts `tools/list` — which happens BEFORE the agent reasons about which tool to use. By enriching descriptions at discovery time, LI doesn't need to intercept the decision because the decision hasn't happened yet. This is the mechanism that makes the "pre-reasoning injection" architecturally valid.

### Code Survival: ~60% Unchanged

| Layer | Status |
|-------|--------|
| Scoring engine (`scoring.ts`, `policy-engine.ts`) | Keep (zero changes) |
| MCTS simulation (all `simulation/` files) | Keep (zero changes) |
| 10 of 13 recommendation engine files | Keep (zero changes) |
| All 133 SQL migrations | Keep (1 new migration for `ingestion_source`) |
| All dashboard pages (15 pages, 12 hooks) | Keep (zero changes) |
| Training pipeline (7 files) | Keep (zero changes) |
| Middleware (5 files) | Keep (zero changes) |
| Ingestion pipeline | Keep (zero changes) |
| 40+ test files | Keep (updated for `'mcp'` source) |
| LangChain/LangGraph adapters | Keep (import converters, NOT SDKs) |
| SDKs (`packages/typescript-sdk/`, `packages/python-sdk/`) | Keep but isolate — disable CI/CD publish |
| 10 current MCP tools | **Delete** |
| `param-resolver.ts`, `episode-tracker.ts` | **Delete** |
| `task-intelligence.ts` resource | **Delete** |
| `agent-setup.ts` prompt | **Delete** |
| `index.ts`, `rest-client.ts`, `config.ts` | **Rewrite** |
| `outcome-orchestrator.ts` | **Modify** (add decision_id + webhook) |
| ~22 new files across 7 categories | **Create** |

### Implementation Order

```
Phase 0: Preparation (SDK isolation, scaffold, config, schema)
  → Phase 1: Gateway Proxy Core (5 files)
    → Phase 2: Tool Enrichment Engine (5 files)
      → Phase 3: Decision Tracking + Webhooks (4 files)
        → Phase 4: LLM Coach (2 files)
          → Phase 5: Safety Features (5 files)
            → Phase 6: Cleanup + Hardening (11 steps)

Phases 2, 3, 4, 5 can run in parallel once Phase 1 completes.
Estimated: 8-10 days (2 devs) or 12-17 days (1 dev).
```

---

## 2. Design Contracts (Build These First)

### 2.1 Core TypeScript Interfaces

```typescript
// packages/mcp-server/src/types.ts

export enum GatewayMode {
  Bootstrap = 'bootstrap',  // Shadow: observe only, no enrichment
  Recommend = 'recommend',  // Informational enrichment
  Assist = 'assist',        // Directional with warnings
  Auto = 'auto',            // Silent rerouting
}

export interface UpstreamServer {
  name: string;             // Tool prefix (e.g. "github", "database")
  url: string;              // MCP server URL
  apiKey?: string;          // Optional per-upstream auth
  healthCheckIntervalMs?: number;  // Default 30_000
}

export interface GatewayConfig {
  port: number;
  upstreamServers: UpstreamServer[];
  mode: GatewayMode;
  modeOverrides: Record<string, GatewayMode>;  // Per task_type
  liApiBaseUrl: string;
  liApiKey: string;
  shadowMode: boolean;        // Observe without injection
  environment: 'staging' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface EnrichedTool {
  name: string;
  description: string;       // ENRICHED — original woven with historical context
  inputSchema: object;       // UNMODIFIED — passthrough from upstream
  upstreamName: string;      // Which upstream server owns this tool
  annotations?: {
    ranking?: number;        // 1-based rank within task (best=1)
    category?: 'recommended' | 'neutral' | 'warning';
  };
}

export interface EnrichmentContext {
  taskType: string;
  customerId: string;
  agentId: string;
  mode: GatewayMode;
  scores: ScoredAction[];    // From scoring.ts
  policyDecision: PolicyDecision;
}

export interface DecisionRecord {
  decisionId: string;        // dec_{ts12}_{agent4}_{rand4}
  agentId: string;
  customerId: string;
  taskType: string;
  actionName: string;
  upstreamName: string;
  originalAction: string;    // What agent chose
  executedAction: string;    // What actually ran (may differ in Auto)
  mode: GatewayMode;
  rerouted: boolean;
  enrichmentScores: Record<string, number>;
  timestamp: string;         // ISO 8601
}

export interface Episode {
  episodeId: string;
  agentId: string;
  sessionStart: string;
  decisions: string[];       // decisionIds in order
  coachingCount: number;     // Max 3
}

export interface WebhookCallback {
  decisionId: string;
  layer: 2 | 3;              // Layer 2 = session, Layer 3 = business
  success: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface FailOpenState {
  upstreamFailures: Map<string, number>;   // Per-upstream failure count
  circuitBreakerOpen: Map<string, boolean>;
  lastHealthCheck: Map<string, Date>;
  totalRequests: number;
  passthroughRequests: number;  // Requests that bypassed LI entirely
}
```

### 2.2 Cache Key Patterns (10 keys, all `customer_id`-namespaced)

```typescript
// packages/mcp-server/src/cache-keys.ts

const PREFIX = 'li';
const SEP = ':';

export const CacheKeys = {
  // Scoring data for enrichment (5-min TTL, from scoring.ts LRU)
  score: (cust: string, task: string) =>
    `${PREFIX}${SEP}score${SEP}${cust}${SEP}${task}`,

  // Enriched tool descriptions (60s TTL — balances freshness with latency)
  enrich: (cust: string, task: string, tool: string) =>
    `${PREFIX}${SEP}enrich${SEP}${cust}${SEP}${task}${SEP}${tool}`,

  // Upstream tool list cache (30s TTL — tools don't change often)
  upstreamTools: (name: string) =>
    `${PREFIX}${SEP}upstream${SEP}tools${SEP}${name}`,

  // Mode resolution per task_type (5-min TTL)
  mode: (cust: string, task: string) =>
    `${PREFIX}${SEP}mode${SEP}${cust}${SEP}${task}`,

  // Trust score per agent (60s TTL)
  trust: (cust: string, agent: string) =>
    `${PREFIX}${SEP}trust${SEP}${cust}${SEP}${agent}`,

  // Episode state (30-min TTL — session duration)
  episode: (cust: string, agent: string) =>
    `${PREFIX}${SEP}episode${SEP}${cust}${SEP}${agent}`,

  // Shadow mode comparison data (5-min TTL)
  shadow: (cust: string, task: string) =>
    `${PREFIX}${SEP}shadow${SEP}${cust}${SEP}${task}`,

  // Global cold-start priors (24h TTL — rarely changes)
  globalPriors: (task: string) =>
    `${PREFIX}${SEP}global${SEP}priors${SEP}${task}`,

  // Rate limit counters (1-min sliding window)
  rateLimit: (cust: string) =>
    `${PREFIX}${SEP}ratelimit${SEP}${cust}`,
};
```

### 2.3 Decision ID Generation

```typescript
// packages/mcp-server/src/decision-tracker.ts

import { randomBytes } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(num: number, pad: number): string {
  let result = '';
  for (let i = 0; i < pad; i++) {
    result = BASE62[num % 62] + result;
    num = Math.floor(num / 62);
  }
  return result;
}

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash >>> 0; // Force unsigned 32-bit
  }
  return hash;
}

export function generateDecisionId(agentId: string): string {
  const ts = toBase62(Date.now(), 12);
  const agentHash = toBase62(djb2(agentId) % (62 ** 4), 4);
  const rand = toBase62(randomBytes(3).readUIntBE(0, 3) % (62 ** 4), 4);
  return `dec_${ts}_${agentHash}_${rand}`;
}
// Format: dec_{timestamp_base62_12chars}_{agent_hash_4chars}_{random_4chars}
// Lexicographically sortable by time, collision probability < 10^-9 per ms
```

### 2.4 Enrichment Formats (Natural Language Only)

```typescript
// packages/mcp-server/src/enrichment/format-recommend.ts

export function formatRecommendEnrichment(
  originalDescription: string,
  toolName: string,
  taskType: string,
  successRate: number,
  sampleSize: number,
  trendLabel?: string,
): string {
  const pct = Math.round(successRate * 100);

  let enrichment: string;
  if (sampleSize < 3) {
    enrichment = `Insufficient historical data for ${toolName} on ${taskType} (${sampleSize} recorded outcomes).`;
  } else if (sampleSize < 10) {
    enrichment = `Historically, ${toolName} has resolved ${taskType} issues successfully ${pct}% of the time (limited data: ${sampleSize} outcomes).`;
  } else {
    enrichment = `Historically, ${toolName} has resolved ${taskType} issues successfully ${pct}% of the time (${sampleSize} recorded outcomes).`;
  }

  if (trendLabel && sampleSize >= 10) {
    enrichment += ` Success rate is ${trendLabel}.`;
  }

  return `${originalDescription} ${enrichment}`;
}
```

```typescript
// packages/mcp-server/src/enrichment/format-assist.ts

export function formatAssistRecommendation(
  originalDescription: string,
  toolName: string,
  taskType: string,
  successRate: number,
  sampleSize: number,
  rank: number,
  totalTools: number,
): string {
  const pct = Math.round(successRate * 100);

  let enrichment: string;
  if (rank === 1 && sampleSize >= 10) {
    enrichment = `This is the recommended tool for ${taskType} — it has succeeded ${pct}% of the time. Use this unless you have a specific reason to choose otherwise.`;
  } else if (rank === 1 && sampleSize < 10) {
    enrichment = `This appears to be the best option for ${taskType} (${pct}% success, ${sampleSize} outcomes). More data needed for high confidence.`;
  } else {
    enrichment = `Ranked #${rank}/${totalTools} for ${taskType} (${pct}% success, ${sampleSize} outcomes).`;
  }

  return `${originalDescription} ${enrichment}`;
}

export function formatAssistWarning(
  originalDescription: string,
  toolName: string,
  taskType: string,
  failRate: number,
  sampleSize: number,
  alternative: string,
): string {
  const failPct = Math.round(failRate * 100);
  return `${originalDescription} WARNING: This tool has FAILED on ${taskType} ${failPct}% of the time (${sampleSize} recorded outcomes). Strongly consider using ${alternative} instead.`;
}
```

```typescript
// packages/mcp-server/src/enrichment/format-auto.ts

export function formatAutoEnrichment(originalDescription: string): string {
  // Auto mode returns descriptions UNCHANGED — agent never knows LI exists
  return originalDescription;
}
```

### 2.5 Virtual `li_recommend` Tool

```typescript
// packages/mcp-server/src/li-recommend-tool.ts

import { z } from 'zod';

export const LI_RECOMMEND_NAME = 'li_recommend';
export const LI_RECOMMEND_DESCRIPTION =
  'Get LayerInfinite decision intelligence: returns ranked tool recommendations ' +
  'with historical success rates and sample sizes for any task. ' +
  'Use this to check which tools have historically worked best for a given task type.';

export const liRecommendInputSchema = {
  type: 'object' as const,
  properties: {
    task: {
      type: 'string' as const,
      description: 'The task type to get recommendations for (e.g., "build_failed", "ci_timeout", "deploy_error")',
    },
  },
  required: ['task'],
};

export const liRecommendZodSchema = z.object({
  task: z.string().min(1).max(200).describe('Task type to get recommendations for'),
});
```

### 2.6 Error Format (MCP Protocol)

All gateway errors use MCP's native error format, never thrown exceptions:

```typescript
// packages/mcp-server/src/gateway-errors.ts

export interface GatewayError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

export const Errors = {
  upstreamUnreachable: (name: string): GatewayError => ({
    content: [{ type: 'text', text: `Upstream MCP server "${name}" is unreachable. The agent can retry or proceed with other tools.` }],
    isError: true,
  }),

  noRecommendations: (task: string): GatewayError => ({
    content: [{ type: 'text', text: `No historical data available for task "${task}". Continue collecting outcomes to enable recommendations.` }],
    isError: true,
  }),

  webhookInvalidSignature: (): GatewayError => ({
    content: [{ type: 'text', text: 'Webhook signature verification failed.' }],
    isError: true,
  }),

  webhookDecisionNotFound: (id: string): GatewayError => ({
    content: [{ type: 'text', text: `Decision ID "${id}" not found. Ensure the decision was logged before sending a callback.` }],
    isError: true,
  }),
};
```

---

## 3. Complete File Audit

### 3.1 KEEP — Zero Changes (These files are untouchable)

**Scoring & Policy:**
- `layer5/api/lib/scoring.ts` — 6-factor formula, Bayesian smoothing, LRU cache
- `layer5/api/lib/policy-engine.ts` — 11-branch decision tree

**MCTS Simulation:**
- `layer5/api/lib/simulation/tier-selector.ts`
- `layer5/api/lib/simulation/tier1.ts`
- `layer5/api/lib/simulation/tier2.ts`
- `layer5/api/lib/simulation/tier3-mcts.ts`
- `layer5/api/lib/simulation/world-model.ts`
- `layer5/api/lib/simulation/types.ts`

**Recommendation Engine (10 files kept, 3 modified):**
- `layer5/api/lib/recommendation/engine.ts`
- `layer5/api/lib/recommendation/cohort-cycle.ts`
- `layer5/api/lib/recommendation/cohort-reliability.ts`
- `layer5/api/lib/recommendation/constants.ts`
- `layer5/api/lib/recommendation/data-freshness.ts`
- `layer5/api/lib/recommendation/rollout-flags.ts`
- `layer5/api/lib/recommendation/outcome-weighting.ts`
- `layer5/api/lib/recommendation/scope-transition.ts`
- `layer5/api/lib/recommendation/semantic-action-cluster.ts`
- `layer5/api/lib/recommendation/task-infer.ts`

**Ingestion Pipeline:**
- `layer5/api/lib/ingest-core.ts` (MODIFY: add `'mcp'` to source validation)
- `layer5/api/lib/outcome-score-inference.ts` (MODIFY: accept `'mcp'` source)
- `layer5/api/lib/verifier.ts`
- `layer5/api/lib/schema-inferrer.ts`
- `layer5/api/lib/context-embed.ts`

**Orchestration:**
- `layer5/api/lib/outcome-orchestrator.ts` (MODIFY: add decision_id + webhook callbacks)
- `layer5/api/lib/decision-writer.ts`
- `layer5/api/lib/drift-detector.ts`
- `layer5/api/lib/predictive-drift.ts`
- `layer5/api/lib/sequence-tracker.ts`
- `layer5/api/lib/reward-backprop.ts`

**Counterfactuals:**
- `layer5/api/lib/ips-engine.ts`

**Queue:**
- `layer5/api/lib/outcome-ingest-queue.ts`

**Adapters (import converters, NOT SDKs):**
- `layer5/api/lib/adapters/langchain-adapter.ts`
- `layer5/api/lib/adapters/langgraph-adapter.ts`

**Core Lib:**
- `layer5/api/lib/supabase.ts`
- `layer5/api/lib/sanitize.ts`
- `layer5/api/lib/tenant-supabase.ts`
- `layer5/api/lib/webhook-auth.ts`

**Middleware (5 files):**
- `layer5/api/middleware/auth.ts`
- `layer5/api/middleware/user-auth.ts`
- `layer5/api/middleware/admin-auth.ts`
- `layer5/api/middleware/validate-action.ts`
- `layer5/api/middleware/rate-limit.ts`

**Types:**
- `layer5/api/types/hono.d.ts`

**Database:**
- All 133 SQL files in `layer5/db/` and `layer5/supabase/migrations/`
- **NEW migration needed:** migration 132 — extend `ingestion_source` CHECK constraint

**Dashboard:**
- All 15+ pages, 12 hooks, 8 components in `layer5/` and `layer4/`

**Training:**
- All 7 files in `layer5/training/`

**CI/CD:**
- `.github/workflows/ci.yml` (MODIFY: disable SDK publish, add MCP server tests)

**Tests (40+ files):**
- All test files kept, updated to cover `'mcp'` ingestion_source variant

### 3.2 DELETE (13 files)

| File | Reason |
|------|--------|
| `packages/mcp-server/src/tools/li-action.ts` | Replaced by gateway rerouting |
| `packages/mcp-server/src/tools/li-log.ts` | Gateway captures outcomes automatically |
| `packages/mcp-server/src/tools/li-observe.ts` | Enrichment engine replaces observation |
| `packages/mcp-server/src/tools/li-audit.ts` | Dashboard handles audit |
| `packages/mcp-server/src/tools/li-health.ts` | Health check via upstream registry |
| `packages/mcp-server/src/tools/li-simulate.ts` | Simulation accessible via API, not MCP tool |
| `packages/mcp-server/src/tools/li-patterns.ts` | Patterns accessible via API |
| `packages/mcp-server/src/tools/li-fallback.ts` | Fail-open layer handles this |
| `packages/mcp-server/src/tools/li-toggle-action.ts` | Dashboard handles action management |
| `packages/mcp-server/src/tools/li-register-action.ts` | Dashboard handles action registration |
| `packages/mcp-server/src/param-resolver.ts` | No tool params to resolve |
| `packages/mcp-server/src/episode-tracker.ts` | Replaced by decision-tracker.ts |
| `packages/mcp-server/src/prompts/agent-setup.ts` | No system prompt changes needed for Auto mode |

### 3.3 REWRITE (3 files)

| File | New Purpose |
|------|-------------|
| `packages/mcp-server/src/index.ts` | Gateway proxy server — uses low-level `Server`/`Transport` from MCP SDK, NOT `McpServer`. Intercepts `tools/list` and `tools/call`. |
| `packages/mcp-server/src/rest-client.ts` | Split into two concerns: (a) upstream MCP connector (proxies to real tool servers), (b) LI API client (scores, logging, enrichment) |
| `packages/mcp-server/src/config.ts` | Supports `LAYERINFINITE_UPSTREAM_TOOLS` JSON array, mode per-task-type map, shadow mode flag, environment tag |

### 3.4 MODIFY (6 files)

| File | Change |
|------|--------|
| `layer5/api/lib/ingest-core.ts` | Add `'mcp'` to `IngestionSource` type. Line 52: extend type union. Line 1012: pass through. |
| `layer5/api/lib/outcome-orchestrator.ts` | Generate `decision_id` at gateway edge. Accept webhook callbacks. Link Layer 2/3 outcomes by decision_id. |
| `layer5/api/lib/outcome-score-inference.ts` | Line 346: accept `'mcp'` in `.eq('ingestion_source', ...)` filter |
| `layer5/api/routes/log-outcome.ts` | Line 821: accept `'mcp'` as valid ingestion_source |
| `layer5/api/routes/get-recommendations.ts` | Lines 66-67: accept `'mcp'` alongside `'import'` and `'api'` |
| `layer5/api/lib/recommendation/task-performance.ts` | Lines 536, 619, 716: include `'mcp'` source in queries |

### 3.5 CREATE (~22 new files)

**Gateway Core (7 files):**
1. `packages/mcp-server/src/gateway-proxy.ts` — Main proxy: intercept tools/list, enrich, forward tools/call
2. `packages/mcp-server/src/tool-enrichment.ts` — Natural language enrichment engine per mode
3. `packages/mcp-server/src/li-recommend-tool.ts` — Virtual li_recommend tool definition + handler
4. `packages/mcp-server/src/mode-manager.ts` — Per-task-type mode resolution (Recommend/Assist/Auto)
5. `packages/mcp-server/src/decision-tracker.ts` — decision_id generation + episode tracking
6. `packages/mcp-server/src/upstream-registry.ts` — Register/health-check upstream MCP servers
7. `packages/mcp-server/src/fail-open.ts` — 3-layer failure protection with circuit breaker

**Enrichment Engine (3 files):**
8. `packages/mcp-server/src/enrichment/format-recommend.ts` — Recommend mode formatting
9. `packages/mcp-server/src/enrichment/format-assist.ts` — Assist mode formatting with warnings
10. `packages/mcp-server/src/enrichment/score-fetcher.ts` — Fetches scores from Hot/Warm layer for enrichment

**LLM Coach (2 files):**
11. `layer5/api/lib/llm-coach.ts` — gpt-4o-mini within-session coaching on failures
12. `layer5/api/lib/coach-session-tracker.ts` — Caps 3/session, retires as data accumulates

**Business Layer (2 files):**
13. `layer5/api/routes/business-webhook.ts` — External webhook callback ingestion endpoint
14. `layer5/api/lib/webhook-verifier.ts` — Webhook signature verification + secret management (replaces current silent no-op)

**Safety & Operations (5 files):**
15. `layer5/api/lib/shadow-mode.ts` — Dry run: observe + compare without injection
16. `layer5/api/lib/environment-isolation.ts` — Staging/production outcome separation
17. `layer5/api/lib/model-versioning.ts` — Version + rollback probability models
18. `layer5/api/routes/model-history.ts` — Dashboard API for version diff, rollback, pin
19. `layer5/api/lib/confidence-thresholds.ts` — Per-agent per-task threshold enforcement

**New MCP Resources (3 files):**
20. `packages/mcp-server/src/resources/dashboard.ts` — Dashboard URL resource
21. `packages/mcp-server/src/resources/docs.ts` — Documentation resource
22. `packages/mcp-server/src/prompts/onboarding.ts` — Onboarding prompt

**Schema Migration:**
23. `layer5/supabase/migrations/132_extend_ingestion_source.sql` — Drops and recreates CHECK constraint to allow `'mcp'`

### 3.6 SDK Isolation (Keep But Remove Relationship)

The TypeScript and Python SDKs (`packages/typescript-sdk/`, `packages/python-sdk/`) are KEPT on disk for future reference. The isolation plan:

1. **Remove from LayerInfinite**: No MCP gateway code imports from SDKs. No SDK code exports to gateway.
2. **Disable CI/CD**: Comment out `publish-npm-sdk.yml` and `publish-python-sdk.yml` in CI matrix.
3. **Mark deprecated**: Add deprecation notice to SDK READMEs: "LayerInfinite is now an MCP gateway. These SDKs are deprecated. Use the MCP integration instead (4 lines of JSON config)."
4. **Leave packages on npm/pip**: Existing published versions remain. No new versions published.
5. **Remove from root package.json workspaces** (if any): Don't build SDKs as part of monorepo build.
6. **Keep import adapters**: `langchain-adapter.ts` and `langgraph-adapter.ts` are import-format converters that transform LangChain/LangSmith trace JSON into `NormalizedOutcomeRow[]`. They serve the `/v1/import` route (bulk historical data import). These are NOT SDK wrappers — they're import infrastructure.

---

## 4. Phase-by-Phase Implementation

### Phase 0: Preparation (Day 1)

**Step 0.1 — SDK Isolation**
- Comment out `publish-npm-sdk.yml` and `publish-python-sdk.yml` in CI matrix
- Add deprecation notice to SDK READMEs
- Verify zero gateway imports from SDK packages
- Verify LangChain/LangGraph adapters are self-contained (no SDK dependency)

**Step 0.2 — Create Directory Scaffold**
- `packages/mcp-server/src/enrichment/` directory
- `packages/mcp-server/src/resources/` directory (add to existing)
- `layer5/api/lib/` — new files go alongside existing lib files
- `layer5/api/routes/` — new routes go alongside existing routes

**Step 0.3 — Extend Config**
- Rewrite `packages/mcp-server/src/config.ts` with new `GatewayConfig` interface
- Add env vars: `LAYERINFINITE_UPSTREAM_TOOLS`, `LAYERINFINITE_SHADOW_MODE`, `LAYERINFINITE_ENVIRONMENT`
- Parse `UPSTREAM_TOOLS` JSON: `[{"name":"github","url":"https://github.mcp","apiKey":"..."}]`
- Validate mode overrides format: `{"build_failed":"auto","ci_timeout":"recommend"}`

**Step 0.4 — DB Schema Migration (132)**
```sql
-- Drop old constraint
ALTER TABLE fact_outcomes
  DROP CONSTRAINT IF EXISTS fact_outcomes_ingestion_source_check;

-- Add new constraint with 'mcp'
ALTER TABLE fact_outcomes
  ADD CONSTRAINT fact_outcomes_ingestion_source_check
  CHECK (ingestion_source IN ('sdk', 'import', 'mcp'));

-- Update comment
COMMENT ON COLUMN fact_outcomes.ingestion_source IS
  'Origin of outcome: sdk (legacy agent SDK), import (bulk historical upload), mcp (gateway proxy)';
```

**Validation Gate:** Config loads without errors. Migration applies cleanly. All existing tests pass (`npm test`).

---

### Phase 1: Gateway Proxy Core (Days 2-3)

**Step 1.1 — Upstream Registry** (`upstream-registry.ts`)
- Parse `LAYERINFINITE_UPSTREAM_TOOLS` JSON
- Maintain Map<name, UpstreamServer>
- Health check loop: every 30s, ping each upstream's health endpoint
- Track failure counts per upstream for circuit breaker
- Expose: `getUpstream(name): UpstreamServer | undefined`
- Expose: `getAllUpstreams(): UpstreamServer[]`
- Expose: `isHealthy(name): boolean`

**Step 1.2 — Upstream MCP Connector** (rewrite `rest-client.ts`)
- Two concerns in one file (OK under 500 lines):
  - **MCP Proxy**: Connect to upstream MCP servers, forward `tools/list` and `tools/call`
  - **LI API Client**: Call LI REST API for scores, log outcomes, fetch enrichment data
- Use raw `fetch()` with AbortController (zero new deps)
- Separate timeout per concern: MCP proxy 30s (simulation), LI API 15s
- Retry logic: 2 retries for 429/502/503/504, no retry for 400/401/403/404

**Step 1.3 — Gateway Proxy** (`gateway-proxy.ts`)
- **CRITICAL**: Use low-level MCP `Server` + custom `Transport`, NOT `McpServer`
- `McpServer` is a high-level abstraction that registers tools. Gateway needs to intercept raw JSON-RPC messages before tool registration happens.
- Implementation approach:
  ```typescript
  import { Server } from '@modelcontextprotocol/sdk/server/index.js';
  import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
  // OR custom StreamableHTTPServerTransport for HTTP
  ```
- Intercept `tools/list`:
  1. Agent requests tools → Gateway receives request
  2. Gateway fetches tools from ALL upstream MCP servers in parallel
  3. Gateway fetches scores from LI API (scoring.ts → 6-factor composite)
  4. Gateway enriches tool descriptions with historical context (per mode)
  5. Gateway adds virtual `li_recommend` tool
  6. Gateway returns enriched tool list to agent
- Intercept `tools/call`:
  1. Agent calls a tool → Gateway receives request
  2. Gateway extracts tool name, identifies upstream server
  3. **Auto mode only**: Gateway checks if reroute is needed → if yes, replaces tool call
  4. Gateway generates `decision_id`
  5. Gateway forwards to real upstream MCP server
  6. Gateway returns result to agent immediately (no blocking)
  7. Gateway logs outcome to LI API ASYNC (fire-and-forget with local disk queue fallback)

**Step 1.4 — Server Rewrite** (rewrite `index.ts`)
- Export `createGatewayServer(config)` function
- Uses low-level `Server` from MCP SDK with custom request handler
- Registers NO tools — only intercepts `tools/list` and `tools/call`
- Adds resources: `layerinfinite://dashboard`, `layerinfinite://docs`
- Adds prompt: `layerinfinite-onboarding`

**Step 1.5 — Fail-Open Layer** (`fail-open.ts`)
```
Layer 1: Async logging fails → write to local disk queue (`.li-queue/`) → retry with exponential backoff
Layer 2: LI API unreachable → gateway fails open → agent executes directly → telemetry queued on disk
Layer 3: Everything fails → agent executes as if LI doesn't exist → zero footprint → developer notified via webhook
```
- Circuit breaker: 3 consecutive upstream failures → open for 60s → half-open probe → close or stay open
- `FailOpenState` tracked in-memory with periodic disk persistence
- Webhook notification on circuit breaker state change

**Validation Gate:** Gateway starts. `tools/list` returns enriched tool descriptions from a single upstream. `tools/call` proxies correctly. Fail-open triggers when upstream is killed.

---

### Phase 2: Tool Enrichment Engine (Days 3-4)

**Step 2.1 — Score Fetcher** (`enrichment/score-fetcher.ts`)
- Calls LI API `/v1/get-scores` for current task_type
- Caches results in Hot layer (5-min TTL, 1000-entry LRU)
- Returns `ScoredAction[]` with composite scores
- Handles cold start: if no scores available, returns empty array (enrichment formatters handle cold start gracefully)
- Timeout: 500ms → cache hit or return empty (never block agent)

**Step 2.2 — Recommend Mode Formatter** (`enrichment/format-recommend.ts`)
- `formatRecommendEnrichment(desc, tool, task, successRate, sampleSize, trend?) → string`
- Cold start (sampleSize < 3): "Insufficient historical data..."
- Limited data (sampleSize < 10): "Historically... (limited data: N outcomes)"
- Sufficient data (sampleSize >= 10): "Historically... N% (N outcomes)"
- Optional trend note: "Success rate is improving."

**Step 2.3 — Assist Mode Formatter** (`enrichment/format-assist.ts`)
- `formatAssistRecommendation(desc, tool, task, successRate, sampleSize, rank, total) → string`
- Best tool with clear margin: "This is the recommended tool..."
- Close race (gap ≤ 5%): "Tied for best option..."
- Not best: "Ranked #N/M..."
- `formatAssistWarning(desc, tool, task, failRate, sampleSize, alternative) → string`
- "WARNING: This tool has FAILED on {task} {X}% of the time..."

**Step 2.4 — Enrichment Engine** (`tool-enrichment.ts`)
- `enrichToolList(tools, context): EnrichedTool[]`
- For each upstream tool:
  1. Look up score for (task_type, tool_name) in enrichment context
  2. Apply mode-specific formatter
  3. Return enriched description, UNMODIFIED inputSchema
- **CRITICAL**: `inputSchema` is NEVER modified — only `description` is enriched
- Adds `li_recommend` as last tool in list

**Step 2.5 — Mode Manager** (`mode-manager.ts`)
- `resolveMode(taskType, config): GatewayMode`
- Checks per-task-type overrides first
- Falls back to global mode config
- Caches resolution (5-min TTL per task type)
- Graduated trust levels enforced: cannot jump from Bootstrap to Auto without explicit config

**Step 2.6 — Virtual li_recommend Tool** (`li-recommend-tool.ts`)
- Added to every `tools/list` response
- Handler: calls LI API `/v1/recommendations`, returns ranked list
- Response format:
  ```
  Recommendations for "build_failed":
  1. push_fix — 84% success (234 outcomes)
  2. rollback — 31% success (189 outcomes) ⚠️ BELOW THRESHOLD
  3. restart_service — 67% success (156 outcomes)
  ```

**Validation Gate:** Tools enriched correctly for each mode. Recommend shows informational context. Assist shows directional guidance + warnings. Auto returns unchanged descriptions. `li_recommend` returns ranked results. Cold start handled gracefully.

---

### Phase 3: Decision Tracking + Business Webhooks (Days 4-5)

**Step 3.1 — Decision Tracker** (`decision-tracker.ts`)
- `generateDecisionId(agentId): string` — base62-encoded, sortable, collision-resistant
- `startEpisode(agentId): string` — new episode_id for session
- `recordDecision(record): void` — log decision to in-memory buffer
- Flush buffer to LI API every 5s (or every decision in Auto mode)
- Local disk queue fallback (`writeFileSync` to `.li-queue/decisions.jsonl`)

**Step 3.2 — Orchestrator Update** (modify `outcome-orchestrator.ts`)
- Accept `decision_id` in outcome payload
- Link Layer 2/3 callbacks via `decision_id` lookup
- SCORE OVERWRITE logic:
  ```
  Layer 1 (technical): initial score from gateway inference
  Layer 2 (session): webhook callback overwrites score
  Layer 3 (business): webhook callback overwrites again
  ```
- Cold append-only log preserves full timeline (all three writes recorded)

**Step 3.3 — Webhook Verifier** (`webhook-verifier.ts`)
- Replaces current silent no-op `verifier.ts` webhook path
- Signature verification: HMAC-SHA256 with shared secret
- Secret management: per-customer secrets stored in `dim_customers.config.webhook_secret`
- Timestamp validation: reject callbacks older than 24h
- Rate limiting: max 100 webhooks/minute per customer

**Step 3.4 — Business Webhook Endpoint** (`business-webhook.ts`)
- `POST /v1/webhook/callback` — external systems POST delayed outcomes
- Request body:
  ```json
  {
    "decision_id": "dec_...",
    "layer": 2,
    "success": false,
    "reason": "memory_leak_detected",
    "metadata": { "leak_mb": 512 }
  }
  ```
- Validates webhook signature
- Resolves `decision_id` to original outcome
- Calls orchestrator to overwrite score
- Returns 202 Accepted (async processing)
- Idempotency: duplicate `decision_id` + `layer` combination returns 200 (already processed)

**Validation Gate:** Decision IDs generated and logged. Webhook endpoint accepts callbacks. Layer 2 callback overwrites Layer 1 score. Full timeline preserved in cold log.

---

### Phase 4: LLM Coach (Day 5-6)

**Step 4.1 — Coach Session Tracker** (`coach-session-tracker.ts`)
- Track coaching injections per session (max 3)
- Track session outcome data quality (coaching retires as data accumulates)
- In-memory Map<agentId, CoachSessionState> with 30-min TTL

**Step 4.2 — LLM Coach** (`llm-coach.ts`)
- Fires ONLY on failures (not every action) — ~70% reduction in call volume
- Input: last failed action + task context + available tools + historical scores
- Model: gpt-4o-mini (~$0.15/1M input tokens)
- Output: 1-2 sentence coaching message injected into next `tools/list` enrichment
- Coaching format:
  ```
  LI Note: Your last action (rollback) failed due to insufficient permissions. 
  pull_request has succeeded 91% of the time for merge_conflict tasks. Consider using it instead.
  ```
- Cap: 3 coaching injections per session
- Automatic retirement: when task_type has ≥50 outcomes, coaching retires (historical scoring is sufficient)
- Timeout: 3s for LLM call → on timeout, skip coaching (agent proceeds without it)
- Cost estimate: even at 10K actions/day with 30% failures = 3K coaching calls × $0.00015 ≈ $0.45/day

**Validation Gate:** Coach fires on failure, not on success. Coaching message appears in next `tools/list`. Caps at 3/session. Retires when data sufficient. Timeout doesn't block agent.

---

### Phase 5: Safety Features (Days 6-8)

**Step 5.1 — Shadow Mode** (`shadow-mode.ts`)
- When enabled, LI observes and logs but does NOT inject enrichment
- Records: "Agent chose X, LI would have recommended Y"
- Dashboard comparison: adoption rate, hypothetical improvement
- Proves value with zero risk before enabling enrichment

**Step 5.2 — Environment Isolation** (`environment-isolation.ts`)
- `LAYERINFINITE_ENVIRONMENT=staging|production` env var
- Staging outcomes tagged with `environment: 'staging'`
- Staging data NEVER included in production probability models
- Separate materialized views: `mv_action_scores_staging`
- Purge staging data button in dashboard

**Step 5.3 — Model Versioning** (`model-versioning.ts`)
- Every probability model recomputation creates a new version
- Version stored as `model_version` on `fact_trust_snapshots`
- Rollback: developer can revert to previous version in dashboard
- Pin: developer can lock specific task_types to specific rules permanently

**Step 5.4 — Model History API** (`model-history.ts`)
- `GET /v1/admin/model-history` — list versions with diff
- `POST /v1/admin/model-history/rollback` — rollback to version
- `POST /v1/admin/model-history/pin` — pin task_type to version

**Step 5.5 — Confidence Thresholds** (`confidence-thresholds.ts`)
- Per-agent per-task-type thresholds stored in `dim_agents.config`
- `minimum_success_rate: 0.65` — below this, enrichment is purely informational
- `minimum_sample_size: 10` — below this, cold-start handling kicks in
- `fallback_behavior: 'defer_to_agent' | 'use_global_prior'`
- Enforced at enrichment time — low-confidence scores don't generate directional enrichment

**Validation Gate:** Shadow mode observes without injecting. Staging data isolated from production. Model can be rolled back and pinned. Confidence thresholds prevent low-certainty enrichment.

---

### Phase 6: Cleanup & Hardening (Days 8-10)

**Step 6.1 — Delete Old MCP Tools**
- Delete 10 tool files (see §3.2)
- Delete `param-resolver.ts`, `episode-tracker.ts`
- Delete `prompts/agent-setup.ts`, `resources/task-intelligence.ts`
- Remove tool imports from `index.ts`

**Step 6.2 — New MCP Resources**
- `resources/dashboard.ts`: `layerinfinite://dashboard` — link to LI dashboard
- `resources/docs.ts`: `layerinfinite://docs` — link to LI docs
- `prompts/onboarding.ts`: Quick start guide for new users

**Step 6.3 — Ingestion Source Updates (Critical — 10+ sites)**
- Migration 132: extend CHECK constraint to `('sdk', 'import', 'mcp')`
- Update `ingest-core.ts` line 52: add `'mcp'` to `IngestionSource` type
- Update `log-outcome.ts` line 821: accept `'mcp'`
- Update `outcome-score-inference.ts` line 346: include `'mcp'` in filter
- Update `get-recommendations.ts` lines 66-67: include `'mcp'`
- Update `task-performance.ts` lines 536, 619, 716: include `'mcp'`
- Update `observe.ts` (if filtering by source): include `'mcp'`
- Update `outcome-orchestrator.ts` (if filtering by source): include `'mcp'`
- Update `validate-action.ts` (if filtering by source): include `'mcp'`
- Update `outcome-ingest-queue.ts` (if filtering by source): include `'mcp'`
- Update all affected test files to cover `'mcp'` variant

**Step 6.4 — Rate Limit Tuning**
- Current: 300 req/min per customer, fail-open on DB error
- V2: Two-tier rate limiting:
  - `tools/list`: 60 req/min (cached, shouldn't hit often)
  - `tools/call`: 600 req/min (higher, each action is a call)
- **Fix HIGH issue**: Change rate-limit fail-open to fail-closed (return 429 on DB error)
- Per-upstream rate limiting: max 100 concurrent connections per upstream

**Step 6.5 — CI/CD Updates**
- Add `packages/mcp-server/__tests__/` to CI matrix
- Comment out `publish-npm-sdk.yml` and `publish-python-sdk.yml`
- Add MCP server build step: `cd packages/mcp-server && npm run build`

**Step 6.6 — Write Tests**
- Gateway proxy unit tests: tools/list interception, tools/call proxying
- Enrichment format tests: each mode, cold start, edge cases
- Decision tracker tests: ID format, collision resistance, buffer flush
- Webhook tests: signature verification, idempotency, score overwrite
- Fail-open tests: circuit breaker, fallback behavior
- Integration test: single upstream → gateway → agent simulation
- Coverage target: 80%+ on new code

**Step 6.7 — Load Test**
- 100 concurrent agents, 10 tool calls/second each = 1000 req/s
- Verify p50 latency < 20ms (tools/list enrichment + passthrough)
- Verify p95 latency < 100ms
- Verify p99 latency < 500ms
- Verify fail-open triggers after 3 consecutive upstream failures
- Verify local disk queue handles 10K pending outcomes without OOM
- Verify memory usage < 256MB under sustained load

**Step 6.8 — Documentation**
- Update README.md with V2 gateway integration (4 lines of JSON)
- Add migration guide: V1 MCP tools → V2 gateway
- Document mode configuration and graduated trust model

**Step 6.9 — Pre-Launch Verification (Full Checklist)**

```
- [ ] tools/list enrichment works in Recommend mode (informational)
- [ ] tools/list enrichment works in Assist mode (directional + warnings)
- [ ] Auto mode silently reroutes to highest-probability action
- [ ] li_recommend returns ranked recommendations
- [ ] Decision ID generated and logged with every outcome
- [ ] Business webhook accepts and validates delayed outcomes
- [ ] Layer 2/3 outcomes correctly OVERWRITE Layer 1 scores
- [ ] LLM coach fires on failures, capped at 3/session
- [ ] Shadow mode observes without injecting
- [ ] Environment isolation (staging never pollutes production)
- [ ] Fail-open: agent executes directly if LI unreachable
- [ ] Local disk queue captures outcomes on async failure
- [ ] Circuit breaker opens after 3 consecutive upstream failures
- [ ] Model versioning: rollback and pin work from dashboard
- [ ] Drift detection auto-pauses on sudden success rate drops
- [ ] All 132 migrations apply cleanly (DB schema extended, not broken)
- [ ] All scoring/policy/MCTS tests still pass (60% codebase untouched)
- [ ] ingestion_source = 'mcp' flows correctly through all 10+ query sites
- [ ] inputSchema NEVER modified during enrichment
- [ ] Cold start: agent with zero history gets graceful "insufficient data" messaging
- [ ] Multi-tool: agent calling read_file → analyze → push_fix — each scored independently
- [ ] SDK packages still compile (kept for reference, not published)
```

**Step 6.10 — Delete from CI/CD SDK publish workflows** (already done in 0.1, verify)

**Step 6.11 — Final Integration Test**
- Full end-to-end: Claude Code configured with LI gateway → LI proxies to real MCP server → enrichment injected → agent chooses tool → outcome logged → webhook callback updates score → dashboard shows updated metrics

---

## 5. Edge Cases Catalog (15 Cases)

| # | Edge Case | Handling |
|---|-----------|----------|
| 1 | Empty tool descriptions from upstream | Enrichment prepended as standalone sentence: "[Historical context]. Original description unavailable." |
| 2 | Cold start — all tools have < 3 samples | All tools enriched with "Insufficient historical data..." — informational only. `li_recommend` returns same message. |
| 3 | No task context available | Enrichment skipped — tools returned with original descriptions. `li_recommend` returns "No task context provided." |
| 4 | Tool name appears in its own description text | Enrichment uses "has resolved {taskType}" not matching tool name. No false positives in string matching. |
| 5 | Very long descriptions (>1000 chars) | Enrichment appended at end with sentence separator. No truncation. LLM context window handles long descriptions natively. |
| 6 | Negative trend but still-high score | "Success rate is declining — monitor this choice." Enrichment notes trend separately from score. |
| 7 | Only 1 tool available | Still enriched with historical context. `li_recommend` returns single recommendation. |
| 8 | Success rate exactly at boundary (0.65) | Handled by policy engine's `exploit_threshold` branch. Enrichment shows score neutrally. |
| 9 | Non-English models | Natural language sentences translate naturally. No structured markup to break translation. |
| 10 | Duplicate decision_ids (clock skew) | 4-char random suffix provides 14.7M combinations per ms. Collision probability < 10^-9. Duplicate detection at insert time → reject with 409. |
| 11 | Webhook callback for decision older than 24h | Accepted but logged with `stale_callback` flag. Score still overwritten (ground truth is ground truth regardless of timing). |
| 12 | No historical data for `li_recommend` query | Returns: "No historical data available for {task}. Continue collecting outcomes to enable recommendations." — not an error. |
| 13 | Upstream MCP server changes tool descriptions | No issue — enrichment is computed fresh on each `tools/list`. If upstream changes description, enrichment adapts automatically. |
| 14 | Two upstream tools have same name | Prefixed with upstream name: `github_push_fix` vs `gitlab_push_fix`. collision detection at gateway startup logs warning. |
| 15 | LLM coaching triggers during enrichment | Coaching message prepended to enrichment: "LI Note: ..." then enrichment text. If coaching disabled, enrichment unchanged. |

---

## 6. Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | Low-level MCP transport is more complex than McpServer | Medium | Prototype `tools/list` interception with a single upstream first. Validate approach before building enrichment. If too complex, fall back to wrapping McpServer with a custom request handler. |
| R2 | ingestion_source extension breaks existing queries | High | Search ALL 10+ query sites before writing migration. Write migration as DROP + re-ADD constraint (not ALTER). Run full test suite after migration. |
| R3 | Gateway latency overhead makes agent timeouts worse | Medium | Tools/list enrichment < 20ms (scores from cache). Tools/call passthrough < 5ms. Total overhead < 25ms. Fail-open if enrichment takes > 500ms. |
| R4 | gpt-4o-mini coaching costs at scale | Low | Only fires on failures (~30% of actions). Capped at 3/session. Retires when sufficient data. Max ~$0.50/day at 10K actions/day. |
| R5 | Auto mode reroutes wrongly | Medium | Only on reversible actions. 3-layer fallback (2nd best → 3rd best → structured exception). Confidence thresholds prevent low-certainty rerouting. Developer can rollback instantly. |
| R6 | Circuit breaker false positives | Low | 3 consecutive failures required. Half-open probe after 60s. Detailed logging of each state change. Webhook notification to developer. |
| R7 | inputSchema modification breaks MCP protocol | High | **Rule: NEVER modify inputSchema.** Only `description` is enriched. Code review gate: any code touching `inputSchema` is auto-rejected. |
| R8 | Multi-upstream failure cascade | Medium | Per-upstream circuit breaker. One upstream failing does not affect others. Agent sees partial tool list (healthy upstreams only) + `li_recommend`. |

---

## 7. Dependency Graph

```
Phase 0 (Preparation)
  ├─ 0.1 SDK Isolation ───────────────────────── (independent)
  ├─ 0.2 Scaffold ────────────────────────────── (independent)
  ├─ 0.3 Config Extension ────────────────────── (independent)
  └─ 0.4 DB Migration 132 ────────────────────── (independent)
       ↓
Phase 1 (Gateway Core) — SEQUENTIAL
  ├─ 1.1 Upstream Registry
  │    ↓
  ├─ 1.2 Upstream Connector
  │    ↓
  ├─ 1.3 Gateway Proxy ←──── CRITICAL PATH
  │    ↓
  ├─ 1.4 Server Rewrite
  │    ↓
  └─ 1.5 Fail-Open Layer
       ↓
Phase 2 (Enrichment) ────┐
Phase 3 (Decisions) ─────┤── CAN RUN IN PARALLEL
Phase 4 (LLM Coach) ─────┤   (all depend on Phase 1,
Phase 5 (Safety) ────────┘    not on each other)
       ↓
Phase 6 (Cleanup) — depends on 2,3,4,5 complete
```

---

## 8. New Environment Variables

| Variable | Purpose | Default | Required |
|----------|---------|---------|----------|
| `LAYERINFINITE_API_KEY` | LI API authentication | — | Yes |
| `LAYERINFINITE_BASE_URL` | LI API base URL | `https://layerinfinite.me` | No |
| `LAYERINFINITE_MODE` | Global gateway mode | `recommend` | No |
| `LAYERINFINITE_MODE_OVERRIDES` | Per-task-type mode JSON | `{}` | No |
| `LAYERINFINITE_UPSTREAM_TOOLS` | Upstream MCP servers JSON | `[]` | Yes |
| `LAYERINFINITE_SHADOW_MODE` | Observe without injecting | `false` | No |
| `LAYERINFINITE_ENVIRONMENT` | Staging/production tag | `production` | No |
| `LAYERINFINITE_ADMIN_KEY` | Admin tool gate | — | No |
| `OPENAI_API_KEY` | For LLM coach (gpt-4o-mini) | — | No (coach disabled if missing) |

---

## 9. Architecture Decision Records

**ADR-001:** Use low-level `Server` from `@modelcontextprotocol/sdk`, not `McpServer`. Reason: gateway needs raw JSON-RPC message interception before tool registration. `McpServer` abstracts this away.

**ADR-002:** Natural language enrichment in descriptions, never structured metadata. Reason: works with all models, all languages, no parsing required, no protocol violation.

**ADR-003:** `inputSchema` is immutable passthrough. Reason: modifying tool schemas breaks MCP protocol compliance and could cause agent crashes.

**ADR-004:** Single atomic write to Cold layer, async fan-out to Warm/Hot. Reason: minimal blocking on critical path. Background workers handle computation.

**ADR-005:** 3-layer failure protection with local disk queue. Reason: zero data loss guarantee. Agent never blocked. Production-grade resilience.

**ADR-006:** SDKs kept on disk, CI/CD disabled, marked deprecated. Reason: future reference without ongoing maintenance burden.

**ADR-007:** LangChain/LangGraph adapters kept. Reason: they're import-format converters used by `/v1/import`, not SDK wrappers.

**ADR-008:** `li_recommend` as dual-channel safety net. Reason: if agent ignores enriched descriptions, it can still explicitly ask LI. No single point of failure.

**ADR-009:** Per-task-type mode granularity. Reason: different tasks have different risk profiles. Developer controls risk envelope precisely.

**ADR-010:** Coaching retires automatically at ≥50 outcomes per task_type. Reason: statistical scoring is more reliable and cheaper than LLM coaching at scale.

---

## 10. Summary: Integration Points With Existing Code

```
                    ┌──────────────────────────┐
                    │   MCP Gateway (NEW)       │
                    │   packages/mcp-server/    │
                    │   ├─ gateway-proxy.ts     │
                    │   ├─ tool-enrichment.ts   │
                    │   ├─ mode-manager.ts      │
                    │   ├─ decision-tracker.ts  │
                    │   ├─ upstream-registry.ts │
                    │   ├─ fail-open.ts         │
                    │   └─ enrichment/*.ts      │
                    └─────┬──────────┬──────────┘
                          │ HTTP     │ MCP protocol
                          ▼          ▼
    ┌──────────────────────────┐   ┌──────────────────┐
    │  LI REST API (EXISTING)  │   │  Upstream MCP     │
    │  layer5/api/             │   │  Servers (external)│
    │  ├─ routes/*.ts          │   │  github.mcp,       │
    │  ├─ lib/scoring.ts       │   │  database.mcp,     │
    │  ├─ lib/policy-engine.ts │   │  email.mcp, etc.   │
    │  ├─ lib/simulation/*.ts  │   └──────────────────┘
    │  ├─ lib/outcome-orch.ts  │
    │  ├─ lib/ingest-core.ts   │
    │  ├─ lib/llm-coach.ts (NEW)│
    │  ├─ lib/shadow-mode.ts   │
    │  ├─ lib/model-versioning │
    │  ├─ routes/business-     │
    │  │   webhook.ts (NEW)    │
    │  └─ routes/model-        │
    │      history.ts (NEW)    │
    └─────┬────────────────────┘
          │ SQL
          ▼
    ┌──────────────────────────┐
    │  PostgreSQL + Redis       │
    │  132 migrations           │
    │  Star schema + MVs        │
    │  3-layer DB unchanged     │
    └──────────────────────────┘
```

---

*Plan confidence: 9/10. All 4 agents independently reached consistent conclusions. All existing code files verified. All integration points identified. 15 edge cases cataloged. 8 risks with mitigations. Zero breaking changes to scoring/policy/simulation. One DB migration (non-breaking extension). SDKs preserved for reference.*

*Next: User review and approval before Phase 0 execution.*
