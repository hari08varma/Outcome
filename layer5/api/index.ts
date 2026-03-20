/**
 * Layerinfinite — api/index.ts
 * ══════════════════════════════════════════════════════════════
 * Main Hono application entry point.
 *
 * Middleware order:
 *   1. Global: logger, CORS, secureHeaders, prettyJSON
 *   2. Rate limit on all /v1 routes (tiered by customer tier)
 *   3. Admin routes: authMiddleware + adminAuthMiddleware
 *   4. Agent routes: authMiddleware (or devAuthMiddleware)
 *   5. validateActionMiddleware on log-outcome only
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';
import { serve } from '@hono/node-server';
import * as Sentry from '@sentry/node';

// Initialize BEFORE creating the Hono app
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'production',
        tracesSampleRate: 0.1,  // 10% of requests traced
    });
}

const REQUIRED_ENV_VARS = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_ANON_KEY',
];

if (process.env.NODE_ENV === 'production') {
    REQUIRED_ENV_VARS.push('LAYERINFINITE_INTERNAL_SECRET');
}

const missing = REQUIRED_ENV_VARS.filter(
    v => !process.env[v]
);

if (missing.length > 0) {
    console.error(
        '❌ FATAL: Missing required environment variables:\n' +
        missing.map(v => `  - ${v}`).join('\n') +
        '\n\nCopy .env.example to .env and fill in values.\n' +
        'See PRODUCTION_CHECKLIST.md for instructions.'
    );
    process.exit(1);
}

// In development, LAYERINFINITE_DEV_API_KEY is optional 
// (falls back to real auth). Never required in production.
if (process.env.NODE_ENV !== 'production' &&
    !process.env.LAYERINFINITE_DEV_API_KEY) {
    console.warn(
        '⚠️  LAYERINFINITE_DEV_API_KEY not set. ' +
        'Dev bypass will require real API keys. ' +
        'Set it in .env for local testing convenience.'
    );
}

import { authMiddleware, devAuthMiddleware } from './middleware/auth.js';
import { adminAuthMiddleware } from './middleware/admin-auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { validateActionMiddleware } from './middleware/validate-action.js';

import { logOutcomeRouter } from './routes/log-outcome.js';
import { getScoresRouter } from './routes/get-scores.js';
import { getPatternsRouter } from './routes/get-patterns.js';
import { auditRouter } from './routes/audit.js';
import { actionsRouter } from './routes/admin/actions.js';
import { reinstateAgentRouter } from './routes/admin/reinstate-agent.js';
import { reinstateSandboxRouter } from './routes/admin/reinstate-sandbox.js';
import { testNotificationRouter } from './routes/admin/test-notification.js';
import { triggerTrainingRoute } from './routes/admin/trigger-training.js';
import { userAuthMiddleware } from './middleware/user-auth.js';
import { apiKeysRouter } from './routes/auth/api-keys.js';
import { outcomeFeedbackRouter } from './routes/outcome-feedback.js';
import { simulateRouter } from './routes/simulate.js';

// ── PORT: Railway injects PORT, fallback to API_PORT, then 3000 ──
const PORT = parseInt(process.env.PORT ?? process.env.API_PORT ?? '3000', 10);

// ── FATAL: Dev bypass CANNOT be active in production ──────────
if (process.env.NODE_ENV === 'production' &&
    process.env.LAYERINFINITE_DEV_BYPASS === 'true') {
    console.error('FATAL: Dev bypass cannot be active in production. Set LAYERINFINITE_DEV_BYPASS=false.');
    process.exit(1);
}

// ── Create app ────────────────────────────────────────────────
const app = new Hono();

// ── CORS: env-driven origins ──────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:5173'];

// Warn loudly in production if no https:// origin is configured
if (process.env.NODE_ENV === 'production') {
    const hasHttps = allowedOrigins.some(o => o.startsWith('https://'));
    if (!hasHttps) {
        console.warn(
            '⚠️  CORS WARNING: ALLOWED_ORIGINS contains no https:// URL in production.\n' +
            '   Current origins: ' + allowedOrigins.join(', ') + '\n' +
            '   All browser requests from your dashboard will be blocked.\n' +
            '   Set ALLOWED_ORIGINS=https://your-dashboard.vercel.app on Railway.'
        );
    }
}

// ── Global middleware ─────────────────────────────────────────
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
    origin: (origin) => allowedOrigins.includes(origin) ? origin : null,
    allowHeaders: ['X-API-Key', 'X-Admin-Key', 'Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
}));
app.use('*', prettyJSON());

// ── Global Timeout Middleware ─────────────────────────────────
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? '10000', 10);

app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/health/deep' || c.req.path === '/') {
        return next();
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const start = Date.now();

    try {
        await Promise.race([
            next(),
            new Promise((_, reject) => {
                controller.signal.addEventListener('abort',
                    () => reject(new Error('TIMEOUT')));
            })
        ]);
    } catch (e: any) {
        if (e?.message === 'TIMEOUT') {
            const elapsed = Date.now() - start;
            console.warn(`[layerinfinite] Request timeout on ${c.req.path} after ${elapsed}ms`);
            return c.json(
                { error: 'Request timeout', code: 'GATEWAY_TIMEOUT', timeout_ms: REQUEST_TIMEOUT_MS },
                504
            );
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
});

// ── Health check (no auth, no rate limiting) ──────────────────
app.get('/', (c) => c.json({
    service: 'Layerinfinite Decision Intelligence API',
    version: '1.0.0',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cors: {
        origins_count: allowedOrigins.length,
        has_production_origin: allowedOrigins.some(o => o.startsWith('https://')),
    },
    endpoints: {
        'POST /v1/log-outcome': 'Append outcome to fact_outcomes',
        'GET  /v1/get-scores': 'Get ranked action scores',
        'GET  /v1/get-patterns': 'Get action sequence patterns',
        'GET  /v1/audit': 'Immutable audit trail',
        'POST /v1/admin/register-action': 'Register an action (admin)',
        'GET  /v1/admin/actions': 'List actions (admin)',
        'POST /v1/admin/reinstate-agent': 'Reinstate suspended agent (admin)',
        'POST /v1/admin/test-notification': 'Test a notification channel (admin)',
        'GET  /health/deep': 'Deep health check (table + env var diagnostics)',
    },
}));

app.get('/health', async (c) => {
    const checks: Record<string, string> = { api: 'ok' };
    let overallStatus = 'ok';

    try {
        const { supabase } = await import('./lib/supabase.js');
        const { error } = await supabase.from('dim_customers').select('customer_id').limit(1);
        checks.database = error ? 'error' : 'ok';
    } catch {
        checks.database = 'error';
    }

    try {
        const { supabase } = await import('./lib/supabase.js');
        const { data, error } = await supabase
            .from('mv_action_scores')
            .select('view_refreshed_at')
            .limit(1);

        if (error || !data || data.length === 0) {
            checks.materialized_view = 'stale';
        } else {
            const refreshedAt = new Date(data[0].view_refreshed_at);
            const ageMinutes = (Date.now() - refreshedAt.getTime()) / 60000;
            checks.materialized_view = ageMinutes > 15 ? 'stale' : 'ok';
        }
    } catch {
        checks.materialized_view = 'error';
    }

    if (Object.values(checks).some(v => v === 'error')) {
        overallStatus = 'degraded';
    } else if (Object.values(checks).some(v => v === 'stale')) {
        overallStatus = 'degraded';
    }

    return c.json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        checks,
        version: '1.0.0',
    });
});

// ── Deep health check ───────────────────────────────────────
app.get('/health/deep', async (c) => {
    const checks: Record<string, string> = { api: 'ok' };
    let overallStatus = 'ok';

    // ── Table reachability checks ──────────────────────────
    const tables = ['dim_agents', 'dim_customers', 'user_profiles', 'dim_actions', 'dim_contexts'] as const;
    try {
        const { supabase } = await import('./lib/supabase.js');
        for (const table of tables) {
            try {
                const { error } = await (supabase as any).from(table).select('*').limit(1);
                checks[`table_${table}`] = error ? `error: ${error.message}` : 'ok';
            } catch (e: any) {
                checks[`table_${table}`] = `error: ${e.message}`;
            }
        }
    } catch (e: any) {
        for (const table of tables) checks[`table_${table}`] = 'error: supabase unavailable';
    }

    // ── Schema version ─────────────────────────────────────
    try {
        const { supabase } = await import('./lib/supabase.js');
        const { data, error } = await supabase
            .from('schema_migrations')
            .select('version')
            .order('version', { ascending: false })
            .limit(1);
        checks.schema_version = (!error && data && data.length > 0)
            ? `v${data[0].version}`
            : 'unknown';
    } catch {
        checks.schema_version = 'unknown';
    }

    // ── Environment variable checks ────────────────────────
    checks.env_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
        ? `set (${allowedOrigins.length} origins)`
        : 'missing';
    checks.env_LAYERINFINITE_INTERNAL_SECRET = process.env.LAYERINFINITE_INTERNAL_SECRET
        ? 'set'
        : 'missing';
    checks.env_SUPABASE_URL = process.env.SUPABASE_URL ? 'set' : 'missing';
    checks.env_SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'missing';

    // ── Existing materialized view check ──────────────────
    try {
        const { supabase } = await import('./lib/supabase.js');
        const { data, error } = await supabase
            .from('mv_action_scores')
            .select('view_refreshed_at')
            .limit(1);
        if (error || !data || data.length === 0) {
            checks.materialized_view = 'stale';
        } else {
            const ageMinutes = (Date.now() - new Date(data[0].view_refreshed_at).getTime()) / 60000;
            checks.materialized_view = ageMinutes > 15 ? 'stale' : 'ok';
        }
    } catch {
        checks.materialized_view = 'error';
    }

    // ── Overall status calculation ─────────────────────────
    const vals = Object.values(checks);
    if (vals.some(v => v.startsWith('error') || v === 'missing')) {
        overallStatus = 'degraded';
    } else if (vals.some(v => v === 'stale' || v === 'unknown')) {
        overallStatus = 'degraded';
    }

    return c.json({
        status: overallStatus,
        timestamp: new Date().toISOString(),
        checks,
        version: '1.0.0',
    }, overallStatus === 'ok' ? 200 : 200); // always 200, let callers read 'status'
});

// ── Internal: scoring cache refresh ───────────────────────────
app.post('/internal/refresh-score-cache', async (c) => {
    const auth = c.req.header('Authorization');
    const internalSecret = process.env.LAYERINFINITE_INTERNAL_SECRET;
    if (!internalSecret || auth !== `Bearer ${internalSecret}`) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    const { invalidateCache } = await import('./lib/scoring.js');
    invalidateCache();
    return c.json({ ok: true, message: 'Score cache cleared' });
});

// ── v1 API ────────────────────────────────────────────────────
const v1 = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

const authRoutes = new Hono();
authRoutes.use('*', userAuthMiddleware);
authRoutes.use('*', rateLimitMiddleware());
authRoutes.route('/api-keys', apiKeysRouter);
authRoutes.route('/keys', apiKeysRouter);
v1.route('/auth', authRoutes);

v1.use('/admin/*', adminAuthMiddleware);
v1.route('/admin', actionsRouter);
v1.route('/admin/reinstate-agent', reinstateAgentRouter);
v1.route('/admin', reinstateSandboxRouter);
v1.route('/admin/test-notification', testNotificationRouter);
v1.route('/admin/trigger-training', triggerTrainingRoute);

v1.use('/log-outcome/*', primaryAuth, rateLimitMiddleware(), validateActionMiddleware);
v1.use('/outcome-feedback/*', primaryAuth, rateLimitMiddleware());
v1.use('/get-scores/*', primaryAuth, rateLimitMiddleware());
v1.use('/get-patterns/*', primaryAuth, rateLimitMiddleware());
v1.use('/audit/*', primaryAuth, rateLimitMiddleware());
v1.use('/simulate/*', primaryAuth, rateLimitMiddleware());

v1.route('/log-outcome', logOutcomeRouter);
v1.route('/outcome-feedback', outcomeFeedbackRouter);
v1.route('/get-scores', getScoresRouter);
v1.route('/get-patterns', getPatternsRouter);
v1.route('/audit', auditRouter);
v1.route('/simulate', simulateRouter);

app.route('/v1', v1);

// ── 404 fallback ──────────────────────────────────────────────
app.notFound((c) => c.json(
    { error: 'Route not found', code: 'NOT_FOUND', available_prefix: '/v1' },
    404
));

// ── Global error handler ──────────────────────────────────────
app.onError((err, c) => {
    if (process.env.SENTRY_DSN) {
        Sentry.captureException(err, {
            extra: {
                path: c.req.path,
                method: c.req.method,
            },
        });
    }

    console.error('[layerinfinite] Unhandled error:', err.message);
    return c.json(
        { error: 'Internal server error', code: 'INTERNAL_ERROR', message: err.message },
        500
    );
});

// ── Start server ──────────────────────────────────────────────
serve({
    fetch: app.fetch,
    port: PORT,
}, (info) => {
    console.log(`\n🚀 Layerinfinite API running on port ${info.port}`);
    console.log(`   Mode:       ${process.env.NODE_ENV ?? 'development'}`);
    console.log(`   Dev bypass: ${process.env.LAYERINFINITE_DEV_BYPASS === 'true' ? '⚠️  ACTIVE' : 'disabled'}`);
    console.log(`   Endpoints:  POST /v1/log-outcome | GET /v1/get-scores | GET /v1/get-patterns | GET /v1/audit`);
    console.log(`   Admin:      POST /v1/admin/register-action | GET /v1/admin/actions | POST /v1/admin/reinstate-agent`);
    console.log(`   Rate limit: Tiered (1K/2K/5K per min by customer tier)\n`);
});
