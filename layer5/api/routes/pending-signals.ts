import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { supabase } from '../lib/supabase.js';

const pendingSignalsRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

pendingSignalsRoute.use('*', primaryAuth, rateLimitMiddleware());

const PendingBody = z.object({
    outcome_id: z.string().uuid(),
    action_name: z.string().min(1),
    provider_hint: z.enum(['stripe', 'sendgrid', 'generic']).nullable().optional(),
    feedback_signal: z.literal('delayed'),
});

pendingSignalsRoute.post('/', async (c) => {
    let body: z.infer<typeof PendingBody>;
    try {
        body = PendingBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    const customerId = c.get('customer_id') as string;

    const { data: outcome, error: outcomeError } = await supabase
        .from('fact_outcomes')
        .select('outcome_id, agent_id')
        .eq('outcome_id', body.outcome_id)
        .maybeSingle();

    if (outcomeError) {
        return c.json({ error: 'Failed outcome lookup', details: outcomeError.message }, 500);
    }

    if (!outcome) {
        return c.json({ error: 'Outcome not found', code: 'NOT_FOUND' }, 404);
    }

    const { data: agent, error: agentError } = await supabase
        .from('dim_agents')
        .select('agent_id')
        .eq('agent_id', outcome.agent_id)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (agentError) {
        return c.json({ error: 'Failed ownership lookup', details: agentError.message }, 500);
    }

    if (!agent) {
        return c.json({ error: 'Outcome not found', code: 'NOT_FOUND' }, 404);
    }

    const { data: contract } = await supabase
        .from('dim_signal_contracts')
        .select('id')
        .eq('customer_id', customerId)
        .eq('action_name', body.action_name)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    const { data: inserted, error: insertError } = await supabase
        .from('dim_pending_signal_registrations')
        .insert({
            outcome_id: body.outcome_id,
            customer_id: customerId,
            action_name: body.action_name,
            provider_hint: body.provider_hint ?? null,
            contract_id: contract?.id ?? null,
        })
        .select('id, outcome_id, registered_at')
        .single();

    if (insertError) {
        return c.json({ error: 'Failed pending registration insert', details: insertError.message }, 500);
    }

    return c.json(inserted, 201);
});

export default pendingSignalsRoute;
