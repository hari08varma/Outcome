# Scalability Hardening Report

Date: 2026-04-11
Scope: Production-readiness performance and multi-instance resilience improvements

## Executive Summary

Implemented the highest-impact and safe scalability fixes end-to-end:

1. Parallelized independent DB lookups in log-outcome.
2. Added 2-minute cache for action baseline inference reads.
3. Added 60-second cache for trust/config reads in get-scores.
4. Switched decision persistence in get-scores to non-blocking buffered path while preserving immediate decision_id contract.
5. Replaced process-local rate limiter with DB-backed limiter using rate_limit_buckets.
6. Added new composite fact_outcomes index as a forward migration.

Intentionally not implemented in this pass:

1. Async idempotency record write in log-outcome (kept synchronous to avoid replay race/duplication risk).
2. Async cohort upsert in get-recommendations (deferred because response currently depends on returned cohort data and reliability computation).

## Implemented Changes

### Fix 1: Parallelize resolveActionId + resolveContextId + resolveRetryChainState

- File: api/routes/log-outcome.ts
- Change: Converted sequential awaits into Promise.all for three independent lookups.
- Expected impact: Reduced per-request latency by collapsing multiple round-trip waits into one.

### Fix 2: Cache fetchActionBaseline (2-minute TTL)

- File: api/lib/outcome-score-inference.ts
- Changes:
  - Added in-memory cache keyed by (agent_id, action_id).
  - Added TTL and stale-entry cleanup.
  - Added cache reset helper for tests.
  - Added targeted invalidation helper.

- Invalidation wiring:
  - api/routes/log-outcome.ts
  - api/lib/ingest-core.ts
  - api/routes/outcome-feedback.ts

- New tests:
  - api/tests/outcome-score-inference-cache.test.ts

### Fix 6: Cache getAgentTrust + getCustomerConfig (60-second TTL)

- File: api/routes/get-scores.ts
- Changes:
  - Added route-level TTL caches for trust/config lookups.
  - Added cleanup timer and cache reset helper for tests.

### Fix 4: Make decision persistence non-blocking safely

- File: api/routes/get-scores.ts
- Change:
  - Replaced awaited persistDecision call with bufferDecision.
  - decision_id is still returned immediately and remains stable for downstream linkage.

- Test updates:
  - tests/layer4/get-scores-environment.test.ts

### Fix 8: DB-backed rate limiter using existing rate_limit_buckets table

- File: api/middleware/rate-limit.ts
- Changes:
  - Removed process-local Map bucket logic.
  - Added RPC-backed consume operation call.
  - Added fail-open/fail-closed behavior via RATE_LIMIT_FAIL_OPEN.
  - Uses hashed customer bucket key.

- New migration:
  - supabase/migrations/115_add_rate_limit_consume_rpc.sql
  - Adds consume_rate_limit_bucket(...) atomic RPC and grant.

- Test updates:
  - api/tests/rate-limit.test.ts rewritten for DB-backed behavior.

### Fix 7: Add composite index via new migration

- New migration:
  - supabase/migrations/116_add_fact_outcomes_customer_agent_task_source_index.sql

- Index added:
  - idx_fact_outcomes_customer_agent_task_source
  - Keys: (customer_id, agent_id, task_name, ingestion_source, timestamp DESC)
  - Partial predicate: non-deleted, non-synthetic, task_name IS NOT NULL.

### Fix 9: MV refresh debounce

- Confirmed already present and left unchanged:
  - api/routes/log-outcome.ts

## Safety Decisions

### Kept synchronous (not converted to fire-and-forget)

- saveIdempotencyRecord in log-outcome remained synchronous to preserve strong replay semantics and avoid duplicate outcome insertion races.

### Deferred

- upsertRecommendationCohortCycle in get-recommendations remains synchronous because current response payload includes cohort_cycle and cohort_reliability derived from RPC output.

## Validation Results

All targeted validations passed:

1. API focused tests:
   - tests/rate-limit.test.ts
   - tests/outcome-score-inference-cache.test.ts
   - tests/log-outcome.test.ts
   - tests/log-outcome-sanitize.test.ts
   - tests/verifier.test.ts
   - tests/outcome-feedback.test.ts

2. Layer tests:
   - tests/layer4/get-scores-environment.test.ts

3. Typecheck:
   - api: npm run typecheck

## Migration Apply Notes

Apply new migrations after existing 114:

1. 115_add_rate_limit_consume_rpc.sql
2. 116_add_fact_outcomes_customer_agent_task_source_index.sql

## Changed Files

- api/lib/outcome-score-inference.ts
- api/routes/log-outcome.ts
- api/lib/ingest-core.ts
- api/routes/outcome-feedback.ts
- api/routes/get-scores.ts
- api/middleware/rate-limit.ts
- api/tests/rate-limit.test.ts
- api/tests/outcome-score-inference-cache.test.ts
- api/tests/verifier.test.ts
- api/tests/log-outcome-sanitize.test.ts
- tests/layer4/get-scores-environment.test.ts
- supabase/migrations/115_add_rate_limit_consume_rpc.sql
- supabase/migrations/116_add_fact_outcomes_customer_agent_task_source_index.sql
