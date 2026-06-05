---
name: layerinfinite-full-architecture
description: "Complete architectural understanding of LayerInfinite — what it is, the 10-layer model, full file map, data flows, key algorithms, database schema, API structure, and all subsystems. Compiled from 5-agent exhaustive exploration (2026-05-20)."
metadata: 
  node_type: memory
  type: project
  originSessionId: bad08b6b-9006-4a4b-acea-88f62b909625
---

# LayerInfinite — Complete Architecture & Codebase Knowledge

## What LayerInfinite Is

LayerInfinite is an open-source **decision intelligence layer for autonomous AI agents**. It sits between an agent's action selection and execution, providing:

- **Scoring**: Bayesian-smoothed composite scores for every action, per task
- **Policy**: A deterministic decision tree telling the agent whether to exploit, explore, escalate, sandbox, or abstain
- **Simulation**: 3-tier what-if engine (Wilson CI → LightGBM → MCTS) predicting outcomes of action sequences
- **Trust**: Asymmetric exponential smoothing trust scores with coordinated failure detection
- **Recommendations**: Full recommendation engine with noise gates, stability gates, and LLM narratives
- **Observability**: Audit trails, discrepancy detection, drift monitoring, trend analysis

## The 10-Layer Model

| Layer | Name | What It Does |
|---|---|---|
| 1 | Structured Experience Memory | Star-schema DB (fact_outcomes + dim tables), 127 migrations, materialized views |
| 2 | Auth & Multi-Tenant | Dual auth (API key for agents, JWT for dashboard), customer_id scoping everywhere |
| 3 | Composite Scoring | 6-factor formula (success/confidence/trend/salience/recency/latency), Bayesian smoothing, LRU cache |
| 4 | Adaptive Policy | 11-branch pure-function decision tree, injectable randomFn, zero DB calls |
| 5 | Temporal Trending | OLS regression on last 20 outcomes, predictive drift alerts, trend labels |
| 6 | Trust & Suspension | Asymmetric exponential smoothing (failure ×0.9ⁿ, success ×1.03), 5-status lifecycle |
| 7 | Sequence Learning (IPS) | Inverse Propensity Scoring, softmax propensities, reward backpropagation (γ=0.85) |
| 8 | 3-Tier Simulation | Tier1 Wilson CI (<10ms) → Tier2 LightGBM (<100ms) → Tier3 MCTS with UCT (≤8s) |
| 9 | Training & World Model | LightGBM quantile regression (q10/q50/q90), 200 trees × 3 quantiles, 10-feature vector |
| 10 | Dashboard & Onboarding | React + Vite + Tailwind, Supabase Realtime, 12 hooks, 15 pages, onboarding flow |

## Complete File Map

### API Layer (`layer5/api/`) — 68 files

**Entry**: `index.ts` (558 lines) — Hono app, middleware stack, route mounting, durable queue worker

**Routes** (22 files):
- `log-outcome.ts` (1,603 lines) — Primary ingestion pipeline
- `import.ts` (1,423 lines) — Bulk file import, 5 formats, LLM schema inference
- `get-recommendations.ts` (1,149 lines) — Recommendation engine entry
- `get-scores.ts` (1,030 lines) — Ranked action scores with caching
- `discrepancy.ts` (823 lines) — Cross-event discrepancy detection
- `webhook.ts` (293 lines) — Stripe/SendGrid/generic webhooks
- `audit.ts` (272 lines) — Paginated audit trail
- `outcome-feedback.ts` (230 lines) — Delayed outcome feedback
- `pending-signals.ts` (190 lines) — Delayed signal registration
- `observe.ts` (168 lines) — Per-task outcome stats
- `simulate.ts` (141 lines) — 3-tier simulation
- `get-patterns.ts` (134 lines) — Sequence pattern retrieval
- `contracts.ts` (107 lines) — Signal contract CRUD
- `auth/me.ts` (19 lines) — Agent identity
- `auth/api-keys.ts` (166 lines) — API key management
- 7 admin routes (actions, drift, reinstate-agent, reinstate-sandbox, restore-trust, test-notification, trigger-training)

