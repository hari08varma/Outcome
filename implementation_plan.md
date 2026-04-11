# Layerinfinite Production Gap Closure Plan

## Current State

**Engine core**: Production-grade. 51 test files, 440 tests, all green. Scalability hardened (parallel lookups, baseline cache, trust/config cache, DB-backed rate limiter, composite indexes).

**What this plan addresses**: 11 gaps identified across security, data integrity, framework compatibility, and intelligence layers. Gaps are categorized into 4 phases ordered by blast radius — Phase 1 gaps can cause data corruption or security breaches; Phase 4 gaps are strategic enhancements.

---

## Phase 1: Security & Data Integrity (CRITICAL — blocks production deployment)

> [!CAUTION]
> These gaps can cause data corruption, fragmentation, or silent failures in production. Must be fixed before any real user connects.

---

### 1.1 SDK Route Schema Hardening

**Gap**: `log-outcome.ts` has a Zod schema (`LogOutcomeBody` at line 264) but it lacks coercion for edge cases the import route handles gracefully.

**What I found in the code**:
- `outcome_score: z.number().min(0).max(1).optional()` — if someone sends `"high"` (string), Zod will reject it with a parse error at line 457. That's *correct* behavior. The original gap description was partially wrong — Zod DOES validate types. **But**: the error message is generic (`VALIDATION_ERROR:`), not helpful.
- `environment` already has normalization via `.transform()` at line 292. **This gap is already fixed** in the current codebase.
- **Missing**: `outcome_score` percentage auto-detection. Import route converts `85` → `0.85`. SDK route rejects `85` because `max(1.0)` fails. A developer sending `outcome_score: 85` gets a cryptic error.

**Proposed changes**:

#### [MODIFY] [log-outcome.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/routes/log-outcome.ts)
- Add `.preprocess()` to `outcome_score` that detects percentage-style values (>1.0 and ≤100) and divides by 100, matching import behavior
- Add structured error response with field-level details instead of raw `VALIDATION_ERROR:` string
- Add `response_time_ms` coercion: if string `"250"` is sent, convert to number 250 (common in log exports)

#### [NEW] [api/tests/log-outcome-schema-coercion.test.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/tests/log-outcome-schema-coercion.test.ts)
- Test: `outcome_score: 85` → coerced to `0.85`
- Test: `outcome_score: "high"` → 400 with structured field error
- Test: `response_time_ms: "250"` → coerced to `250`
- Test: `environment: "prod"` → normalized to `"production"` (already works, need regression test)

---

### 1.2 Execute Backfill Migration 104

**Gap**: `normalizeActionName()` strips version suffixes (`_v2`, `_test`) on write, but historical `dim_actions` rows still have the old names. This creates fragmentation: new outcomes go to `retry_payment`, old outcomes stay under `retry_payment_v2`. The scoring engine treats them as separate actions with separate success rates.

**What I found in the code**:
- Migration 104 (`backfill_fragmented_actions`) is well-written: dry-run by default, audit trail, trigger management, row count limits.
- Migration 105 (`harden_fragmented_action_backfill`) adds safety harnesses.
- **Neither has been executed against production data** (only the DDL/function creation has run).

**Proposed changes**:

#### [NEW] [scripts/run-backfill-104.sql](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/scripts/run-backfill-104.sql)
- Step 1: `SELECT * FROM preview_fragmented_action_merges(NULL) LIMIT 200;` — read-only preview
- Step 2: `SELECT * FROM backfill_fragmented_actions(NULL, true, 500000);` — dry-run with audit
- Step 3: Manual review of `action_fragmentation_backfill_details` table
- Step 4: `SELECT * FROM backfill_fragmented_actions(NULL, false, 500000);` — apply
- Step 5: `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;` — force MV refresh

> [!IMPORTANT]
> This is a one-time operation. Must be run during a maintenance window. After execution, all future writes are automatically canonical due to `normalizeActionName()` in the SDK/import paths.

---

## Phase 2: Framework Compatibility (HIGH — blocks agent framework users)

> [!WARNING]
> Without these, developers using LangChain/LangGraph/CrewAI cannot import their historical data into Layerinfinite.

---

