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
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    }
);

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export async function adminAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Missing authorization' }, 401);
    }

    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
        return c.json({ error: 'Missing authorization' }, 401);
    }

    // Try 1: Supabase JWT (dashboard users)
    try {
        const {
            data: { user },
            error: userError,
        } = await supabaseAdmin.auth.getUser(token);

        if (user && !userError) {
            const { data: profile, error: profileError } = await supabaseAdmin
                .from('user_profiles')
                .select('customer_id, role')
                .eq('id', user.id)
                .maybeSingle();

            if (profileError) {
                console.error('[admin-auth] Profile lookup error:', profileError.message);
                return c.json({ error: 'Admin auth service unavailable', code: 'AUTH_ERROR' }, 503);
            }

            if (!profile) {
                return c.json({ error: 'Profile not found' }, 403);
            }

            c.set('user_id', user.id);
            c.set('customer_id', profile.customer_id);
            await next();
            return;
        }
    } catch {
        // Not a JWT. Continue to raw API key check.
    }

    // Try 2: Raw API key (SDK users)
    const { data: agent, error: agentError } = await supabaseAdmin
        .from('dim_agents')
        .select('agent_id, customer_id, is_active')
        .eq('api_key_hash', hashToken(token))
        .eq('is_active', true)
        .maybeSingle();

    if (agentError) {
        console.error('[admin-auth] Agent lookup error:', agentError.message);
        return c.json({ error: 'Admin auth service unavailable', code: 'AUTH_ERROR' }, 503);
    }

    if (!agent) {
        return c.json({ error: 'Invalid API key' }, 401);
    }

    c.set('agent_id', agent.agent_id);
    c.set('customer_id', agent.customer_id);
    await next();
}
