import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
import { supabase } from '../lib/supabase.js';

const contractsRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

contractsRoute.use('*', primaryAuth);

const ContractBody = z.object({
    action_name: z.string().min(1),
    event_type: z.string().min(1),
    platform: z.string().min(1),
    success_condition: z.string().min(1),
    score_expression: z.string().min(1),
});

contractsRoute.post('/', async (c) => {
    let body: z.infer<typeof ContractBody>;
    try {
        body = ContractBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    const customerId = c.get('customer_id') as string;

    const { data: action, error: actionError } = await supabase
        .from('dim_actions')
        .select('action_id')
        .eq('action_name', body.action_name)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (actionError) {
        return c.json({ error: 'Failed to resolve action', details: actionError.message }, 500);
    }

    if (!action) {
        return c.json({ error: 'Action not found' }, 404);
    }

    const { data, error } = await supabase
        .from('dim_signal_contracts')
        .upsert({
            action_id: action.action_id,
            customer_id: customerId,
            event_type: body.event_type,
            platform: body.platform,
            success_condition: body.success_condition,
            score_expression: body.score_expression,
            is_active: true,
        }, { onConflict: 'action_id,customer_id,platform' })
        .select('*')
        .single();

    if (error) {
        return c.json({ error: 'Failed to upsert contract', details: error.message }, 500);
    }

    return c.json(data, 201);
});

contractsRoute.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const { data, error } = await supabase
        .from('dim_signal_contracts')
        .select('*')
        .eq('customer_id', customerId)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

    if (error) {
        return c.json({ error: 'Failed to list contracts', details: error.message }, 500);
    }

    return c.json(data ?? [], 200);
});

contractsRoute.delete('/:id', async (c) => {
    const customerId = c.get('customer_id') as string;
    const id = c.req.param('id');

    const { data, error } = await supabase
        .from('dim_signal_contracts')
        .update({ is_active: false })
        .eq('contract_id', id)
        .eq('customer_id', customerId)
        .select('contract_id');

    if (error) {
        return c.json({ error: 'Failed to deactivate contract', details: error.message }, 500);
    }

    if (!data || data.length === 0 || !data[0]?.contract_id) {
        return c.json({ error: 'Contract not found', code: 'NOT_FOUND' }, 404);
    }

    return new Response(null, { status: 204 });
});

export default contractsRoute;
