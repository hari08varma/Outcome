/**
 * Layerinfinite — lib/supabase.ts
 * Singleton Supabase client for server-side operations.
 * Always uses service_role key to bypass RLS.
 * Customer isolation is enforced in query logic, not RLS.
 *
 * SECURITY: SUPABASE_SERVICE_ROLE_KEY bypasses 
 * all Row Level Security. This file must NEVER 
 * log or expose this key. All console.log calls 
 * in this file must be reviewed before commit.
 * Audit date: 2026-03-13
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Only load .env file in development — Railway injects env vars directly in production
if (process.env.NODE_ENV !== 'production') {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    config({ path: resolve(__dirname, '..', '.env') });
}

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
}

// Singleton — instantiated once at startup
// NOTE: This client uses the Supabase REST API
// (not direct PostgreSQL). Connection pooling is
// handled by Supabase infrastructure automatically.
// If you add direct pg connections via 'pg' or
// 'postgres' packages, use the Pooler URL from
// Supabase dashboard → Settings → Database → 
// Connection pooling → Transaction mode (port 6543)
export const supabase: SupabaseClient = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
        db: {
            schema: 'public',
        },
    }
);

// ── Type helpers ─────────────────────────────────────────────

export interface ActionScore {
    action_id: string;
    context_id: string;
    customer_id: string;
    action_name: string;
    action_category: string;
    raw_success_rate: number;
    weighted_success_rate: number;
    confidence: number;
    total_attempts: number;
    total_successes: number;
    total_failures: number;
    trend_delta: number | null;
    business_hours_rate: number | null;
    after_hours_rate: number | null;
    last_outcome_at: string;
    view_refreshed_at: string;
}

export interface EpisodePattern {
    context_id: string;
    customer_id: string;
    action_sequence: unknown[];
    action_sequence_hash: string;
    episode_success_rate: number;
    avg_duration_ms: number;
    sample_count: number;
    last_seen_at: string;
    view_refreshed_at: string;
}

export interface OutcomeRow {
    outcome_id: string;
    agent_id: string;
    action_id: string;
    context_id: string;
    customer_id: string;
    session_id: string;
    timestamp: string;
    success: boolean;
    response_time_ms: number | null;
    error_code: string | null;
    error_message: string | null;
    raw_context: Record<string, unknown>;
    is_synthetic: boolean;
    is_deleted: boolean;
    salience_score: number;
}
