/**
 * Layerinfinite — routes/admin/reinstate-sandbox.ts
 * POST /v1/admin/agents/:agent_id/sandbox-reinstate
 * ══════════════════════════════════════════════════════════════
 * Reinstates a suspended agent directly into the Sandbox protocol
 * to begin a graduated behavioral recovery sequence under review.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';

export const reinstateSandboxRouter = new Hono();

const ReinstateSandboxBody = z.object({
    consecutive_failures_override: z.number().int().min(0).optional().default(0),
    trust_score_boost: z.number().min(0.0).max(1.0).optional().default(0.15),
    reason: z.string().min(1).max(1000),
});

reinstateSandboxRouter.post('/:agent_id/sandbox-reinstate', async (c) => {
    const agentId = c.req.param('agent_id');

    let body: z.infer<typeof ReinstateSandboxBody>;
    try {
        body = ReinstateSandboxBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json(
            { error: 'Invalid request body', details: err.errors ?? err.message, code: 'VALIDATION_ERROR' },
            400
        );
    }

    // 1. Verify agent exists and is suspended
    const { data: trustRec, error: fetchErr } = await supabase
        .from('agent_trust_scores')
        .select('trust_status, customer_id')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (fetchErr || !trustRec) {
        return c.json({ error: 'Agent trust record not found', code: 'NOT_FOUND' }, 404);
    }

    if (trustRec.trust_status !== 'suspended') {
        return c.json(
            { error: 'Agent is not currently suspended', code: 'INVALID_STATE', current_status: trustRec.trust_status },
            400
        );
    }

    // 2-4. Update trust scores to push them into Sandbox manually
    const { error: updateErr } = await supabase
        .from('agent_trust_scores')
        .update({
            trust_score: body.trust_score_boost,
            trust_status: 'sandbox',
            consecutive_failures: body.consecutive_failures_override,
            suspension_reason: null,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);

    if (updateErr) {
        return c.json({ error: 'Failed to update trust status', code: 'UPDATE_ERROR' }, 500);
    }

    // 5. Insert audit trail record
    const { error: auditErr } = await supabase
        .from('agent_trust_audit')
        .insert({
            agent_id: agentId,
            customer_id: trustRec.customer_id,
            event_type: 'sandbox_reinstated',
            old_score: 0.0, // Arbitrary for suspended
            new_score: body.trust_score_boost,
            old_status: 'suspended',
            new_status: 'sandbox',
            reason: body.reason,
        });

    if (auditErr) {
        console.warn('[reinstate-sandbox] Failed to log audit trail:', auditErr.message);
    }

    return c.json({
        success: true,
        message: 'Agent reinstated into Sandbox mode. All autonomous functions restabilized but explicitly flagged for human review verification.',
        new_status: 'sandbox',
        trust_score: body.trust_score_boost,
        consecutive_failures: body.consecutive_failures_override,
    }, 200);
});
