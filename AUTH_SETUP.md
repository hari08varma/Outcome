# Layer5 Auth Setup Guide

## 1. Enable Google OAuth in Supabase

1. Go to **Supabase Dashboard → Authentication → Providers**
2. Enable **Google** provider
3. Create OAuth credentials at [console.cloud.google.com](https://console.cloud.google.com):
   - New project → APIs & Services → Credentials
   - OAuth 2.0 Client ID → Web application
   - Authorized redirect URIs:
     ```
     https://fakomwsewdxazaqawjuv.supabase.co/auth/v1/callback
     ```
4. Copy **Client ID** and **Client Secret** into Supabase
5. Save

## 2. Configure Redirect URLs

In **Supabase Dashboard → Authentication → URL Configuration**:

| Setting | Value |
|---|---|
| Site URL | `https://your-production-domain.com` |
| Redirect URLs | Add all below: |

```
http://localhost:5173/dashboard
http://localhost:3000/dashboard
https://your-production-domain.com/dashboard
```

## 3. Set Dashboard Environment Variables

Create `dashboard/.env`:

```env
VITE_SUPABASE_URL=https://fakomwsewdxazaqawjuv.supabase.co
VITE_SUPABASE_ANON_KEY=[your anon key from Supabase Dashboard → Settings → API]
```

## 4. Test Auth Flow Locally

```bash
cd layer5/dashboard && npm run dev
```

Open [http://localhost:5173/auth?mode=signup](http://localhost:5173/auth?mode=signup) and test:

- [ ] Sign up with Google → should redirect to `/dashboard`
- [ ] Sign up with email → check inbox for verification email
- [ ] Sign in with email/password → should redirect to `/dashboard`
- [ ] Visit `/dashboard` without login → should redirect to `/auth?mode=login`
- [ ] Visit `/auth` while logged in → should redirect to `/dashboard`
- [ ] Click "Forgot password?" → reset form shows
- [ ] Toggle between login ↔ signup via link at bottom
- [ ] Sign out button in nav → redirects to `/auth?mode=login`

## 5. Run Auth Migration

If the auth system migration (013) hasn't been applied yet:

```bash
node scripts/run-migrations.js 013
```

## Known Limitations (fix before production)

- **Email verification** is required before dashboard access (Supabase default)
- **Password reset email** template uses Supabase default — customize in Supabase Dashboard → Auth → Email Templates
- **Rate limit**: 3 signups per hour per IP (Supabase default) — increase in Supabase Dashboard → Auth → Rate Limits
- **Google OAuth** won't work until Client ID/Secret are configured in Supabase (see Step 1)
