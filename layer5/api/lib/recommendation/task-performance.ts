import { supabase } from '../supabase.js';

export const ZERO_UUID_AGENT_ID = '00000000-0000-0000-0000-000000000000';

type QueryError = {
    message: string;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
};

export interface TaskPerformanceRow {
    action_id: string;
    action_name: string;
    total_count: number;
    success_count: number;
    success_rate: number;
    resolution_rate: number;
    ml_score: number | null;
    last_seen_at: string | null;
}

interface FetchTaskPerformanceParams {
    customerId: string;
    taskName: string;
    agentId?: string | null;
    windowStart?: string;
}

function isMissingMvError(error: QueryError): boolean {
    const msg = (error.message ?? '').toLowerCase();
    return error.code === '42P01'
        || (msg.includes('mv_task_action_performance') && msg.includes('relation'));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeTaskName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const task = value.trim();
    return task.length > 0 ? task : null;
}

function parseIso(iso: string | null): number {
    if (!iso) return 0;
    const time = Date.parse(iso);
    return Number.isFinite(time) ? time : 0;
}

function latestTimestamp(current: string | null, candidate: string | null): string | null {
    if (!current) return candidate;
    if (!candidate) return current;
    return parseIso(candidate) >= parseIso(current) ? candidate : current;
}

async function queryTaskPerformanceFromMV(
    params: FetchTaskPerformanceParams,
): Promise<{ rows: TaskPerformanceRow[]; error: QueryError | null }> {
    let query = supabase
        .from('mv_task_action_performance')
        .select('action_id, action_name, total_count, success_count, success_rate, ml_score, last_seen_at')
        .eq('customer_id', params.customerId)
        .eq('task_name', params.taskName);

    if (params.windowStart) {
        query = query.gte('last_seen_at', params.windowStart);
    }

    if (params.agentId) {
        query = query.eq('agent_id', params.agentId);
    } else {
        query = query.neq('agent_id', ZERO_UUID_AGENT_ID);
    }

    const { data, error } = await query;

    if (error) {
        return { rows: [], error: error as QueryError };
    }

    const rows: TaskPerformanceRow[] = (data ?? []).map((row: any) => ({
        action_id: String(row.action_id),
        action_name: String(row.action_name ?? row.action_id),
        total_count: Number(row.total_count ?? 0),
        success_count: Number(row.success_count ?? 0),
        success_rate: Number(row.success_rate ?? 0),
        resolution_rate: Number(row.success_rate ?? 0),
        ml_score: row.ml_score === null || row.ml_score === undefined
            ? null
            : Number(row.ml_score),
        last_seen_at: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    }));

    // Derive task-specific resolution quality from fact_outcomes.outcome_score
    // so recommendations track incident resolution semantics (not just binary success).
    const resolutionRateByAction = await getTaskResolutionRateByAction(params);
    const hydratedRows = rows.map((row) => ({
        ...row,
        resolution_rate: resolutionRateByAction.get(row.action_id) ?? row.resolution_rate,
    }));

    return { rows: hydratedRows, error: null };
}

async function getLatestMlScoreByAction(
    customerId: string,
    actionIds: string[],
): Promise<Map<string, number>> {
    if (actionIds.length === 0) return new Map<string, number>();

    const { data, error } = await supabase
        .from('mv_action_scores')
        .select('action_id, weighted_success_rate, view_refreshed_at')
        .eq('customer_id', customerId)
        .in('action_id', actionIds);

    if (error || !data) return new Map<string, number>();

    const latest = new Map<string, { score: number; refreshedAt: number }>();

    for (const row of data as Array<Record<string, unknown>>) {
        const actionId = typeof row.action_id === 'string' ? row.action_id : null;
        if (!actionId) continue;

        const rawScore = Number(row.weighted_success_rate ?? Number.NaN);
        if (!Number.isFinite(rawScore)) continue;

        const refreshedAtRaw = typeof row.view_refreshed_at === 'string'
            ? row.view_refreshed_at
            : null;
        const refreshedAt = parseIso(refreshedAtRaw);

        const current = latest.get(actionId);
        if (!current || refreshedAt >= current.refreshedAt) {
            latest.set(actionId, { score: rawScore, refreshedAt });
        }
    }

    const mapped = new Map<string, number>();
    for (const [actionId, value] of latest.entries()) {
        mapped.set(actionId, value.score);
    }
    return mapped;
}

