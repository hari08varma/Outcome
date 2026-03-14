/**
 * Layerinfinite — routes/admin/actions.ts
 * Admin action management endpoints.
 * ══════════════════════════════════════════════════════════════
 * POST /register-action   — register a new action
 * GET  /actions            — list all registered actions
 * PUT  /actions/:id        — enable/disable an action
 *
 * Authentication via admin-auth.ts middleware (customer_admin).
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';
import { invalidateActionCache } from '../../middleware/validate-action.js';

export const actionsRouter = new Hono();

// ── Register action schema ────────────────────────────────────
const RegisterActionBody = z.object({
    action_name: z.string().min(1).max(255),
    action_category: z.enum(['recovery', 'escalation', 'automation', 'custom']).default('custom'),
    action_description: z.string().max(1000).optional(),
    required_params: z.record(z.string(), z.unknown()).optional().default({}),
});

// ── POST /register-action ─────────────────────────────────────
actionsRouter.post('/register-action', async (c) => {
    let body: z.infer<typeof RegisterActionBody>;
    try {
        body = RegisterActionBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    const { data, error } = await supabase
        .from('dim_actions')
        .insert({
            action_name: body.action_name,
            action_category: body.action_category,
            action_description: body.action_description ?? null,
            required_params: body.required_params,
            is_active: true,
        })
        .select('action_id, action_name, action_category, created_at')
        .single();

    if (error) {
        if (error.code === '23505') {
            return c.json(
                { error: `Action "${body.action_name}" already exists.`, code: 'DUPLICATE' },
                409
            );
        }
        return c.json({ error: 'Failed to register action', details: error.message }, 500);
    }

    invalidateActionCache(body.action_name);

    return c.json({
        success: true,
        action: data,
        message: `Action "${body.action_name}" registered. Agents can now log outcomes with this action.`,
    }, 201);
});

// ── GET /actions — list all registered actions ────────────────
actionsRouter.get('/actions', async (c) => {
    const includeInactive = c.req.query('include_inactive') === 'true';

    let query = supabase
        .from('dim_actions')
        .select('action_id, action_name, action_category, action_description, required_params, is_active, created_at')
        .order('action_name', { ascending: true });

    if (!includeInactive) {
        query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) return c.json({ error: error.message }, 500);

    return c.json({
        actions: data ?? [],
        total: data?.length ?? 0,
        note: 'These are the only actions agents can log. Any other action name will be blocked.',
    });
});

// ── PUT /actions/:id — toggle is_active ───────────────────────
actionsRouter.put('/actions/:id', async (c) => {
    const actionId = c.req.param('id');

    let body: { is_active?: boolean };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.is_active !== 'boolean') {
        return c.json({ error: 'Provide { is_active: true|false }' }, 400);
    }

    const { data, error } = await supabase
        .from('dim_actions')
        .update({ is_active: body.is_active })
        .eq('action_id', actionId)
        .select('action_id, action_name, is_active')
        .single();

    if (error) return c.json({ error: error.message }, 500);
    if (!data) return c.json({ error: 'Action not found' }, 404);

    invalidateActionCache(data.action_name);

    return c.json({
        success: true,
        action: data,
        message: `Action "${data.action_name}" is now ${data.is_active ? 'active' : 'disabled'}.`,
    });
});
