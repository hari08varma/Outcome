// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYER5 — Edge Function: trust-updater
// ==============================================================
// Triggered async after every outcome write (or via cron for batch).
// Recalculates agent trust scores based on outcome success/failure.
//
// Trust Update Rules:
//   On success:  consecutive_failures = 0; trust_score = MIN(score × 1.03, 1.0)
//   On failure:  consecutive_failures += 1; trust_score = score × (0.9 ^ failures)
//
// Status thresholds:
//   trust_score >= 0.6  → 'trusted'
//   trust_score 0.3–0.6 → 'probation'
//   trust_score < 0.3 OR consecutive_failures >= 5 → 'suspended'
//
// Deploy: supabase functions deploy trust-updater
// Cron:   */5 * * * *  (every 5 minutes for batch catchup)
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

interface TrustRow {
    trust_id: string;
    agent_id: string;
    trust_score: number;
    total_decisions: number;
    correct_decisions: number;
    consecutive_failures: number;
    trust_status: string;
}

function computeNewTrust(
    current: TrustRow,
    success: boolean
): { newScore: number; newFailures: number; newCorrect: number; newStatus: string } {
    let newScore: number;
    let newFailures: number;
    let newCorrect = current.correct_decisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        newScore = Math.min(current.trust_score * 1.03, 1.0);
    } else {
        newFailures = current.consecutive_failures + 1;
        newScore = current.trust_score * Math.pow(0.9, newFailures);
    }

    let newStatus: string;
    if (newScore < 0.3 || newFailures >= 5) {
        newStatus = 'suspended';
    } else if (newScore < 0.6) {
        newStatus = 'probation';
    } else {
        newStatus = 'trusted';
    }

    return { newScore, newFailures, newCorrect, newStatus };
}

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const isCronInvocation = req.headers.get('x-supabase-event') === 'cron';

    if (!isCronInvocation && authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });

    // ── Mode: single outcome (POST body) or batch (cron) ───────
    let mode: 'single' | 'batch' = 'batch';
    let singlePayload: { agent_id: string; customer_id: string; success: boolean } | null = null;

    if (req.method === 'POST') {
        try {
            const body = await req.json();
            if (body.agent_id && body.customer_id && typeof body.success === 'boolean') {
                mode = 'single';
                singlePayload = body;
            }
        } catch {
            // Not JSON or missing fields → fall through to batch mode
        }
    }

    const results = {
        mode,
        agents_processed: 0,
        status_changes: 0,
        suspensions: 0,
        errors: 0,
    };

    if (mode === 'single' && singlePayload) {
        // ── Single agent update ────────────────────────────────
        const { agent_id, customer_id, success } = singlePayload;

        const { data: trust } = await supabase
            .from('agent_trust_scores')
            .select('*')
            .eq('agent_id', agent_id)
            .maybeSingle();

        if (trust) {
            const oldStatus = trust.trust_status;
            const { newScore, newFailures, newCorrect, newStatus } = computeNewTrust(trust, success);

            await supabase
                .from('agent_trust_scores')
                .update({
                    trust_score: newScore,
                    total_decisions: trust.total_decisions + 1,
                    correct_decisions: newCorrect,
                    consecutive_failures: newFailures,
                    trust_status: newStatus,
                    suspension_reason: newStatus === 'suspended'
                        ? (newFailures >= 5 ? 'consecutive_failures_exceeded' : 'trust_score_below_threshold')
                        : null,
                    updated_at: new Date().toISOString(),
                })
                .eq('agent_id', agent_id);

            results.agents_processed = 1;

            if (oldStatus !== newStatus) {
                results.status_changes = 1;
                if (newStatus === 'suspended') results.suspensions = 1;

                await supabase.from('agent_trust_audit').insert({
                    agent_id,
                    customer_id,
                    event_type: newStatus === 'suspended' ? 'suspended' : 'recalibrated',
                    old_score: trust.trust_score,
                    new_score: newScore,
                    old_status: oldStatus,
                    new_status: newStatus,
                    performed_by: 'trust-updater',
                    reason: newStatus === 'suspended'
                        ? `Auto-suspended: score=${newScore.toFixed(3)}, failures=${newFailures}`
                        : `Trust ${oldStatus} → ${newStatus}`,
                });
            }
        }
    } else {
        // ── Batch mode: recalculate trust for all agents ────────
        // Look at outcomes logged since last trust update
        const { data: agents } = await supabase
            .from('agent_trust_scores')
            .select('*');

        if (agents) {
            for (const trust of agents) {
                // Get the latest outcome for this agent since last trust update
                const { data: recentOutcomes } = await supabase
                    .from('fact_outcomes')
                    .select('success, timestamp, customer_id')
                    .eq('agent_id', trust.agent_id)
                    .eq('is_synthetic', false)
                    .gt('timestamp', trust.updated_at ?? '1970-01-01')
                    .order('timestamp', { ascending: true });

                if (!recentOutcomes || recentOutcomes.length === 0) continue;

                // Apply each outcome sequentially to compute final state
                let currentTrust = { ...trust };
                for (const outcome of recentOutcomes) {
                    const { newScore, newFailures, newCorrect, newStatus } = computeNewTrust(
                        currentTrust as TrustRow,
                        outcome.success
                    );
                    currentTrust = {
                        ...currentTrust,
                        trust_score: newScore,
                        consecutive_failures: newFailures,
                        correct_decisions: newCorrect,
                        total_decisions: currentTrust.total_decisions + 1,
                        trust_status: newStatus,
                    };
                }

                const oldStatus = trust.trust_status;
                const newStatus = currentTrust.trust_status;

                await supabase
                    .from('agent_trust_scores')
                    .update({
                        trust_score: currentTrust.trust_score,
                        total_decisions: currentTrust.total_decisions,
                        correct_decisions: currentTrust.correct_decisions,
                        consecutive_failures: currentTrust.consecutive_failures,
                        trust_status: newStatus,
                        suspension_reason: newStatus === 'suspended'
                            ? (currentTrust.consecutive_failures >= 5
                                ? 'consecutive_failures_exceeded'
                                : 'trust_score_below_threshold')
                            : null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('agent_id', trust.agent_id);

                results.agents_processed++;

                if (oldStatus !== newStatus) {
                    results.status_changes++;
                    if (newStatus === 'suspended') results.suspensions++;

                    const customerId = recentOutcomes[recentOutcomes.length - 1].customer_id;
                    await supabase.from('agent_trust_audit').insert({
                        agent_id: trust.agent_id,
                        customer_id: customerId,
                        event_type: newStatus === 'suspended' ? 'suspended' : 'recalibrated',
                        old_score: trust.trust_score,
                        new_score: currentTrust.trust_score,
                        old_status: oldStatus,
                        new_status: newStatus,
                        performed_by: 'trust-updater-batch',
                        reason: `Batch recalculation: processed ${recentOutcomes.length} outcomes`,
                    });
                }
            }
        }
    }

    const duration = Date.now() - startTime;
    return new Response(
        JSON.stringify({ completed: true, duration_ms: duration, timestamp: new Date().toISOString(), ...results }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
});
