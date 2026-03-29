import { Hono } from 'hono';
import { getRecommendation } from '../lib/recommendation/engine.js';
import { buildActionableOutput } from '../lib/recommendation/reason.js';
import { supabase } from '../lib/supabase.js';

export const getRecommendationsRouter = new Hono();

// GET /tasks — returns distinct task_names available for a customer (+ optional agent scope)
// Must be registered before '/' so Hono matches it first
getRecommendationsRouter.get('/tasks', async (c) => {
    const customerId = c.get('customer_id') as string | undefined;
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    const scopedAgentId = c.req.query('agent_id')?.trim() || null;

    try {
        let query = supabase
            .from('mv_task_action_performance')
            .select('task_name')
            .eq('customer_id', customerId)
            .neq('agent_id', '00000000-0000-0000-0000-000000000000');

        if (scopedAgentId) {
            query = query.eq('agent_id', scopedAgentId);
        }

        const { data, error } = await query;
        if (error) return c.json({ tasks: [] }, 200);

        const tasks = [
            ...new Set((data ?? []).map((r: any) => r.task_name as string)),
        ].sort();

        return c.json({ tasks }, 200);
    } catch {
        return c.json({ tasks: [] }, 200);
    }
});

getRecommendationsRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string | undefined;
    const agentId = c.get('agent_id') as string | undefined;

    if (!customerId) {
        return c.json(
            { error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' },
            401
        );
    }

    const rawTask = c.req.query('task');
    // Optional agent_id filter — scopes recommendation to a single agent
    // When absent, returns customer-wide blended view (backward compatible)
    const rawAgentId = c.req.query('agent_id') ?? null;
    const scopedAgentId = rawAgentId?.trim() || null;

    if (!rawTask || rawTask.trim() === '') {
        return c.json(
            {
                error: 'Missing required query parameter: task',
                code: 'MISSING_TASK',
                hint: 'Example: GET /v1/recommendations?task=payment_failed',
            },
            400
        );
    }

    const taskName = rawTask.trim()
        .toLowerCase()
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^_+|_+$/g, '')
        || rawTask.trim().toLowerCase();

    if (taskName.length === 0) {
        return c.json(
            {
                error: 'Invalid task parameter - could not normalize to a valid slug',
                code: 'INVALID_TASK',
            },
            400
        );
    }

    try {
        const result = await getRecommendation(customerId, taskName, scopedAgentId);
        const output = buildActionableOutput(result);

        return c.json(
            {
                ...output,
                agent_id: result.agent_id,
                agent_scope: scopedAgentId
                    ? 'agent_scoped'
                    : 'customer_blended',
                scope_label: scopedAgentId
                    ? 'Based on this agent\'s logged outcomes only'
                    : 'Based on all agents\' combined outcomes',
                customer_id: customerId,
            },
            200
        );
    } catch (err: any) {
        console.error('[get-recommendations] unexpected error:', err.message);
        return c.json(
            {
                error: 'Internal server error',
                code: 'INTERNAL_ERROR',
                details: err.message,
            },
            500
        );
    }
});
