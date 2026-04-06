import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
import { supabase } from '../lib/supabase.js';

const pendingSignalsRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

pendingSignalsRoute.use('*', primaryAuth);

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

    const { data: action, error: actionError } = await supabase
        .from('dim_actions')
        .select('action_id')
        .eq('customer_id', customerId)
        .eq('action_name', body.action_name)
        .maybeSingle();

    if (actionError) {
        return c.json({ error: 'Failed action lookup', details: actionError.message }, 500);
    }

    if (!action) {
        return c.json({ error: 'No active contract found for this action' }, 422);
    }

    const { data: contract, error: contractError } = await supabase
        .from('dim_signal_contracts')
        .select('contract_id, event_type, platform')
        .eq('customer_id', customerId)
        .eq('action_id', action.action_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();

    if (contractError) {
        return c.json({ error: 'Failed contract lookup', details: contractError.message }, 500);
    }

    if (!contract) {
        return c.json({ error: 'No active contract found for this action' }, 422);
    }

    const { data: existingRegistration, error: existingRegistrationError } = await supabase
        .from('dim_pending_signal_registrations')
        .select('registration_id, outcome_id, created_at')
        .eq('customer_id', customerId)
        .eq('outcome_id', body.outcome_id)
        .eq('event_type', contract.event_type)
        .eq('platform', contract.platform)
        .eq('resolved', false)
        .limit(1)
        .maybeSingle();

    if (existingRegistrationError) {
        return c.json({ error: 'Failed pending registration lookup', details: existingRegistrationError.message }, 500);
    }

    if (existingRegistration) {
        const nowIso = new Date().toISOString();
        const { error: markExistingPendingError } = await supabase
            .from('fact_outcomes')
            .update({
                signal_pending: true,
                signal_updated_at: nowIso,
                cross_event_status: 'pending_signal',
                cross_event_last_updated: nowIso,
                pending_registration_id: existingRegistration.registration_id,
            })
            .eq('outcome_id', body.outcome_id)
            .eq('customer_id', customerId);

        if (markExistingPendingError) {
            return c.json({
                error: 'Failed to mark outcome as pending',
                details: markExistingPendingError.message,
            }, 500);
        }

        return c.json({
            ...existingRegistration,
            idempotent_replay: true,
            pending_state: {
                signal_pending: true,
                cross_event_status: 'pending_signal',
            },
        }, 200);
    }

    const { data: inserted, error: insertError } = await supabase
        .from('dim_pending_signal_registrations')
        .insert({
            outcome_id: body.outcome_id,
            agent_id: outcome.agent_id,
            customer_id: customerId,
            event_type: contract.event_type,
            platform: contract.platform,
        })
        .select('registration_id, outcome_id, created_at')
        .single();

    if (insertError) {
        return c.json({ error: 'Failed pending registration insert', details: insertError.message }, 500);
    }

    const nowIso = new Date().toISOString();
    const { error: pendingStateError } = await supabase
        .from('fact_outcomes')
        .update({
            signal_pending: true,
            signal_updated_at: nowIso,
            cross_event_status: 'pending_signal',
            cross_event_last_updated: nowIso,
            pending_registration_id: inserted.registration_id,
        })
        .eq('outcome_id', body.outcome_id)
        .eq('customer_id', customerId);

    if (pendingStateError) {
        await supabase
            .from('dim_pending_signal_registrations')
            .delete()
            .eq('registration_id', inserted.registration_id)
            .eq('customer_id', customerId);

        return c.json({
            error: 'Failed to sync pending state on outcome',
            details: pendingStateError.message,
        }, 500);
    }

    return c.json({
        ...inserted,
        idempotent_replay: false,
        pending_state: {
            signal_pending: true,
            cross_event_status: 'pending_signal',
        },
    }, 201);
});

export default pendingSignalsRoute;
