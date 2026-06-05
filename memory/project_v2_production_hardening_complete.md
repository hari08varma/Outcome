---
name: v2-production-hardening-complete
description: "All V2 production hardening items implemented (2026-05-31). MCP gateway tests written, 6 gaps fixed. 17 test files, 224 tests. Ready to commit."
metadata:
  type: project
  originSessionId: 816aae12-737a-4d68-a361-1841daa99f23
---

# V2 Production Hardening — COMPLETE (2026-05-31)

All production hardening items for the V2 MCP Gateway Proxy have been implemented in the working tree. NOT committed.

## What Was Done This Session

### 1. MCP Gateway Test Suite (Phase 1 — WAS the critical gap)

Wrote 15 unit test files (later expanded to 17) covering all gateway modules:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `__tests__/config.test.ts` | 23 | Env var parsing, validation, modes, upstreams, classifier, immutability |
| `__tests__/cache-keys.test.ts` | 11 | All 9 cache key patterns, tenant isolation |
| `__tests__/gateway-errors.test.ts` | 5 | All 4 error types, interface conformance |
| `__tests__/enrichment/format-recommend.test.ts` | 12 | Recommend mode — trends, sample sizes, descriptions |
| `__tests__/enrichment/format-assist.test.ts` | 15 | Assist mode — ranking, warnings, cautions, alternatives, trends |
| `__tests__/enrichment/format-auto.test.ts` | 3 | Auto mode passthrough |
| `__tests__/mode-manager.test.ts` | 11 | Mode resolution, overrides, caching, TTL expiry |
| `__tests__/tool-enrichment.test.ts` | 12 | Enrichment orchestration, ranking, categories, mode dispatch |
| `__tests__/outcome-classifier.test.ts` | 12 | Rule-based classification, error keywords, task types |
| `__tests__/decision-tracker.test.ts` | 14 | Decision IDs, episodes, coaching, buffer flush, timer |
| `__tests__/fail-open.test.ts` | 20 | Circuit breaker, disk queue, backoff, queue processing |
| `__tests__/li-recommend-tool.test.ts` | 10 | Virtual tool creation, formatting, rankings, trends, errors |
| `__tests__/score-fetcher.test.ts` | 10 | Cache hits/misses, staleness, warming, error fallback |
| `__tests__/gateway-proxy.test.ts` | 11 | tools/list, tools/call, li_recommend routing, degradation |
| `__tests__/outcome-pipeline.test.ts` | (agent-created) End-to-end pipeline: classifier, tracker, queue, confidence gating |

### 2. Pre-Commit Audit & Fixes

Two agents (Senior Developer + Architect) audited the entire codebase. Found and fixed:

- **2 zero-byte artifacts** at repo root deleted (`0)`, `IPS_WEIGHT_MIN)`)
- **`successRate` scale inconsistency** fixed — `format-assist.ts` now uses 0-1 scale internally, multiplies by 100 for display, matching `format-recommend.ts`
- **Dead code modules wired in** — `resources/dashboard.ts`, `resources/docs.ts`, `prompts/onboarding.ts` are now imported and registered in `index.ts`
- **Broken import fixed** — `UpstreamCallResult` in `outcome-pipeline.test.ts` was importing from wrong module
- **Duplicate test removed** — `gateway-smoke.test.ts` deleted (fully covered by `decision-tracker.test.ts`)

### 3. Production Hardening (Phase 2 — 6 items)

| # | Change | Files Modified |
|---|--------|---------------|
| 1 | `OutcomePayload.environment` narrowed to `'staging' \| 'production'` | `src/types.ts` line 162 |
| 2 | API key rotation — `LAYERINFINITE_API_KEY_2` env var, `apiKeySecondary` config, 401/403 retry in `LiApiClient.request()` | `src/config.ts`, `src/rest-client.ts` (LiApiClient) |
| 3 | `processQueue` concurrency guard — `processQueueRunning` flag with try/finally | `src/fail-open.ts` |
| 4 | `DecisionTracker` max buffer (10,000) + dynamic `environment` param (replaces hardcoded `'production'`) | `src/decision-tracker.ts`, `src/index.ts` |
| 5 | MCP `initialize` handshake — lazy init with coalescing, `notifications/initialized` sent per MCP spec | `src/rest-client.ts` (UpstreamMCPClient) |
| 6 | Integration tests for `rest-client.ts` (11 tests) + `upstream-registry.ts` (11 tests) | `__tests__/rest-client.test.ts`, `__tests__/upstream-registry.test.ts` |