function parseBoundedScore(value: unknown): number | null {
    const parsed = Number(value ?? Number.NaN);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(1, parsed));
}

async function getTaskResolutionRateByAction(
    params: FetchTaskPerformanceParams,
): Promise<Map<string, number>> {
    let query = supabase
        .from('fact_outcomes')
        .select('action_id, outcome_score, success')
        .eq('customer_id', params.customerId)
        .eq('is_deleted', false)
        .eq('is_synthetic', false)
        .eq('task_name', params.taskName);

    if (params.windowStart) {
        query = query.gte('timestamp', params.windowStart);
    }

    if (params.agentId) {
        query = query.eq('agent_id', params.agentId);
    } else {
        query = query.neq('agent_id', ZERO_UUID_AGENT_ID);
    }

    const { data, error } = await query;
    if (error || !data) {
        return new Map<string, number>();
    }

    const grouped = new Map<string, { total: number; scoreSum: number }>();

    for (const row of data as Array<Record<string, unknown>>) {
        const actionId = typeof row.action_id === 'string' ? row.action_id : null;
        if (!actionId) continue;

        const explicitScore = parseBoundedScore(row.outcome_score);
        const fallbackScore = row.success === true ? 1 : 0;
        const score = explicitScore ?? fallbackScore;

        const current = grouped.get(actionId) ?? { total: 0, scoreSum: 0 };
        current.total += 1;
        current.scoreSum += score;
        grouped.set(actionId, current);
    }

    const rates = new Map<string, number>();
    for (const [actionId, stats] of grouped.entries()) {
        if (stats.total <= 0) continue;
        rates.set(actionId, Number((stats.scoreSum / stats.total).toFixed(4)));
    }

    return rates;
}

async function queryTaskPerformanceFromFacts(
    params: FetchTaskPerformanceParams,
): Promise<TaskPerformanceRow[]> {
    let query = supabase
        .from('fact_outcomes')
        .select('action_id, success, outcome_score, timestamp, dim_actions!inner(action_name)')
        .eq('customer_id', params.customerId)
        .eq('is_deleted', false)
        .eq('is_synthetic', false)
        .eq('task_name', params.taskName);

    if (params.windowStart) {
        query = query.gte('timestamp', params.windowStart);
    }

    if (params.agentId) {
        query = query.eq('agent_id', params.agentId);
    } else {
        query = query.neq('agent_id', ZERO_UUID_AGENT_ID);
    }

    const { data, error } = await query;

    if (error) {
        throw new Error(`[task-performance] fallback query failed: ${error.message}`);
    }

    const grouped = new Map<string, {
        action_id: string;
        action_name: string;
        total_count: number;
        success_count: number;
        resolution_score_total: number;
        last_seen_at: string | null;
    }>();

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const actionId = typeof row.action_id === 'string' ? row.action_id : null;
        if (!actionId) continue;

        const dimActions = row.dim_actions;
        let actionName = actionId;

        if (isObject(dimActions) && typeof dimActions.action_name === 'string') {
            actionName = dimActions.action_name;
        } else if (Array.isArray(dimActions) && dimActions.length > 0) {
            const first = dimActions[0];
            if (isObject(first) && typeof first.action_name === 'string') {
                actionName = first.action_name;
            }
        }

        const key = `${actionId}::${actionName}`;
        const existing = grouped.get(key) ?? {
            action_id: actionId,
            action_name: actionName,
            total_count: 0,
            success_count: 0,
            resolution_score_total: 0,
            last_seen_at: null,
        };

        existing.total_count += 1;
        if (row.success === true) {
            existing.success_count += 1;
        }

        const explicitScore = parseBoundedScore(row.outcome_score);
        const fallbackScore = row.success === true ? 1 : 0;
        existing.resolution_score_total += explicitScore ?? fallbackScore;

        const ts = typeof row.timestamp === 'string' ? row.timestamp : null;
        existing.last_seen_at = latestTimestamp(existing.last_seen_at, ts);

        grouped.set(key, existing);
    }

    const actionIds = Array.from(
        new Set(Array.from(grouped.values()).map((row) => row.action_id)),
    );
    const mlScoreByAction = await getLatestMlScoreByAction(params.customerId, actionIds);

    return Array.from(grouped.values()).map((row) => {
        const successRate = row.total_count > 0
            ? Number((row.success_count / row.total_count).toFixed(4))
            : 0;
        const resolutionRate = row.total_count > 0
            ? Number((row.resolution_score_total / row.total_count).toFixed(4))
            : successRate;

        return {
            action_id: row.action_id,
            action_name: row.action_name,
            total_count: row.total_count,
            success_count: row.success_count,
            success_rate: successRate,
            resolution_rate: resolutionRate,
            ml_score: mlScoreByAction.get(row.action_id) ?? null,
            last_seen_at: row.last_seen_at,
        };
    });
}

