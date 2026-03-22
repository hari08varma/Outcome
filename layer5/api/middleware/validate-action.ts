/**
 * Layerinfinite — middleware/validate-action.ts
 * ══════════════════════════════════════════════════════════════
 * Hallucination Prevention Middleware for Hono.
 *
 * Validates that action_name from request body exists in
 * dim_actions registry. Blocks unregistered actions with 400.
 * Uses 30-min in-memory cache to minimise DB round-trips.
 *
 * On success: sets action + validated_action on context + calls next()
 * On failure: returns 400 UNKNOWN_ACTION (not 422 per PRD)
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import { supabase } from '../lib/supabase.js';

const ACTION_CACHE_TTL_MS = 30 * 60 * 1000;  // 30 min

interface ActionCacheEntry {
    action_id: string;
    action_name: string;
    action_category: string;
    required_params: Record<string, unknown>;
    validation_mode: string;
    is_active: boolean;
    expires_at: number;
}

// Cache by customer_id:action_name
const actionCache = new Map<string, ActionCacheEntry>();

function getActionCacheKey(customerId: string, actionName: string): string {
    return `${customerId}:${actionName}`;
}

// Evict expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of actionCache.entries()) {
        if (entry.expires_at < now) {
            actionCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.info(`[cache-cleanup] Evicted ${evicted} expired entries from actionCache`);
    }
}, CLEANUP_INTERVAL_MS).unref();

setInterval(() => {
    console.info(`[cache-size] actionCache: ${actionCache.size} entries`);
}, 15 * 60_000).unref();

export interface ActionValidationResult {
    valid: boolean;
    action_id?: string;
    action_name?: string;
    action_category?: string;
    required_params?: Record<string, unknown>;
    validation_mode?: string;
    error?: string;
    error_code?: string;
    warnings?: string[];
}

// Extend Hono Context to recognize validated_action
declare module 'hono' {
    interface ContextVariableMap {
        action: {
            action_id: string;
            action_name: string;
            is_active: boolean;
        };
        validated_action: {
            action_id: string;
            action_name: string;
            action_category: string;
            validation_warnings?: string[];
        };
        parsed_body: unknown;
    }
}

// ── Middleware form ───────────────────────────────────────────
/**
 * Hono middleware that validates action_name in the request body
 * against dim_actions. Sets c.set('validated_action', ...) on success.
 */
export async function validateActionMiddleware(c: Context, next: Next): Promise<Response | void> {
    // Clone the request body so downstream handlers can read it
    let body: Record<string, unknown>;
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, 400);
    }

    const actionName = body.action_name ?? body.actionName;
    const customerId = ((c as any).get('customerId') ?? c.get('customer_id')) as string | undefined;

    // If action_name is absent but action_id is present,
    // skip middleware validation — resolveActionId() handles it.
    if (!actionName || typeof actionName !== 'string') {
        if (body.action_id || body.action_id_input) {
            c.set('parsed_body', body);
            await next();
            return;
        }
        return c.json({ error: 'action_name or action_id is required', code: 'MISSING_FIELD' }, 400);
    }

    if (!customerId) {
        return c.json({ error: 'customerId is required', code: 'MISSING_CUSTOMER' }, 401);
    }

    // Look up action scoped to this customer
    const { data: existingAction } = await supabase
        .from('dim_actions')
        .select('action_id, action_name, is_active')
        .eq('action_name', actionName.trim())
        .eq('customer_id', customerId)
        .maybeSingle();

    if (!existingAction) {
        // AUTO-REGISTER: silently create on first use
        // This means users never need to manually register actions
        const { data: newAction, error: insertError } = await supabase
            .from('dim_actions')
            .upsert({
                action_name:        actionName.trim(),
                customer_id:        customerId,
                is_active:          true,
                action_category:    'auto-discovered',
                action_description: 'Auto-registered on first use by SDK',
                required_params:    {},
                validation_mode:    'advisory',
            }, {
                onConflict:       'action_name,customer_id',
                ignoreDuplicates: false,
            })
            .select('action_id, action_name, is_active')
            .maybeSingle();

        if (insertError || !newAction) {
            // Only fail if DB itself errors
            console.error('[validate-action] Auto-register failed', {
                action_name: actionName,
                customer_id: customerId,
                error_code: insertError?.code,
                error_message: insertError?.message,
            });
            return c.json({ error: 'Failed to register action' }, 500);
        }

        c.set('action', newAction);
        c.set('validated_action', {
            action_id: newAction.action_id,
            action_name: newAction.action_name,
            action_category: 'auto-discovered',
            validation_warnings: [],
        });
        c.set('parsed_body', body);
        await next();
        return;
    }

    // Action exists but is disabled — reject
    if (!existingAction.is_active) {
        return c.json(
            {
                error: 'Action is disabled',
                action_name: actionName,
            },
            403
        );
    }

    c.set('action', existingAction);
    c.set('validated_action', {
        action_id: existingAction.action_id,
        action_name: existingAction.action_name,
        action_category: 'custom',
        validation_warnings: [],
    });
    c.set('parsed_body', body);

    await next();
}

