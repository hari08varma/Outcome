/**
 * Layerinfinite — middleware/admin-auth.ts
 * ══════════════════════════════════════════════════════════════
 * Admin authentication middleware.
 * Accepts either:
 * 1) Supabase JWT (dashboard users)
 * 2) Raw API key (SDK users)
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import { supabase } from '../lib/supabase.js';

export async function adminAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    const customerId = c.get('customer_id') as string | undefined;

    if (!customerId) {
        return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    const { data, error } = await supabase
        .from('dim_customers')
        .select('customer_id, config')
        .eq('customer_id', customerId)
        .maybeSingle();

    if (error) {
        return c.json({ error: 'Admin auth service unavailable', code: 'AUTH_ERROR' }, 503);
    }

    const role = (data as any)?.config?.role;
    if (role !== 'customer_admin') {
        return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    await next();
}
