/**
 * Layerinfinite — routes/observe.ts
 * ══════════════════════════════════════════════════════════════
 * GET /v1/observe?task={task}
 *
 * Returns per-task outcome statistics for li.observe() in the SDK.
 * Queries mv_task_action_performance which is already populated
 * by every POST /v1/log-outcome call.
 *
 * Auth: X-API-Key (agent key via authMiddleware — same as get-scores).
 * Context variables available: agent_id, customer_id (set by authMiddleware).
 *
 * Response shape (matches ObservationSummary dataclass in SDK models.py):
 * {
 *   task:             string       — the issue_type queried
 *   total_runs:       number       — sum of total_attempts across all actions
 *   success_rate:     number       — overall success rate (0.0 to 1.0)
 *   actions_seen:     string[]     — action names ordered best → worst
 *   best_performing:  string|null  — action_name with highest success_rate
 *   worst_performing: string|null  — action_name with lowest success_rate
 *                                    (null if only one action exists)
 *   last_run:         string|null  — ISO timestamp of most recent outcome
 * }
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';

export const observeRouter = new Hono();

observeRouter.get('/', async (c) => {
    // agent_id and customer_id are set by authMiddleware
    // Use customer_id for data scoping (all agents under same customer share data)
    const customerId = c.get('customer_id') as string;
    const task = c.req.query('task');

    if (!task || typeof task !== 'string' || !task.trim()) {
        return c.json(
            {
                error: 'Missing required query parameter: task',
                hint: 'Example: GET /v1/observe?task=payment_failed',
                code: 'MISSING_PARAM',
            },
            400
        );
    }

    const { data: rows, error } = await supabase
        .from('mv_task_action_performance')
        .select(
            'action_name, total_attempts, success_count, success_rate, last_seen_at'
        )
        .eq('customer_id', customerId)
        .eq('issue_type', task.trim())
        .order('success_rate', { ascending: false });

    if (error) {
        console.error('[observe] Query failed:', {
            customer_id: customerId,
            task,
            error: error.message,
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

    // No data yet — cold start, return empty shape (not an error)
    if (!rows || rows.length === 0) {
        return c.json({
            task: task.trim(),
            total_runs: 0,
            success_rate: 0.0,
            actions_seen: [],
            best_performing: null,
            worst_performing: null,
            last_run: null,
        });
    }

    // Aggregate totals across all actions for this task
    const totalRuns = rows.reduce(
        (sum: number, r: any) => sum + (r.total_attempts ?? 0), 0
    );
    const totalSuccess = rows.reduce(
        (sum: number, r: any) => sum + (r.success_count ?? 0), 0
    );
    const overallSuccessRate =
        totalRuns > 0
            ? parseFloat((totalSuccess / totalRuns).toFixed(4))
            : 0.0;

    // rows is already ordered DESC by success_rate
    const actionsSeen: string[] = rows.map((r: any) => r.action_name);
    const best = rows[0];
    const worst = rows[rows.length - 1];

    // Only report worst_performing if it's a different action from best
    const worstPerforming =
        rows.length > 1 && worst.action_name !== best.action_name
            ? worst.action_name
            : null;

    // Most recent outcome timestamp across all actions
    const lastRun =
        rows
            .map((r: any) => r.last_seen_at)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null;

    return c.json({
        task: task.trim(),
        total_runs: totalRuns,
        success_rate: overallSuccessRate,
        actions_seen: actionsSeen,
        best_performing: best.action_name,
        worst_performing: worstPerforming,
        last_run: lastRun,
    });
});