**Lib Modules** (39 files):
- **Core**: `supabase.ts`, `sanitize.ts`, `tenant-supabase.ts`, `webhook-auth.ts`
- **Ingestion**: `ingest-core.ts` (1,118), `outcome-score-inference.ts` (426), `verifier.ts`, `schema-inferrer.ts` (663), `context-embed.ts` (512)
- **Scoring & Policy**: `scoring.ts` (706), `policy-engine.ts` (269)
- **Counterfactuals**: `ips-engine.ts` (219)
- **Orchestration**: `outcome-orchestrator.ts` (642), `decision-writer.ts`, `drift-detector.ts`, `predictive-drift.ts`, `sequence-tracker.ts`, `reward-backprop.ts`
- **Queue**: `outcome-ingest-queue.ts` (595)
- **Simulation**: `simulation/tier-selector.ts` (285), `tier1.ts`, `tier2.ts`, `tier3-mcts.ts` (309), `world-model.ts` (346), `types.ts`
- **Recommendation Engine** (13 files): `engine.ts` (1,162), `task-performance.ts` (933), `reason.ts` (822), `cohort-cycle.ts` (396), `llm-narrative.ts` (341), `scope-transition.ts` (147), `cohort-reliability.ts` (148), `semantic-action-cluster.ts` (218), `task-infer.ts` (244), `outcome-weighting.ts` (82), `data-freshness.ts` (33), `rollout-flags.ts` (127), `constants.ts` (9)
- **Adapters**: `adapters/langchain-adapter.ts` (238), `adapters/langgraph-adapter.ts` (306)

**Middleware** (5 files):
- `auth.ts` (232) — X-API-Key/Bearer, SHA-256 hash, 60s cache
- `user-auth.ts` (168) — Supabase JWT for dashboard
- `admin-auth.ts` (38) — Admin role check
- `validate-action.ts` (509) — Action normalization + auto-registration
- `rate-limit.ts` (155) — 300 req/min, fail-open

**Types**: `types/hono.d.ts` (24) — Hono context variable augmentation

### Database (`layer5/db/`) — 133 SQL files

- 127 migrations (001–131), star schema
- 22+ tables: `dim_agents`, `dim_customers`, `dim_actions`, `dim_contexts`, `dim_institutional_knowledge`, `dim_action_aliases`, `fact_outcomes` (append-only), `fact_outcome_counterfactuals`, `fact_decisions`, `fact_trust_snapshots`, `world_model_artifacts`, `recommendation_cohort_cycles`, `queue_outcome_ingress`, and more
- Materialized views: `mv_action_scores`, `mv_cluster_scores`, `mv_episode_patterns`, `mv_sequence_scores`, `mv_task_action_performance_180d`
- 6 Supabase Edge Functions: scoring-engine, trend-detector, cold-start-bootstrap, pruning-scheduler, notification-dispatcher
- 23 scripts in `scripts/` — deployment, health checks, migration governance

### MCP Server (`packages/mcp-server/`) — 15 files

- `src/index.ts` (198) — Server factory with 4-mode progression
- `src/episode-tracker.ts` (61) — In-memory Set, 30-min TTL
- `src/param-resolver.ts` — 3-layer param resolution (args → config → env)
- 10 tools: `li-action`, `li-log`, `li-status`, `li-export`, `li-import`, `li-simulate`, `li-patterns`, `li-dashboard`, `li-configure`, `li-observe`
- CLI, REST client, config, logger, prompts, resources

### Dashboard (`layer5/` + `layer4/`) — 80+ files

- React + Vite + Tailwind CSS + Supabase Realtime
- 12 custom hooks, 15 pages, 8 components, 6 settings pages
- Dual auth: Supabase JWT (dashboard) vs API key (backend)

### Training Pipeline (`layer5/training/`) — 7 files

