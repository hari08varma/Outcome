/**
 * Layerinfinite — routes/admin/actions.ts
 * Admin action management endpoints.
 * ══════════════════════════════════════════════════════════════
 * REST endpoints:
 * POST /        — register a new action
 * GET  /        — list all registered actions
 * GET  /:id     — get a single action
 * PUT  /:id     — enable/disable an action
 *
 * Legacy aliases are kept for compatibility:
 * POST /register-action, GET /actions, GET /actions/:id, PUT /actions/:id
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
    // Any string is accepted. Value is normalized to lowercase.
    // 'custom' is the default for callers that omit the field.
    // Field is a display label — scoring.ts passes it through as-is,
    // no branching or scoring weight applied.
    action_category: z
        .string()
        .max(100)
        .optional()
        .default('custom')
        .transform(val => val.trim().toLowerCase()),
    action_description: z.string().max(1000).optional(),
    required_params: z.array(z.string()).optional().default([]),
    validation_mode: z.string().optional().default('none'),
});

function getCustomerId(c: any): string | null {
    return ((c as any).get('customerId') ?? c.get('customer_id') ?? null) as string | null;
}

async function registerActionHandler(c: any) {
    const customerId = getCustomerId(c);
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

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
            validation_mode: body.validation_mode ?? 'none',
            is_active: true,
            customer_id: customerId,
        })
        .select('action_id, action_name, action_category, is_active, customer_id, created_at')
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
}

async function listActionsHandler(c: any) {
    const customerId = getCustomerId(c);
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const { data, error } = await supabase
        .from('dim_actions')
        .select('*')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false });

    if (error) return c.json({ error: error.message }, 500);

    return c.json({
        actions: data ?? [],
        total: data?.length ?? 0,
        note: 'Customer-scoped action registry.',
    });
}

async function getActionByIdHandler(c: any) {
    const customerId = getCustomerId(c);
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const actionId = c.req.param('id');
    const { data, error } = await supabase
        .from('dim_actions')
        .select('*')
        .eq('action_id', actionId)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (error) return c.json({ error: error.message }, 500);
    if (!data) return c.json({ error: 'Action not found' }, 404);

    return c.json({ action: data });
}

async function toggleActionHandler(c: any) {
    const customerId = getCustomerId(c);
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

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
        .update({
            is_active: body.is_active,
            updated_at: new Date().toISOString(),
        })
        .eq('action_id', actionId)
        .eq('customer_id', customerId)
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
}

// ── RESTful paths ─────────────────────────────────────────────
actionsRouter.get('/', listActionsHandler);
actionsRouter.post('/', registerActionHandler);
actionsRouter.get('/:id', getActionByIdHandler);
actionsRouter.put('/:id', toggleActionHandler);

// ── Legacy aliases ────────────────────────────────────────────
actionsRouter.get('/actions', listActionsHandler);
actionsRouter.post('/register-action', registerActionHandler);
actionsRouter.get('/actions/:id', getActionByIdHandler);
actionsRouter.put('/actions/:id', toggleActionHandler);
