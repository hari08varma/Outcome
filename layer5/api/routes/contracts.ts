import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { supabase } from '../lib/supabase.js';

const contractsRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

contractsRoute.use('*', primaryAuth, rateLimitMiddleware());

const ContractBody = z.object({
    action_name: z.string().min(1),
    success_condition: z.string().min(1),
    score_expression: z.string().min(1),
    timeout_hours: z.number().int().min(1).max(8760).default(24),
    fallback_strategy: z.enum(['use_http_status', 'explicit_only', 'always_pending']).default('use_http_status'),
});

contractsRoute.post('/', async (c) => {
    let body: z.infer<typeof ContractBody>;
    try {
        body = ContractBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    const customerId = c.get('customer_id') as string;

    const { data, error } = await supabase
        .from('dim_signal_contracts')
        .upsert({
            customer_id: customerId,
            action_name: body.action_name,
            success_condition: body.success_condition,
            score_expression: body.score_expression,
            timeout_hours: body.timeout_hours,
            fallback_strategy: body.fallback_strategy,
            is_active: true,
        }, { onConflict: 'customer_id,action_name' })
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
        .eq('id', id)
        .eq('customer_id', customerId)
        .select('id');

    if (error) {
        return c.json({ error: 'Failed to deactivate contract', details: error.message }, 500);
    }

    if (!data || data.length === 0) {
        return c.json({ error: 'Contract not found', code: 'NOT_FOUND' }, 404);
    }

    return new Response(null, { status: 204 });
});

export default contractsRoute;
