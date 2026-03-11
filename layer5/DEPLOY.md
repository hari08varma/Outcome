# Layer5 — Deployment Guide

## Prerequisites

- Node.js v20+
- Supabase project running (10 migrations already deployed)
- 5 Edge Functions already deployed
- GitHub repo with layer5 code pushed

---

## Part 1: Deploy API (Railway / Any Node.js Host)

### Option A: Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select your repo → set **Root Directory** to `/layer5/api`
3. Add environment variables (see `api/.env.production.example` for full list):

   | Variable | Value |
   |----------|-------|
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` |
   | `SUPABASE_URL` | `https://[project-ref].supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | *(from Supabase dashboard)* |
   | `SUPABASE_ANON_KEY` | *(from Supabase dashboard)* |
   | `EMBEDDING_PROVIDER` | `supabase` |
   | `LAYER5_DEV_BYPASS` | `false` |
   | `ALLOWED_ORIGINS` | `https://your-dashboard.vercel.app` |

4. Railway auto-detects Node.js and deploys
5. Copy the generated Railway URL (e.g. `layer5-api-production.up.railway.app`)
6. Update `ALLOWED_ORIGINS` to include the final dashboard URL after Step 2

### Option B: Any Node.js Host

```bash
cd layer5/api
npm install
npm start   # runs: tsx index.ts
```

Set the same environment variables listed above.

---

## Part 2: Deploy Dashboard (Vercel / Any Static Host)

### Option A: Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project** → **Import GitHub repo**
2. Set **Root Directory** to `/layer5/dashboard`
3. Vercel auto-detects Vite — confirm:
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
4. Add environment variables:

   | Variable | Value |
   |----------|-------|
   | `VITE_SUPABASE_URL` | `https://[project-ref].supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | *(from Supabase dashboard)* |
   | `VITE_API_URL` | `https://your-api.railway.app` |

5. Deploy → copy the Vercel URL
6. Go back to Railway → update `ALLOWED_ORIGINS` to include the Vercel URL

### Option B: Any Static Host

```bash
cd layer5/dashboard
npm install
npm run build    # outputs to dist/
# Serve dist/ with any static file server (nginx, Cloudflare Pages, etc.)
```

**Important:** Configure a rewrite rule so all paths serve `index.html` (React Router needs this).

---

## Part 3: Post-Deployment Setup

### 3a. Run new migrations

```bash
# Run against your Supabase database:
psql $DB_URL -f supabase/migrations/011_create_cron_schedules.sql
psql $DB_URL -f supabase/migrations/012_create_vector_index.sql
```

### 3b. Configure Supabase app settings

In **Supabase Dashboard → Settings → Database → Configuration**, add:

| Setting | Value |
|---------|-------|
| `app.supabase_url` | `https://[project-ref].supabase.co` |
| `app.service_role_key` | *(your service role key)* |

These are used by pg_cron to call Edge Functions.

### 3c. Verify cron jobs

Go to **Supabase Dashboard → Database → Cron Jobs** and confirm 4 jobs:

| Job | Schedule |
|-----|----------|
| `scoring-engine-refresh` | Every 5 min |
| `trust-updater-batch` | Every 5 min |
| `trend-detector-nightly` | 02:00 UTC daily |
| `pruning-scheduler-nightly` | 03:00 UTC daily |

### 3d. Enable Supabase PITR

⚠️ **REQUIRED BEFORE FIRST PRUNING RUN (03:00 UTC):**

1. **Supabase Dashboard → Settings → Database**
2. Enable **Point in Time Recovery**
3. Set retention to **30 days** (recommended)
4. **Database → Backups → Create backup now**

Run the verification script:
```bash
node scripts/verify-backup-status.js
```

### 3e. Set up monitoring

Follow instructions in `scripts/setup-monitoring.md`:
- Add UptimeRobot monitor on `https://your-api.railway.app/health`
- Keyword check: response contains `"status":"ok"`

### 3f. pgvector index maintenance

When `dim_contexts` exceeds 10,000 rows:
```sql
REINDEX INDEX CONCURRENTLY idx_contexts_vector;
```
Update the `lists` parameter to `sqrt(row_count)` rounded up.

---

## Verification Checklist

After deployment, test these:

```bash
# Health check
curl https://your-api.railway.app/health

# Score query (requires API key)
curl -H "X-API-Key: [key]" \
     "https://your-api.railway.app/v1/get-scores?issue_type=payment_failed"

# Log outcome (requires API key)
curl -X POST -H "X-API-Key: [key]" \
     -H "Content-Type: application/json" \
     -d '{"session_id":"test-session","action_name":"restart_service","issue_type":"payment_failed","success":true}' \
     "https://your-api.railway.app/v1/log-outcome"

# Dashboard
open https://your-dashboard.vercel.app
```
