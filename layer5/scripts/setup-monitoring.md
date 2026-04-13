# Setting Up Uptime Monitoring

## Step 1 — Verify health endpoint works locally

```bash
node scripts/health-check.js
```

Expected output:
```
✓ Status: ok
✓ DB connected: true
✅ Health check passed.
```

## Step 2 — Set up UptimeRobot (free, 5 minutes)

1. Go to https://uptimerobot.com and create account
2. Click "Add New Monitor"
3. Monitor Type: HTTPS
4. URL: `https://[your-railway-url]/health`
5. Monitoring Interval: 5 minutes
6. Alert contacts: Add your email
7. Click "Create Monitor"

UptimeRobot will:
- Check `/health` every 5 minutes
- Email you within 5 minutes of downtime
- Show uptime percentage in dashboard
- Free tier supports 50 monitors

## Step 3 — Set up status page (optional)

UptimeRobot provides a free public status page.
Share it with enterprise customers as proof of uptime.

Settings → Status Pages → Create Status Page
Add your API monitor to the status page.
Set custom domain if desired: `status.layerinfinite.dev`

## Step 4 — Automate endpoint parity + failover readiness

Run these checks from CI or a scheduled job:

Preferred single command (auto-detects single vs multi endpoint mode):

`npm --prefix layer5 run check:production`

- If only `PRIMARY_API_URL` is configured, it runs `/health` + `/health/deep` sanity checks and skips parity/failover.
- If `FALLBACK_API_URLS` contains at least one independent fallback origin, it runs full independence/parity/failover checks.

1. Endpoint independence:

  `npm --prefix layer5 run check:endpoint-independence`

2. Version/schema parity across all endpoints:

  `npm --prefix layer5 run check:endpoint-parity`

3. Failover drill (simulates primary outage and validates recovery):

  `npm --prefix layer5 run drill:failover`

Required environment variables:

- `PRIMARY_API_URL`
- `FALLBACK_API_URLS` (comma-separated)

Optional variables:

- `ENDPOINT_CHECK_TIMEOUT_MS`
- `ENDPOINT_CHECK_STRICT_STATUS`
- `DRILL_FORCE_PRIMARY_DOWN`
- `DRILL_TIMEOUT_MS`

The repository includes a scheduled workflow that runs these checks:

- `.github/workflows/production-readiness-checks.yml`

## Step 5 — Monitor discrepancy and conflict drift

Run drift detection and unresolved discrepancy/conflict rate checks:

`npm --prefix layer5 run check:discrepancy-drift`

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional environment variables:

- `DRIFT_MONITOR_CUSTOMER_ID` (limit monitor to one customer/tenant scope)
- `DRIFT_LOOKBACK_DAYS` (default `7`)
- `DRIFT_MONITOR_TIMEOUT_MS` (default `15000`)
- `DRIFT_DISCREPANCY_RATE_THRESHOLD` (default `0.03`)
- `DRIFT_CONFLICT_RATE_THRESHOLD` (default `0.01`)
- `DRIFT_CONFLICT_SHARE_THRESHOLD` (default `0.35`)
- `DRIFT_OPEN_DISCREPANCY_THRESHOLD` (default `80`)
- `DRIFT_OPEN_CONFLICT_THRESHOLD` (default `30`)
- `DRIFT_MIN_OPEN_FOR_SHARE` (default `10`)
- `DRIFT_FAIL_ON_BREACH` (default `true`)

The production-readiness workflow now runs this monitor automatically when
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured as repository vars/secrets.

## Alerting thresholds recommended

| Alert condition | Response |
|---|---|
| API down > 1 min | Email immediately |
| API down > 5 min | SMS (UptimeRobot paid) |
| Response time > 2s | Email (warning) |

## Incident alerts (required)

Create alert rules for:

- 5xx burst rate
- timeout spike (`GATEWAY_TIMEOUT`)
- unhandled exception count
- release health regression

Route alerts to Slack/PagerDuty/email.

## What /health checks

`GET /health` returns:
```json
{
  "status": "ok" | "degraded",
  "checks": {
      "api": "ok",
      "database": "ok",
      "materialized_view": "ok"
  },
  "timestamp": "2026-03-13T...',
  "version": "1.0.0"
}
```

`"degraded"` means DB is reachable but something internal failed, or materialized view refresh is stale.