- `train_world_model.py` — LightGBM quantile regression
- `features.py` — 10-feature extraction
- `validate_model.py` — Performance gates
- `export_model.py` — JSON serialization for TS evaluation
- `counterfactual_retraining.py` — Doubly Robust targets
- `DEPLOY.md`, `README.md`

### Tests — 40+ files

- `layer5/tests/` — Integration tests
- `layer5/api/tests/` — API route tests
- `layer5/training/tests/` — ML pipeline tests
- `packages/mcp-server/__tests__/` — MCP tool tests

### CI/CD — 4 workflows

- `ci.yml` — API tests only (missing training + MCP)
- `production-readiness-checks.yml`
- `publish-npm-sdk.yml`
- `publish-python-sdk.yml`

## Key Data Flows

### Outcome Ingestion Flow
```
Agent → POST /v1/log-outcome
  → Parse body → Idempotency check (SHA-256)
  → Verification (resolves verified_success)
  → Action resolution (normalize + auto-register)
  → Context resolution (embedding + cosine similarity, pgvector RPC)
  → Retry chain detection
  → Semantic clustering
  → Score inference (3-layer: hard signals → soft signals → latency)
  → Core insert (ingest-core.ts → fact_outcomes)
  → 8 side-effects via Promise.allSettled:
      1. Trust update (atomic RPC, exponential smoothing)
      2. Context drift check
      3. Silent failure detection
      4. Counterfactual computation (IPS)
      5. Sequence tracking
      6. Latency spike detection
      7. Cache invalidation
      8. Predictive drift check
```

### Scoring Flow
```
Agent → GET /v1/get-scores
  → Check L1 cache (5s TTL, 500-entry LRU)
  → Fetch from mv_action_scores (or fact_outcomes fallback)
  → Apply 6-factor formula per action:
      composite = 0.40 × bayesian_success + 0.20 × confidence
                + 0.20 × trend + 0.10 × salience
                + 0.05 × recency + 0.05 × latency
  → IPS blending for low-sample actions (<20 episodes)
  → Cold-start guard (MIN_CONFIDENCE=0.15)
  → Cluster prior blending via mv_cluster_scores
  → Ambiguity detection (gap ≤ 0.05, both in 40-65% range)
  → Run policy engine (11-branch decision tree)
  → Cache results (5min TTL, 1000-entry LRU)
  → Return ranked scores + policy decision
```

### Recommendation Flow
```
Agent → GET /v1/recommendations
  → Trust gate check
  → Scope selection (agent_scoped vs customer_blended)
  → Fetch task-action performance from mv_task_action_performance_180d
  → Shadow signals (simulation blend if enabled)
  → Noise assessment
  → Evidence threshold check
  → Ranking with Laplace smoothing
  → Confidence computation (harmonic mean of samples + lift)
  → Stability gates
  → Semantic convergence gate
  → Cohort reliability evaluation
  → LLM narrative generation (gpt-4o-mini, 1.5s timeout)
  → Build actionable output
```

### Simulation Flow
```
Agent → POST /v1/simulate
  → Tier selector evaluates eligibility:
      Tier 3 requires ≥1000 episodes + loaded model + CI < 0.25
      Tier 2 requires ≥200 episodes + loaded model
      Tier 1 always available
  → Runs all eligible tiers in parallel
  → Tier 3: MCTS with UCT (C=√2), 500 sims, max depth 5, batch 10, 8s timeout
  → Tier 2: LightGBM ensemble, 600 tree evaluations
  → Tier 1: Wilson CI on mv_sequence_scores, fallback to cold_start_priors
  → Returns best result (highest tier that succeeded)
```

## Key Algorithms

