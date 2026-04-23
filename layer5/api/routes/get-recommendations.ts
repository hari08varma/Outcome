import { Hono } from 'hono';
import {
    MIN_SAMPLES_STABLE,
    type RecommendationResult,
    getRecommendation,
    MIN_SAMPLES,
    MIN_SAMPLES_HIGH_CONFIDENCE,
    RECOMMENDATION_WINDOW_DAYS,
} from '../lib/recommendation/engine.js';
import { buildActionableOutput } from '../lib/recommendation/reason.js';
import {
    AGENT_SCOPE_MIN_CONFIDENCE,
    type RecommendationScope,
    type ScopeTransitionCandidate,
    chooseScopedOrBlendedCandidate,
} from '../lib/recommendation/scope-transition.js';
import { buildRecommendationDataFreshness } from '../lib/recommendation/data-freshness.js';
import {
    fetchAvailableTasks,
    fetchTaskActionPerformance,
    type ContextFilter,
} from '../lib/recommendation/task-performance.js';
import { ZERO_UUID_AGENT_ID } from '../lib/recommendation/task-performance.js';
import { upsertRecommendationCohortCycle } from '../lib/recommendation/cohort-cycle.js';
import { computeCohortReliability } from '../lib/recommendation/cohort-reliability.js';
import { supabase } from '../lib/supabase.js';
import { generateNarrative } from '../lib/recommendation/llm-narrative.js';

export const getRecommendationsRouter = new Hono();

// ── Data sources summary ──────────────────────────────────────
// Counts SDK vs imported outcomes for the agent so the client
// can show "Based on 248 uploaded + 42 SDK outcomes, quality 0.71"
async function fetchDataSources(
    customerId: string,
    agentId: string,
    taskName: string,
): Promise<{
    uploaded_outcomes: number;
    sdk_outcomes: number;
    total: number;
    upload_share: number;
    quality_score: number | null;
}> {
    try {
        const normalizedTask = normalizeTaskSlug(taskName);
        const candidates = normalizedTask && normalizedTask !== taskName
            ? [taskName, normalizedTask]
            : [taskName];

        let finalCandidate = candidates[0];
        let importedCount = 0;
        let sdkCount = 0;

        for (const candidate of candidates) {
            const baseQuery = supabase
                .from('fact_outcomes')
                .select('*', { count: 'exact', head: true })
                .eq('customer_id', customerId)
                .eq('agent_id', agentId)
                .eq('task_name', candidate)
                .eq('is_synthetic', false)
                .eq('is_deleted', false);

            const [importRes, sdkRes] = await Promise.all([
                baseQuery.eq('ingestion_source', 'import'),
                baseQuery.eq('ingestion_source', 'api')
            ]);
            
            // If we found data using this slug, stick with it.
            if ((importRes.count ?? 0) > 0 || (sdkRes.count ?? 0) > 0) {
                importedCount = importRes.count ?? 0;
                sdkCount = sdkRes.count ?? 0;
                finalCandidate = candidate;
                break;
            }
        }

        const total = importedCount + sdkCount;
        if (total === 0) {
            return { uploaded_outcomes: 0, sdk_outcomes: 0, total: 0, upload_share: 0, quality_score: null };
        }

        // Fetch just a 1000-row sample for the average quality to prevent OOM
        const { data: qualityRows } = await supabase
            .from('fact_outcomes')
            .select('data_quality')
            .eq('customer_id', customerId)
            .eq('agent_id', agentId)
            .eq('task_name', finalCandidate)
            .eq('is_synthetic', false)
            .eq('is_deleted', false)
            .not('data_quality', 'is', 'null')
            .order('timestamp', { ascending: false })
            .limit(1000);

        let qualityScore = null;
        if (qualityRows && qualityRows.length > 0) {
            const sum = qualityRows.reduce((acc, row) => acc + (Number(row.data_quality) || 0), 0);
            qualityScore = Math.round((sum / qualityRows.length) * 10000) / 10000;
        }

        const uploadShare = Math.round((importedCount / total) * 10000) / 10000;

        return { uploaded_outcomes: importedCount, sdk_outcomes: sdkCount, total, upload_share: uploadShare, quality_score: qualityScore };
    } catch {
        return { uploaded_outcomes: 0, sdk_outcomes: 0, total: 0, upload_share: 0, quality_score: null };
    }
}

function toScopeTransitionCandidate(
    result: RecommendationResult,
): ScopeTransitionCandidate {
    return {
        state: result.state,
        min_sample_count: result.min_sample_count,
        confidence: result.confidence,
        has_best_action: !!result.best_action,
    };
}

function medianOf(values: number[]): number | null {
    const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (finite.length === 0) return null;

    const middle = Math.floor(finite.length / 2);
    if (finite.length % 2 === 1) {
        return Number(finite[middle].toFixed(4));
    }

    return Number(((finite[middle - 1] + finite[middle]) / 2).toFixed(4));
}

