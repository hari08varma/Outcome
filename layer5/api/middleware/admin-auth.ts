/**
 * Layer5 — middleware/admin-auth.ts
 * ══════════════════════════════════════════════════════════════
 * Admin authentication middleware.
 * Verifies the caller has customer_admin role.
 * Must be applied AFTER auth.ts middleware (which sets customer_id).
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import { supabase } from '../lib/supabase.js';

export async function adminAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    const customerId = c.get('customer_id') as string;

    if (!customerId) {
        return c.json({ error: 'Authentication required', code: 'UNAUTHORIZED' }, 401);
    }

    // Lookup customer config to check role
    const { data, error } = await supabase
        .from('dim_customers')
        .select('customer_id, config')
        .eq('customer_id', customerId)
        .maybeSingle();

    if (error) {
        console.error('[admin-auth] DB error:', error.message);
        return c.json({ error: 'Admin auth service unavailable', code: 'AUTH_ERROR' }, 503);
    }

    if (!data) {
        return c.json({ error: 'Customer not found', code: 'NOT_FOUND' }, 404);
    }

    const config = data.config as Record<string, unknown> ?? {};
    const role = config.role as string ?? '';

    if (role !== 'customer_admin') {
        return c.json(
            { error: 'Admin access required. Your role does not have admin permissions.', code: 'FORBIDDEN' },
            403
        );
    }

    await next();
}
