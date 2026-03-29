# Layerinfinite API — Production Checklist

## Railway Environment Variables (Required)

| Variable | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` | From Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | Service role key (never anon key) |
| `SUPABASE_ANON_KEY` | `eyJ...` | Anon key for client-facing ops |
| `LAYERINFINITE_INTERNAL_SECRET` | random 32-char secret | Used for /internal/* routes |
| `NODE_ENV` | `production` | Enables production guards |
| `ALLOWED_ORIGINS` | `https://layerinfinite.app,https://www.layerinfinite.app` | **CRITICAL — see note below** |

## ⚠️ ALLOWED_ORIGINS — Do NOT add Vercel preview URLs

The dashboard is permanently served at `https://layerinfinite.app`.  
Vercel creates random preview URLs on every deploy (e.g. `outcome-abc123.vercel.app`) — **never add these to ALLOWED_ORIGINS**.

**Correct value (permanent):**
```
ALLOWED_ORIGINS=https://layerinfinite.app,https://www.layerinfinite.app
```

**Wrong (breaks on next deploy):**
```
ALLOWED_ORIGINS=https://outcome-green.vercel.app,https://layerinfinite.app
```

Vercel is configured to route all traffic through the custom domain `layerinfinite.app`.  
Preview deployments are blocked from calling the API by design — they should use a staging API if needed.

## Vercel Environment Variables (Required)

| Variable | Value |
|---|---|
| `VITE_LAYERINFINITE_API_URL` | `https://api.layerinfinite.app` |
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` |

## Custom Domains

| Service | Domain |
|---|---|
| Dashboard (Vercel) | `layerinfinite.app`, `www.layerinfinite.app` |
| API (Railway) | `api.layerinfinite.app` |
