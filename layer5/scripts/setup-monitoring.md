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

## Alerting thresholds recommended

| Alert condition | Response |
|---|---|
| API down > 1 min | Email immediately |
| API down > 5 min | SMS (UptimeRobot paid) |
| Response time > 2s | Email (warning) |

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
