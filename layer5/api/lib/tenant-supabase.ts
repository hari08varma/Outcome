/**
 * Layerinfinite — lib/tenant-supabase.ts
 * ══════════════════════════════════════════════════════════════
 * Tenant-scoped Supabase query helper.
 *
 * Use tenantFrom() for ALL tables that have a customer_id column.
 * The customer_id filter is applied automatically — it cannot be forgotten.
 *
 * Usage:
 *   const { data } = await tenantFrom(customerId, 'fact_outcomes')
 *     .select('outcome_id, success')
 *     .eq('agent_id', agentId);
 *
 * DO NOT use supabase.from() directly for CustomerScopedTable names.
 * supabase.ts is still used for global tables (dim_customers, world_model_artifacts, etc.)
 * and for internal helpers that do not require tenant scoping.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

// Exhaustive list of tables that MUST be customer-scoped.
// Add new tables here as the schema grows — omitting a table here is a conscious
// decision that it does NOT have a customer_id column or is globally scoped.
export type CustomerScopedTable =
    | 'fact_outcomes'
    | 'fact_decisions'
    | 'fact_episodes'
    | 'fact_outcome_feedback'
    | 'dim_actions'
    | 'dim_contexts'
    | 'dim_agents'
    | 'agent_trust_scores'
    | 'agent_trust_audit'
    | 'degradation_alert_events'
    | 'rate_limit_buckets';

/**
 * Returns a Supabase query builder pre-filtered to a single customer.
 * Caller chains .select(), .eq(), .order() etc. as normal.
 * The .eq('customer_id', customerId) filter is already applied.
 *
 * TypeScript enforces that only customer-scoped tables can be passed.
 * Passing a global table name (e.g. 'dim_customers') is a compile error.
 */
export function tenantFrom(customerId: string, table: CustomerScopedTable) {
    return (supabase.from(table) as any).eq('customer_id', customerId);
}
