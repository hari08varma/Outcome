/**
 * Layer5 — routes/outcome-feedback.ts
 * POST /v1/outcome-feedback
 * ══════════════════════════════════════════════════════════════
 * Accepts delayed outcome feedback — submitted hours/days after
 * the original outcome was logged.
 *
 * This is the ONE permitted UPDATE path on fact_outcomes.
 * Only outcome_score, business_outcome, and feedback_received_at
 * are modified. All other columns remain immutable.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { invalidateCache } from '../lib/scoring.js';

export const outcomeFeedbackRouter = new Hono();

const FeedbackBody = z.object({
    outcome_id: z.string().uuid(),
    final_score: z.number().min(0.0).max(1.0),
    business_outcome: z.enum(['resolved', 'partial', 'failed', 'unknown']),
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
        .select('outcome_id, customer_id, context_id')
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
    // The prevent_outcome_update trigger allows changes ONLY to
    // outcome_score, business_outcome, and feedback_received_at.
    const { error: updateErr } = await supabase
        .from('fact_outcomes')
        .update({
            outcome_score: body.final_score,
            business_outcome: body.business_outcome,
            feedback_received_at: new Date().toISOString(),
        })
        .eq('outcome_id', body.outcome_id);

    if (updateErr) {
        return c.json({ error: 'Failed to update outcome', details: updateErr.message }, 500);
    }

    // ── Trigger score cache refresh (async, non-blocking) ────
    invalidateCache(customerId, outcome.context_id);

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
    });
});