### 2.1 LangChain/LangGraph Trace Adapter

**Gap**: The import parser's 5 strategies (JSON → JSONL → embedded JSON → CSV → key=value) don't understand LangChain's nested `runs[]` structure where `run_type: "tool"` contains the actual action outcomes.

**LangSmith export format** (what developers will actually send):
```json
{
  "runs": [
    {
      "run_type": "chain",
      "name": "AgentExecutor",
      "child_runs": [
        {
          "run_type": "tool",
          "name": "search_database",
          "inputs": {"query": "..."},
          "outputs": {"result": "..."},
          "error": null,
          "execution_order": 1,
          "start_time": "2026-04-10T10:00:00Z",
          "end_time": "2026-04-10T10:00:01.2Z",
          "extra": {"token_usage": {"total_tokens": 450}}
        }
      ]
    }
  ]
}
```

**Proposed changes**:

#### [NEW] [api/lib/adapters/langchain-adapter.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/adapters/langchain-adapter.ts)
- `flattenLangChainTrace(trace: unknown): NormalizedOutcomeRow[]`
- Extracts only `run_type: "tool"` runs (skips `chain` and `llm` wrapper runs)
- Maps: `name` → `action_name`, `error !== null` → `success: false`, duration → `response_time_ms`
- Groups by `parent_run_id` to reconstruct episodes
- Extracts `token_usage.total_tokens` into a new `metadata.token_cost` field

#### [NEW] [api/lib/adapters/langgraph-adapter.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/adapters/langgraph-adapter.ts)
- `flattenLangGraphCheckpoint(checkpoint: unknown): NormalizedOutcomeRow[]`
- LangGraph uses a different structure: state transitions with `node_name` → `channel_values`
- Maps: `node_name` → `action_name`, state transition success → `success`

#### [MODIFY] [import.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/routes/import.ts)
- Add `format` query param: `auto` (default), `langchain`, `langgraph`, `csv`, `jsonl`
- When `format=langchain`: route raw payload through `flattenLangChainTrace()` before existing pipeline
- When `format=auto`: detect LangChain format by checking for `runs[]` array with `run_type` field

#### [NEW] [api/tests/adapters/langchain-adapter.test.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/tests/adapters/langchain-adapter.test.ts)
- Test: nested 3-level chain → extracts only tool-level runs
- Test: tool with `error: "TimeoutError"` → `success: false`, `error_message: "TimeoutError"`
- Test: tool with no `outputs` → `success: false` (incomplete execution)
- Test: `token_usage` extracted correctly
- Test: episode_id generated from parent chain run_id

#### [NEW] [api/tests/adapters/langgraph-adapter.test.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/tests/adapters/langgraph-adapter.test.ts)
- Test: state transition extraction
- Test: node with error state → failure mapping

---

### 2.2 Token/Resource Cost Tracking

**Gap**: Agent frameworks report `token_usage.total_tokens` per step. This is critical for "did this action cost too much for the value it produced?" Layerinfinite has no cost field.

**Proposed changes**:

#### [NEW] [supabase/migrations/117_add_resource_cost_to_fact_outcomes.sql](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/supabase/migrations/117_add_resource_cost_to_fact_outcomes.sql)
- `ALTER TABLE fact_outcomes ADD COLUMN resource_cost_units numeric DEFAULT NULL;`
- `ALTER TABLE fact_outcomes ADD COLUMN resource_cost_type text DEFAULT NULL CHECK (resource_cost_type IN ('tokens', 'api_calls', 'compute_seconds', NULL));`
- Add to `mv_action_scores`: `avg_resource_cost numeric` (average cost per outcome for this action)
- Index: `CREATE INDEX idx_fact_outcomes_resource_cost ON fact_outcomes (action_id, resource_cost_units) WHERE resource_cost_units IS NOT NULL;`

#### [MODIFY] [log-outcome.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/routes/log-outcome.ts)
- Add `resource_cost_units: z.number().min(0).optional()` to `LogOutcomeBody` schema
- Add `resource_cost_type: z.enum(['tokens', 'api_calls', 'compute_seconds']).optional()` to schema
- Pass through to `insertCoreOutcome`

