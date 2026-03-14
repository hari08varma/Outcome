/**
 * Layerinfinite — routes/get-patterns.ts
 * GET /v1/get-patterns
 * ══════════════════════════════════════════════════════════════
 * Returns the most successful action sequences (episodes)
 * for a given context. Powers "pattern-based recommendations"
 * which go beyond single-action scoring by returning whole
 * playbooks (ordered sequences of actions that resolved issues).
 * Reads from mv_episode_patterns (refreshed nightly).
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';

export const getPatternsRouter = new Hono();

// ── GET /v1/get-patterns ──────────────────────────────────────
getPatternsRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const issueType = c.req.query('issue_type');
    const contextId = c.req.query('context_id');
    const minSamples = parseInt(c.req.query('min_samples') ?? '2', 10);
    const topN = parseInt(c.req.query('top_n') ?? '5', 10);

    if (!issueType && !contextId) {
        return c.json(
            { error: 'Provide either issue_type or context_id', code: 'MISSING_PARAM' },
            400
        );
    }

    // ── Resolve context_id ────────────────────────────────────
    let resolvedContextId = contextId;

    if (!resolvedContextId && issueType) {
        const { data, error } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('issue_type', issueType)
            .limit(1)
            .maybeSingle();

        if (error) {
            return c.json({ error: 'Context lookup failed', details: error.message }, 500);
        }
        if (!data) {
            return c.json(
                {
                    patterns: [],
                    total_found: 0,
                    context_id: null,
                    issue_type: issueType,
                    message: `No patterns yet for "${issueType}". Patterns appear after 2+ complete episodes.`,
                    cold_start: true,
                },
                200
            );
        }
        resolvedContextId = data.context_id;
    }

    // ── Fetch patterns from materialized view ─────────────────
    const { data: patterns, error } = await supabase
        .from('mv_episode_patterns')
        .select('*')
        .eq('customer_id', customerId)
        .eq('context_id', resolvedContextId)
        .gte('sample_count', minSamples)
        .gte('episode_success_rate', 0.5)     // only show patterns with >50% success
        .order('episode_success_rate', { ascending: false })
        .limit(Math.min(topN, 20));

    if (error) {
        return c.json({ error: 'Pattern query failed', details: error.message, code: 'DB_ERROR' }, 500);
    }

    if (!patterns || patterns.length === 0) {
        return c.json({
            patterns: [],
            total_found: 0,
            context_id: resolvedContextId,
            issue_type: issueType ?? null,
            message: 'No patterns found yet. Patterns appear after 2+ complete episodes with shared action sequences.',
            cold_start: true,
        }, 200);
    }

    // ── Enrich action_sequence with names ─────────────────────
    // action_sequence is stored as [{action_id, success, ...}, ...]
    // Batch-resolve action names from dim_actions
    const allActionIds = new Set<string>();
    patterns.forEach((p: any) => {
        const seq = p.action_sequence ?? [];
        seq.forEach((step: any) => {
            if (step?.action_id) allActionIds.add(step.action_id);
        });
    });

    let actionNameMap: Record<string, string> = {};
    if (allActionIds.size > 0) {
        const { data: actions } = await supabase
            .from('dim_actions')
            .select('action_id, action_name')
            .in('action_id', Array.from(allActionIds));

        if (actions) {
            actionNameMap = Object.fromEntries(actions.map((a: any) => [a.action_id, a.action_name]));
        }
    }

    const enriched = patterns.map((p: any) => ({
        context_id: p.context_id,
        customer_id: p.customer_id,
        episode_success_rate: p.episode_success_rate,
        avg_duration_ms: p.avg_duration_ms,
        sample_count: p.sample_count,
        last_seen_at: p.last_seen_at,
        view_refreshed_at: p.view_refreshed_at,
        action_sequence: (p.action_sequence ?? []).map((step: any) => ({
            ...step,
            action_name: actionNameMap[step?.action_id] ?? step?.action_id,
        })),
    }));

    return c.json({
        patterns: enriched,
        total_found: enriched.length,
        context_id: resolvedContextId,
        issue_type: issueType ?? null,
        cold_start: false,
    });
});
