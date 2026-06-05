---
name: product-master-reference
description: "Definitive product reference — architecture, file inventory, production score 3.8/5, 11 gaps fixed on 2026-05-28, 11 remain, 2 open bugs. See PRODUCT_MASTER.md for full details."
metadata: 
  node_type: memory
  type: project
  originSessionId: 93caaee8-9572-42df-82a1-ebb32b5cf977
---

# Product Master Reference

See `C:\Users\kusta\Layerinfinite\Outcome\PRODUCT_MASTER.md` for the full document.

## Key Facts

- **What**: Decision intelligence MCP gateway proxy for AI agents
- **How**: Intercepts tools/list (enrichment) + tools/call (proxy/reroute), logs outcomes, feeds back into scoring
- **Version**: V2 Gateway Proxy (2.0.0), implemented in working tree, NOT committed
- **Architecture**: MCP Gateway → LI REST API → PostgreSQL (Supabase), 134 migrations
- **4 modes**: Bootstrap (observe), Recommend (informational), Assist (directional), Auto (silent reroute)
- **10-layer model**: Memory → Auth → Scoring → Policy → Trending → Trust → IPS → Simulation → Training → Dashboard

## Production Score: 3.8 / 5 (after 2026-05-28 hardening)

| Concern | Score | Change |
|---------|-------|--------|
| Security | 4 | — |
| Reliability | 4 | ↑ rate limits +2000, durable queue default, decision-writer 2s flush |
| Observability | 3 | — |
| Performance | 4 | ↑ postgres queue default, batch 100, poll 500ms |
| Test Coverage | 3 | — |
| Documentation | 2 | — |
| Deployment | 3 | — |
| Multi-tenancy | 4 | — |

## 2026-05-28 Hardening — 11 Gaps Fixed

| Fix | Files Changed |
|-----|--------------|
| Rate limits: 600→2000 tools/call, 300→1000 general | `rate-limit.ts` |
| Decision-writer flush: 5s→2s, buffer 50→100 | `decision-writer.ts` |
| Durable queue: postgres default, batch 100, poll 500ms | `outcome-ingest-queue.ts` |
| Removed downstream_webhook no-op source | `verifier.ts` |
| e2e-verify.js creds → env vars | `e2e-verify.js` |
| get_undelivered_alerts RPC created | `133_create_undelivered_alerts_rpc.sql` (NEW) |
| Deleted debug migration | `128_debug.sql` (DELETED) |
| Removed stale ips-engine TODO | `ips-engine.ts` |
| Cohort cycle DB warm on startup | `cohort-cycle.ts` + `index.ts` |
| Coach session DB persistence | `coach-session-tracker.ts` + `llm-coach.ts` + `134_coach_session_persistence.sql` (NEW) |

## Still Remaining (11 gaps)

**Critical**: Zero MCP gateway tests, single-region SPOF, no monitoring
**High**: No API key rotation, no secret manager, no request tracing, no migration rollback
**Medium**: Static admin key, no load tests, no incident runbook, no per-tenant cache quota
**Low**: Layer4 mock data, dashboard styles, smoke-test, no DB pruning

## Still Open Bugs (2)
- No DB-level pruning for fact_outcomes
- Training tests not in CI

**Why:** This is the definitive reference. Updated after the 2026-05-28 production hardening session where 10 files were modified, 2 migrations created, and 1 debug migration deleted.

**How to apply:** Always reference PRODUCT_MASTER.md and this memory before working on the codebase.
