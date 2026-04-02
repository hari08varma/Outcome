/**
 * Layerinfinite — routes/observe.ts
 * ══════════════════════════════════════════════════════════════
 * GET /v1/observe?task={task}
 *
 * Returns per-task outcome statistics for li.observe() in the SDK.
 *
 * Queries mv_task_action_performance which is populated by every
 * POST /v1/log-outcome call via the validateActionMiddleware pipeline.
 *
 * Auth: X-API-Key via authMiddleware (agent key — same as get-scores).
 * Context: customer_id (set by authMiddleware, used for tenant scoping).
 *
 * Response shape (matches ObservationSummary in SDK models.py):
 * {
 *   task:             string        — the task_name queried
 *   total_runs:       number        — sum of total_count across all actions
 *   success_rate:     number        — overall rate 0.0–1.0 (4 decimal places)
 *   actions_seen:     string[]      — action names, ordered best → worst
 *   best_performing:  string | null — action_name with highest success_rate
 *   worst_performing: string | null — action_name with lowest success_rate,
 *                                     null if only one action exists for task
 *   last_run:         string | null — ISO timestamp of most recent outcome
 * }
 *
 * Cold start (no data yet): returns 200 with all-zero shape — NOT a 404.
 * This is intentional: no data is a valid state, not an error.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';

export const observeRouter = new Hono();

observeRouter.get('/', async (c) => {
    // ── Auth context ─────────────────────────────────────────
    // customer_id is required for tenant scoping.
    // agent_id is available but intentionally NOT used —
    // observe() returns the customer-wide blended view,
    // consistent with how get-recommendations works.
    const customerId = c.get('customer_id') as string | undefined;

    if (!customerId) {
        return c.json(
            { error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' },
            401
        );
    }

    // ── Query param validation ────────────────────────────────
    const rawTask = c.req.query('task');

    if (!rawTask || rawTask.trim() === '') {
        return c.json(
            {
                error: 'Missing required query parameter: task',
                code: 'MISSING_TASK',
                hint: 'Example: GET /v1/observe?task=payment_failed',
            },
            400
        );
    }

    const task = rawTask.trim();

    // ── Query mv_task_action_performance ─────────────────────
    // Ordered DESC by success_rate so rows[0] is always best.
    // Filter by both customer_id (tenant) and task_name (task).
    let rows: Array<{
        action_name: string;
        total_count: number;
        success_count: number;
        success_rate: number;
        last_seen_at: string | null;
    }>;

    try {
        const { data, error } = await supabase
            .from('mv_task_action_performance')
            .select('action_name, total_count, success_count, success_rate, last_seen_at')
            .eq('customer_id', customerId)
            .eq('task_name', task)
            .order('success_rate', { ascending: false });

        if (error) {
            console.error('[observe] Query failed:', {
                customer_id: customerId,
                task,
                error_code: error.code,
                error_message: error.message,
            });
            return c.json(
                {
                    error: 'Failed to fetch observation data',
                    code: 'DB_ERROR',
                    details: error.message,
                },
                500
            );
        }

        rows = data ?? [];
    } catch (err: any) {
        console.error('[observe] Unexpected error:', err.message);
        return c.json(
            {
                error: 'Internal server error',
                code: 'INTERNAL_ERROR',
                details: err.message,
            },
            500
        );
    }

    // ── Cold start: no data yet — return all-zero shape ──────
    // This is 200, not 404. No data is a valid state.
    // The SDK's observe() cold start handler expects this shape.
    if (rows.length === 0) {
        return c.json({
            task,
            total_runs: 0,
            success_rate: 0.0,
            actions_seen: [],
            best_performing: null,
            worst_performing: null,
            last_run: null,
        }, 200);
    }

    // ── Aggregate totals across all actions for this task ────
    const totalRuns = rows.reduce(
        (sum, r) => sum + (r.total_count ?? 0), 0
    );
    const totalSuccess = rows.reduce(
        (sum, r) => sum + (r.success_count ?? 0), 0
    );

    // Overall success rate across ALL actions, 4 decimal places.
    // This is NOT the top action's rate — it's the blended customer rate.
    const overallSuccessRate =
        totalRuns > 0
            ? parseFloat((totalSuccess / totalRuns).toFixed(4))
            : 0.0;

    // rows is already DESC by success_rate — index 0 is best, last is worst
    const actionsSeen = rows.map((r) => r.action_name);
    const best = rows[0];
    const worst = rows[rows.length - 1];

    // worst_performing is null when only one action exists for this task.
    // It would be misleading to report an action as "worst" when it's the only one.
    const worstPerforming =
        rows.length > 1 && worst.action_name !== best.action_name
            ? worst.action_name
            : null;

    // Most recent outcome timestamp across ALL actions for this task.
    // Filter nulls, sort ascending, take last.
    const lastRun = rows
        .map((r) => r.last_seen_at)
        .filter((ts): ts is string => ts !== null)
        .sort()
        .at(-1) ?? null;

    return c.json({
        task,
        total_runs: totalRuns,
        success_rate: overallSuccessRate,
        actions_seen: actionsSeen,
        best_performing: best.action_name,
        worst_performing: worstPerforming,
        last_run: lastRun,
    }, 200);
});
