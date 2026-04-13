# Deployment Readiness Pass (Status + Traceability + Confidence Source)

Date: 2026-04-10
Scope: Binary status contract, structured traceability payloads, confidence_source lifecycle + cohort persistence

## 1) Migration Apply Order (Production)

Apply in two phases.

Phase A -- rollout (immediate):

1. `107_validate_import_and_inference_constraints.sql`
2. `110_add_execution_status_and_failure_trace.sql`
3. `111_align_feedback_mutability_and_discrepancy_trace.sql`
4. `112_harden_status_trace_and_cohort_source.sql`

Phase B -- post-deploy hardening (after data is confirmed clean):

5. `113_validate_status_score_raw_coherence.sql`
6. `114_rpc_upsert_reco_cohort_cycle_confidence_source.sql`

Why this order:
- `110` introduces status/failure columns used by ingestion and feedback routes.
- `111` updates discrepancy schema + mutability trigger for reconciliation fields.
- `112` hardens vocab/coherence constraints and introduces normalized discrepancy naming + cohort confidence-source columns.
- `113` validates the staged status/score coherence constraint only after production data passes pre-check.
- `114` upgrades the cohort-cycle RPC so confidence-source labels are persisted atomically in the same transaction.

## 2) Pre-Deploy Checks

Run before applying DB changes:

1. Confirm app build is green:
   - `cd layer5/api`
   - `npm run typecheck`
2. Confirm target tests are green:
   - `cd layer5`
   - `npx vitest run tests/layer3/recommendation-engine.test.ts tests/layer3/recommendation-cohort-cycle.test.ts tests/layer4/get-scores-environment.test.ts tests/layer5/task-performance-fallback.test.ts tests/layer5/import.test.ts`
   - `cd api`
   - `npx vitest run tests/discrepancy.test.ts tests/outcome-feedback.test.ts tests/layer1/schema.test.ts`
3. Verify DB has migration `093_persist_recommendation_cohort_cycles.sql` already applied before `112`.

## 3) Post-Migration Verification SQL

Run after migration apply:

```sql
-- fact_outcomes status columns present
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name='fact_outcomes'
  AND column_name IN ('execution_status','failure_reason_code','failure_stage','status_origin')
ORDER BY column_name;

-- discrepancy normalized columns present
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name='dim_discrepancy_log'
  AND column_name IN ('reason_code','trace_payload','trace_reason_code','trace_context')
ORDER BY column_name;

-- cohort confidence source columns present
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name='recommendation_cohort_cycles'
  AND column_name IN ('opened_confidence_source','opened_confidence_source_reason')
ORDER BY column_name;

-- migration 112 constraints status
SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'chk_fact_outcomes_failure_reason_code_vocab',
  'chk_fact_outcomes_failure_stage_vocab',
  'chk_fact_outcomes_status_score_raw_coherence',
  'chk_reco_cycle_opened_confidence_source_vocab'
)
ORDER BY conname;

-- optional: check post-deploy hardening migration 113 result
SELECT conname, convalidated
FROM pg_constraint
WHERE conname = 'chk_fact_outcomes_status_score_raw_coherence'
   AND conrelid = 'fact_outcomes'::regclass;
```

Expected:
- `chk_fact_outcomes_failure_reason_code_vocab` -> validated true
- `chk_fact_outcomes_failure_stage_vocab` -> validated true
- `chk_fact_outcomes_status_score_raw_coherence` ->
   - after phase A: present, likely `convalidated=false` (intentional staged hardening)
   - after phase B migration 113: `convalidated=true`
- `chk_reco_cycle_opened_confidence_source_vocab` -> validated true

## 4) Rollback Notes (Fast Recovery)

This release is mostly additive and dual-write friendly.

### A) Write-path failures due to new status checks
Symptoms:
- `STATUS_CONFLICT` responses on `/v1/log-outcome` or import parser rejects more rows.

Immediate mitigation:
1. Disable strict caller-side inputs in clients (omit `execution_status` until producer fixed).
2. If DB constraint blocks urgent writes, drop only the new coherence constraint:

```sql
ALTER TABLE fact_outcomes
DROP CONSTRAINT IF EXISTS chk_fact_outcomes_status_score_raw_coherence;
```

### B) Unexpected failures from bounded failure vocab
Symptoms:
- Inserts fail for `failure_reason_code` or `failure_stage` values outside bounded set.

Immediate mitigation:
- Keep service running by normalizing producers to known tokens.
- Emergency DB unblock (temporary):

```sql
ALTER TABLE fact_outcomes
DROP CONSTRAINT IF EXISTS chk_fact_outcomes_failure_reason_code_vocab;
ALTER TABLE fact_outcomes
DROP CONSTRAINT IF EXISTS chk_fact_outcomes_failure_stage_vocab;
```

### C) Cohort confidence-source persistence errors
Symptoms:
- RPC call `upsert_recommendation_cohort_cycle` fails due to missing new signature.

Impact:
- API falls back to in-memory cycle behavior; cohort metadata remains available but is not durably persisted.

Mitigation:
- Ensure migration `114_rpc_upsert_reco_cohort_cycle_confidence_source.sql` is applied.
- Confirm service role has execute permission on the 8-arg function signature.

### D) Discrepancy trace naming transition issues
Symptoms:
- Consumers reading only old fields or only new fields mismatch.