## Current State

- **17 test files, 224 tests, all passing**
- **`tsc --noEmit` passes cleanly**
- **All changes are in the working tree, NOT committed**
- **Version remains `1.0.0`** (user explicitly rejected bumping to 2.0.0)

## What's NOT Done (Deferred)

These items from the Architect's audit are deferred — not blocking commit:

1. **Monitoring/metrics/alerting** — explicitly out of scope
2. **Single-region SPOF** — infrastructure concern
3. **Load tests** — no load testing tool in devDependencies
4. **API key rotation at infrastructure level** — the code supports it via `LAYERINFINITE_API_KEY_2`, but there's no automated rotation scheduler
5. **Per-tenant cache quota**
6. **Incident runbook**

## Still Open Issues (from project_issues_master.md)

Relevant to the MCP gateway (all in layer5 API, NOT in the gateway itself):
- Issue #1: Webhook auth bypass (layer5 API)
- Issue #2: RLS `USING (TRUE)` on dim tables (Supabase)
- Issue #7: Pruning scheduler broken (database)
- Issue #8: dim_actions global uniqueness (database)
- Issue #10: Training lacks customer_id scoping (ML pipeline)

None block the MCP gateway commit.

## Files Created This Session

```
packages/mcp-server/__tests__/config.test.ts
packages/mcp-server/__tests__/cache-keys.test.ts
packages/mcp-server/__tests__/gateway-errors.test.ts
packages/mcp-server/__tests__/mode-manager.test.ts
packages/mcp-server/__tests__/tool-enrichment.test.ts
packages/mcp-server/__tests__/outcome-classifier.test.ts
packages/mcp-server/__tests__/decision-tracker.test.ts
packages/mcp-server/__tests__/fail-open.test.ts
packages/mcp-server/__tests__/li-recommend-tool.test.ts
packages/mcp-server/__tests__/score-fetcher.test.ts
packages/mcp-server/__tests__/gateway-proxy.test.ts
packages/mcp-server/__tests__/rest-client.test.ts
packages/mcp-server/__tests__/upstream-registry.test.ts
packages/mcp-server/__tests__/outcome-pipeline.test.ts
packages/mcp-server/__tests__/enrichment/format-recommend.test.ts
packages/mcp-server/__tests__/enrichment/format-assist.test.ts
packages/mcp-server/__tests__/enrichment/format-auto.test.ts
```

## Files Modified This Session

```
packages/mcp-server/src/types.ts — environment type narrowed
packages/mcp-server/src/config.ts — apiKeySecondary added
packages/mcp-server/src/rest-client.ts — LiApiClient key rotation + UpstreamMCPClient init handshake
packages/mcp-server/src/fail-open.ts — processQueue concurrency guard
packages/mcp-server/src/decision-tracker.ts — max buffer + dynamic environment
packages/mcp-server/src/index.ts — wire dashboard/docs/onboarding resources, DecisionTracker env param
packages/mcp-server/src/enrichment/format-assist.ts — successRate 0-1 scale normalization
```

## Files Deleted This Session

```
packages/mcp-server/__tests__/gateway-smoke.test.ts (duplicate — covered by decision-tracker.test.ts)
<repo-root>/0) (zero-byte artifact)
<repo-root>/IPS_WEIGHT_MIN) (zero-byte artifact)
```

## Verdict

The MCP gateway is production-grade for internal/beta use. 224 tests, type-safe, no secrets, fail-open design, circuit breaker, key rotation support, MCP spec-compliant init handshake. Ready to commit.

**Next session should:** stage all changes (80+ unstaged files), normalize CRLF line endings, and make the V2 commit.

**Why:** After the May 28 V2 implementation and May 31 production hardening, the gateway is complete but uncommitted. The next step is to commit everything as a single squashed commit representing the full V2 transformation.

**How to apply:** On next session, start with `git status` to see the full change set. Stage deletions with `git add -u`, additions with `git add`, review with `git diff --staged`, and commit.