function buildTraceability(params: {
    result: RecommendationResult;
    requestedScope: RecommendationScope;
    servedScope: RecommendationScope;
    fallbackApplied: boolean;
    scopeReason: string | null;
}): {
    reason_code: string;
    stage: string;
    gate: string | null;
    detail: string | null;
} {
    const { result, requestedScope, servedScope, fallbackApplied, scopeReason } = params;

    const baseTraceability = result.traceability ?? {
        reason_code: 'unknown_recommendation_trace',
        stage: 'decision',
        gate: null,
        detail: null,
    };

    if (fallbackApplied && requestedScope === 'agent_scoped' && servedScope === 'customer_blended') {
        return {
            ...baseTraceability,
            detail: baseTraceability.detail
                ? `${baseTraceability.detail} Scope fallback: ${scopeReason ?? 'agent scope reliability gate.'}`
                : `Scope fallback: ${scopeReason ?? 'agent scope reliability gate.'}`,
        };
    }

    return baseTraceability;
}

type QueryError = {
    message: string;
    code?: string | null;
};

const SUPABASE_PAGE_SIZE = 1000;

// ── Context resolution ────────────────────────────────────────
// Resolves a ContextFilter from (issue_type, environment, customer_tier) query params.
// Mirrors the same lookup used by get-scores.ts so context is consistent across endpoints.
// Returns { resolved: false } when no context params are provided (backward-compatible).
async function resolveContextFilter(params: {
    customerId: string;
    issueType: string | null;
    environment: string | null;
    customerTier: string | null;
}): Promise<ContextFilter> {
    const { customerId, issueType, environment, customerTier } = params;

    if (!issueType) {
        return { resolved: false, contextId: null, label: null };
    }

    // Canonicalize issue_type to match log-outcome and import normalization.
    const normalizedIssueType = issueType.trim().toLowerCase()
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || issueType.trim();

    const normalizedEnv = (environment ?? 'production').trim().toLowerCase() || 'production';

    try {
        // Exact match on (customer_id, issue_type, environment)
        const { data, error } = await supabase
            .from('dim_contexts')
            .select('context_id, issue_type, environment, customer_tier')
            .eq('customer_id', customerId)
            .eq('issue_type', normalizedIssueType)
            .eq('environment', normalizedEnv)
            .limit(1)
            .maybeSingle();

        if (!error && data?.context_id) {
            return {
                resolved: true,
                contextId: data.context_id as string,
                label: `${normalizedIssueType} / ${normalizedEnv}${customerTier ? ` / ${customerTier}` : ''}`,
            };
        }

        // Fallback: match just issue_type for this customer (ignore environment)
        const { data: fuzzy } = await supabase
            .from('dim_contexts')
            .select('context_id, issue_type, environment')
            .eq('customer_id', customerId)
            .eq('issue_type', normalizedIssueType)
            .limit(1)
            .maybeSingle();

        if (fuzzy?.context_id) {
            return {
                resolved: true,
                contextId: fuzzy.context_id as string,
                label: `${normalizedIssueType} / ${fuzzy.environment ?? 'any'} (env fallback)`,
            };
        }

        // Context doesn't exist yet — cold start; signal is globally blended
        return { resolved: false, contextId: null, label: `${normalizedIssueType} (cold start)` };
    } catch {
        return { resolved: false, contextId: null, label: null };
    }
}

function normalizeTaskSlug(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^_+|_+$/g, '');
}

function hasRecommendationEvidence(result: RecommendationResult): boolean {
    return result.all_actions.some((action) => Math.max(0, Number(action.total_count ?? 0)) > 0);
}

function toUniqueTaskCandidates(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const value of values) {
        if (!value) continue;
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }

    return out;
}

async function getRecommendationWithTaskFallback(
    customerId: string,
    requestedTaskName: string,
    agentId: string | null,
    contextFilter?: ContextFilter | null,
): Promise<{ taskName: string; result: RecommendationResult }> {
    const primaryTaskName = requestedTaskName.trim();
    const normalizedTaskName = normalizeTaskSlug(primaryTaskName);

    const primaryResult = await getRecommendation(customerId, primaryTaskName, agentId, contextFilter);

    if (
        normalizedTaskName.length === 0
        || normalizedTaskName === primaryTaskName
        || hasRecommendationEvidence(primaryResult)
        || primaryResult.state !== 'no_data'
    ) {
        return { taskName: primaryTaskName, result: primaryResult };
    }

    const normalizedResult = await getRecommendation(customerId, normalizedTaskName, agentId, contextFilter);
    if (hasRecommendationEvidence(normalizedResult) || normalizedResult.state !== 'no_data') {
        return { taskName: normalizedTaskName, result: normalizedResult };
    }

    return { taskName: primaryTaskName, result: primaryResult };
}

function addOutcomeCount(
    agentTaskTotals: Map<string, Map<string, number>>,
    agentGrandTotals: Map<string, number>,
    agentSuccessStats: Map<string, { wins: number; rated: number }>,
    agentId: string,
    taskName: string,
    increment: number,
    success: boolean | null,
    score: number | null,
    scoreRaw: number | null,
): void {
    if (!agentId || !taskName || !Number.isFinite(increment) || increment <= 0) {
        return;
    }

    let taskMap = agentTaskTotals.get(agentId);
    if (!taskMap) {
        taskMap = new Map<string, number>();
        agentTaskTotals.set(agentId, taskMap);
    }

    taskMap.set(taskName, (taskMap.get(taskName) ?? 0) + increment);
    agentGrandTotals.set(agentId, (agentGrandTotals.get(agentId) ?? 0) + increment);

    // Track win rate across all tasks for this agent
    const stats = agentSuccessStats.get(agentId) ?? { wins: 0, rated: 0 };
    const finalScore = scoreRaw ?? score ?? (success === true ? 1 : success === false ? 0 : null);
    if (finalScore !== null) {
        stats.rated += increment;
        stats.wins += (finalScore * increment);
        agentSuccessStats.set(agentId, stats);
    }
}

