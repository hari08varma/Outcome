---
name: architecture-v2-migration
description: "V2 implementation migration plan — what code survives (~60%), what gets deleted, what gets created (~22 files), unresolved gaps, risks with mitigations. Companion to architecture_v2_complete."
metadata:
  node_type: memory
  type: project
  originSessionId: bad08b6b-9006-4a4b-acea-88f62b909625
---

# ARCHITECTURE_V2 — Implementation Migration Plan

## Code Survival: ~60% Unchanged

### What Survives (No Changes)
- **Scoring engine** (`layer5/api/lib/scoring.ts`, `policy-engine.ts`) — 6-factor formula, 11-branch policy tree, Bayesian smoothing, LRU cache
- **MCTS simulation** (`layer5/api/lib/simulation/tier3-mcts.ts`, `tier1.ts`, `tier2.ts`, `tier-selector.ts`, `world-model.ts`)
- **10 of 13 recommendation engine files** — including task-performance, reason, cohort-cycle, semantic-action-cluster, outcome-weighting, data-freshness, rollout-flags, constants
- **All 133 SQL migrations** (`layer5/db/`) — star schema, materialized views, RPCs unchanged
- **All dashboard pages** (React + Vite + Tailwind, 15 pages, 12 hooks, 8 components)
- **Training pipeline** (`layer5/training/` — 7 files, LightGBM quantile regression)
- **Middleware** (`auth.ts`, `user-auth.ts`, `admin-auth.ts`, `validate-action.ts`, `rate-limit.ts`)
- **Type augmentation** (`types/hono.d.ts`)
- **CI/CD workflows** (4 files)
- **Ingestion pipeline** (`ingest-core.ts`, `outcome-score-inference.ts`, `verifier.ts`, `schema-inferrer.ts`, `context-embed.ts`)
- **Counterfactuals** (`ips-engine.ts`)
- **Orchestration** (`outcome-orchestrator.ts`, `decision-writer.ts`, `drift-detector.ts`, `predictive-drift.ts`, `sequence-tracker.ts`, `reward-backprop.ts`)
- **Queue** (`outcome-ingest-queue.ts`)
- **Adapters** (`langchain-adapter.ts`, `langgraph-adapter.ts`)
- **Supabase, sanitize, tenant-supabase, webhook-auth libs**
- **All 40+ test files**
- **Seed data, scripts, config.toml**

### What Gets Deleted
- **All 10 MCP tools** (`packages/mcp-server/src/tools/`): li-action, li-log, li-status, li-export, li-import, li-simulate, li-patterns, li-dashboard, li-configure, li-observe
- **param-resolver.ts** — no longer needed (no tool params to resolve)
- **task-intelligence.ts** — replaced by enrichment engine
- **episode-tracker.ts** — replaced by session-level episode tracking at gateway
- **12 of 14 REST routes become internal** (only MCP proxy endpoints exposed externally)

### What Gets Rewritten
- **`packages/mcp-server/src/index.ts`** → Gateway proxy server (handles `tools/list` + `tools/call` passthrough)
- **`packages/mcp-server/src/rest-client.ts`** → Upstream MCP connector (proxies to real tool servers)
- **`packages/mcp-server/src/config.ts`** → Supports multi-tool upstream config + mode config
- **`layer5/api/lib/outcome-orchestrator.ts`** → Adds decision_id generation + webhook callback handling

### What Gets Created (~22 new files)

**Gateway Core (7 files):**
1. `packages/mcp-server/src/gateway-proxy.ts` — Main proxy: intercept tools/list, enrich, forward tools/call
2. `packages/mcp-server/src/tool-enrichment.ts` — Natural language enrichment engine per mode
3. `packages/mcp-server/src/li-recommend-tool.ts` — Virtual li_recommend tool definition
4. `packages/mcp-server/src/mode-manager.ts` — Per-task-type mode resolution (Recommend/Assist/Auto)
5. `packages/mcp-server/src/decision-tracker.ts` — decision_id generation + episode tracking
6. `packages/mcp-server/src/upstream-registry.ts` — Register/health-check upstream MCP servers
7. `packages/mcp-server/src/fail-open.ts` — 3-layer failure protection implementation

**Enrichment Engine (3 files):**
8. `packages/mcp-server/src/enrichment/format-recommend.ts` — Recommend mode formatting
9. `packages/mcp-server/src/enrichment/format-assist.ts` — Assist mode formatting with warnings
10. `packages/mcp-server/src/enrichment/score-fetcher.ts` — Fetches scores from Hot/Warm layer for enrichment

