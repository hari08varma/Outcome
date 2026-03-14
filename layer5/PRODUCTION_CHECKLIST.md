# Layer5 — Pre-Launch Production Checklist

## Before Deploying

- [ ] CORS updated with `ALLOWED_ORIGINS` environment variable
- [ ] All `.env.production.example` files reviewed
- [ ] 105/105 tests passing locally (`cd api && npm test`)
- [ ] New migrations (011, 012) ready to apply

## PRE-MIGRATION CHECKLIST

Before running any migrations:
□ Enable pg_cron in Supabase Dashboard
  → Database → Extensions → pg_cron → Enable
□ Enable pgvector in Supabase Dashboard
  → Database → Extensions → vector → Enable
□ Verify both: run scripts/verify-pgcron.sql

After migrations 019-026:
□ Confirm 4 new tables exist:
  fact_decisions, action_sequences,
  fact_outcome_counterfactuals, world_model_artifacts
□ Confirm mv_sequence_scores exists
□ Confirm 14+ new indexes exist
□ Test immutability trigger (see migration 019 comments)

## ENVIRONMENT VARIABLES
Set on Railway: Settings → Variables

**REQUIRED**
- [ ] `SUPABASE_URL` (API + Edge Functions)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` (API + Edge Functions)
- [ ] `SUPABASE_ANON_KEY` (API)
- [ ] `NODE_ENV` (API)
- [ ] `ALLOWED_ORIGINS` (API) — Verify this includes the production dashboard URL before deploying
- [ ] `VITE_SUPABASE_URL` (Dashboard)
- [ ] `VITE_SUPABASE_ANON_KEY` (Dashboard)
- [ ] `VITE_LAYER5_API_URL` (Dashboard)

**OPTIONAL / RECOMMENDED**
- [ ] `SENTRY_DSN` (API)
- [ ] `VITE_SENTRY_DSN` (Dashboard)
- [ ] `RESEND_API_KEY` (API + Edge Functions)
- [ ] `ALERT_FROM_EMAIL` (API + Edge Functions)
- [ ] `API_PORT` (API)
- [ ] `DATABASE_POOLER_URL` (API)
- [ ] `DASHBOARD_URL` (Edge Functions)
- [ ] `API_CACHE_REFRESH_URL` (Edge Functions)

## Deployment Steps (in order)

- [ ] 1. Deploy API to hosting platform → copy public URL
- [ ] 2. Set `ALLOWED_ORIGINS` in API env to include dashboard URL
- [ ] 3. Deploy dashboard to hosting platform → copy public URL
- [ ] 4. Add dashboard URL to API `ALLOWED_ORIGINS` (redeploy if needed)
- [ ] 5. Run migration 011 — pg_cron schedules (`psql $DB_URL -f supabase/migrations/011_create_cron_schedules.sql`)
- [ ] 6. Run migration 012 — pgvector index (`psql $DB_URL -f supabase/migrations/012_create_vector_index.sql`)
- [ ] 7. Set `app.supabase_url` in Supabase Dashboard → Settings → Database → Configuration
- [ ] 8. Set `app.service_role_key` in Supabase Dashboard → Settings → Database → Configuration
- [ ] 9. Verify 4 cron jobs in Supabase Dashboard → Database → Cron Jobs

## SDK Publishing
Before launch:
□ Create PyPI account → get API token → add as GitHub secret PYPI_API_TOKEN
□ Create npm account → npm login → create automation token → add as NPM_TOKEN
□ Run: make test (both SDKs must pass)
□ Run: make test-publish (dry run verification)
□ Tag release: git tag sdk-v0.1.0 && git push --tags
□ Verify: pip install layer5-sdk succeeds
□ Verify: npm install @layer5/sdk succeeds
□ Update onboarding page install commands if package names changed

## Before First Customer

- [ ] Enable Supabase PITR — Dashboard → Settings → Database → Point in Time Recovery (30-day retention)
- [ ] Take manual backup — Dashboard → Database → Backups → Create backup now
- [ ] Run `node scripts/verify-backup-status.js` — confirm row counts
- [ ] Set up UptimeRobot on `/health` endpoint (see `scripts/setup-monitoring.md`)
- [ ] Test `GET /health` → all checks return `"ok"`
- [ ] Test `GET /v1/get-scores?issue_type=payment_failed` → ranked actions returned
- [ ] Test `POST /v1/log-outcome` → 201 response with outcome_id
- [ ] Test dashboard loads at production URL → all 4 pages render
- [ ] Test CSV export on `/audit` page
- [ ] Verify Edge Functions respond (check Supabase Dashboard → Edge Functions → Logs)

## Go Live

- [ ] Send first API key to first customer
- [ ] Monitor `/health` for 24 hours — confirm `"status":"ok"`
- [ ] Check Supabase logs after first cron run (scoring-engine at next 5-min mark)
- [ ] Verify `mv_action_scores` refreshes (view_refreshed_at updates)
- [ ] Watch for first degradation alert (trend-detector at 02:00 UTC)

## Ongoing Maintenance

- [ ] When `dim_contexts` exceeds 10,000 rows → `REINDEX INDEX CONCURRENTLY idx_contexts_vector;`
- [ ] Review pruning logs weekly (Supabase → Edge Functions → pruning-scheduler)
- [ ] Rotate API keys periodically (update `dim_agents.api_key_hash`)
- [ ] Review trust audit log monthly (`agent_trust_audit` table)
