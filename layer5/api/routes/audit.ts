/**
 * Layerinfinite — routes/audit.ts
 * GET /v1/audit
 * ══════════════════════════════════════════════════════════════
 * Immutable audit trail for compliance teams.
 * Returns a paginated list of logged outcomes (fact_outcomes)
 * with filtering by session, action, time range.
 * ALL data is read-only. No mutations possible.
 * GDPR: soft-deleted rows (is_deleted=TRUE) are excluded.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';

export const auditRouter = new Hono();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

// ── GET /v1/audit ─────────────────────────────────────────────
auditRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const sessionId = c.req.query('session_id');
    const actionName = c.req.query('action_name');
    const agentId = c.req.query('agent_id');
    const success = c.req.query('success');     // 'true' | 'false' | undefined
    const from = c.req.query('from');         // ISO date string
    const to = c.req.query('to');           // ISO date string
    const cursor = c.req.query('cursor');
    const pageStr = c.req.query('page');
    const offsetStr = c.req.query('offset');
    const sizeStr = c.req.query('page_size') ?? c.req.query('limit') ?? String(DEFAULT_PAGE_SIZE);

    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(sizeStr, 10) || DEFAULT_PAGE_SIZE));

    // ── Build query ───────────────────────────────────────────
    let query = supabase
        .from('fact_outcomes')
        .select(`
      outcome_id,
      session_id,
      timestamp,
      success,
      response_time_ms,
      error_code,
      error_message,
      is_synthetic,
      salience_score,
      dim_agents!inner(agent_id, agent_name, agent_type),
      dim_actions!inner(action_id, action_name, action_category),
      dim_contexts!inner(context_id, issue_type, environment)
    `, { count: 'exact' })
        .eq('customer_id', customerId)
        .eq('is_deleted', false)           // GDPR: exclude soft-deleted
        .order('timestamp', { ascending: false })
        .order('outcome_id', { ascending: false })  // secondary sort: stable pagination across tied timestamps
        .limit(pageSize);

    if (cursor) {
        try {
            const { ts, id } = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
            // Composite row-value comparison (descending): skip rows at or before the cursor position.
            // Handles ties at page boundaries: same timestamp rows are ordered by outcome_id descending.
            query = query.or(`timestamp.lt.${ts},and(timestamp.eq.${ts},outcome_id.lt.${id})`);
        } catch {
            // Malformed cursor — ignore and return from the beginning
        }
    } else if (pageStr || offsetStr) {
        // Fallback for legacy offset pagination
        const offset = offsetStr ? parseInt(offsetStr, 10) : (page - 1) * pageSize;
        if (!isNaN(offset)) {
            query = query.range(offset, offset + pageSize - 1);
        }
    }

    // ── Apply filters ─────────────────────────────────────────
    if (sessionId) query = query.eq('session_id', sessionId);
    if (agentId) query = query.eq('agent_id', agentId);
    if (success !== undefined) {
        query = query.eq('success', success === 'true');
    }
    if (from) query = query.gte('timestamp', from);
    if (to) query = query.lte('timestamp', to);

    // Filter by action_name (via joined table)
    if (actionName) {
        // Supabase supports filtering on joined tables
        query = (query as any).eq('dim_actions.action_name', actionName);
    }

    const { data, error, count } = await query;

    if (error) {
        console.error('[audit] Query error:', error.message);
        return c.json({ error: 'Audit query failed', details: error.message, code: 'DB_ERROR' }, 500);
    }

    const totalPages = Math.ceil((count ?? 0) / pageSize);
    const hasMore = (data && data.length === pageSize);
    const lastRow = hasMore ? data[data.length - 1] : null;
    const nextCursor = (lastRow?.timestamp && lastRow?.outcome_id)
        ? Buffer.from(JSON.stringify({ ts: lastRow.timestamp, id: lastRow.outcome_id })).toString('base64')
        : null;

    return c.json({
        outcomes: (data ?? []).map((row: any) => ({
            outcome_id: row.outcome_id,
            session_id: row.session_id,
            timestamp: row.timestamp,
            success: row.success,
            response_time_ms: row.response_time_ms,
            error_code: row.error_code,
            error_message: row.error_message,
            is_synthetic: row.is_synthetic,
            salience_score: row.salience_score,
            agent: row.dim_agents ? {
                id: row.dim_agents.agent_id,
                name: row.dim_agents.agent_name,
                type: row.dim_agents.agent_type,
            } : null,
            action: row.dim_actions ? {
                id: row.dim_actions.action_id,
                name: row.dim_actions.action_name,
                category: row.dim_actions.action_category,
            } : null,
            context: row.dim_contexts ? {
                id: row.dim_contexts.context_id,
                issue_type: row.dim_contexts.issue_type,
                environment: row.dim_contexts.environment,
            } : null,
        })),
        pagination: {
            page,
            page_size: pageSize,
            total_rows: count ?? 0,
            total_pages: totalPages,
            has_next: page < totalPages,
            has_prev: page > 1,
            // Keyset fields
            next_cursor: nextCursor,
            has_more: hasMore,
        },
        pagination_warning: (pageStr || offsetStr) ? 'page/offset parameters deprecated. Use cursor.' : undefined,
        filters: {
            session_id: sessionId ?? null,
            action_name: actionName ?? null,
            agent_id: agentId ?? null,
            success: success ?? null,
            from: from ?? null,
            to: to ?? null,
        },
        note: 'This audit trail is immutable. All rows reflect append-only fact_outcomes.',
    });
});

// ── GET /v1/audit/:outcome_id — Single outcome detail ─────────
auditRouter.get('/:outcome_id', async (c) => {
    const customerId = c.get('customer_id') as string;
    const outcomeId = c.req.param('outcome_id');

    const { data, error } = await supabase
        .from('fact_outcomes')
        .select(`
      *,
      dim_agents!inner(agent_id, agent_name, agent_type, llm_model),
      dim_actions!inner(action_id, action_name, action_category, action_description),
      dim_contexts!inner(context_id, issue_type, environment, customer_tier)
    `)
        .eq('outcome_id', outcomeId)
        .eq('customer_id', customerId)
        .eq('is_deleted', false)
        .maybeSingle();

    if (error) {
        return c.json({ error: 'Query failed', details: error.message }, 500);
    }
    if (!data) {
        return c.json({ error: `Outcome ${outcomeId} not found`, code: 'NOT_FOUND' }, 404);
    }

    return c.json({ outcome: data });
});
