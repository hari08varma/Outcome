/**
 * Layerinfinite — middleware/user-auth.ts
 * ══════════════════════════════════════════════════════════════
 * Human user authentication middleware (Supabase JWT).
 *
 * Verifies the Supabase access token via supabase.auth.getUser().
 * Looks up user_profiles to resolve customer_id.
 * Sets: user_id, customer_id on the Hono context.
 *
 * This is SEPARATE from api/middleware/auth.ts (agent API key auth).
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Next } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase.js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

export async function userAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return c.json(
            { error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' },
            401
        );
    }

    const token = authHeader.slice(7);

    // Create a per-request client with the user's JWT
    // so supabase.auth.getUser() validates against *their* token
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error } = await userClient.auth.getUser(token);

    if (error || !user) {
        return c.json(
            { error: 'Invalid or expired token', code: 'UNAUTHORIZED' },
            401
        );
    }

    // Resolve customer_id from user_profiles (using service role client)
    const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('customer_id, role')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError) {
        return c.json(
            {
                error: 'Failed to resolve account profile',
                code: 'PROFILE_LOOKUP_FAILED',
            },
            500
        );
    }

    if (!profile) {
        return c.json(
            {
                error: 'Account setup incomplete',
                code: 'PROFILE_MISSING',
                action: 'Please sign out and sign in again to trigger account setup',
            },
            403
        );
    }

    c.set('user_id', user.id);
    c.set('customer_id', profile.customer_id);

    await next();
}
