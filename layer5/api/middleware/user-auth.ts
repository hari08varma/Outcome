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

function randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function provisionMissingProfile(user: { id: string; email?: string | null; user_metadata?: any }) {
    const email = user.email ?? `${user.id}@unknown.local`;
    const companyName = typeof user.user_metadata?.company_name === 'string' && user.user_metadata.company_name.trim()
        ? user.user_metadata.company_name.trim()
        : email;

    const { data: customer, error: customerError } = await supabase
        .from('dim_customers')
        .insert({
            company_name: companyName,
            tier: 'starter',
            api_key_hash: randomHex(32),
            created_at: new Date().toISOString(),
        })
        .select('customer_id')
        .single();

    if (customerError || !customer) {
        return { ok: false, reason: customerError?.message ?? 'Failed to create customer row' };
    }

    const { error: profileError } = await supabase
        .from('user_profiles')
        .upsert(
            {
                id: user.id,
                customer_id: customer.customer_id,
                role: 'admin',
                created_at: new Date().toISOString(),
            },
            {
                onConflict: 'id',
                ignoreDuplicates: true,
            }
        );

    if (profileError) {
        return { ok: false, reason: profileError.message };
    }

    const { error: agentError } = await supabase
        .from('dim_agents')
        .insert({
            agent_name: 'default-agent',
            agent_type: 'api-key',
            customer_id: customer.customer_id,
            is_active: true,
            created_at: new Date().toISOString(),
        });

    if (agentError) {
        return { ok: false, reason: agentError.message };
    }

    return { ok: true };
}

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
        // Self-heal path: if auth trigger was skipped (e.g., admin-created users),
        // provision a minimal account/profile/agent and retry once.
        const provision = await provisionMissingProfile({
            id: user.id,
            email: user.email,
            user_metadata: user.user_metadata,
        });

        if (provision.ok) {
            const { data: retriedProfile, error: retryError } = await supabase
                .from('user_profiles')
                .select('customer_id, role')
                .eq('id', user.id)
                .maybeSingle();

            if (!retryError && retriedProfile) {
                c.set('user_id', user.id);
                c.set('customer_id', retriedProfile.customer_id);
                await next();
                return;
            }
        }

        return c.json(
            {
                error: 'Account setup incomplete',
                code: 'PROFILE_MISSING',
                action: 'Please sign out and sign in again to trigger account setup',
                details: provision.reason,
            },
            403
        );
    }

    c.set('user_id', user.id);
    c.set('customer_id', profile.customer_id);

    await next();
}