#### [MODIFY] [ingest-core.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/ingest-core.ts)
- Add `resource_cost_units` and `resource_cost_type` to `NormalizedOutcomeRow` interface
- Include in DB insert payload

#### [MODIFY] [import.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/routes/import.ts)
- Add field extraction aliases: `token_usage`, `total_tokens`, `cost`, `tokens` → `resource_cost_units`
- LangChain adapter extracts this automatically

---

## Phase 3: Intelligence Layer (MEDIUM — differentiator features)

> [!NOTE]
> These features transform Layerinfinite from "outcome tracking" to "outcome intelligence." They use existing infrastructure but add new scoring dimensions.

---

### 3.1 Cross-Action Cluster Scoring

**Gap**: `semantic_cluster_key` is computed and stored on every outcome (e.g., `payments__retry`, `support__escalate`) but never used in the scoring engine. Related actions don't share learnings.

**What I found in the code**:
- `inferSemanticActionCluster()` in `semantic-action-cluster.ts` already produces `clusterKey`, `domain`, `intent`, `confidence`
- These are stored in `fact_outcomes` as `semantic_cluster_key` and `semantic_cluster_domain`
- `computeCompositeScore()` in `scoring.ts` does NOT read cluster data
- `mv_action_scores` does NOT aggregate by cluster

**Proposed changes**:

#### [NEW] [supabase/migrations/118_add_cluster_scoring.sql](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/supabase/migrations/118_add_cluster_scoring.sql)
- Create `mv_cluster_scores` materialized view:
  ```sql
  SELECT semantic_cluster_key, customer_id,
         AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as cluster_success_rate,
         COUNT(*) as cluster_total_attempts,
         AVG(outcome_score) as cluster_avg_score
  FROM fact_outcomes
  WHERE is_deleted = false AND semantic_cluster_key IS NOT NULL
  GROUP BY semantic_cluster_key, customer_id
  ```
- Add refresh to existing cron schedule

#### [MODIFY] [scoring.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/scoring.ts)
- In `getScores()`: fetch cluster-level aggregates alongside action-level scores
- In `computeCompositeScore()`: when action has < 10 outcomes but its cluster has 50+, blend cluster success rate as a Bayesian prior (weight = `max(0, (10 - n) / 10) * 0.15`)
- This gives cold-start actions a head start if similar actions in their cluster perform well

---

### 3.2 Predictive Drift Detection

**Gap**: Current drift detection is reactive — the `recluster_action_aliases()` cron (migration 103) runs at 04:00 UTC and checks if success rate drifted >15% between raw and canonical forms. But it only detects drift *after* it has already happened. No early warning.

**What I found in the code**:
- `trend_delta` is computed per action in `mv_action_scores` (week-over-week change)
- `detectContextDrift()` in `outcome-orchestrator.ts` runs per-outcome but only checks if context is known
- `degradation_alert_events` table already supports alert storage
- No sliding window regression or predictive alerting exists

**Proposed changes**:

#### [NEW] [api/lib/predictive-drift.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/predictive-drift.ts)
- `predictDrift(actionId, customerId, contextId): DriftPrediction`
- Fetches last 20 outcomes for this action, ordered by timestamp
- Computes simple linear regression: `y = a + bx` where y = outcome_score, x = sequence index
- If projected score in next 20 outcomes breaches threshold (< 0.3 success rate): emit `predicted_degradation` alert
- Uses `degradation_alert_events` with `alert_type = 'predicted_drift'`
- Deduplicate: only one prediction alert per action per 24h window

#### [MODIFY] [outcome-orchestrator.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/lib/outcome-orchestrator.ts)
- Add `predictiveDriftCheck()` as a new fire-and-forget task in `orchestrateOutcome()`
- Only runs when action has ≥ 20 outcomes (below that, prediction is meaningless)

#### [NEW] [tests/layer4/predictive-drift.test.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/tests/layer4/predictive-drift.test.ts)
- Test: 20 outcomes with declining scores → alert emitted
- Test: 20 outcomes with stable scores → no alert
- Test: 15 outcomes (< threshold) → no prediction attempted
- Test: alert deduplication within 24h window

---

### 3.3 Intermediate Step Scoring (Per-Step Episode Intelligence)

