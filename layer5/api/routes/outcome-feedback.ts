/**
 * Layerinfinite — routes/outcome-feedback.ts
 * POST /v1/outcome-feedback
 * ══════════════════════════════════════════════════════════════
 * Accepts delayed outcome feedback — submitted hours/days after
 * the original outcome was logged.
 *
 * This is the ONE permitted UPDATE path on fact_outcomes.
 * It updates reconciliation fields (score, business_outcome,
 * feedback timestamps, pending/cross-event state, and
 * execution-status trace metadata). All identity fields remain immutable.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { invalidateCache } from '../lib/scoring.js';
import { invalidateActionBaselineCache } from '../lib/outcome-score-inference.js';

export const outcomeFeedbackRouter = new Hono();

const FeedbackBody = z.object({
    outcome_id: z.string().uuid(),
    final_score: z.number().min(0.0).max(1.0),
    // Any string is accepted. Values are normalized to the four canonical
    // labels at the application layer. Unknown values map to 'unknown'.
    // Field is metadata-only — never read by scoring, trust, or policy.
    business_outcome: z
        .string()
        .min(1)
        .max(100)
        .transform(val => {
            const normalized = val.trim().toLowerCase();
            const known = ['resolved', 'partial', 'failed', 'unknown'] as const;
            return (known as readonly string[]).includes(normalized)
                ? (normalized as typeof known[number])
                : 'unknown';
        }),
    feedback_notes: z.string().max(2000).optional(),
});

outcomeFeedbackRouter.post('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    let body: z.infer<typeof FeedbackBody>;
    try {
        body = FeedbackBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json(
            { error: 'Invalid request body', details: err.errors ?? err.message, code: 'VALIDATION_ERROR' },
            400
        );
    }

    // ── Verify outcome belongs to this customer ──────────────
    const { data: outcome, error: lookupErr } = await supabase
        .from('fact_outcomes')
        .select('outcome_id, customer_id, context_id, success, signal_pending, cross_event_status, action_id, agent_id')
        .eq('outcome_id', body.outcome_id)
        .maybeSingle();

    if (lookupErr) {
        return c.json({ error: 'Lookup failed', details: lookupErr.message }, 500);
    }

    if (!outcome || outcome.customer_id !== customerId) {
        return c.json({ error: 'Outcome not found', code: 'NOT_FOUND' }, 404);
    }

    // ── Insert feedback record ───────────────────────────────
    const { error: feedbackErr } = await supabase
        .from('fact_outcome_feedback')
        .insert({
            outcome_id: body.outcome_id,
            customer_id: customerId,
            final_score: body.final_score,
            business_outcome: body.business_outcome,
            feedback_notes: body.feedback_notes ?? null,
        });

    if (feedbackErr) {
        return c.json({ error: 'Failed to store feedback', details: feedbackErr.message }, 500);
    }

    // ── Update fact_outcomes with final score ────────────────
    // This is the ONE permitted UPDATE on fact_outcomes.
    // The prevent_outcome_update trigger enforces append-only semantics for
    // identity columns while allowing the reconciliation field set below.
    const feedbackSignalsSuccess = body.final_score >= 0.5;
    const executionStatus = feedbackSignalsSuccess ? 'COMPLETED' : 'FAILED';
    const failureReasonCode = executionStatus === 'FAILED'
        ? 'delayed_feedback_failed'
        : null;
    const failureStage = executionStatus === 'FAILED'
        ? 'delayed_feedback'
        : null;
    const crossEventStatus = outcome.signal_pending === true
        ? (outcome.success === feedbackSignalsSuccess ? 'confirmed' : 'conflict')
        : (outcome.success === feedbackSignalsSuccess ? 'resolved' : 'conflict');
    const nowIso = new Date().toISOString();

    const { error: updateErr } = await supabase
        .from('fact_outcomes')
        .update({
            outcome_score: body.final_score,
            business_outcome: body.business_outcome,
            feedback_received_at: nowIso,
            signal_pending: false,
            signal_updated_at: nowIso,
            cross_event_status: crossEventStatus,
            cross_event_last_updated: nowIso,
            execution_status: executionStatus,
            failure_reason_code: failureReasonCode,
            failure_stage: failureStage,
            status_origin: 'reconciled_feedback',
        })
        .eq('outcome_id', body.outcome_id)
        .eq('customer_id', customerId);

    if (updateErr) {
        return c.json({ error: 'Failed to update outcome', details: updateErr.message }, 500);
    }

    // ── Trigger score cache refresh (async, non-blocking) ────
    invalidateCache(customerId, outcome.context_id);
    invalidateActionBaselineCache(outcome.agent_id ?? undefined, outcome.action_id ?? undefined);

    const { error: resolvePendingError } = await supabase
        .from('dim_pending_signal_registrations')
        .update({
            resolved: true,
            resolved_at: nowIso,
            resolved_by: 'outcome_feedback',
        })
        .eq('customer_id', customerId)
        .eq('outcome_id', body.outcome_id)
        .eq('resolved', false);

    if (resolvePendingError) {
        console.warn('[outcome-feedback] failed to resolve pending registrations:', resolvePendingError.message);
    }

    if (crossEventStatus === 'conflict') {
        const { data: existingConflict } = await supabase
            .from('dim_discrepancy_log')
            .select('discrepancy_id')
            .eq('customer_id', customerId)
            .eq('outcome_id', body.outcome_id)
            .eq('discrepancy_type', 'cross_event_conflict')
            .eq('resolved', false)
            .limit(1);

        if (!existingConflict || existingConflict.length === 0) {
            await supabase
                .from('dim_discrepancy_log')
                .insert({
                    customer_id: customerId,
                    outcome_id: body.outcome_id,
                    action_name: `action:${outcome.action_id ?? 'unknown'}`,
                    discrepancy_type: 'cross_event_conflict',
                    expected_outcome: outcome.success,
                    actual_outcome: feedbackSignalsSuccess,
                    signal_confidence: body.final_score,
                    detail:
                        'Delayed feedback contradicted initial outcome polarity. ' +
                        `initial_success=${String(outcome.success)} final_score=${body.final_score.toFixed(4)}.`,
                    reason_code: 'cross_event_feedback_conflict',
                    trace_reason_code: 'cross_event_feedback_conflict',
                    trace_stage: 'delayed_feedback',
                    trace_gate: 'cross_event_status_conflict',
                    source_execution_status: executionStatus,
                    source_status_origin: 'reconciled_feedback',
                    source_failure_reason_code: failureReasonCode,
                    source_failure_stage: failureStage,
                    trace_payload: {
                        initial_success: outcome.success,
                        final_score: body.final_score,
                        signal_pending_before_feedback: outcome.signal_pending === true,
                    },
                    trace_context: {
                        initial_success: outcome.success,
                        final_score: body.final_score,
                        signal_pending_before_feedback: outcome.signal_pending === true,
                    },
                });
        }
    }

    // ── DELAYED SILENT FAILURE DETECTION (Gap 5) ─────────────
    // Original outcome was success=true but feedback shows low score.
    (async () => {
        const { data: original } = await supabase
            .from('fact_outcomes')
            .select('success, action_id, agent_id')
            .eq('outcome_id', body.outcome_id)
            .single();

        const isDelayedSilentFailure =
            original?.success === true &&
            body.final_score < 0.3;

        if (isDelayedSilentFailure) {
            await supabase.from('degradation_alert_events').insert({
                customer_id: customerId,
                action_id: original.action_id,
                alert_type: 'degradation',
                severity: 'warning',
                current_value: body.final_score,
                baseline_value: 1.0,
                message: `Delayed silent failure confirmed: "${body.business_outcome}" — originally logged as success, final score: ${body.final_score}. ${body.feedback_notes || ''}`,
            });
        }
    })().catch(err => {
        console.warn('[outcome-feedback] Delayed silent failure check failed:', err);
    });

    return c.json({
        updated: true,
        outcome_id: body.outcome_id,
        final_score: body.final_score,
        business_outcome: body.business_outcome,
        execution_status: executionStatus,
        failure_reason_code: failureReasonCode,
        failure_stage: failureStage,
        status_origin: 'reconciled_feedback',
        cross_event_status: crossEventStatus,
        cross_event_conflict: crossEventStatus === 'conflict',
    });
});
