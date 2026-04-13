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
import { fetchAvailableTasks } from '../lib/recommendation/task-performance.js';
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

        let rows: Array<{ ingestion_source: unknown; data_quality: unknown }> = [];

        for (const candidate of candidates) {
            const { data } = await supabase
                .from('fact_outcomes')
                .select('ingestion_source, data_quality')
                .eq('customer_id', customerId)
                .eq('agent_id', agentId)
                .eq('task_name', candidate)
                .eq('is_synthetic', false)
                .eq('is_deleted', false);

            if (data && data.length > 0) {
                rows = data as Array<{ ingestion_source: unknown; data_quality: unknown }>;
                break;
            }
        }

        if (rows.length === 0) {
            return { uploaded_outcomes: 0, sdk_outcomes: 0, total: 0, upload_share: 0, quality_score: null };
        }

        let uploaded = 0;
        let sdk = 0;
        let qualitySum = 0;
        let qualityCount = 0;

        for (const row of rows) {
            if (row.ingestion_source === 'import') uploaded++;
            else sdk++;
            if (typeof row.data_quality === 'number') {
                qualitySum += row.data_quality;
                qualityCount++;
            }
        }

        const total = uploaded + sdk;
        const uploadShare = total > 0 ? Math.round((uploaded / total) * 10000) / 10000 : 0;
        const qualityScore = qualityCount > 0 ? Math.round((qualitySum / qualityCount) * 10000) / 10000 : null;

        return { uploaded_outcomes: uploaded, sdk_outcomes: sdk, total, upload_share: uploadShare, quality_score: qualityScore };
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

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
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

async function getRecommendationWithTaskFallback(
    customerId: string,
    requestedTaskName: string,
    agentId: string | null,
): Promise<{ taskName: string; result: RecommendationResult }> {
    const primaryTaskName = requestedTaskName.trim();
    const normalizedTaskName = normalizeTaskSlug(primaryTaskName);

    const primaryResult = await getRecommendation(customerId, primaryTaskName, agentId);

    if (
        normalizedTaskName.length === 0
        || normalizedTaskName === primaryTaskName
        || hasRecommendationEvidence(primaryResult)
        || primaryResult.state !== 'no_data'
    ) {
        return { taskName: primaryTaskName, result: primaryResult };
    }

    const normalizedResult = await getRecommendation(customerId, normalizedTaskName, agentId);
    if (hasRecommendationEvidence(normalizedResult) || normalizedResult.state !== 'no_data') {
        return { taskName: normalizedTaskName, result: normalizedResult };
    }

    return { taskName: primaryTaskName, result: primaryResult };
}

function addOutcomeCount(
    agentTaskTotals: Map<string, Map<string, number>>,
    agentGrandTotals: Map<string, number>,
    agentId: string,
    taskName: string,
    increment: number,
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
}

async function fetchAgentTaskOutcomeTotals(params: {
    customerId: string;
    agentId: string | null;
}): Promise<{
    agentTaskTotals: Map<string, Map<string, number>>;
    agentGrandTotals: Map<string, number>;
    source: 'fact_outcomes';
}> {
    const { customerId, agentId } = params;
    const agentTaskTotals = new Map<string, Map<string, number>>();
    const agentGrandTotals = new Map<string, number>();

    for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
        let factsQuery = supabase
            .from('fact_outcomes')
            .select('agent_id, task_name')
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

        const page = (data ?? []) as Array<{ agent_id: string | null; task_name: string | null }>;
        for (const row of page) {
            addOutcomeCount(
                agentTaskTotals,
                agentGrandTotals,
                row.agent_id ?? '',
                row.task_name ?? '',
                1,
            );
        }

        if (page.length < SUPABASE_PAGE_SIZE) {
            break;
        }
    }

    return { agentTaskTotals, agentGrandTotals, source: 'fact_outcomes' };
}

type AgentTaskActionRow = {
    action_id: string | null;
    outcome_score: number | null;
    outcome_score_raw: number | null;
    success: boolean | null;
    execution_status: string | null;
    timestamp: string | null;
    dim_actions: { action_name: string | null } | Array<{ action_name: string | null }> | null;
};

type AgentTaskActionAggregate = {
    action_id: string;
    action_name: string;
    total_count: number;
    score_sum: number;
    score_count: number;
    last_seen_at: string | null;
};

function latestTimestamp(current: string | null, candidate: string | null): string | null {
    if (!current) return candidate;
    if (!candidate) return current;
    return candidate > current ? candidate : current;
}