**LLM Coach (2 files):**
11. `layer5/api/lib/llm-coach.ts` — gpt-4o-mini within-session coaching on failures
12. `layer5/api/lib/coach-session-tracker.ts` — Caps 3/session, retires as data accumulates

**Business Layer (2 files):**
13. `layer5/api/routes/business-webhook.ts` — External webhook callback ingestion endpoint
14. `layer5/api/lib/webhook-verifier.ts` — Webhook signature verification + secret management

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

## Risks & Mitigations (Zero Users, Small LLM)

### Risk 1: Breaking existing MCP tools → ELIMINATED (zero users)
**Why:** No production agents depend on current MCP tools. Safe to delete all 10.

### Risk 2: LLM coaching cost at scale → LOW (small LLM design)
**Why:** gpt-4o-mini costs ~$0.15/1M input tokens. Coaching only fires on failures (~30% of actions). Capped at 3/session. Retires automatically as data accumulates. Even at 10K actions/day: ~$0.50/day max. Acceptable.

### Risk 3: Gateway latency overhead → LOW (simple proxy)
**Why:** LI is a thin proxy. tools/list interception adds 5-15ms (score lookup from Redis/memory). tools/call passthrough adds <2ms. Total overhead <20ms. Agent timeouts unaffected. Fail-open if slow.

### Risk 4: Natural language enrichment confuses some LLMs → ELIMINATED (dual channel)
**Why:** Natural language woven into descriptions (not bracketed metadata) — reads like any sentence. Virtual li_recommend tool as safety net. If agent ignores enriched descriptions, it can still explicitly call li_recommend. No single failure point.

### Risk 5: Auto mode reroutes wrongly → LOW (3-layer fallback + reversibility gate)
**Why:** Auto mode only on reversible actions. 3-layer fallback (2nd best → 3rd best → structured exception). Confidence thresholds prevent low-certainty rerouting. Graduated trust requires explicit developer opt-in per task type. Developer can rollback instantly.

### Risk 6: Migration complexity → LOW (clear boundaries)
**Why:** ~60% codebase untouched. Clear delete/create/modify boundaries. MCP server is greenfield within existing package. API routes mostly carry over. Database schema unchanged. Can implement incrementally: gateway proxy → enrichment → LLM coach → safety features.

## Unresolved Gaps (Operational/UX — Solve During/After Implementation)

1. **Multi-tool sequence scoring** — How LI scores read_file→analyze→push_fix as a sequence. Current architecture scores individual tools. Sequence scoring exists in codebase (mv_sequence_scores, sequence-tracker.ts) but enrichment currently only injects per-tool scores. Not a blocker — individual tool routing works first, sequence optimization follows.

2. **Latency budget specifics** — Architecture says "sub-millisecond Redis" and "50ms total" but no p95/p99 targets defined. Set during load testing.

3. **Rate limiting for high-volume agents** — 1000+ tool calls/minute. Rate-limit.ts exists (300 req/min, fail-open). Needs tuning for gateway proxy use case.

4. **Multi-tenant Redis isolation details** — Keys namespaced by Customer ID but implementation details (separate instances vs shared) depend on deployment infrastructure.

5. **Cost model for LI gateway** — Not architected. LI is open-source; users self-host. Gateway costs are their infra costs.

6. **A/B testing framework** — Shadow mode (dry run) exists as a safety feature, but formal A/B testing between LI-routed and non-routed not specified. Can be added post-launch.

7. **Dashboard pages for new V2 features** — Model history page, mode management UI, webhook configuration page, environment tag management, human-in-loop approval queue. These are frontend additions that don't block backend implementation.

8. **SDK sunset path** — TypeScript and Python SDKs exist but will be replaced by MCP gateway. No migration needed (zero users). Just stop publishing updates. Existing npm/pip packages remain for reference.

## Implementation Order (Recommended)

1. Gateway proxy core (tools/list interception + tools/call passthrough) — 7 new files
2. Tool enrichment engine (natural language formatting + score fetcher) — 3 new files
3. li_recommend virtual tool — 1 new file
4. Decision ID + episode tracking — 1 new file
5. LLM coach (within-session failure analysis) — 2 new files
6. Business webhook endpoint — 2 new files
7. Safety features (shadow mode, env isolation, model versioning, confidence thresholds) — 5 new files
8. Dashboard updates for V2 features — frontend additions
9. Delete old MCP tools — 10 file deletions
10. Test, load test, document

## Verification Checklist (Pre-Launch)

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
- [ ] Model versioning: rollback and pin work from dashboard
- [ ] Drift detection auto-pauses on sudden success rate drops
- [ ] All 133 migrations apply cleanly (DB schema unchanged)
- [ ] All scoring/policy/MCTS tests still pass (60% codebase untouched)