Mitigation:
- Current implementation dual-writes:
  - old: `trace_reason_code`, `trace_context`
  - new: `reason_code`, `trace_payload`
- Keep consumers tolerant during transition, then converge on normalized fields.

## 5) Staging Smoke Checklist (Mapped to Exact Changes)

### Binary status migration + ingestion contract
1. POST `/v1/log-outcome` with:
   - `success=true`, `execution_status=COMPLETED`, `outcome_score=0.9` -> expect 201.
2. POST `/v1/log-outcome` with:
   - `success=true`, `execution_status=FAILED` -> expect 400 `STATUS_CONFLICT`.
3. POST `/v1/log-outcome` with:
   - `execution_status=COMPLETED`, `outcome_score=0.2` -> expect 400 `STATUS_CONFLICT`.
4. Import dry-run row:
   - `execution_status=FAILED`, no `success` -> expect parser derives `success=false`.
5. Import dry-run row:
   - `execution_status=COMPLETED`, `outcome_score=0.1` -> expect validation error.

### Structured failure traceability payload in recommendation/scoring responses
1. GET `/v1/recommendations?task=...`:
   - response includes `traceability.reason_code`, `traceability.stage`, `traceability.gate`, `traceability.detail`.
2. GET `/v1/get-scores?issue_type=...`:
   - response includes `traceability.reason_code` using normalized taxonomy and `confidence_source_reason`.
3. Trigger discrepancy detection:
   - rows in `dim_discrepancy_log` contain both `reason_code` + `trace_payload` and legacy mirrors.

### Confidence_source lifecycle + cohort integration
1. GET `/v1/recommendations?task=...` for no-data task:
   - expect `confidence_source=bootstrap`.
2. For warmup task:
   - expect `confidence_source=empirical_warmup`.
3. For stable task:
   - expect `confidence_source=empirical_stable`.
4. For simulation-shadow-assisted task:
   - expect `confidence_source=hybrid_shadow`.
5. Verify `recommendation_cohort_cycles` active row for task stores:
   - `opened_confidence_source`
   - `opened_confidence_source_reason`

## 6) Production Grade Assessment

Current state: production-ready with staged-hardening residual tracked only for phase-B validation sequencing.

What is strong:
- Contract checks are implemented in API and shared ingest paths.
- DB schema supports status, normalized discrepancy naming, and cohort source labels.
- Recommendation/scoring responses expose structured traceability and confidence-source reason.
- Targeted tests and typecheck are green.

Residuals to track:
1. `chk_fact_outcomes_status_score_raw_coherence` remains NOT VALID until phase B migration 113 is applied.

## 7) Optional Next Hardening (Post-Deploy)

1. After monitoring clean writes, evaluate validating `chk_fact_outcomes_status_score_raw_coherence`.
2. Remove legacy discrepancy field dependency from downstream consumers once normalized fields are fully adopted.



┌─────────────────────────────────────────────────────────────────────┐
│  ZONE 1: Command Bar (top)                                         │
│  Agent selector │ Time range │ Scope toggle │ Refresh │ Export      │
├────────────────────────┬────────────────────────────────────────────┤
│  ZONE 2: Portfolio     │  ZONE 3: Deep Dive (main panel)           │
│  Overview (left 30%)   │  (right 70%)                              │
│                        │                                           │
│  ┌──────────────────┐  │  ┌──────────────────────────────────────┐  │
│  │ Agent Health Card │  │  │ A. AI Insight Panel (LLM-powered)   │  │
│  │ Trust · Mode ·    │  │  │    Headline · Narrative · Next Step │  │
│  │ Total Outcomes    │  │  └──────────────────────────────────────┘  │
│  └──────────────────┘  │  ┌──────────────────────────────────────┐  │
│                        │  │ B. Action Leaderboard (sortable)     │  │
│  ┌──────────────────┐  │  │    Resolution% · Samples · Trend ·  │  │
│  │ Task Heatmap     │  │  │    Confidence · ML Score · Cluster   │  │
│  │ Grid of tasks    │  │  └──────────────────────────────────────┘  │
│  │ colored by state │  │  ┌──────────┬───────────────────────────┐  │
│  │ (no_data/early/  │  │  │ C. Perf  │ D. Evidence & Confidence │  │
│  │  stable)         │  │  │  Delta   │    Progress meter +       │  │
│  │ Click to select  │  │  │  Card    │    Confidence breakdown   │  │
│  └──────────────────┘  │  └──────────┴───────────────────────────┘  │
│                        │  ┌──────────────────────────────────────┐  │
│  ┌──────────────────┐  │  │ E. Signal Quality Dashboard         │  │
│  │ Portfolio KPIs   │  │  │    Data freshness · Cohort health ·  │  │
│  │ Avg confidence   │  │  │    Scope · Source mix · Registry     │  │
│  │ Tasks at stable  │  │  └──────────────────────────────────────┘  │
│  │ Top improver     │  │  ┌──────────────────────────────────────┐  │
│  │ Needs attention  │  │  │ F. Cohort Cycle Timeline             │  │
│  └──────────────────┘  │  │    Historical cycles + rotation      │  │
│                        │  │    reasons                            │  │
├────────────────────────┴────────────────────────────────────────────┤
│  ZONE 4: Footer bar — generated_at · scope_label · version         │
└─────────────────────────────────────────────────────────────────────┘
