# Layer5 — Outcome-Ranked Decision Intelligence Layer

> The world's first Outcome-Ranked Decision Intelligence Layer for Enterprise AI Agents.

Layer5 is a 6-layer middleware that sits between AI agents and enterprise systems, providing outcome-based scoring, adaptive policy decisions, trust management, and a full audit trail.

## Architecture

| Layer | Name | Purpose |
|---|---|---|
| 1 | Storage | Append-only fact tables, dimension tables, episodes, archive |
| 2 | Materialization | Materialized views, composite scoring, trend aggregation |
| 3 | API | REST endpoints (Hono), auth, rate-limiting, hallucination guard |
| 4 | Temporal | Trend detection, degradation alerts, score-flip events |
| 5 | Adaptive Policy | Trust scores, cold-start bootstrap, explore/exploit/escalate |
| 6 | Trust & Ops | Trust updater, data pruning, admin dashboard |

## Quick Start

### Prerequisites

- Node.js v20+
- A Supabase project (free tier works)
- PostgreSQL extensions: `uuid-ossp` (enable in Supabase Dashboard → Database → Extensions)

### Setup

```bash
# 1. Clone & enter
git clone <repo-url>
cd layer5

# 2. Install API dependencies
cd api && npm install && cd ..

# 3. Create environment file
cp api/.env.example api/.env
# Fill in: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, LAYER5_INTERNAL_SECRET, DB_URL

# 4. Run migrations (in order, 001 → 010)
node scripts/run-migrations.js
# Or individually: psql $DB_URL -f supabase/migrations/001_create_dimensions.sql

# 5. Seed development data
psql $DB_URL -f supabase/seed/cold_start_priors.sql

# 6. Start API server
cd api && npm run dev
```

### Dashboard (optional)

```bash
cd dashboard
npm install
# Create dashboard/.env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
# Opens at http://localhost:5173
```

## Project Structure

```
layer5/
├── api/                     ← REST API (Hono + TypeScript)
│   ├── lib/                 ← Core logic (scoring, policy-engine, context-embed)
│   ├── middleware/           ← Auth, rate-limit, hallucination guard
│   ├── routes/              ← Endpoint handlers
│   └── types/               ← TypeScript declarations
├── supabase/
│   ├── migrations/          ← SQL migrations (001-010, run in order)
│   ├── functions/           ← 5 Edge Functions (Deno)
│   └── seed/                ← Cold-start priors seed data
├── dashboard/               ← Admin dashboard (React + Vite)
│   └── src/
│       ├── components/      ← ScoreCard, TrendBadge, OutcomeTable, TrustGauge
│       └── pages/           ← Score leaderboard, outcomes, audit, trust
├── tests/                   ← Tests organized by layer
│   ├── layer3/              ← Scoring, policy, hallucination, audit, admin (55 tests)
│   ├── layer4/              ← Trend detection (24 tests)
│   ├── layer5/              ← Adaptive policy, cold-start (10 tests)
│   └── layer6/              ← Trust system, pruning (16 tests)
└── scripts/                 ← Deploy & migration helpers
```

## Migrations

Migrations run in numeric order. **Never edit an applied migration** — create a new numbered file.

| Migration | Contents | Phase |
|---|---|---|
| 001 | Dimension tables (customers, agents, actions, contexts) | 1 |
| 002 | fact_outcomes (append-only + trigger) | 1 |
| 003 | Episodes, archive, institutional knowledge | 1 |
| 004 | Materialized views (mv_action_scores, mv_episode_patterns) | 2 |
| 005 | All indexes (15 across all tables) | 1 |
| 006 | Row Level Security policies (12 policies) | 1 |
| 007 | Trust scores + audit (agent_trust_scores, agent_trust_audit) | 5 |
| 008 | Event tables (degradation_alert_events, trend_change_events) | 4 |
| 009 | Unique indexes for CONCURRENTLY refresh | 2 |
| 010 | Helper RPC functions (refresh_mv_action_scores, refresh_mv_episode_patterns) | 2 |

## Edge Functions

| Function | Trigger | Purpose |
|---|---|---|
| `scoring-engine` | Cron (5 min + nightly) | Refresh materialized views |
| `trend-detector` | Cron (nightly) | Detect degradation & score-flip events |
| `cold-start-bootstrap` | On-demand | 4-stage cold-start protocol with cross-agent transfer |
| `trust-updater` | On-demand | Single & batch trust score recalculation |
| `pruning-scheduler` | Cron (nightly) | Archive >90 day low-salience rows, cold-delete >365 day archive |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/v1/log-outcome` | Log an agent action outcome (with trust update) |
| GET | `/v1/get-scores` | Get ranked actions with policy decision |
| GET | `/v1/get-patterns` | Get historically successful action sequences |
| GET | `/v1/audit` | Get audit trail (regulator-ready) |
| POST | `/v1/admin/reinstate-agent` | Reinstate a suspended agent (admin only) |
| POST | `/v1/admin/actions` | Manage allowed actions (admin only) |

## Testing

```bash
cd api
npm test                    # Run all 105 tests
npx vitest run tests/layer3 # Run only layer 3 tests
npx vitest run tests/layer6 # Run only layer 6 tests
```

| Suite | Tests | Focus |
|---|---|---|
| layer3/scoring | 24 | Composite score formula, weights, edge cases |
| layer3/policy | 9 | Explore/exploit/escalate decision tree |
| layer3/hallucination | 12 | Action validation against dim_actions |
| layer3/audit-isolation | 5 | Customer-scoped audit isolation |
| layer3/admin-auth | 5 | Admin role enforcement |
| layer4/trend | 24 | Trend labeling, SMA, degradation detection |
| layer5/policy | 6 | Trust-aware policy with real DB config |
| layer5/cold-start | 4 | 4-stage cold-start protocol |
| layer6/trust | 7 | Trust decay, recovery, reinstatement |
| layer6/pruning | 9 | Archive rules, cold-delete, salience stats |

## Critical Rules

1. **`fact_outcomes` is APPEND-ONLY** — BEFORE UPDATE trigger raises EXCEPTION
2. **UUID everywhere** — no SERIAL or auto-increment
3. **TIMESTAMPTZ everywhere** — no TIMESTAMP WITHOUT TIME ZONE
4. **CONCURRENTLY for all view refreshes** — requires unique index
5. **Indexes before data** — all indexes created before first INSERT
6. **RLS on all tenant-scoped tables** — customer_id isolation enforced
7. **Hallucination prevention** — validate action_name against dim_actions before write
8. **One phase = one commit** — test gate must pass before next phase
9. **Migrations are immutable** — never edit applied migrations
10. **⚠ Pruning is destructive** — `pruning-scheduler` hard-deletes archive rows >365 days. Ensure backups before enabling.

## Trust System

Trust scores control the policy engine's explore/exploit/escalate behaviour:

| Score Range | Status | Policy Effect |
|---|---|---|
| ≥ 0.6 | `trusted` | Normal explore/exploit |
| 0.3 – 0.6 | `probation` | Conservative exploit |
| < 0.3 or ≥5 failures | `suspended` | Escalate to human |

- **Success**: `score × 1.03` (capped at 1.0), failures reset to 0
- **Failure**: `score × 0.9^n` where n = consecutive failure count
- **Reinstatement**: Admin sets score=0.4, status=probation, failures=0

## License

Proprietary — All rights reserved.
