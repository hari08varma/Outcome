// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYERINFINITE — Edge Function: trust-updater
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
// Audit strategy:
//   EVERY outcome writes one audit row — not just status changes.
//   This is what powers the Trust History timeline in the dashboard.
//   old_score and old_status are ALWAYS captured before any update.
//
// Deploy: supabase functions deploy trust-updater
// Cron:   */5 * * * *  (every 5 minutes for batch catchup)
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LAYERINFINITE_INTERNAL_SECRET = Deno.env.get('LAYERINFINITE_INTERNAL_SECRET');

interface TrustRow {
    trust_id: string;
    agent_id: string;
    trust_score: number;
    total_decisions: number;
    correct_decisions: number;
    consecutive_failures: number;
    trust_status: string;
    updated_at: string;
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

// ── FIX: Build reason string that dashboard can parse ─────────
// agent.tsx parses action name from reason using these patterns:
//   "Outcome success via SDK: {action_name}"
//   "Outcome failure recorded: {action_name}"
// Keep this format consistent — the dashboard regex depends on it.
function buildReason(success: boolean, actionName: string | null | undefined): string {
    const action = actionName?.trim() || 'unknown_action';
    return success
        ? `Outcome success via SDK: ${action}`
        : `Outcome failure recorded: ${action}`;
}

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check ─────────────────────────────────────────────
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

    // ── Mode: single outcome (POST body) or batch (cron) ───────
    let mode: 'single' | 'batch' = 'batch';

    // FIX: payload now includes action_name so audit rows can display
    // the action in the Trust History timeline
    let singlePayload: {
        agent_id: string;
        customer_id: string;
        success: boolean;
        action_name?: string;   // ← added: used in audit reason string
    } | null = null;

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
        const { agent_id, customer_id, success, action_name } = singlePayload;

        const { data: trust } = await supabase
            .from('agent_trust_scores')
            .select('*')
            .eq('agent_id', agent_id)
            .maybeSingle();

        if (trust) {
            // FIX: always capture old values BEFORE any update
            // Previously old_score/old_status were only saved on status changes.
            // Now every audit row has them — dashboard can show proper deltas.
            const oldScore = trust.trust_score;
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
            }

            // FIX: write audit row for EVERY outcome, not just status changes.
            // The Trust History timeline shows per-outcome events — if we only
            // write on status change, the timeline is almost always empty.
            await supabase.from('agent_trust_audit').insert({
                agent_id,
                customer_id,
                // event_type: "success" or "failure" drives the ✓/✕ icon in dashboard
                event_type: success ? 'success' : 'failure',
                old_score: oldScore,           // FIX: was null — now always populated
                new_score: newScore,
                old_status: oldStatus,         // FIX: was null — now always populated
                new_status: newStatus,
                performed_by: 'trust-updater',
                // FIX: reason format matches the regex in agent.tsx parseActionFromReason()
                // "Outcome success via SDK: close_ticket"
                // "Outcome failure recorded: escalate_to_human"
                reason: buildReason(success, action_name),
            });
        }
    } else {
        // ── Batch mode: recalculate trust for all agents ────────
        const { data: agents } = await supabase
            .from('agent_trust_scores')
            .select('*');

        if (agents) {
            for (const trust of agents) {
                const { data: recentOutcomes } = await supabase
                    .from('fact_outcomes')
                    .select('success, timestamp, customer_id, action_id')
                    .eq('agent_id', trust.agent_id)
                    .eq('is_synthetic', false)
                    .gt('timestamp', trust.updated_at ?? '1970-01-01')
                    .order('timestamp', { ascending: true });

                if (!recentOutcomes || recentOutcomes.length === 0) continue;

                // FIX: capture old state before any mutations
                const oldScore = trust.trust_score;
                const oldStatus = trust.trust_status;

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
                }

                // FIX: write one audit row per outcome (not one per batch run).
                // This gives the Trust History timeline real per-action granularity.
                const customerId = recentOutcomes[recentOutcomes.length - 1].customer_id;
                const auditRows = recentOutcomes.map((outcome) => ({
                    agent_id: trust.agent_id,
                    customer_id: customerId,
                    event_type: outcome.success ? 'success' : 'failure',
                    // FIX: old_score/old_status populated — was null before
                    old_score: oldScore,
                    old_status: oldStatus,
                    new_score: currentTrust.trust_score,
                    new_status: newStatus,
                    performed_by: 'trust-updater-batch',
                    // action_id is available on each outcome row; action_name
                    // is not denormalised here — use the reason format that
                    // agent.tsx can parse, falling back to action_id for tracing
                    reason: outcome.success
                        ? `Outcome success via SDK: ${outcome.action_id ?? 'unknown'}`
                        : `Outcome failure recorded: ${outcome.action_id ?? 'unknown'}`,
                    performed_at: outcome.timestamp,
                }));

                // Batch insert — one call per agent instead of one per outcome
                if (auditRows.length > 0) {
                    await supabase.from('agent_trust_audit').insert(auditRows);
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