export async function fetchTaskActionPerformance(
    params: FetchTaskPerformanceParams,
): Promise<{ rows: TaskPerformanceRow[]; source: 'mv' | 'fact_fallback' }> {
    const mvResult = await queryTaskPerformanceFromMV(params);
    if (!mvResult.error) {
        return { rows: mvResult.rows, source: 'mv' };
    }

    const reason = isMissingMvError(mvResult.error)
        ? 'materialized view is missing'
        : mvResult.error.message;
    console.warn('[task-performance] mv_task_action_performance unavailable, using fallback:', reason);

    const fallbackRows = await queryTaskPerformanceFromFacts(params);
    return { rows: fallbackRows, source: 'fact_fallback' };
}

export async function fetchAvailableTasks(
    customerId: string,
    scopedAgentId: string | null,
): Promise<{ tasks: string[]; source: 'mv' | 'fact_fallback' }> {
    let mvQuery = supabase
        .from('mv_task_action_performance')
        .select('task_name')
        .eq('customer_id', customerId)
        .neq('agent_id', ZERO_UUID_AGENT_ID);

    if (scopedAgentId) {
        mvQuery = mvQuery.eq('agent_id', scopedAgentId);
    }

    const { data: mvData, error: mvError } = await mvQuery;

    if (!mvError) {
        const tasks = [
            ...new Set((mvData ?? [])
                .map((row: any) => normalizeTaskName(row.task_name))
                .filter((task): task is string => task !== null)),
        ].sort();

        return { tasks, source: 'mv' };
    }

    const reason = isMissingMvError(mvError as QueryError)
        ? 'materialized view is missing'
        : mvError.message;
    console.warn('[task-performance] task list fallback activated:', reason);

    let fallbackQuery = supabase
        .from('fact_outcomes')
        .select('task_name')
        .eq('customer_id', customerId)
        .eq('is_deleted', false)
        .eq('is_synthetic', false)
        .not('task_name', 'is', null)
        .neq('agent_id', ZERO_UUID_AGENT_ID);

    if (scopedAgentId) {
        fallbackQuery = fallbackQuery.eq('agent_id', scopedAgentId);
    }

    const { data: fallbackData, error: fallbackError } = await fallbackQuery;

    if (fallbackError) {
        throw new Error(`[task-performance] task list fallback failed: ${fallbackError.message}`);
    }

    const tasks = [
        ...new Set((fallbackData ?? [])
            .map((row: any) => normalizeTaskName(row.task_name))
            .filter((task): task is string => task !== null)),
    ].sort();

    return { tasks, source: 'fact_fallback' };
}