**Gap**: For multi-step agents (LangGraph), Layerinfinite knows the episode succeeded/failed via `backprop_episode_id`, but doesn't score intermediate steps independently. A 5-step agent has reward backprop on episode end — but no real-time "step 3 is the bottleneck" signal.

**What I found in the code**:
- `episode_id`, `episode_history`, `backprop_episode_id` all exist in the schema
- Reward backpropagation (`reward-backprop.ts`) runs post-hoc with temporal-difference decay
- No per-step success rate tracking exists

**Proposed changes**:

#### [NEW] [supabase/migrations/119_add_step_performance_view.sql](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/supabase/migrations/119_add_step_performance_view.sql)
- Create `mv_step_performance` materialized view:
  ```sql
  SELECT action_id, customer_id, episode_position,
         AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END) as step_success_rate,
         COUNT(*) as step_attempts,
         AVG(response_time_ms) as step_avg_latency
  FROM fact_outcomes fo
  JOIN fact_decisions fd ON fd.id = fo.decision_id
  WHERE fo.is_deleted = false AND fd.episode_position IS NOT NULL
  GROUP BY action_id, customer_id, episode_position
  ```

#### [MODIFY] [get-scores.ts](file:///c:/Users/kusta/Layerinfinite/Outcome/layer5/api/routes/get-scores.ts)
- When `episode_history` is provided: fetch `mv_step_performance` for the current step position
- Add `step_performance` to response: `{ position: 3, historical_success_rate: 0.72, is_bottleneck: true }`
- `is_bottleneck` = true when this step's success rate is >20% below the episode average

---

## Phase 4: Context Quality Signal (STRATEGIC — future differentiator)

> [!NOTE]
> This is the hardest gap and addresses RAG quality. Build only after Phases 1-3 are shipped and validated with real users. Noted here for architectural planning.

---

### 4.1 Context Quality Dimension

**Gap**: Engine can't differentiate "the action was right but the context was wrong" from "the action was wrong."

**Not implementing now.** Requires:
- A context similarity score comparing the retrieved context to the ideal context
- Integration with embedding models to compute semantic distance
- A new `context_quality` column in `fact_outcomes`
- A separate scoring dimension in `computeCompositeScore()`

**Defer to v2** once real users report this as a pain point.

### 4.2 Semantic Hallucination Detection

**Out of scope.** This is an LLM evaluation problem (checking if output content is factually correct), not an outcome scoring problem. Layerinfinite's role is to score whether the *action choice* was correct, not whether the *LLM output* was accurate.

---

## Execution Order

| Priority | Gap | Phase | Estimated effort | Risk |
|----------|-----|-------|-----------------|------|
| 1 | SDK Schema Hardening (1.1) | Phase 1 | 2-3 hours | Low |
| 2 | Execute Backfill 104 (1.2) | Phase 1 | 1 hour (scripted) | Medium — data mutation |
| 3 | Token/Cost Tracking (2.2) | Phase 2 | 3-4 hours | Low |
| 4 | LangChain Adapter (2.1) | Phase 2 | 6-8 hours | Medium |
| 5 | Cross-Action Cluster Scoring (3.1) | Phase 3 | 4-5 hours | Low |
| 6 | Predictive Drift (3.2) | Phase 3 | 3-4 hours | Low |
| 7 | Step Performance (3.3) | Phase 3 | 4-5 hours | Low |
| 8 | Context Quality (4.1) | Phase 4 | Deferred | — |
| 9 | Hallucination Detection (4.2) | Phase 4 | Out of scope | — |

**Total estimated engineering time**: ~24-30 hours across Phases 1-3.

---

## Verification Plan

### Automated Tests
- `npx vitest run` — full suite must remain green after each change
- New test files for each feature (listed above)
- Schema coercion tests for SDK boundary

### Integration Checks
- Import a real LangSmith trace export file (can generate synthetic from LangSmith docs)
- Verify action normalization + cluster scoring end-to-end
- Verify backfill 104 dry-run output matches expected merge candidates

### Manual Verification
- Run backfill 104 dry-run on production DB, review audit rows
- Confirm `mv_action_scores` reflects merged actions after backfill apply
