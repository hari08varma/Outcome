# Health Monitoring Setup

## /health Endpoint Response

```json
{
  "status": "ok | degraded | error",
  "timestamp": "2026-03-07T...",
  "checks": {
    "database": "ok | error",
    "materialized_view": "ok | stale | error",
    "api": "ok"
  },
  "version": "1.0.0"
}
```

- `ok` — all systems operational
- `degraded` — API running but a backend check failed/stale
- Always returns HTTP 200 (monitoring tools need 200 to parse body)

## UptimeRobot Setup (Free Tier)

1. Go to [uptimerobot.com](https://uptimerobot.com) → Sign up / Log in
2. Click **Add New Monitor**
3. Configure:
   - **Monitor Type:** HTTP(S)
   - **Friendly Name:** Layer5 API
   - **URL:** `https://your-api.railway.app/health`
   - **Monitoring Interval:** 5 minutes
4. **Alert Contacts:** Add your email
5. (Optional) **Keyword Monitoring:**
   - Check response contains: `"status":"ok"`
   - Alert if keyword is NOT found (catches degraded state)
6. Save

## What You Get (Free)

- Uptime percentage tracking (last 24h, 7d, 30d)
- Email alert within 5 minutes of downtime
- Public status page URL (optional — share with customers)
- Up to 50 monitors free
- Response time graph

## Dashboard Monitor (Optional)

Add a second monitor for the dashboard:
- **URL:** `https://your-dashboard.vercel.app`
- **Monitor Type:** HTTP(S)
- **Interval:** 5 minutes

## Supabase Database Monitor (Optional)

Supabase provides its own health at:
- `https://[project-ref].supabase.co/rest/v1/` (returns 200 if running)
- Add as a third UptimeRobot monitor