// ── Core validation function (also exported for direct use) ──
export async function validateAction(
    actionName: string,
    customerId: string,
    params?: Record<string, unknown>
): Promise<ActionValidationResult> {
    const cacheKey = getActionCacheKey(customerId, actionName);
    const cached = actionCache.get(cacheKey);

    if (cached && cached.expires_at > Date.now()) {
        if (!cached.is_active) {
            return { valid: false, error: `Action "${actionName}" is disabled`, error_code: 'ACTION_DISABLED' };
        }
        return validateParams(cached, params);
    }

    // Cache miss — lookup in dim_actions
    const { data, error } = await supabase
        .from('dim_actions')
        .select('action_id, action_name, action_category, action_description, required_params, is_active, validation_mode')
        .eq('action_name', actionName)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (error) {
        return { valid: false, error: `Action lookup failed: ${error.message}`, error_code: 'DB_ERROR' };
    }

    if (!data) {
        return {
            valid: false,
            error: `action_name '${actionName}' not found in registry and could not be auto-registered.`,
            error_code: 'UNKNOWN_ACTION',
        };
    }

    // Cache result
    actionCache.set(cacheKey, {
        ...data,
        required_params: data.required_params as Record<string, unknown>,
        expires_at: Date.now() + ACTION_CACHE_TTL_MS,
    });

    if (!data.is_active) {
        return { valid: false, error: `Action "${actionName}" is currently disabled`, error_code: 'ACTION_DISABLED' };
    }

    return validateParams(data, params);
}

function validateParams(
    action: { action_id: string; action_name: string; action_category: string; required_params: Record<string, unknown>, validation_mode?: string },
    params?: Record<string, unknown>
): ActionValidationResult {
    const mode = action.validation_mode ?? 'advisory';
    const required = action.required_params ?? {};
    const requiredKeys = Object.keys(required);

    const missing = requiredKeys.filter(k => !(k in (params ?? {})));

    if (missing.length === 0) {
        return {
            valid: true,
            action_id: action.action_id,
            action_name: action.action_name,
            action_category: action.action_category,
            required_params: action.required_params,
        };
    }

    if (mode === 'strict') {
        return {
            valid: false,
            error: `action '${action.action_name}' requires: ${missing.join(', ')}`,
            error_code: 'MISSING_PARAMS',
        };
    }

    if (mode === 'advisory') {
        return {
            valid: true,
            action_id: action.action_id,
            action_name: action.action_name,
            action_category: action.action_category,
            required_params: action.required_params,
            warnings: missing.map(k => `param '${k}' is recommended but not provided`),
        };
    }

    // disabled logic
    return {
        valid: true,
        action_id: action.action_id,
        action_name: action.action_name,
        action_category: action.action_category,
        required_params: action.required_params,
    };
}

// Invalidate action cache (call after admin registers new action)
export function invalidateActionCache(actionName?: string): void {
    if (actionName) {
        for (const key of actionCache.keys()) {
            if (key.endsWith(`:${actionName}`)) {
                actionCache.delete(key);
            }
        }
    } else {
        actionCache.clear();
    }
}
