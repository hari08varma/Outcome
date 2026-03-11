# Layer5 — Pre-Launch Production Checklist

## Before Deploying

- [ ] CORS updated with `ALLOWED_ORIGINS` environment variable
- [ ] All `.env.production.example` files reviewed
- [ ] 105/105 tests passing locally (`cd api && npm test`)
- [ ] New migrations (011, 012) ready to apply

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
