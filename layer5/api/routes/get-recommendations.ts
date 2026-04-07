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

export const getRecommendationsRouter = new Hono();

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
        const cohortCycle = await upsertRecommendationCohortCycle({
            customer_id: customerId,
            task_name: taskName,
            observed_at: result.generated_at,
            total_outcomes: totalOutcomes,
            median_confidence: result.confidence,
            median_success_rate: medianSuccessRate,
        });
        const cohortReliability = computeCohortReliability(result, cohortCycle);

        return c.json(
            {
                ...output,
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
