// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYER5 — Edge Function: trend-detector
// ==============================================================
// Runs nightly via Supabase cron.
// Detects:
//   1. Degradation alerts: trend_delta < -0.15
//   2. Score flip contradictions: success rate change > 0.4 in 7d
//
// Deploy: supabase functions deploy trend-detector
// Cron:   0 2 * * *  (nightly at 02:00 UTC)
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LAYER5_INTERNAL_SECRET = Deno.env.get('LAYER5_INTERNAL_SECRET');

// Thresholds
const DEGRADATION_THRESHOLD = -0.15;
const SCORE_FLIP_THRESHOLD = 0.4;

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const isCronInvocation = req.headers.get('x-supabase-event') === 'cron';

    if (!isCronInvocation && (!LAYER5_INTERNAL_SECRET || authHeader !== `Bearer ${LAYER5_INTERNAL_SECRET}`)) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });

    const results: Record<string, unknown> = {
        degradation_alerts: { inserted: 0, errors: 0 },
        trend_changes: { inserted: 0, errors: 0 },
    };

    // ── Step 1: Detect degradation (trend_delta < -0.15) ───────
    try {
        const { data: degraded, error: queryErr } = await supabase
            .from('mv_action_scores')
            .select('action_id, context_id, customer_id, action_name, trend_delta, raw_success_rate, weighted_success_rate, total_attempts')
            .not('trend_delta', 'is', null)
            .lt('trend_delta', DEGRADATION_THRESHOLD);

        if (queryErr) {
            console.error('[trend-detector] Degradation query failed:', queryErr.message);
            (results.degradation_alerts as any).error = queryErr.message;
        } else if (degraded && degraded.length > 0) {
            console.log(`[trend-detector] Found ${degraded.length} degraded actions`);

            for (const row of degraded) {
                // Check if alert already exists for this action+context in the last 24h
                const { data: existing } = await supabase
                    .from('degradation_alert_events')
                    .select('alert_id')
                    .eq('action_id', row.action_id)
                    .eq('context_id', row.context_id)
                    .eq('customer_id', row.customer_id)
                    .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
                    .limit(1)
                    .maybeSingle();

                if (existing) {
                    // Already alerted in last 24h — skip duplicate
                    continue;
                }

                // Compute previous success rate from trend_delta
                const currentRate = row.weighted_success_rate ?? row.raw_success_rate ?? 0;
                const previousRate = currentRate - (row.trend_delta ?? 0);

                const { error: insertErr } = await supabase
                    .from('degradation_alert_events')
                    .insert({
                        action_id: row.action_id,
                        context_id: row.context_id,
                        customer_id: row.customer_id,
                        action_name: row.action_name,
                        trend_delta: row.trend_delta,
                        current_success_rate: currentRate,
                        previous_success_rate: Math.max(0, previousRate),
                        total_attempts: row.total_attempts,
                    });

                if (insertErr) {
                    console.error('[trend-detector] Alert insert failed:', insertErr.message);
                    (results.degradation_alerts as any).errors++;
                } else {
                    (results.degradation_alerts as any).inserted++;
                }
            }
        } else {
            console.log('[trend-detector] No degraded actions found');
        }
    } catch (err) {
        console.error('[trend-detector] Degradation detection error:', err);
        (results.degradation_alerts as any).error = String(err);
    }

    // ── Step 2: Detect score flips (>0.4 magnitude in 7 days) ──
    try {
        // Query current week vs previous week success rates
        // We use mv_action_scores which already has the raw and weighted rates
        const { data: allScores, error: scoresErr } = await supabase
            .from('mv_action_scores')
            .select('action_id, context_id, customer_id, action_name, raw_success_rate, weighted_success_rate, trend_delta, total_attempts')
            .not('trend_delta', 'is', null);

        if (scoresErr) {
            console.error('[trend-detector] Score flip query failed:', scoresErr.message);
            (results.trend_changes as any).error = scoresErr.message;
        } else if (allScores && allScores.length > 0) {
            for (const row of allScores) {
                const currentRate = row.weighted_success_rate ?? row.raw_success_rate ?? 0;
                const trendDelta = row.trend_delta ?? 0;
                // Approximate previous rate from delta
                const previousRate = currentRate - trendDelta;
                const flipMagnitude = Math.abs(trendDelta);

                if (flipMagnitude < SCORE_FLIP_THRESHOLD) continue;

                // Check if event already exists in last 24h
                const { data: existing } = await supabase
                    .from('trend_change_events')
                    .select('event_id')
                    .eq('action_id', row.action_id)
                    .eq('context_id', row.context_id)
                    .eq('customer_id', row.customer_id)
                    .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
                    .limit(1)
                    .maybeSingle();

                if (existing) continue;

                const { error: insertErr } = await supabase
                    .from('trend_change_events')
                    .insert({
                        action_id: row.action_id,
                        context_id: row.context_id,
                        customer_id: row.customer_id,
                        action_name: row.action_name,
                        old_success_rate: Math.max(0, Math.min(1, previousRate)),
                        new_success_rate: currentRate,
                        score_flip_magnitude: Math.round(flipMagnitude * 10000) / 10000,
                        affected_outcomes_count: row.total_attempts ?? 0,
                    });

                if (insertErr) {
                    console.error('[trend-detector] Trend change insert failed:', insertErr.message);
                    (results.trend_changes as any).errors++;
                } else {
                    (results.trend_changes as any).inserted++;
                }
            }
        }
    } catch (err) {
        console.error('[trend-detector] Score flip detection error:', err);
        (results.trend_changes as any).error = String(err);
    }

    // ── Step 3: Latency spike detection (Gap 1) ──────────────
    results.latency_spikes = { inserted: 0, errors: 0 };
    try {
        const LATENCY_SPIKE_THRESHOLD = 3.0;

        const { data: latencySpikes, error: latencyErr } = await supabase
            .from('mv_action_scores')
            .select(`
                action_id, customer_id, context_id,
                latency_p95_ms, latency_p95_baseline_ms,
                latency_spike_ratio
            `)
            .not('latency_spike_ratio', 'is', null)
            .gte('latency_spike_ratio', LATENCY_SPIKE_THRESHOLD)
            .gte('total_attempts', 10);

        if (latencyErr) {
            console.error('[trend-detector] Latency spike query failed:', latencyErr.message);
            (results.latency_spikes as any).error = latencyErr.message;
        } else if (latencySpikes && latencySpikes.length > 0) {
            console.log(`[trend-detector] Found ${latencySpikes.length} latency spikes`);

            for (const spike of latencySpikes) {
                // 24h dedup
                const { data: existing } = await supabase
                    .from('degradation_alert_events')
                    .select('alert_id')
                    .eq('action_id', spike.action_id)
                    .eq('context_id', spike.context_id)
                    .eq('customer_id', spike.customer_id)
                    .eq('alert_type', 'latency_spike')
                    .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
                    .limit(1)
                    .maybeSingle();

                if (existing) continue;

                const { error: insertErr } = await supabase
                    .from('degradation_alert_events')
                    .insert({
                        customer_id: spike.customer_id,
                        action_id: spike.action_id,
                        context_id: spike.context_id,
                        alert_type: 'latency_spike',
                        severity: spike.latency_spike_ratio >= 5.0 ? 'critical' : 'warning',
                        current_value: spike.latency_p95_ms,
                        baseline_value: spike.latency_p95_baseline_ms,
                        spike_ratio: spike.latency_spike_ratio,
                        message: `p95 latency ${spike.latency_p95_ms}ms is ${spike.latency_spike_ratio.toFixed(1)}x above 30-day baseline (${spike.latency_p95_baseline_ms}ms)`,
                    });

                if (insertErr) {
                    console.error('[trend-detector] Latency alert insert failed:', insertErr.message);
                    (results.latency_spikes as any).errors++;
                } else {
                    (results.latency_spikes as any).inserted++;
                }
            }
        } else {
            console.log('[trend-detector] No latency spikes found');
        }
    } catch (err) {
        console.error('[trend-detector] Latency spike detection error:', err);
        (results.latency_spikes as any).error = String(err);
    }

    // ── Step 4: Coordinated failure detection (Gap 3) ──────────
    results.coordinated_failures = { inserted: 0, errors: 0 };
    try {
        const COORDINATION_WINDOW_MINUTES = 15;
        const MIN_AGENTS_FOR_COORDINATION = 3;

        const { data: coordinatedFailures, error: coordErr } = await supabase.rpc(
            'detect_coordinated_failures',
            {
                window_minutes: COORDINATION_WINDOW_MINUTES,
                min_agent_count: MIN_AGENTS_FOR_COORDINATION,
            }
        );

        if (coordErr) {
            console.error('[trend-detector] Coordinated failure query failed:', coordErr.message);
            (results.coordinated_failures as any).error = coordErr.message;
        } else if (coordinatedFailures && coordinatedFailures.length > 0) {
            console.log(`[trend-detector] Found ${coordinatedFailures.length} coordinated failures`);

            for (const failure of coordinatedFailures) {
                // 1-hour dedup (shorter than 24h — coordinated failures can recur hourly)
                const { data: recentAlert } = await supabase
                    .from('degradation_alert_events')
                    .select('alert_id')
                    .eq('customer_id', failure.customer_id)
                    .eq('alert_type', 'coordinated_failure')
                    .eq('action_id', failure.action_id)
                    .gte('detected_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
                    .limit(1)
                    .maybeSingle();

                if (recentAlert) continue;

                const { error: insertErr } = await supabase
                    .from('degradation_alert_events')
                    .insert({
                        customer_id: failure.customer_id,
                        action_id: failure.action_id,
                        alert_type: 'coordinated_failure',
                        severity: 'critical',
                        affected_agent_count: failure.agent_count,
                        message: `${failure.agent_count} agents all failed "${failure.action_name}" within ${COORDINATION_WINDOW_MINUTES} minutes. Likely shared infrastructure failure. Escalate to platform team immediately.`,
                    });

                if (insertErr) {
                    console.error('[trend-detector] Coordinated failure alert insert failed:', insertErr.message);
                    (results.coordinated_failures as any).errors++;
                } else {
                    (results.coordinated_failures as any).inserted++;
                }
            }
        } else {
            console.log('[trend-detector] No coordinated failures found');
        }
    } catch (err) {
        console.error('[trend-detector] Coordinated failure detection error:', err);
        (results.coordinated_failures as any).error = String(err);
    }

    // TODO: Seasonal anomaly detection (Gap 4)
    // Build after 90 days of production data.
    // Requires: day_of_week + hour_of_day columns
    // in mv_action_scores baseline comparison.
    // Trigger: Black Friday / month-end /
    // scheduled batch job patterns.
    // Data already being collected via timestamp.

    // ── Response ────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const response = {
        completed: true,
        duration_ms: totalDuration,
        timestamp: new Date().toISOString(),
        thresholds: {
            degradation: DEGRADATION_THRESHOLD,
            score_flip: SCORE_FLIP_THRESHOLD,
        },
        results,
    };

    console.log('[trend-detector] Complete in', totalDuration, 'ms —',
        JSON.stringify(results));

    return new Response(
        JSON.stringify(response),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
});