async function fetchAgentTaskOutcomeTotals(params: {
    customerId: string;
    agentId: string | null;
}): Promise<{
    agentTaskTotals: Map<string, Map<string, number>>;
    agentGrandTotals: Map<string, number>;
    agentSuccessStats: Map<string, { wins: number; rated: number }>;
    source: 'fact_outcomes';
}> {
    const { customerId, agentId } = params;
    const agentTaskTotals = new Map<string, Map<string, number>>();
    const agentGrandTotals = new Map<string, number>();
    const agentSuccessStats = new Map<string, { wins: number; rated: number }>();

    for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
        let factsQuery = supabase
            .from('fact_outcomes')
            .select('agent_id, task_name, success, outcome_score, outcome_score_raw')
            .eq('customer_id', customerId)
            .eq('is_synthetic', false)
            .eq('is_deleted', false)
            .neq('agent_id', ZERO_UUID_AGENT_ID)
            .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

        if (agentId) {
            factsQuery = factsQuery.eq('agent_id', agentId);
        }

        const { data, error } = await factsQuery;
        if (error) {
            throw new Error(`[agent-summary] fallback aggregation failed: ${error.message}`);
        }

        const page = (data ?? []) as Array<{ 
            agent_id: string | null; 
            task_name: string | null;
            success: boolean | null;
            outcome_score: number | null;
            outcome_score_raw: number | null;
        }>;
        for (const row of page) {
            addOutcomeCount(
                agentTaskTotals,
                agentGrandTotals,
                agentSuccessStats,
                row.agent_id ?? '',
                row.task_name ?? '',
                1,
                row.success,
                row.outcome_score,
                row.outcome_score_raw
            );
        }

        if (page.length < SUPABASE_PAGE_SIZE) {
            break;
        }
    }

    return { agentTaskTotals, agentGrandTotals, agentSuccessStats, source: 'fact_outcomes' };
}

// GET /agent-summary — per-agent stats + per-task outcome counts
// Uses fact_outcomes directly (all-time) so agent/task totals reflect everything logged.
// Returns tasks only for the requested agent.
getRecommendationsRouter.get('/agent-summary', async (c) => {
    c.header('Cache-Control', 'no-store');
    const customerId = c.get('customer_id') as string | undefined;
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    const agentId = c.req.query('agent_id')?.trim() || null;

    try {
        // 1. Agent metadata + trust (parallel)
        let agentQuery = supabase
            .from('dim_agents')
            .select('agent_id, agent_name, agent_type, llm_model')
            .eq('customer_id', customerId);
        if (agentId) agentQuery = agentQuery.eq('agent_id', agentId);

        const [agentResult, trustResult, outcomeTotals] = await Promise.all([
            agentQuery,
            agentId
                ? supabase
                    .from('agent_trust_scores')
                    .select('agent_id, trust_score, trust_status')
                    .eq('agent_id', agentId)
                    .single()
                : Promise.resolve({ data: null, error: null }),
            fetchAgentTaskOutcomeTotals({ customerId, agentId }),
        ]);

        const agentMeta = agentResult.data ?? [];
        const trustMeta = trustResult.data as {
            agent_id: string; trust_score: number; trust_status: string;
        } | null;

        const { agentTaskTotals, agentGrandTotals, agentSuccessStats, source } = outcomeTotals;

        if (agentId) {
            const meta = (agentMeta as any[]).find((a) => a.agent_id === agentId);
            const taskMap = agentTaskTotals.get(agentId) ?? new Map();
            const grandTotal = agentGrandTotals.get(agentId) ?? 0;
            const successStats = agentSuccessStats.get(agentId);
            const winRate = successStats && successStats.rated > 0 
                ? Number((successStats.wins / successStats.rated).toFixed(4)) 
                : null;

            const tasks = Array.from(taskMap.entries())
                .map(([task_name, total]) => ({ task_name, total }))
                .sort((a, b) => b.total - a.total);

            return c.json({
                agent_id: agentId,
                agent_name: meta?.agent_name ?? agentId,
                agent_type: meta?.agent_type ?? null,
                llm_model: meta?.llm_model ?? null,
                trust_score: trustMeta?.trust_score ?? null,
                trust_status: trustMeta?.trust_status ?? null,
                total_outcomes: grandTotal,
                win_rate: winRate,
                tasks,
                window_days: null,
                counts_source: source,
            }, 200);
        } else {
            const agents = (agentMeta as any[]).map((a) => ({
                agent_id: a.agent_id,
                agent_name: a.agent_name,
                agent_type: a.agent_type ?? null,
                llm_model: a.llm_model ?? null,
                total_outcomes: agentGrandTotals.get(a.agent_id) ?? 0,
            })).sort((a, b) => b.total_outcomes - a.total_outcomes);

            return c.json({ agents, window_days: null, counts_source: source }, 200);
        }
    } catch (err: any) {
        console.error('[agent-summary] error:', err.message);
        return c.json({ error: 'Internal error', details: err.message }, 500);
    }
});

