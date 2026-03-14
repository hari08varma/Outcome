// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYERINFINITE — Edge Function: scoring-engine
// ==============================================================
// Triggered by Supabase cron every 5 minutes.
// Refreshes mv_action_scores CONCURRENTLY.
// Refreshes mv_episode_patterns nightly (or on demand).
//
// Deploy: supabase functions deploy scoring-engine
// Cron:   Supabase Dashboard → Edge Functions → scoring-engine
//         → Schedule: */5 * * * *
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LAYERINFINITE_INTERNAL_SECRET = Deno.env.get('LAYERINFINITE_INTERNAL_SECRET');

// Internal endpoint to notify API server of cache refresh
// (The API server maintains an in-memory score cache with 5-min TTL)
const API_CACHE_REFRESH_URL = Deno.env.get('API_CACHE_REFRESH_URL') ?? '';

// Staleness threshold: alert if last refresh > 10 min ago (in ms)
const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check (for manual invocations) ────────────────────
    // Cron invocations come from Supabase infrastructure (trusted).
    // Manual invocations require service role key in Authorization header.
    const authHeader = req.headers.get('Authorization') ?? '';
    const isCronInvocation = req.headers.get('x-supabase-event') === 'cron';

    if (!isCronInvocation && (!LAYERINFINITE_INTERNAL_SECRET || authHeader !== `Bearer ${LAYERINFINITE_INTERNAL_SECRET}`)) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });

    const results: Record<string, unknown> = {};

    // ── Step 1: Check staleness ─────────────────────────────────
    let lastRefreshAt: Date | null = null;
    try {
        const { data, error } = await supabase
            .from('mv_action_scores')
            .select('view_refreshed_at')
            .limit(1)
            .maybeSingle();

        if (!error && data?.view_refreshed_at) {
            lastRefreshAt = new Date(data.view_refreshed_at);
            const ageMs = Date.now() - lastRefreshAt.getTime();
            if (ageMs > STALENESS_THRESHOLD_MS) {
                console.warn(`[scoring-engine] STALE: mv_action_scores last refreshed ${Math.round(ageMs / 60000)} mins ago`);
                results.staleness_alert = true;
                results.last_refresh_age_minutes = Math.round(ageMs / 60000);
            }
        }
    } catch (err) {
        console.warn('[scoring-engine] Could not check staleness:', err);
    }

    // ── Step 2: Refresh mv_action_scores ───────────────────────
    const refreshScoresStart = Date.now();
    try {
        const { error } = await supabase.rpc('refresh_mv_action_scores');
        if (error) throw error;
        results.mv_action_scores = {
            status: 'refreshed',
            duration_ms: Date.now() - refreshScoresStart,
        };
        console.log('[scoring-engine] mv_action_scores refreshed in', Date.now() - refreshScoresStart, 'ms');
    } catch (err) {
        console.error('[scoring-engine] mv_action_scores refresh failed:', err);
        results.mv_action_scores = { status: 'error', error: String(err) };
    }

    // ── Step 3: Refresh mv_episode_patterns (nightly only) ─────
    // Only refresh episodes during nightly window (22:00–06:00 UTC)
    // or when triggered manually with ?force_episodes=true
    const forceEpisodes = new URL(req.url).searchParams.get('force_episodes') === 'true';
    const hourUTC = new Date().getUTCHours();
    const isNightlyWindow = hourUTC >= 22 || hourUTC < 6;

    if (isNightlyWindow || forceEpisodes) {
        const refreshEpisodesStart = Date.now();
        try {
            const { error } = await supabase.rpc('refresh_mv_episode_patterns');
            if (error) throw error;
            results.mv_episode_patterns = {
                status: 'refreshed',
                duration_ms: Date.now() - refreshEpisodesStart,
            };
            console.log('[scoring-engine] mv_episode_patterns refreshed in', Date.now() - refreshEpisodesStart, 'ms');
        } catch (err) {
            console.error('[scoring-engine] mv_episode_patterns refresh failed:', err);
            results.mv_episode_patterns = { status: 'error', error: String(err) };
        }
    } else {
        results.mv_episode_patterns = { status: 'skipped', reason: 'outside nightly window' };
    }

    // ── Step 4: Notify API server to refresh score cache ───────
    if (API_CACHE_REFRESH_URL) {
        try {
            const cacheRes = await fetch(`${API_CACHE_REFRESH_URL}/internal/refresh-score-cache`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LAYERINFINITE_INTERNAL_SECRET}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ triggered_by: 'scoring-engine' }),
            });
            results.cache_refresh = {
                status: cacheRes.ok ? 'notified' : 'failed',
                http_status: cacheRes.status,
            };
        } catch (err) {
            // Non-fatal: cache will TTL-expire naturally
            console.warn('[scoring-engine] Cache refresh notification failed (non-fatal):', err);
            results.cache_refresh = { status: 'skipped', reason: String(err) };
        }
    } else {
        results.cache_refresh = { status: 'skipped', reason: 'API_CACHE_REFRESH_URL not configured' };
    }

    // ── Response ────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const response = {
        refreshed: true,
        duration_ms: totalDuration,
        timestamp: new Date().toISOString(),
        results,
    };

    console.log('[scoring-engine] Complete in', totalDuration, 'ms');

    return new Response(
        JSON.stringify(response),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
});