function deriveResolutionScore(row: AgentTaskActionRow): number | null {
    if (typeof row.outcome_score === 'number' && Number.isFinite(row.outcome_score)) {
        return clamp01(row.outcome_score);
    }

    if (typeof row.outcome_score_raw === 'number' && Number.isFinite(row.outcome_score_raw)) {
        return clamp01(row.outcome_score_raw);
    }

    const status = typeof row.execution_status === 'string'
        ? row.execution_status.trim().toLowerCase()
        : '';

    if (status === 'completed' || status === 'success' || status === 'succeeded') {
        return 1;
    }
    if (status === 'partial' || status === 'degraded') {
        return 0.5;
    }
    if (status === 'failed' || status === 'error') {
        return 0;
    }

    if (typeof row.success === 'boolean') {
        return row.success ? 1 : 0;
    }

    return null;
}

async function fetchAgentTaskActionPerformance(params: {
    customerId: string;
    agentId: string;
    taskName: string;
}): Promise<{
    actions: Array<{
        action_id: string;
        action_name: string;
        total_count: number;
        effective_sample_count: number;
        resolution_rate: number;
        last_seen_at: string | null;
    }>;
    total_outcomes: number;
}> {
    const queryForTask = async (taskName: string): Promise<{
        actions: Array<{
            action_id: string;
            action_name: string;
            total_count: number;
            effective_sample_count: number;
            resolution_rate: number;
            last_seen_at: string | null;
        }>;
        total_outcomes: number;
    }> => {
        const aggregates = new Map<string, AgentTaskActionAggregate>();

        for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
            const query = supabase
                .from('fact_outcomes')
                .select('action_id, outcome_score, outcome_score_raw, success, execution_status, timestamp, dim_actions!inner(action_name)')
                .eq('customer_id', params.customerId)
                .eq('agent_id', params.agentId)
                .eq('task_name', taskName)
                .eq('is_synthetic', false)
                .eq('is_deleted', false)
                .range(offset, offset + SUPABASE_PAGE_SIZE - 1);

            const { data, error } = await query;
            if (error) {
                throw new Error(`[get-recommendations] action performance query failed: ${error.message}`);
            }

            const page = (data ?? []) as AgentTaskActionRow[];

            for (const row of page) {
                const actionId = row.action_id ?? '';
                if (!actionId) continue;

                const relation = Array.isArray(row.dim_actions)
                    ? row.dim_actions[0]
                    : row.dim_actions;
                const actionName = relation?.action_name ?? actionId;

                const existing = aggregates.get(actionName) ?? {
                    action_id: actionId,
                    action_name: actionName,
                    total_count: 0,
                    score_sum: 0,
                    score_count: 0,
                    last_seen_at: null,
                };

                existing.total_count += 1;

                const score = deriveResolutionScore(row);
                if (score !== null) {
                    existing.score_sum += score;
                    existing.score_count += 1;
                }

                existing.last_seen_at = latestTimestamp(existing.last_seen_at, row.timestamp ?? null);

                aggregates.set(actionName, existing);
            }

            if (page.length < SUPABASE_PAGE_SIZE) {
                break;
            }
        }

        const actions = Array.from(aggregates.values())
            .map((entry) => ({
                action_id: entry.action_id,
                action_name: entry.action_name,
                total_count: entry.total_count,
                effective_sample_count: entry.total_count,
                resolution_rate: entry.score_count > 0
                    ? Number((entry.score_sum / entry.score_count).toFixed(4))
                    : 0,
                last_seen_at: entry.last_seen_at,
            }))
            .sort((a, b) => {
                if (b.total_count !== a.total_count) return b.total_count - a.total_count;
                return b.resolution_rate - a.resolution_rate;
            });

        const totalOutcomes = actions.reduce((sum, action) => sum + action.total_count, 0);

        return { actions, total_outcomes: totalOutcomes };
    };

    const exactResult = await queryForTask(params.taskName);
    if (exactResult.total_outcomes > 0) {
        return exactResult;
    }

    const normalizedTask = normalizeTaskSlug(params.taskName);
    if (!normalizedTask || normalizedTask === params.taskName) {
        return exactResult;
    }

    return queryForTask(normalizedTask);
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

        const { agentTaskTotals, agentGrandTotals, source } = outcomeTotals;

        if (agentId) {
            const meta = (agentMeta as any[]).find((a) => a.agent_id === agentId);
            const taskMap = agentTaskTotals.get(agentId) ?? new Map();
            const grandTotal = agentGrandTotals.get(agentId) ?? 0;

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
        // Always track the agent-scoped result when an agent_id is provided —
        // used to compute task_total_outcomes so it matches the task list count.
        let agentScopedResult: RecommendationResult | null = null;

        if (scopedAgentId) {
            const scopedResolution = await getRecommendationWithTaskFallback(
                customerId,
                requestedTaskName,
                scopedAgentId,
            );
            taskName = scopedResolution.taskName;

            const scopedResult = scopedResolution.result;
            const blendedResult = await getRecommendation(customerId, taskName, null);
            agentScopedResult = scopedResult;

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

        const totalOutcomes = result.all_actions.reduce(
            (sum, action) => sum + Math.max(0, Number(action.total_count ?? 0)),
            0,
        );
        const medianSuccessRate = medianOf(
            result.all_actions.map((action) => Number(action.resolution_rate ?? Number.NaN)),
        );
        const [cohortCycle, dataSources, agentTaskPerformance] = await Promise.all([
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
            scopedAgentId
                ? fetchDataSources(customerId, scopedAgentId, taskName)
                : Promise.resolve(null),
            scopedAgentId
                ? fetchAgentTaskActionPerformance({
                    customerId,
                    agentId: scopedAgentId,
                    taskName,
                })
                : Promise.resolve(null),
        ]);
        const cohortReliability = computeCohortReliability(result, cohortCycle);

        // LLM narrative — non-blocking, falls back to static text on failure
        const narrative = await generateNarrative(output, {
            reliability_band: cohortReliability.band,
            reliability_reasons: cohortReliability.reasons,
            silent_failure_warning: !!(result as any)._silent_failure_warning,
            data_freshness_stale: dataFreshness.is_stale,
            data_freshness_age_hours: dataFreshness.age_hours,
            scope: servedScope,
            scope_fallback_applied: fallbackApplied,
            confidence_source: confidenceSource,
            confidence_source_reason: confidenceSourceReason,
        });

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
                noise_gate: result._noise_gate ?? null,
                simulation_guardrail: result._simulation_guardrail ?? null,
                confidence_source: confidenceSource,
                confidence_source_reason: confidenceSourceReason,
                traceability,
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
                // Always use agent-scoped fact_outcomes rows for action and outcome display
                // when an agent_id is provided, so the UI reflects exactly what this agent logged.
                all_actions: agentTaskPerformance?.actions ?? (() => {
                    const byName = new Map<string, {
                        action_id: string;
                        action_name: string;
                        total_count: number;
                        resolution_rate_weighted_sum: number;
                        last_seen_at: string | null;
                    }>();
                    for (const a of result.all_actions) {
                        const name = a.action_name;
                        const existing = byName.get(name);
                        if (!existing) {
                            byName.set(name, {
                                action_id: a.action_id,
                                action_name: name,
                                total_count: Math.max(0, Number(a.total_count ?? 0)),
                                resolution_rate_weighted_sum: Number(a.resolution_rate ?? 0) * Math.max(0, Number(a.total_count ?? 0)),
                                last_seen_at: a.last_seen_at ?? null,
                            });
                        } else {
                            const count = Math.max(0, Number(a.total_count ?? 0));
                            existing.total_count += count;
                            existing.resolution_rate_weighted_sum += Number(a.resolution_rate ?? 0) * count;
                            if (a.last_seen_at && (!existing.last_seen_at || a.last_seen_at > existing.last_seen_at)) {
                                existing.last_seen_at = a.last_seen_at;
                            }
                        }
                    }
                    return Array.from(byName.values())
                        .map((a) => ({
                            action_id: a.action_id,
                            action_name: a.action_name,
                            total_count: a.total_count,
                            effective_sample_count: a.total_count,
                            resolution_rate: a.total_count > 0
                                ? Number((a.resolution_rate_weighted_sum / a.total_count).toFixed(4))
                                : 0,
                            last_seen_at: a.last_seen_at,
                        }))
                        .sort((a, b) => b.total_count - a.total_count);
                })(),
                // Authoritative task outcomes for gating/display on the dashboard.
                task_total_outcomes: agentTaskPerformance?.total_outcomes
                    ?? (agentScopedResult ?? result).all_actions.reduce(
                        (sum, a) => sum + Math.max(0, Number(a.total_count ?? 0)),
                        0,
                    ),
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
