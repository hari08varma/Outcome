import { supabase } from '../supabase.js';
import { computeOutcomeEffectiveWeightForScore } from './outcome-weighting.js';

export const ZERO_UUID_AGENT_ID = '00000000-0000-0000-0000-000000000000';
const TASK_PERFORMANCE_MV = 'mv_task_action_performance_180d';
const LEGACY_TASK_PERFORMANCE_MV = 'mv_task_action_performance';
const RECOMMENDATION_WINDOW_DAYS = 180;
const SUPABASE_PAGE_SIZE = 1000;

function clampWeight(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(1, value));
}

const IMPORT_SIGNAL_WEIGHT = clampWeight(
    Number(process.env.LI_IMPORT_RECO_SIGNAL_WEIGHT ?? 0.35),
    0.35,
);
const INCONSISTENT_SIGNAL_WEIGHT = clampWeight(
    Number(process.env.LI_INCONSISTENT_RECO_SIGNAL_WEIGHT ?? 0.25),
    0.25,
);
const UNCERTAIN_CLASS_SIGNAL_WEIGHT = clampWeight(
    Number(process.env.LI_UNCERTAIN_RECO_SIGNAL_WEIGHT ?? 0.5),
    0.5,
);
const DEGRADED_CLASS_SIGNAL_WEIGHT = clampWeight(
    Number(process.env.LI_DEGRADED_RECO_SIGNAL_WEIGHT ?? 0.75),
    0.75,
);

function sourceSignalWeight(ingestionSource: unknown): number {
    return ingestionSource === 'import' ? IMPORT_SIGNAL_WEIGHT : 1.0;
}

function reliabilitySignalWeight(params: {
    isInconsistent: unknown;
    outcomeClass: unknown;
}): number {
    let weight = 1.0;

    if (params.isInconsistent === true) {
        weight *= INCONSISTENT_SIGNAL_WEIGHT;
    }

    const outcomeClass = typeof params.outcomeClass === 'string'
        ? params.outcomeClass
        : null;

    if (outcomeClass === 'uncertain') {
        weight *= UNCERTAIN_CLASS_SIGNAL_WEIGHT;
    } else if (outcomeClass === 'degraded') {
        weight *= DEGRADED_CLASS_SIGNAL_WEIGHT;
    }

    return Math.max(0, Math.min(1, weight));
}

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
    effective_sample_count: number;
    success_count: number;
    success_rate: number;
    resolution_rate: number;
    semantic_cluster_convergence: number;
    ml_score: number | null;
    last_seen_at: string | null;
}

interface TaskResolutionStats {
    resolutionRate: number;
    effectiveSamples: number;
    semanticClusterConvergence: number;
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
        || ((msg.includes(TASK_PERFORMANCE_MV) || msg.includes(LEGACY_TASK_PERFORMANCE_MV)) && msg.includes('relation'));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeTaskName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^_+|_+$/g, '');
    return normalized.length > 0 ? normalized : null;
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

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function computeSemanticClusterConvergence(params: {
    clusterCounts: Map<string, number>;
    clusterSamples: number;
    clusterConfidenceSum: number;
    clusterConfidenceCount: number;
}): number {
    const {
        clusterCounts,
        clusterSamples,
        clusterConfidenceSum,
        clusterConfidenceCount,
    } = params;

    if (clusterSamples <= 0) {
        return 0.5;
    }

    let dominantClusterCount = 0;
    for (const count of clusterCounts.values()) {
        if (count > dominantClusterCount) dominantClusterCount = count;
    }

    const dominantShare = dominantClusterCount / clusterSamples;
    const avgConfidence = clusterConfidenceCount > 0
        ? clusterConfidenceSum / clusterConfidenceCount
        : 0.5;

    const convergence = clamp01((dominantShare * 0.7) + (avgConfidence * 0.3));
    return Number(convergence.toFixed(4));
}