// GET /tasks — returns distinct task_names available for a customer (+ optional agent scope)
// Uses mv_task_action_performance with automatic fallback to fact_outcomes.
// Must be registered before '/' so Hono matches it first
getRecommendationsRouter.get('/tasks', async (c) => {
    c.header('Cache-Control', 'no-store');
    const customerId = c.get('customer_id') as string | undefined;
    if (!customerId) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    const scopedAgentId = c.req.query('agent_id')?.trim() || null;

    try {
        const { tasks } = await fetchAvailableTasks(customerId, scopedAgentId);

        return c.json({ tasks }, 200);
    } catch (err: any) {
        console.warn('[get-recommendations/tasks] fallback query failed:', err.message);
        return c.json({ tasks: [] }, 200);
    }
});

// ── GET /task-analytics ──────────────────────────────────────
// Computes three signals the main recommendation response doesn't include:
//   1. Drift trendline — sliding-window linear regression on success rate over
//      the last N outcomes, giving slope + confidence so the UI can show
//      "success rate is silently dropping" before it hits the noise gate.
//   2. Explore/exploit ratio — fraction of outcomes that were exploration events
//      (cross_event_status != 'none' or is_synthetic) vs exploitation.
//   3. Trust blocks — how many outcomes were blocked/logged while trust_status
//      was below threshold (recorded via execution_status='FAILED' + failure_reason_code='TRUST_GATE').
//
// All queries are read-only against fact_outcomes.
// Required query params: task (string), agent_id (UUID)
// Optional: window (integer, default 50) — outcome count for drift window
getRecommendationsRouter.get('/task-analytics', async (c) => {
    c.header('Cache-Control', 'no-store');
    const customerId = c.get('customer_id') as string | undefined;
    if (!customerId) {
        return c.json({ error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' }, 401);
    }

    const rawTask = c.req.query('task')?.trim() || null;
    const rawAgentId = c.req.query('agent_id')?.trim() || null;
    const windowSize = Math.max(20, Math.min(200, parseInt(c.req.query('window') ?? '50', 10) || 50));

    if (!rawTask) {
        return c.json({ error: 'Missing required query parameter: task', code: 'MISSING_TASK' }, 400);
    }
    if (!rawAgentId) {
        return c.json({ error: 'Missing required query parameter: agent_id', code: 'MISSING_AGENT_ID' }, 400);
    }

    try {
        // Run drift-window query and action-aggregate query in parallel.
        // The drift query is limited to a recent window; action aggregates are all-time.
        // Action aggregates are needed when trust gate blocks the engine (all_actions=[]).
        const [driftResult, actionResult] = await Promise.all([
            supabase
                .from('fact_outcomes')
                .select('success, outcome_score, outcome_score_raw, execution_status, failure_reason_code, cross_event_status, is_synthetic, timestamp, data_quality')
                .eq('customer_id', customerId)
                .eq('agent_id', rawAgentId)
                .eq('task_name', rawTask)
                .eq('is_deleted', false)
                .eq('is_synthetic', false)
                .order('timestamp', { ascending: false })
                .limit(windowSize * 2),
            supabase
                .from('fact_outcomes')
                .select('action_id, outcome_score, outcome_score_raw, success, execution_status, timestamp, dim_actions(action_name)')
                .eq('customer_id', customerId)
                .eq('agent_id', rawAgentId)
                .eq('task_name', rawTask)
                .eq('is_deleted', false)
                .eq('is_synthetic', false)
                .order('timestamp', { ascending: false })
                .limit(5000),
        ]);

        if (driftResult.error) {
            throw new Error(`[task-analytics] drift query failed: ${driftResult.error.message}`);
        }

        const rows = (driftResult.data ?? []) as Array<{
            success: boolean | null;
            outcome_score: number | null;
            outcome_score_raw: number | null;
            execution_status: string | null;
            failure_reason_code: string | null;
            cross_event_status: string | null;
            is_synthetic: boolean | null;
            timestamp: string | null;
            data_quality: number | null;
        }>;

        // ── Action aggregates (for trust-blocked fallback) ────
        type ActionAgg = { action_id: string; action_name: string; total_count: number; score_sum: number; score_count: number; last_seen_at: string | null };
        const actionAggMap = new Map<string, ActionAgg>();
        for (const raw of (actionResult.data ?? []) as Array<Record<string, unknown>>) {
            const actionId = typeof raw.action_id === 'string' ? raw.action_id : null;
            if (!actionId) continue;
            const rel = raw.dim_actions;
            const actionName: string = (Array.isArray(rel) ? (rel[0] as any)?.action_name : (rel as any)?.action_name) ?? actionId;
            const rawScore = typeof raw.outcome_score_raw === 'number' ? raw.outcome_score_raw
                : typeof raw.outcome_score === 'number' ? raw.outcome_score : null;
            const statusScore = typeof raw.execution_status === 'string'
                ? (raw.execution_status.toUpperCase() === 'COMPLETED' ? 1 : raw.execution_status.toUpperCase() === 'FAILED' ? 0 : null)
                : null;
            const score = rawScore ?? statusScore ?? (raw.success === true ? 1 : raw.success === false ? 0 : null);
            const ts = typeof raw.timestamp === 'string' ? raw.timestamp : null;
            const key = actionId;
            const agg = actionAggMap.get(key) ?? { action_id: actionId, action_name: actionName, total_count: 0, score_sum: 0, score_count: 0, last_seen_at: null };
            agg.total_count += 1;
            if (score !== null) { agg.score_sum += score; agg.score_count += 1; }
            if (ts && (!agg.last_seen_at || ts > agg.last_seen_at)) agg.last_seen_at = ts;
            actionAggMap.set(key, agg);
        }
        const actionAggregates = Array.from(actionAggMap.values())
            .map((a) => ({
                action_id: a.action_id,
                action_name: a.action_name,
                total_count: a.total_count,
                effective_sample_count: a.total_count,
                resolution_rate: a.score_count > 0 ? Number((a.score_sum / a.score_count).toFixed(4)) : 0,
                ml_score: null,
                semantic_cluster_convergence: null,
                last_seen_at: a.last_seen_at,
            }))
            .sort((a, b) => b.resolution_rate - a.resolution_rate);

        if (rows.length === 0 && actionAggregates.length === 0) {
            return c.json({
                drift: { slope: null, confidence: null, window_size: 0, direction: 'unknown', points: [] },
                explore_exploit: { explore_count: 0, exploit_count: 0, total: 0, explore_ratio: null },
                trust_blocks: { blocked_count: 0, total: 0 },
                action_aggregates: [],
            }, 200);
        }

        // ── 1. Drift trendline ────────────────────────────────
        // Reverse to chronological order, take last `windowSize`.
        // Use a 5-outcome sliding window to compute local success rate at each step,
        // then run linear regression (OLS) on those rates vs. position index.
        const chronological = [...rows].reverse().slice(-windowSize);
        const SLIDING = 5;
        const points: Array<{ index: number; rate: number; timestamp: string }> = [];

        for (let i = SLIDING - 1; i < chronological.length; i++) {
            const slice = chronological.slice(i - SLIDING + 1, i + 1);
            let successSum = 0;
            let count = 0;
            for (const r of slice) {
                const score = typeof r.outcome_score === 'number' ? r.outcome_score
                    : typeof r.outcome_score_raw === 'number' ? r.outcome_score_raw
                        : typeof r.success === 'boolean' ? (r.success ? 1 : 0)
                            : null;
                if (score !== null) {
                    successSum += score;
                    count++;
                }
            }
            if (count > 0) {
                points.push({
                    index: i,
                    rate: Number((successSum / count).toFixed(4)),
                    timestamp: chronological[i]!.timestamp ?? '',
                });
            }
        }

        let slope: number | null = null;
        let rSquared: number | null = null;

        if (points.length >= 4) {
            const n = points.length;
            const xs = points.map((p) => p.index);
            const ys = points.map((p) => p.rate);
            const xMean = xs.reduce((a, b) => a + b, 0) / n;
            const yMean = ys.reduce((a, b) => a + b, 0) / n;
            const ssXY = xs.reduce((acc, x, i) => acc + (x - xMean) * (ys[i]! - yMean), 0);
            const ssXX = xs.reduce((acc, x) => acc + (x - xMean) ** 2, 0);
            const ssYY = ys.reduce((acc, y) => acc + (y - yMean) ** 2, 0);

            if (ssXX > 0) {
                slope = Number((ssXY / ssXX).toFixed(6));
                rSquared = ssYY > 0 ? Number(((ssXY ** 2) / (ssXX * ssYY)).toFixed(4)) : 1;
            }
        }

        const direction: 'improving' | 'stable' | 'degrading' | 'unknown' =
            slope === null ? 'unknown'
                : slope > 0.002 ? 'improving'
                    : slope < -0.002 ? 'degrading'
                        : 'stable';

        // ── 2. Explore / exploit ──────────────────────────────
        // Exploration = cross_event_status is 'pending_signal' or 'conflict' (engine pushed a test action).
        // Exploitation = confirmed, resolved, or 'none' (engine used its best known action).
        let exploreCount = 0;
        let exploitCount = 0;
        for (const r of rows) {
            const status = r.cross_event_status ?? 'none';
            if (status === 'pending_signal' || status === 'conflict') {
                exploreCount++;
            } else {
                exploitCount++;
            }
        }
        const total = rows.length;
        const exploreRatio = total > 0 ? Number((exploreCount / total).toFixed(4)) : null;

        // ── 3. Trust blocks ───────────────────────────────────
        // A trust block is an outcome that was logged with failure_reason_code = 'TRUST_GATE'
        // OR execution_status = 'FAILED' while failure_reason_code contains 'TRUST'.
        const blockedCount = rows.filter((r) => {
            const code = (r.failure_reason_code ?? '').toUpperCase();
            return code.includes('TRUST') || code === 'TRUST_GATE';
        }).length;

        return c.json({
            drift: {
                slope,
                confidence: rSquared,
                window_size: chronological.length,
                direction,
                points: points.slice(-30), // cap response size — last 30 points enough for a sparkline
            },
            explore_exploit: {
                explore_count: exploreCount,
                exploit_count: exploitCount,
                total,
                explore_ratio: exploreRatio,
            },
            trust_blocks: {
                blocked_count: blockedCount,
                total,
            },
            // All-time action aggregates from fact_outcomes — available even when trust gate blocks the engine.
            action_aggregates: actionAggregates,
        }, 200);
    } catch (err: any) {
        console.error('[task-analytics] unexpected error:', err.message);
        return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR', details: err.message }, 500);
    }
});

getRecommendationsRouter.get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const customerId = c.get('customer_id') as string | undefined;

    if (!customerId) {
        return c.json(
            { error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' },
            401
        );
    }

    const rawTask = c.req.query('task');
    // Optional agent_id filter — scopes recommendation to a single agent
    // When absent, returns customer-wide blended view (backward compatible)
    const rawAgentId = c.req.query('agent_id') ?? null;
    const scopedAgentId = rawAgentId?.trim() || null;
    const strictAgentScope = ['1', 'true', 'yes', 'on'].includes(
        (c.req.query('strict_agent_scope') ?? '').trim().toLowerCase(),
    );
    // Optional context filter — narrows performance signal to a specific (issue_type, environment, customer_tier)
    // combination, using blended signal as prior when context-specific sample count is low
    const rawIssueType = c.req.query('issue_type')?.trim() || null;
    const rawEnvironment = c.req.query('environment')?.trim() || null;
    const rawCustomerTier = c.req.query('customer_tier')?.trim() || null;

    if (!rawTask || rawTask.trim() === '') {
        return c.json(
            {
                error: 'Missing required query parameter: task',
                code: 'MISSING_TASK',
                hint: 'Example: GET /v1/recommendations?task=payment_failed',
            },
            400
        );
    }

    const requestedTaskName = rawTask.trim();

    if (requestedTaskName.length === 0) {
        return c.json(
            {
                error: 'Invalid task parameter',
                code: 'INVALID_TASK',
            },
            400
        );
    }

    try {
        const requestedScope: RecommendationScope = scopedAgentId
            ? 'agent_scoped'
            : 'customer_blended';

        // Resolve context filter once — shared across all recommendation calls in this request
        const contextFilter = await resolveContextFilter({
            customerId,
            issueType: rawIssueType,
            environment: rawEnvironment,
            customerTier: rawCustomerTier,
        });

        let result: RecommendationResult;
        let servedScope: RecommendationScope = requestedScope;
        let scopeReason: string | null = null;
        let scopeThresholdProgress: {
            bucket: string;
            current_samples: number;
            next_threshold: number | null;
            remaining_to_next_bucket: number;
        } | null = null;
        let taskName = requestedTaskName;

        if (scopedAgentId) {
            const scopedResolution = await getRecommendationWithTaskFallback(
                customerId,
                requestedTaskName,
                scopedAgentId,
                contextFilter,
            );
            taskName = scopedResolution.taskName;

            const scopedResult = scopedResolution.result;
            const blendedResult = await getRecommendation(customerId, taskName, null, contextFilter);

            if (strictAgentScope) {
                result = scopedResult;
                servedScope = 'agent_scoped';
                scopeReason = 'Strict agent scope requested; blended fallback disabled.';
                scopeThresholdProgress = chooseScopedOrBlendedCandidate(
                    toScopeTransitionCandidate(scopedResult),
                    toScopeTransitionCandidate(blendedResult),
                ).threshold_progress;
            } else {
                const selection = chooseScopedOrBlendedCandidate(
                    toScopeTransitionCandidate(scopedResult),
                    toScopeTransitionCandidate(blendedResult),
                );

                result = selection.servedScope === 'customer_blended'
                    ? blendedResult
                    : scopedResult;
                servedScope = selection.servedScope;
                scopeReason = selection.reason;
                scopeThresholdProgress = selection.threshold_progress;
            }
        } else {
            const blendedResolution = await getRecommendationWithTaskFallback(
                customerId,
                requestedTaskName,
                null,
                contextFilter,
            );
            taskName = blendedResolution.taskName;
            result = blendedResolution.result;
        }

        const fallbackApplied = requestedScope !== servedScope;
        const confidenceSource = result.confidence_source ?? 'bootstrap';
        const confidenceSourceReason = result.confidence_source_reason ?? 'unknown_confidence_source_reason';
        const thresholdHint = scopeThresholdProgress
            ? scopeThresholdProgress.next_threshold === null
                ? `Evidence bucket: ${scopeThresholdProgress.bucket} (${scopeThresholdProgress.current_samples} samples, cohort-anchor reached).`
                : `Evidence bucket: ${scopeThresholdProgress.bucket} (${scopeThresholdProgress.current_samples} samples, ${scopeThresholdProgress.remaining_to_next_bucket} to ${scopeThresholdProgress.next_threshold}).`
            : null;
        const scopeLabel = servedScope === 'agent_scoped'
            ? 'Based on this agent\'s logged outcomes only'
            : fallbackApplied
                ? 'Agent-specific evidence is still warming. Temporarily using blended cohort outcomes for lower uncertainty.'
                : 'Based on all agents\' combined outcomes';

        const output = buildActionableOutput(result);
        const lastSeenAt = output.data_window?.last_seen_at ?? null;
        const dataFreshness = buildRecommendationDataFreshness(
            result._data_source ?? 'unknown',
            lastSeenAt,
        );

        let scopedEvidenceActions = result.all_actions;
        let scopedEvidenceSource: 'engine' | 'task_performance_mv' | 'task_performance_fact_fallback' = 'engine';
        let evidenceTaskName = taskName;

        // Always fetch agent-scoped action evidence when an agent_id is provided.
        // The engine may have served customer_blended results (scope fallback) whose
        // all_actions contain cross-agent totals — those numbers must NOT appear in
        // the per-agent leaderboard. Force a per-agent evidence fetch in three cases:
        //   1. Trust gate blocked (engine returns [])
        //   2. Scope fell back to customer_blended (actions are cross-agent)
        //   3. Engine returned no actions at all
        if (scopedAgentId && (result._trust_gate_blocked || servedScope === 'customer_blended' || scopedEvidenceActions.length === 0)) {
            const taskCandidates = toUniqueTaskCandidates([
                taskName,
                requestedTaskName,
                normalizeTaskSlug(taskName),
                normalizeTaskSlug(requestedTaskName),
            ]);

            const windowStart = new Date(
                Date.now() - RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString();

            for (const candidateTask of taskCandidates) {
                const { rows, source } = await fetchTaskActionPerformance({
                    customerId,
                    taskName: candidateTask,
                    agentId: scopedAgentId,
                    windowStart,
                    contextFilter,
                });

                if (!rows.length) {
                    continue;
                }

                scopedEvidenceActions = rows.map((row) => ({
                    action_id: row.action_id,
                    action_name: row.action_name,
                    total_count: Number(row.total_count ?? 0),
                    effective_sample_count: Number(row.effective_sample_count ?? row.total_count ?? 0),
                    success_count: Number(row.success_count ?? 0),
                    success_rate: Number(row.success_rate ?? 0),
                    resolution_rate: Number(row.resolution_rate ?? row.success_rate ?? 0),
                    ml_score: row.ml_score === null || row.ml_score === undefined ? null : Number(row.ml_score),
                    semantic_cluster_convergence: Number(row.semantic_cluster_convergence ?? 0.5),
                    last_seen_at: row.last_seen_at ?? null,
                }));

                evidenceTaskName = candidateTask;
                scopedEvidenceSource = source === 'mv'
                    ? 'task_performance_mv'
                    : 'task_performance_fact_fallback';
                break;
            }
        }

        const scopedTaskOutcomeTotal = scopedEvidenceActions.reduce(
            (sum, action) => sum + Math.max(0, Number(action.total_count ?? 0)),
            0,
        );

        const totalOutcomes = result.all_actions.reduce(
            (sum, action) => sum + Math.max(0, Number(action.total_count ?? 0)),
            0,
        );
        const medianSuccessRate = medianOf(
            result.all_actions.map((action) => Number(action.resolution_rate ?? Number.NaN)),
        );
        // Run cohort upsert, data sources, and LLM narrative in parallel.
        // LLM narrative is skipped when the agent is trust-blocked (no actions = no useful narrative).
        // Data sources uses a 2s timeout — those COUNT(*) queries on raw fact_outcomes
        // are the slowest under connection pool pressure, and they're only used for UI hints.
        const isTrustBlocked = !!(result as any)._trust_gate_blocked;

        const dataSourcesPromise = scopedAgentId
            ? Promise.race([
                fetchDataSources(customerId, scopedAgentId, taskName),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
            ])
            : Promise.resolve(null);

        const [cohortCycle, dataSources, narrative] = await Promise.all([
            upsertRecommendationCohortCycle({
                customer_id: customerId,
                task_name: taskName,
                observed_at: result.generated_at,
                total_outcomes: totalOutcomes,
                median_confidence: result.confidence,
                median_success_rate: medianSuccessRate,
                confidence_source: confidenceSource,
                confidence_source_reason: confidenceSourceReason,
            }),
            dataSourcesPromise.catch(() => null),
            // Skip LLM when trust-blocked — no actions means nothing meaningful to narrate.
            // Also skip when state is no_data to avoid burning tokens on empty responses.
            !isTrustBlocked && result.state !== 'no_data'
                ? generateNarrative(output, {
                    reliability_band: null, // filled after cohortReliability — we'll patch below
                    reliability_reasons: [],
                    silent_failure_warning: !!(result as any)._silent_failure_warning,
                    data_freshness_stale: dataFreshness.is_stale,
                    data_freshness_age_hours: dataFreshness.age_hours,
                    scope: servedScope,
                    scope_fallback_applied: fallbackApplied,
                    confidence_source: confidenceSource,
                    confidence_source_reason: confidenceSourceReason,
                })
                : Promise.resolve(null),
        ]);
        const cohortReliability = computeCohortReliability(result, cohortCycle);

        const traceability = buildTraceability({
            result,
            requestedScope,
            servedScope,
            fallbackApplied,
            scopeReason,
        });

        // Merge LLM narrative over the static template fields when available
        const narrativeOverride = narrative
            ? {
                message: narrative.message,
                reason: {
                    summary: narrative.summary,
                    evidence: narrative.evidence,
                    confidence_note: narrative.confidence_note,
                },
                llm_narrative: {
                    headline: narrative.headline,
                    narrative: narrative.narrative,
                    next_steps: narrative.next_steps,
                    risk_factors: narrative.risk_factors,
                    trend_direction: narrative.trend_direction,
                    generated: true,
                    model: process.env.RECOMMENDATION_NARRATIVE_MODEL ?? 'gpt-4o-mini',
                },
            }
            : {
                llm_narrative: {
                    headline: null,
                    narrative: null,
                    next_steps: null,
                    risk_factors: null,
                    trend_direction: null,
                    generated: false,
                    model: null,
                },
            };

        // Build cohort history from active + previous cycle for timeline display
        const cohortHistory = [
            cohortCycle.active_cycle
                ? {
                    cycle_id: cohortCycle.active_cycle.cycle_id,
                    opened_at: cohortCycle.active_cycle.opened_at,
                    closed_at: cohortCycle.active_cycle.closed_at,
                    close_reason: cohortCycle.active_cycle.close_reason,
                    elapsed_days: cohortCycle.active_cycle.elapsed_days,
                    outcomes_in_cycle: cohortCycle.active_cycle.outcomes_in_cycle,
                    confidence_source: cohortCycle.active_cycle.opened_confidence_source,
                    is_active: true,
                }
                : null,
            cohortCycle.previous_cycle
                ? {
                    cycle_id: cohortCycle.previous_cycle.cycle_id,
                    opened_at: cohortCycle.previous_cycle.opened_at,
                    closed_at: cohortCycle.previous_cycle.closed_at,
                    close_reason: cohortCycle.previous_cycle.close_reason,
                    elapsed_days: cohortCycle.previous_cycle.elapsed_days,
                    outcomes_in_cycle: cohortCycle.previous_cycle.outcomes_in_cycle,
                    confidence_source: cohortCycle.previous_cycle.opened_confidence_source,
                    is_active: false,
                }
                : null,
        ].filter(Boolean);

        return c.json(
            {
                ...output,
                ...narrativeOverride,
                agent_id: result.agent_id,
                agent_scope: servedScope,
                scope_label: scopeLabel,
                scope_transition: {
                    requested_scope: requestedScope,
                    served_scope: servedScope,
                    fallback_applied: fallbackApplied,
                    reason: scopeReason,
                    threshold_hint: thresholdHint,
                    threshold_bucket: scopeThresholdProgress?.bucket ?? null,
                    current_samples: scopeThresholdProgress?.current_samples ?? null,
                    next_threshold: scopeThresholdProgress?.next_threshold ?? null,
                    remaining_samples_to_next_bucket:
                        scopeThresholdProgress?.remaining_to_next_bucket ?? null,
                    switch_back_rule: requestedScope === 'agent_scoped'
                        ? `Switches back to agent-only automatically at >=${MIN_SAMPLES_STABLE} min samples and >=${Math.round(AGENT_SCOPE_MIN_CONFIDENCE * 100)}% confidence.`
                        : null,
                },
                data_freshness: dataFreshness,
                cohort_cycle: cohortCycle,
                cohort_history: cohortHistory,
                cohort_reliability: cohortReliability,
                customer_id: customerId,
                // Context filter applied to this recommendation — null when no context params provided
                context_filter: contextFilter.resolved
                    ? {
                        context_id: contextFilter.contextId,
                        label: contextFilter.label,
                        issue_type: rawIssueType,
                        environment: rawEnvironment,
                        customer_tier: rawCustomerTier,
                    }
                    : {
                        context_id: null,
                        label: contextFilter.label,
                        issue_type: rawIssueType,
                        environment: rawEnvironment,
                        customer_tier: rawCustomerTier,
                    },
                trust_blocked: isTrustBlocked,
                trust_status: isTrustBlocked ? ((result as any)._trust_status ?? null) : null,
                noise_gate: result._noise_gate ?? null,
                simulation_guardrail: result._simulation_guardrail ?? null,
                confidence_source: confidenceSource,
                confidence_source_reason: confidenceSourceReason,
                traceability,
                policy_gate: {
                    trust_blocked: !!result._trust_gate_blocked,
                    trust_status: result._trust_status ?? null,
                },
                debug_scope: {
                    requested_agent_id: scopedAgentId,
                    requested_task_name: requestedTaskName,
                    effective_task_name: taskName,
                    evidence_task_name: evidenceTaskName,
                    strict_agent_scope: strictAgentScope,
                    evidence_source: scopedEvidenceSource,
                    evidence_action_count: scopedEvidenceActions.length,
                    trust_gate_blocked: !!result._trust_gate_blocked,
                },
                // ISSUE 1: Action registry validation.
                // Tells the developer if the recommended action matches what they have registered.
                // action_mismatch=true means the recommended action name does not exist in
                // their dim_actions registry - they should check their action naming.
                // warning is null when everything matches (do not show it in the dashboard).
                action_registry: {
                    registered_actions: result.registered_actions,
                    action_mismatch: result.action_mismatch,
                    warning: result.action_mismatch && result.best_action
                        ? `Recommended action "${result.best_action.action_name}" is not in your ` +
                        `registered actions. Check your action names match between log_outcome calls ` +
                        `and your registered dim_actions.`
                        : null,
                },
                // Present only when agent_id is scoped. Shows the split between
                // uploaded historical outcomes and live SDK outcomes for this agent+task,
                // so the developer knows what fraction of confidence comes from each source.
                data_sources: dataSources,
                // Always return task-scoped evidence actions for display,
                // including trust-gated responses where decision state may be blocked.
                all_actions: scopedEvidenceActions.map((a) => ({
                    action_id: a.action_id,
                    action_name: a.action_name,
                    total_count: a.total_count,
                    effective_sample_count: a.effective_sample_count,
                    success_count: a.success_count,
                    success_rate: a.success_rate,
                    resolution_rate: a.resolution_rate,
                    ml_score: a.ml_score ?? null,
                    semantic_cluster_convergence: a.semantic_cluster_convergence ?? null,
                    last_seen_at: a.last_seen_at,
                })).sort((a, b) => b.resolution_rate - a.resolution_rate),
                // Authoritative task outcomes for gating/display on the dashboard.
                task_total_outcomes: scopedTaskOutcomeTotal,
            },
            200
        );
    } catch (err: any) {
        console.error('[get-recommendations] unexpected error:', err.message);
        return c.json(
            {
                error: 'Internal server error',
                code: 'INTERNAL_ERROR',
                details: err.message,
            },
            500
        );
    }
});
