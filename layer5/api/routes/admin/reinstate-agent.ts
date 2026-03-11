/**
 * Layer5 — routes/admin/reinstate-agent.ts
 * POST /v1/admin/reinstate-agent
 * ══════════════════════════════════════════════════════════════
 * Reinstates a suspended agent to probation status.
 * Sets trust_score=0.4, trust_status='probation',
 * consecutive_failures=0, and logs to agent_trust_audit.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';

export const reinstateAgentRouter = new Hono();

const ReinstateBody = z.object({
    agent_id: z.string().uuid(),
    reinstated_by: z.string().min(1).max(255),
});

reinstateAgentRouter.post('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    let body: z.infer<typeof ReinstateBody>;
    try {
        body = ReinstateBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    // ── Verify agent belongs to this customer ──────────────────
    const { data: agent, error: agentErr } = await supabase
        .from('dim_agents')
        .select('agent_id, agent_name, customer_id')
        .eq('agent_id', body.agent_id)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (agentErr) {
        return c.json({ error: 'Agent lookup failed', details: agentErr.message }, 500);
    }
    if (!agent) {
        return c.json({ error: 'Agent not found or does not belong to your account', code: 'NOT_FOUND' }, 404);
    }

    // ── Verify agent is currently suspended ────────────────────
    const { data: trust, error: trustErr } = await supabase
        .from('agent_trust_scores')
        .select('trust_score, trust_status, consecutive_failures')
        .eq('agent_id', body.agent_id)
        .maybeSingle();

    if (trustErr) {
        return c.json({ error: 'Trust lookup failed', details: trustErr.message }, 500);
    }

    if (!trust || trust.trust_status !== 'suspended') {
        return c.json(
            { error: 'Agent is not currently suspended', code: 'INVALID_STATE', current_status: trust?.trust_status ?? 'unknown' },
            400
        );
    }

    // ── Reinstate: update trust scores ─────────────────────────
    const { error: updateErr } = await supabase
        .from('agent_trust_scores')
        .update({
            trust_score: 0.4,
            trust_status: 'probation',
            consecutive_failures: 0,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', body.agent_id);

    if (updateErr) {
        return c.json({ error: 'Failed to reinstate agent', details: updateErr.message }, 500);
    }

    // ── Log to agent_trust_audit ───────────────────────────────
    await supabase
        .from('agent_trust_audit')
        .insert({
            agent_id: body.agent_id,
            customer_id: customerId,
            event_type: 'reinstated',
            old_score: trust.trust_score,
            new_score: 0.4,
            old_status: 'suspended',
            new_status: 'probation',
            performed_by: body.reinstated_by,
            reason: `Manually reinstated by ${body.reinstated_by}`,
        });

    return c.json({
        reinstated: true,
        agent_id: body.agent_id,
        agent_name: agent.agent_name,
        new_status: 'probation',
        new_score: 0.4,
        message: `Agent "${agent.agent_name}" reinstated to probation (score: 0.4).`,
    }, 200);
});