async function queryTaskPerformanceFromMV(
    params: FetchTaskPerformanceParams,
): Promise<{ rows: TaskPerformanceRow[]; error: QueryError | null }> {
    let query = supabase
        .from(TASK_PERFORMANCE_MV)
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
        effective_sample_count: Number(row.total_count ?? 0),
        success_count: Number(row.success_count ?? 0),
        success_rate: Number(row.success_rate ?? 0),
        resolution_rate: Number(row.success_rate ?? 0),
        semantic_cluster_convergence: 0.5,
        ml_score: row.ml_score === null || row.ml_score === undefined
            ? null
            : Number(row.ml_score),
        last_seen_at: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
    }));

    // Derive task-specific resolution quality from fact_outcomes.outcome_score
    // so recommendations track incident resolution semantics (not just binary success).
    const resolutionStatsByAction = await getTaskResolutionStatsByAction(params);
    const hydratedRows = rows.map((row) => ({
        ...row,
        resolution_rate:
            resolutionStatsByAction.get(row.action_id)?.resolutionRate
            ?? row.resolution_rate,
        effective_sample_count:
            resolutionStatsByAction.get(row.action_id)?.effectiveSamples
            ?? row.effective_sample_count,
        semantic_cluster_convergence:
            resolutionStatsByAction.get(row.action_id)?.semanticClusterConvergence
            ?? row.semantic_cluster_convergence,
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

function scoreFromExecutionStatus(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === 'COMPLETED') return 1;
    if (normalized === 'FAILED') return 0;
    return null;
}

async function getTaskResolutionStatsByAction(
    params: FetchTaskPerformanceParams,
): Promise<Map<string, TaskResolutionStats>> {
    let query = supabase
        .from('fact_outcomes')
        // Include data_quality so the scoring engine can down-weight low-quality events.
        // Pre-migration rows will have data_quality=NULL — treated as 1.0 (no penalty).
        .select('action_id, outcome_score, outcome_score_raw, success, execution_status, timestamp, data_quality, ingestion_source, is_inconsistent, outcome_class, semantic_cluster_key, semantic_cluster_confidence')
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
        return new Map<string, TaskResolutionStats>();
    }

    const grouped = new Map<string, {
        total: number;
        score_sum: number;
        weighted_score_sum: number;
        weight_total: number;
        cluster_counts: Map<string, number>;
        cluster_samples: number;
        cluster_confidence_sum: number;
        cluster_confidence_count: number;
    }>();

    for (const row of data as Array<Record<string, unknown>>) {
        const actionId = typeof row.action_id === 'string' ? row.action_id : null;
        if (!actionId) continue;

        // Prefer outcome_score_raw (exact developer signal) over the potentially
        // inferred outcome_score. Falls back to execution_status polarity, then
        // legacy success if status is unavailable.
        const rawScore = parseBoundedScore(row.outcome_score_raw);
        const explicitScore = rawScore ?? parseBoundedScore(row.outcome_score);
        const statusScore = scoreFromExecutionStatus(row.execution_status);
        const fallbackScore = statusScore ?? (row.success === true ? 1 : 0);
        const score = explicitScore ?? fallbackScore;

        const current = grouped.get(actionId) ?? {
            total: 0,
            score_sum: 0,
            weighted_score_sum: 0,
            weight_total: 0,
            cluster_counts: new Map<string, number>(),
            cluster_samples: 0,
            cluster_confidence_sum: 0,
            cluster_confidence_count: 0,
        };
        current.total += 1;
        current.score_sum += score;

        const timestamp = typeof row.timestamp === 'string' ? row.timestamp : null;
        const recencyWeight = computeOutcomeEffectiveWeightForScore(score, timestamp);

        // data_quality: NULL on pre-migration rows → default to 1.0 (no penalty).
        // This ensures existing data is not retroactively penalised.
        const rawQuality = typeof row.data_quality === 'number' ? row.data_quality : null;
        const qualityMultiplier = rawQuality !== null
            ? Math.max(0, Math.min(1, rawQuality))
            : 1.0;
        const sourceMultiplier = sourceSignalWeight(row.ingestion_source);
        const reliabilityMultiplier = reliabilitySignalWeight({
            isInconsistent: row.is_inconsistent,
            outcomeClass: row.outcome_class,
        });

        const effectiveWeight = recencyWeight * qualityMultiplier * sourceMultiplier * reliabilityMultiplier;
        if (effectiveWeight > 0) {
            current.weight_total += effectiveWeight;
            current.weighted_score_sum += score * effectiveWeight;
        }

        const clusterKey = typeof row.semantic_cluster_key === 'string'
            ? row.semantic_cluster_key.trim()
            : '';
        if (clusterKey.length > 0) {
            current.cluster_counts.set(clusterKey, (current.cluster_counts.get(clusterKey) ?? 0) + 1);
            current.cluster_samples += 1;
        }

        if (typeof row.semantic_cluster_confidence === 'number') {
            current.cluster_confidence_sum += clamp01(row.semantic_cluster_confidence);
            current.cluster_confidence_count += 1;
        }

        grouped.set(actionId, current);
    }

    const statsByAction = new Map<string, TaskResolutionStats>();
    for (const [actionId, stats] of grouped.entries()) {
        if (stats.total <= 0) continue;
        const weightedRate = stats.weight_total > 0
            ? stats.weighted_score_sum / stats.weight_total
            : stats.score_sum / stats.total;
        const effectiveSamples = stats.weight_total > 0
            ? stats.weight_total
            : stats.total;
        statsByAction.set(actionId, {
            resolutionRate: Number(weightedRate.toFixed(4)),
            effectiveSamples: Number(effectiveSamples.toFixed(4)),
            semanticClusterConvergence: computeSemanticClusterConvergence({
                clusterCounts: stats.cluster_counts,
                clusterSamples: stats.cluster_samples,
                clusterConfidenceSum: stats.cluster_confidence_sum,
                clusterConfidenceCount: stats.cluster_confidence_count,
            }),
        });
    }

    return statsByAction;
}

async function queryTaskPerformanceFromFacts(
    params: FetchTaskPerformanceParams,
): Promise<TaskPerformanceRow[]> {
    let query = supabase
        .from('fact_outcomes')
        .select('action_id, success, execution_status, outcome_score, outcome_score_raw, data_quality, ingestion_source, is_inconsistent, outcome_class, timestamp, semantic_cluster_key, semantic_cluster_confidence, dim_actions!inner(action_name)')
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
        resolution_weighted_score_total: number;
        resolution_weight_total: number;
        cluster_counts: Map<string, number>;
        cluster_samples: number;
        cluster_confidence_sum: number;
        cluster_confidence_count: number;
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
            resolution_weighted_score_total: 0,
            resolution_weight_total: 0,
            cluster_counts: new Map<string, number>(),
            cluster_samples: 0,
            cluster_confidence_sum: 0,
            cluster_confidence_count: 0,
            last_seen_at: null,
        };

        existing.total_count += 1;
        if (row.success === true) {
            existing.success_count += 1;
        }

        // Prefer outcome_score_raw (exact developer signal) over the potentially
        // inferred outcome_score. Falls back to execution_status polarity, then
        // legacy success if status is unavailable.
        const rawScore = parseBoundedScore(row.outcome_score_raw);
        const explicitScore = rawScore ?? parseBoundedScore(row.outcome_score);
        const statusScore = scoreFromExecutionStatus(row.execution_status);
        const fallbackScore = statusScore ?? (row.success === true ? 1 : 0);
        const score = explicitScore ?? fallbackScore;
        existing.resolution_score_total += score;

        const ts = typeof row.timestamp === 'string' ? row.timestamp : null;
        const recencyWeight = computeOutcomeEffectiveWeightForScore(score, ts);

        // data_quality: NULL on pre-migration rows → default to 1.0 (no penalty).
        const rawQuality = typeof row.data_quality === 'number' ? row.data_quality : null;
        const qualityMultiplier = rawQuality !== null
            ? Math.max(0, Math.min(1, rawQuality))
            : 1.0;
        const sourceMultiplier = sourceSignalWeight(row.ingestion_source);
        const reliabilityMultiplier = reliabilitySignalWeight({
            isInconsistent: row.is_inconsistent,
            outcomeClass: row.outcome_class,
        });

        const effectiveWeight = recencyWeight * qualityMultiplier * sourceMultiplier * reliabilityMultiplier;
        if (effectiveWeight > 0) {
            existing.resolution_weight_total += effectiveWeight;
            existing.resolution_weighted_score_total += score * effectiveWeight;
        }

        const clusterKey = typeof row.semantic_cluster_key === 'string'
            ? row.semantic_cluster_key.trim()
            : '';
        if (clusterKey.length > 0) {
            existing.cluster_counts.set(clusterKey, (existing.cluster_counts.get(clusterKey) ?? 0) + 1);
            existing.cluster_samples += 1;
        }

        if (typeof row.semantic_cluster_confidence === 'number') {
            existing.cluster_confidence_sum += clamp01(row.semantic_cluster_confidence);
            existing.cluster_confidence_count += 1;
        }

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
            ? Number((
                row.resolution_weight_total > 0
                    ? row.resolution_weighted_score_total / row.resolution_weight_total
                    : row.resolution_score_total / row.total_count
            ).toFixed(4))
            : successRate;

        return {
            action_id: row.action_id,
            action_name: row.action_name,
            total_count: row.total_count,
            effective_sample_count: Number((
                row.resolution_weight_total > 0
                    ? row.resolution_weight_total
                    : row.total_count
            ).toFixed(4)),
            success_count: row.success_count,
            success_rate: successRate,
            resolution_rate: resolutionRate,
            semantic_cluster_convergence: computeSemanticClusterConvergence({
                clusterCounts: row.cluster_counts,
                clusterSamples: row.cluster_samples,
                clusterConfidenceSum: row.cluster_confidence_sum,
                clusterConfidenceCount: row.cluster_confidence_count,
            }),
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
    console.warn(`[task-performance] ${TASK_PERFORMANCE_MV} unavailable, using fallback:`, reason);

    const fallbackRows = await queryTaskPerformanceFromFacts(params);
    return { rows: fallbackRows, source: 'fact_fallback' };
}

export async function fetchAvailableTasks(
    customerId: string,
    scopedAgentId: string | null,
): Promise<{ tasks: string[]; source: 'mv' | 'fact_fallback' }> {
    const mvRows: Array<{ task_name: unknown }> = [];
    let mvError: QueryError | null = null;

    for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
        let mvQuery = supabase
            .from(TASK_PERFORMANCE_MV)
            .select('task_name')
            .eq('customer_id', customerId)
            .neq('agent_id', ZERO_UUID_AGENT_ID)
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

        if (scopedAgentId) {
            mvQuery = mvQuery.eq('agent_id', scopedAgentId);
        }

        const { data, error } = await mvQuery;
        if (error) {
            mvError = error as QueryError;
            break;
        }

        const page = (data ?? []) as Array<{ task_name: unknown }>;
        mvRows.push(...page);
        if (page.length < SUPABASE_PAGE_SIZE) {
            break;
        }
    }

    if (!mvError) {
        const tasks = [
            ...new Set(mvRows
                .map((row: any) => normalizeTaskName(row.task_name))
                .filter((task): task is string => task !== null)),
        ].sort();

        return { tasks, source: 'mv' };
    }

    const reason = isMissingMvError(mvError)
        ? 'materialized view is missing'
        : mvError.message;
    console.warn('[task-performance] task list fallback activated:', reason);

    const fallbackRows: Array<{ task_name: unknown }> = [];
    const windowStart = new Date(
        Date.now() - RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
        let fallbackQuery = supabase
            .from('fact_outcomes')
            .select('task_name')
            .eq('customer_id', customerId)
            .eq('is_deleted', false)
            .eq('is_synthetic', false)
            .not('task_name', 'is', null)
            .neq('agent_id', ZERO_UUID_AGENT_ID)
            .gte('timestamp', windowStart)
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

        if (scopedAgentId) {
            fallbackQuery = fallbackQuery.eq('agent_id', scopedAgentId);
        }

        const { data, error } = await fallbackQuery;

        if (error) {
            throw new Error(`[task-performance] task list fallback failed: ${error.message}`);
        }

        const page = (data ?? []) as Array<{ task_name: unknown }>;
        fallbackRows.push(...page);
        if (page.length < SUPABASE_PAGE_SIZE) {
            break;
        }
    }

    const tasks = [
        ...new Set(fallbackRows
            .map((row: any) => normalizeTaskName(row.task_name))
            .filter((task): task is string => task !== null)),
    ].sort();

    return { tasks, source: 'fact_fallback' };
}
