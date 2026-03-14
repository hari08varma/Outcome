/**
 * Layer5 — middleware/validate-action.ts
 * ══════════════════════════════════════════════════════════════
 * Hallucination Prevention Middleware for Hono.
 *
 * Validates that action_name from request body exists in
 * dim_actions registry. Blocks unregistered actions with 400.
 * Uses 30-min in-memory cache to minimise DB round-trips.
 *
 * On success: sets validated_action on context + calls next()
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

// Cache by action_name
const actionCache = new Map<string, ActionCacheEntry>();

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

    const actionName = body.action_name as string;
    if (!actionName || typeof actionName !== 'string') {
        return c.json({ error: 'action_name is required', code: 'MISSING_FIELD' }, 400);
    }

    const params = body.action_params as Record<string, unknown> | undefined;
    const result = await validateAction(actionName, params);

    if (!result.valid) {
        // FIX 6: Return 400 (not 422) per PRD contract
        return c.json(
            { error: result.error_code ?? 'UNKNOWN_ACTION', message: result.error },
            400
        );
    }

    // Store validated action in context for downstream handlers
    c.set('validated_action', {
        action_id: result.action_id!,
        action_name: result.action_name!,
        action_category: result.action_category!,
        validation_warnings: result.warnings ?? [],
    });
    // Store parsed body so handlers don't need to re-parse
    c.set('parsed_body', body);

    await next();
}

// ── Core validation function (also exported for direct use) ──
export async function validateAction(
    actionName: string,
    params?: Record<string, unknown>
): Promise<ActionValidationResult> {
    const cached = actionCache.get(actionName);

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
        .maybeSingle();

    if (error) {
        return { valid: false, error: `Action lookup failed: ${error.message}`, error_code: 'DB_ERROR' };
    }

    if (!data) {
        return {
            valid: false,
            error: `action_name '${actionName}' not found in registry. Register it via POST /v1/admin/actions first.`,
            error_code: 'UNKNOWN_ACTION',
        };
    }

    // Cache result
    actionCache.set(actionName, {
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
        actionCache.delete(actionName);
    } else {
        actionCache.clear();
    }
}
