import { Hono } from 'hono';
import {
    MIN_SAMPLES_STABLE,
    type RecommendationResult,
    getRecommendation,
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
        const { data } = await supabase
            .from('fact_outcomes')
            .select('ingestion_source, data_quality')
            .eq('customer_id', customerId)
            .eq('agent_id', agentId)
            .eq('task_name', taskName)
            .eq('is_synthetic', false)
            .eq('is_deleted', false);

        if (!data || data.length === 0) {
            return { uploaded_outcomes: 0, sdk_outcomes: 0, total: 0, upload_share: 0, quality_score: null };
        }

        let uploaded = 0;
        let sdk = 0;
        let qualitySum = 0;
        let qualityCount = 0;

        for (const row of data) {
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

// GET /agent-summary — per-agent stats + per-task outcome counts
// Task counts come from mv_task_action_performance_180d (same source as the engine).
// Falls back to fact_outcomes if MV is unavailable.
getRecommendationsRouter.get('/agent-summary', async (c) => {
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

        const [agentResult, trustResult] = await Promise.all([
            agentQuery,
            agentId
                ? supabase
                    .from('agent_trust_scores')
                    .select('agent_id, trust_score, trust_status')
                    .eq('agent_id', agentId)
                    .single()
                : Promise.resolve({ data: null, error: null }),
        ]);

        const agentMeta = agentResult.data ?? [];
        const trustMeta = trustResult.data as {
            agent_id: string; trust_score: number; trust_status: string;
        } | null;

        // 2. Task+outcome counts from MV — same source the engine uses.
        //    Sum total_count per (agent_id, task_name) across all action rows.
        let mvQuery = supabase
            .from('mv_task_action_performance_180d')
            .select('agent_id, task_name, total_count')
            .eq('customer_id', customerId)
            .neq('agent_id', '00000000-0000-0000-0000-000000000000');
        if (agentId) mvQuery = mvQuery.eq('agent_id', agentId);

        const { data: mvRows, error: mvError } = await mvQuery;

        // Aggregate: sum total_count per agent+task from MV rows
        type TaskTotals = Map<string, number>; // task_name -> total
        const agentTaskTotals = new Map<string, TaskTotals>();
        const agentGrandTotals = new Map<string, number>();

        const useFallback = !!mvError;

        if (!mvError && mvRows) {
            for (const row of mvRows as Array<{ agent_id: string; task_name: string; total_count: number }>) {
                if (!row.agent_id || !row.task_name) continue;
                const count = Math.max(0, Number(row.total_count ?? 0));

                let taskMap = agentTaskTotals.get(row.agent_id);
                if (!taskMap) { taskMap = new Map(); agentTaskTotals.set(row.agent_id, taskMap); }
                taskMap.set(row.task_name, (taskMap.get(row.task_name) ?? 0) + count);

                agentGrandTotals.set(row.agent_id, (agentGrandTotals.get(row.agent_id) ?? 0) + count);
            }
        }

        // Fallback: count from fact_outcomes when MV unavailable
        if (useFallback) {
            console.warn('[agent-summary] MV unavailable, falling back to fact_outcomes:', mvError?.message);
            let foQuery = supabase
                .from('fact_outcomes')
                .select('agent_id, task_name')
                .eq('customer_id', customerId)
                .eq('is_synthetic', false)
                .eq('is_deleted', false)
                .neq('agent_id', '00000000-0000-0000-0000-000000000000');
            if (agentId) foQuery = foQuery.eq('agent_id', agentId);

            const { data: foRows } = await foQuery;
            for (const row of (foRows ?? []) as Array<{ agent_id: string; task_name: string }>) {
                if (!row.agent_id || !row.task_name) continue;
                let taskMap = agentTaskTotals.get(row.agent_id);
                if (!taskMap) { taskMap = new Map(); agentTaskTotals.set(row.agent_id, taskMap); }
                taskMap.set(row.task_name, (taskMap.get(row.task_name) ?? 0) + 1);
                agentGrandTotals.set(row.agent_id, (agentGrandTotals.get(row.agent_id) ?? 0) + 1);
            }
        }

        if (agentId) {
            const meta = agentMeta.find((a: any) => a.agent_id === agentId);
            const taskMap = agentTaskTotals.get(agentId) ?? new Map();
            const grandTotal = agentGrandTotals.get(agentId) ?? 0;

            const tasks = Array.from(taskMap.entries())
                .map(([task_name, total]) => ({ task_name, total }))
                .sort((a, b) => b.total - a.total);

            return c.json({
                agent_id: agentId,
                agent_name: (meta as any)?.agent_name ?? agentId,
                agent_type: (meta as any)?.agent_type ?? null,
                llm_model: (meta as any)?.llm_model ?? null,
                trust_score: trustMeta?.trust_score ?? null,
                trust_status: trustMeta?.trust_status ?? null,
                total_outcomes: grandTotal,
                tasks,
            }, 200);
        } else {
            const agents = (agentMeta as any[]).map((a) => ({
                agent_id: a.agent_id,
                agent_name: a.agent_name,
                agent_type: a.agent_type ?? null,
                llm_model: a.llm_model ?? null,
                total_outcomes: agentGrandTotals.get(a.agent_id) ?? 0,
            })).sort((a, b) => b.total_outcomes - a.total_outcomes);

            return c.json({ agents }, 200);
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

    const taskName = rawTask.trim()
        .toLowerCase()
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/^_+|_+$/g, '')
        || rawTask.trim().toLowerCase();

    if (taskName.length === 0) {
        return c.json(
            {
                error: 'Invalid task parameter - could not normalize to a valid slug',
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

        if (scopedAgentId) {
            const [scopedResult, blendedResult] = await Promise.all([
                getRecommendation(customerId, taskName, scopedAgentId),
                getRecommendation(customerId, taskName, null),
            ]);

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
            result = await getRecommendation(customerId, taskName, null);
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
        const [cohortCycle, dataSources] = await Promise.all([
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
                    generated: true,
                },
            }
            : { llm_narrative: { headline: null, generated: false } };

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
                // All action-level performance data — used by Action Battle card in dashboard.
                // Deduplicated by action_name: the MV has one row per (agent_id, action_id, task_name),
                // so the same action can appear multiple times when blending across agents.
                // We merge them here: sum total_count, weighted-average resolution_rate.
                all_actions: (() => {
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
                            // keep latest last_seen_at
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
                            resolution_rate: a.total_count > 0
                                ? Number((a.resolution_rate_weighted_sum / a.total_count).toFixed(4))
                                : 0,
                            last_seen_at: a.last_seen_at,
                        }))
                        .sort((a, b) => b.resolution_rate - a.resolution_rate);
                })(),
                // Total outcomes for this task (sum of deduplicated all_actions total_count).
                // This is the authoritative count that matches what the recommendation engine used.
                task_total_outcomes: result.all_actions.reduce(
                    (sum, a) => sum + Math.max(0, Number(a.total_count ?? 0)), 0,
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