### 6-Factor Scoring Formula
```
composite = 0.40 × bayesian_success_rate + 0.20 × confidence
          + 0.20 × trend_signal + 0.10 × salience_score
          + 0.05 × recency_bonus + 0.05 × latency_penalty

Where:
  bayesian_success_rate = (successes + prior_strength × prior_mean) / (total + prior_strength)
  trend_signal ∈ {strongly_improving, improving, stable, declining, critical}
  salience_score = f(episode_position, outcome_magnitude)
  recency_bonus = f(days_since_last_outcome)
  latency_penalty = f(relative_latency_vs_baseline)
```

### 11-Branch Policy Decision Tree
```
1. agent suspended           → ESCALATE
2. action new (no data)      → EXPLORE (force)
3. in sandbox                → SANDBOX (review)
4. cold_start                 → EXPLORE
5. low separation, ambiguous  → ABSTAIN
6. composite_score > exploit_threshold → EXPLOIT (epsilon-greedy)
7. composite_score > explore_threshold → EXPLORE
8. below_threshold            → ABSTAIN
9. epsilon-greedy roll       → EXPLORE (with probability epsilon)
10. default                   → EXPLOIT
11. (implicit) no valid path  → ABSTAIN
```

### MCTS (Tier 3 Simulation)
```
For each simulation (500 total, batched in groups of 10):
  SELECT: traverse tree using UCT = win_rate + √2 × √(ln(parent_visits) / node_visits)
  EXPAND: add child node when leaf reached
  ROLLOUT: use Tier 2 world model for fast evaluation
  BACKPROPAGATE: update win rates up the tree
Best sequence = most-visited child path (robust policy)
```

### Trust Score (Asymmetric Exponential Smoothing)
```
On success: trust = min(1.0, trust × 1.03)
On failure: trust = max(0.0, trust × 0.90)
Status: trusted(≥0.70) → probation(≥0.40) → sandbox(≥0.20) → suspended(<0.20)
New agents start at 0.50 (probation)
```

### LightGBM World Model Features
```
1. action_encoded (label-encoded action ID)
2. episode_position (normalized 0-1)
3-5. prev_action_encoded × 3 (last 3 actions in sequence)
6. context_frequency (how often this context appears)
7-8. hour_sin, hour_cos (time-of-day cycle)
9-10. dow_sin, dow_cos (day-of-week cycle)
```

## Caching Architecture

| Cache | TTL | Size | In-flight Dedup |
|---|---|---|---|
| Auth | 60s | Unlimited Map | No |
| Action validation | 30min | Unlimited Map | No |
| Scoring | 5min | 1000-entry LRU | **No** (gap) |
| ML score baseline | 2min | 5000 entries | No |
| World model | 30min | Per customer | No |
| Narrative | 60s | Unlimited | Yes |
| Schema inferrer | Permanent | 100-entry LRU | Yes |
| Context embedding | 10min | Unlimited | Yes |

## Graceful Degradation Patterns
- Simulation: Tier 3 → Tier 2 → Tier 1 fallback chain
- Scoring: MV → fact table → institutional priors → global fallback
- Task performance: MV → raw fact_outcomes fallback
- LLM narrative: gpt-4o-mini → null (caller falls back to static template)
- Cohort cycle: SQL RPC → in-memory Map fallback
- Rate limit: RPC → fail-open (⚠️ security issue)
- Decision writes: circuit breaker (3 failures → 60s open)

## Multi-Tenant Isolation
- Every query scoped by `customer_id`
- `tenant-supabase.ts` enforces at type level (exhaustive union type)
- `ZERO_UUID_AGENT_ID` marks records excluded from blended scopes
- API keys scoped per customer via `dim_agents` join

## Dual Auth Model
- **Agent API**: `X-API-Key` header or `Authorization: Bearer`, SHA-256 hash against `dim_agents.api_key_hash`, sets `agent_id` + `customer_id` on context
- **Dashboard User**: Supabase JWT via `Authorization: Bearer`, validates via `supabase.auth.getUser()`, resolves `customer_id` from `user_profiles`, sets `user_id` + `customer_id` on context
- **Admin**: Requires `adminAuthMiddleware` checking `dim_customers.config.role === 'customer_admin'`
