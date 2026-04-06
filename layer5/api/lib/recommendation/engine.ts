import { supabase } from '../supabase.js';
import {
    MIN_SAMPLES,
    MIN_SAMPLES_HIGH_CONFIDENCE,
    MIN_SAMPLES_STABLE,
} from './constants.js';
import { getRecommendationRolloutConfig } from './rollout-flags.js';
import { fetchTaskActionPerformance } from './task-performance.js';

export {
    MIN_SAMPLES,
    MIN_SAMPLES_STABLE,
    MIN_SAMPLES_HIGH_CONFIDENCE,
} from './constants.js';
export const TRUST_GATE_STATUSES: string[] = ['suspended'];
export const TRUST_GATE_MIN_SCORE = 0.10;
export const RECOMMENDATION_WINDOW_DAYS = 180;

export type RecommendationState =
    | 'no_data'
    | 'early_signal'
    | 'stable';

export interface ActionPerformance {
    action_id: string;
    action_name: string;
    total_count: number;
    effective_sample_count: number;
    success_count: number;
    success_rate: number;
    resolution_rate: number;
    ml_score: number | null;
    last_seen_at: string | null;
    shadow_signal?: number | null;
    shadow_weight?: number;
}

export interface RecommendationNoiseGateMeta {
    enabled: boolean;
    is_noisy_task: boolean;
    task_noise_score: number;
    best_action_win_rate: number | null;
    absolute_gap: number | null;
    effective_samples: number;
    required_samples: number;
    stable_samples: number;
    high_confidence_samples: number;
    decision_gate_reason: string | null;
}

export interface RecommendationSimulationGuardrailMeta {
    enabled: boolean;
    shadow_applied: boolean;
    assisted_actions: number;
    top_action_shadow_weight: number;
    confidence_ceiling_applied: boolean;
    exploit_gate_applied: boolean;
    confidence_ceiling: number;
    exploit_gate_min_samples: number;
}

export interface RecommendationResult {
    task: string;
    state: RecommendationState;
    best_action: ActionPerformance | null;
    worst_action: ActionPerformance | null;
    confidence: number | null;
    improvement: {
        baseline_rate: number;
        improved_rate: number;
        absolute_delta: number;
        relative_delta: number;
    } | null;
    min_sample_count: number;
    all_actions: ActionPerformance[];
    _qualification_context?: {
        qualified_count: number;
        unqualified_count: number;
        leading_action: {
            name: string;
            total: number;
            rate: number;
        } | null;
        actions_needing_more: Array<{
            action_name: string;
            current: number;
            needed: number;
        }>;
    };
    _trust_gate_blocked?: boolean;
    _trust_status?: string;
    _silent_failure_warning?: boolean;
    _data_source?: 'mv' | 'fact_fallback' | 'unknown';
    _noise_gate?: RecommendationNoiseGateMeta;
    _simulation_guardrail?: RecommendationSimulationGuardrailMeta;
    agent_id: string | null;
    generated_at: string;
    registered_actions: string[];
    action_mismatch: boolean;
}

const SHADOW_DECISION_CHUNK_SIZE = 50;

interface EvidenceThresholds {
    warmupSamples: number;
    stableSamples: number;
    highConfidenceSamples: number;
    reason: string;
}

interface TaskNoiseAssessment {
    score: number;
    isNoisyTask: boolean;
    bestWinRate: number | null;
    absoluteGap: number | null;
    reasons: string[];
}

interface CounterfactualSignalRow {
    unchosen_action_id: string | null;
    counterfactual_est: number | null;
    ips_weight: number | null;
    created_at: string | null;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function effectiveSampleCount(action: ActionPerformance): number {
    const sampleCount = Number(action.effective_sample_count);
    if (!Number.isFinite(sampleCount)) {
        return Math.max(0, Number(action.total_count ?? 0));
    }
    return Math.max(0, sampleCount);
}

function resolutionRateForRanking(action: ActionPerformance): number {
    const baseRate = clamp01(Number(action.resolution_rate));
    const shadowWeight = Math.max(0, Math.min(1, action.shadow_weight ?? 0));
    const shadowSignal = action.shadow_signal;

    if (shadowSignal === null || shadowSignal === undefined || shadowWeight <= 0) {
        return baseRate;
    }

    return clamp01(baseRate * (1 - shadowWeight) + clamp01(shadowSignal) * shadowWeight);
}

function rankingScore(a: ActionPerformance): number {
    // Primary signal: task-specific outcome quality (resolution semantics).
    // Use Laplace smoothing so tiny sample sets do not dominate.
    const n = effectiveSampleCount(a);
    const taskSignal = (resolutionRateForRanking(a) * n + 1) / (n + 2);

    // Secondary prior: global ML score from mv_action_scores.
    // Keep this as a stabilizer, but prioritize task-specific resolution evidence.
    if (a.ml_score === null || a.ml_score === undefined) {
        return taskSignal;
    }

    const globalSignal = Math.max(0, Math.min(1, a.ml_score));
    const globalWeight = n >= MIN_SAMPLES_STABLE
        ? 0.20
        : n >= MIN_SAMPLES
            ? 0.30
            : 0.40;
    return taskSignal * (1 - globalWeight) + globalSignal * globalWeight;
}

function confidenceFromSamplesAndLift(
    bestCount: number,
    worstCount: number,
    lift: number,
    sampleTarget: number = MIN_SAMPLES_HIGH_CONFIDENCE,
): number {
    // Harmonic mean penalizes when one arm is under-sampled
    const harmonicSamples =
        bestCount > 0 && worstCount > 0
            ? (2 * bestCount * worstCount) / (bestCount + worstCount)
            : 0;

    // sampleWeight: how much data do we have? [0, 1]
    const sampleWeight = Math.min(
        1,
        harmonicSamples / Math.max(1, sampleTarget)
    );

    // liftSignal: how decisive is the gap?
    // Normalized so a 0.30+ delta = full signal (1.0).
    // This is separate from sampleWeight — large delta with few
    // samples should NOT produce high confidence.
    const liftSignal = Math.min(1, Math.max(0, lift / 0.30));

    // Combined: both dimensions must be high for high confidence.
    // Using geometric mean so neither factor dominates alone.
    const combined = Math.sqrt(sampleWeight * liftSignal);

    return Math.max(0, Number(combined.toFixed(4)));
}

function assessTaskNoise(
    best: ActionPerformance | null,
    worst: ActionPerformance | null,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): TaskNoiseAssessment {
    if (!best || !worst) {
        return {
            score: 0,
            isNoisyTask: false,
            bestWinRate: null,
            absoluteGap: null,
            reasons: ['insufficient_actions'],
        };
    }

    const bestRate = clamp01(Number(best.resolution_rate));
    const worstRate = clamp01(Number(worst.resolution_rate));
    const gap = Math.max(0, bestRate - worstRate);

    const center = (rolloutConfig.noiseWinRateLower + rolloutConfig.noiseWinRateUpper) / 2;
    const halfRange = Math.max(
        0.0001,
        (rolloutConfig.noiseWinRateUpper - rolloutConfig.noiseWinRateLower) / 2,
    );
    const distance = Math.abs(bestRate - center);
    const bandScore = 1 - Math.min(1, distance / halfRange);
    const gapScore = 1 - Math.min(1, gap / rolloutConfig.noiseGapMax);
    const score = Number((bandScore * 0.6 + gapScore * 0.4).toFixed(4));

    const inWinBand =
        bestRate >= rolloutConfig.noiseWinRateLower
        && bestRate <= rolloutConfig.noiseWinRateUpper;
    const narrowGap = gap <= rolloutConfig.noiseGapMax;

    const reasons: string[] = [];
    if (inWinBand) reasons.push('best_action_win_rate_in_hard_band');
    if (narrowGap) reasons.push('best_worst_gap_is_narrow');
    if (score >= rolloutConfig.noiseScoreThreshold) reasons.push('noise_score_above_threshold');

    const isNoisyTask = rolloutConfig.noiseAwareGateEnabled
        && score >= rolloutConfig.noiseScoreThreshold
        && (inWinBand || narrowGap);

    return {
        score,
        isNoisyTask,
        bestWinRate: Number(bestRate.toFixed(4)),
        absoluteGap: Number(gap.toFixed(4)),
        reasons,
    };
}

function resolveEvidenceThresholds(
    noise: TaskNoiseAssessment,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): EvidenceThresholds {
    if (!rolloutConfig.noiseAwareGateEnabled || !noise.isNoisyTask) {
        return {
            warmupSamples: rolloutConfig.normalWarmupSamples,
            stableSamples: rolloutConfig.stableSamples,
            highConfidenceSamples: rolloutConfig.highConfidenceSamples,
            reason: 'normal_task_thresholds',
        };
    }

    return {
        warmupSamples: rolloutConfig.noisyWarmupSamples,
        stableSamples: rolloutConfig.noisyStableSamples,
        highConfidenceSamples: rolloutConfig.noisyHighConfidenceSamples,
        reason: noise.reasons.join('+') || 'noisy_task_thresholds',
    };
}

function computeShadowBlendWeight(
    sampleCount: number,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): number {
    if (sampleCount >= rolloutConfig.simulationShadowBlendUntilSamples) {
        return 0;
    }

    const ratio =
        (rolloutConfig.simulationShadowBlendUntilSamples - sampleCount)
        / rolloutConfig.simulationShadowBlendUntilSamples;
    return Number(
        Math.min(rolloutConfig.simulationShadowBlendCap, ratio * rolloutConfig.simulationShadowBlendCap)
            .toFixed(4),
    );
}

function applyConfidenceCeiling(
    confidence: number,
    action: ActionPerformance,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): { confidence: number; applied: boolean; topShadowWeight: number } {
    const topShadowWeight = Number((action.shadow_weight ?? 0).toFixed(4));

    if (!rolloutConfig.simulationConfidenceCeilingEnabled || topShadowWeight <= 0) {
        return {
            confidence,
            applied: false,
            topShadowWeight,
        };
    }

    const capped = Math.min(confidence, rolloutConfig.simulationConfidenceCeiling);
    return {
        confidence: Number(capped.toFixed(4)),
        applied: capped < confidence,
        topShadowWeight,
    };
}

function shouldApplySimulationExploitGate(
    action: ActionPerformance,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): boolean {
    if (!rolloutConfig.simulationExploitGateEnabled) return false;
    if ((action.shadow_weight ?? 0) <= 0) return false;
    return effectiveSampleCount(action) < rolloutConfig.simulationExploitGateMinSamples;
}

async function fetchCounterfactualShadowSignals(
    actionIds: string[],
    customerId: string,
    agentId: string | null,
    rolloutConfig: ReturnType<typeof getRecommendationRolloutConfig>,
): Promise<Map<string, number>> {
    const uniqueActionIds = [...new Set(actionIds.filter(Boolean))];
    if (uniqueActionIds.length === 0) return new Map<string, number>();

    let decisionsQuery = supabase
        .from('fact_decisions')
        .select('id, dim_agents!inner(customer_id, agent_id)')
        .eq('dim_agents.customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(rolloutConfig.simulationShadowDecisionLookback);

    if (agentId) {
        decisionsQuery = decisionsQuery.eq('agent_id', agentId);
    }

    const { data: decisions, error: decisionError } = await decisionsQuery;
    if (decisionError) {
        console.warn('[recommendation-engine] shadow decision lookup failed:', decisionError.message);
        return new Map<string, number>();
    }

    const decisionIds = (decisions ?? [])
        .map((decision: any) => decision.id)
        .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0);

    if (decisionIds.length === 0) {
        return new Map<string, number>();
    }

    const chunks: string[][] = [];
    for (let idx = 0; idx < decisionIds.length; idx += SHADOW_DECISION_CHUNK_SIZE) {
        chunks.push(decisionIds.slice(idx, idx + SHADOW_DECISION_CHUNK_SIZE));
    }

    const chunkRows = await Promise.all(chunks.map(async (chunk, chunkIndex) => {
        const { data, error } = await supabase
            .from('fact_outcome_counterfactuals')
            .select('unchosen_action_id, counterfactual_est, ips_weight, created_at')
            .in('decision_id', chunk)
            .in('unchosen_action_id', uniqueActionIds)
            .order('created_at', { ascending: false })
            .limit(rolloutConfig.simulationShadowRecentPerAction * uniqueActionIds.length);

        if (error) {
            console.warn(
                '[recommendation-engine] shadow counterfactual lookup failed:',
                error.message,
                '| chunk:',
                chunkIndex,
            );
            return [] as CounterfactualSignalRow[];
        }

        return (data ?? []) as CounterfactualSignalRow[];
    }));

    const dedupedRows = new Map<string, CounterfactualSignalRow>();
    for (const row of chunkRows.flat()) {
        if (!row.unchosen_action_id || !row.created_at) continue;
        const key = `${row.unchosen_action_id}:${row.created_at}`;
        if (!dedupedRows.has(key)) dedupedRows.set(key, row);
    }

    const grouped = new Map<string, CounterfactualSignalRow[]>();
    for (const row of dedupedRows.values()) {
        if (!row.unchosen_action_id) continue;
        const existing = grouped.get(row.unchosen_action_id) ?? [];
        existing.push(row);
        grouped.set(row.unchosen_action_id, existing);
    }

    const signals = new Map<string, number>();
    for (const actionId of uniqueActionIds) {
        const rows = (grouped.get(actionId) ?? [])
            .sort(
                (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
            )
            .slice(0, rolloutConfig.simulationShadowRecentPerAction);

        if (rows.length === 0) continue;

        let weightedTotal = 0;
        let weightTotal = 0;
        let simpleTotal = 0;

        for (const row of rows) {
            const estimate = clamp01(Number(row.counterfactual_est ?? 0));
            const weight = clamp01(Number(row.ips_weight ?? 0));
            simpleTotal += estimate;
            if (weight > 0) {
                weightedTotal += estimate * weight;
                weightTotal += weight;
            }
        }

        const signal = weightTotal > 0
            ? weightedTotal / weightTotal
            : simpleTotal / rows.length;
        signals.set(actionId, Number(clamp01(signal).toFixed(4)));
    }

    return signals;
}

async function getRegisteredActions(customerId: string): Promise<string[]> {
    const { data, error } = await supabase
        .from('dim_actions')
        .select('action_name')
        .eq('customer_id', customerId)
        .eq('is_active', true);
    if (error || !data) return [];
    return data.map((r: any) => String(r.action_name));
}

async function getAgentTrustStatus(
    agentId: string,
): Promise<{ trust_status: string; trust_score: number | null } | null> {
    if (!agentId) return null;
    const { data, error } = await supabase
        .from('agent_trust_scores')
        .select('trust_status, trust_score')
        .eq('agent_id', agentId)
        .maybeSingle();
    if (error || !data) return null;
    return {
        trust_status: String(data.trust_status ?? 'new'),
        trust_score: typeof data.trust_score === 'number'
            ? data.trust_score
            : null,
    };
}

async function hasSilentFailureAlertForActions(
    actionIds: string[],
    customerId: string,
): Promise<boolean> {
    if (actionIds.length === 0) return false;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Check degradation alerts for the qualified actions in this task.
    const { count, error } = await supabase
        .from('degradation_alert_events')
        .select('alert_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .in('action_id', actionIds)
        .in('alert_type', ['degradation', 'success_hallucination'])
        .gte('detected_at', since);

    if (error) return false;
    return (count ?? 0) > 0;
}

export async function getRecommendation(
    customerId: string,
    taskName: string,
    agentId?: string | null,
): Promise<RecommendationResult> {
    const generatedAt = new Date().toISOString();
    const registeredActions = await getRegisteredActions(customerId);
    const rolloutConfig = getRecommendationRolloutConfig();

    const defaultNoiseMeta: RecommendationNoiseGateMeta = {
        enabled: rolloutConfig.noiseAwareGateEnabled,
        is_noisy_task: false,
        task_noise_score: 0,
        best_action_win_rate: null,
        absolute_gap: null,
        effective_samples: 0,
        required_samples: rolloutConfig.normalWarmupSamples,
        stable_samples: rolloutConfig.stableSamples,
        high_confidence_samples: rolloutConfig.highConfidenceSamples,
        decision_gate_reason: null,
    };

    const defaultSimulationMeta: RecommendationSimulationGuardrailMeta = {
        enabled:
            rolloutConfig.simulationShadowEnabled
            || rolloutConfig.simulationConfidenceCeilingEnabled
            || rolloutConfig.simulationExploitGateEnabled,
        shadow_applied: false,
        assisted_actions: 0,
        top_action_shadow_weight: 0,
        confidence_ceiling_applied: false,
        exploit_gate_applied: false,
        confidence_ceiling: rolloutConfig.simulationConfidenceCeiling,
        exploit_gate_min_samples: rolloutConfig.simulationExploitGateMinSamples,
    };

    function withGuardrailMeta(
        result: RecommendationResult,
        noiseMeta: RecommendationNoiseGateMeta = defaultNoiseMeta,
        simulationMeta: RecommendationSimulationGuardrailMeta = defaultSimulationMeta,
    ): RecommendationResult {
        return {
            ...result,
            _noise_gate: noiseMeta,
            _simulation_guardrail: simulationMeta,
        };
    }

    // Suspended / critically low-trust agents must not emit recommendations.
    if (agentId) {
        const trustState = await getAgentTrustStatus(agentId);
        if (trustState) {
            const isBlocked =
                TRUST_GATE_STATUSES.includes(trustState.trust_status) ||
                (trustState.trust_score !== null &&
                    trustState.trust_score < TRUST_GATE_MIN_SCORE);
            if (isBlocked) {
                return withGuardrailMeta({
                    task: taskName,
                    state: 'no_data',
                    best_action: null,
                    worst_action: null,
                    confidence: null,
                    improvement: null,
                    min_sample_count: 0,
                    all_actions: [],
                    agent_id: agentId,
                    generated_at: generatedAt,
                    _trust_gate_blocked: true,
                    _trust_status: trustState.trust_status,
                    _data_source: 'unknown',
                    registered_actions: registeredActions,
                    action_mismatch: false,
                } as any);
            }
        }
    }

    function makeResult(
        state: RecommendationState,
        actions: ActionPerformance[],
        best: ActionPerformance | null = null,
        worst: ActionPerformance | null = null,
        dataSource: RecommendationResult['_data_source'] = 'unknown',
    ): RecommendationResult {
        return {
            task: taskName,
            state,
            best_action: best,
            worst_action: worst,
            confidence: null,
            improvement: null,
            min_sample_count: (best && worst)
                ? Number(Math.min(effectiveSampleCount(best), effectiveSampleCount(worst)).toFixed(4))
                : Number((best ? effectiveSampleCount(best) : 0).toFixed(4)),
            all_actions: actions,
            _data_source: dataSource,
            agent_id: agentId ?? null,
            generated_at: generatedAt,
            registered_actions: registeredActions,
            action_mismatch: false,
        };
    }

    try {
        // NOTE: This filter excludes actions that haven't been seen in 180 days
        // (dormant action suppression). It does NOT window individual outcome counts -
        // mv_task_action_performance aggregates all-time totals, not rolling windows.
        // total_count and success_count reflect the full history of any action that
        // passes this filter. A true rolling window requires a separate MV or
        // a raw fact_outcomes query with a per-row timestamp filter.
        // TODO: Add a windowed MV (mv_task_action_performance_180d) that computes
        // rolling 180-day counts natively in SQL before enabling true windowing here.
        const windowStart = new Date(
            Date.now() - RECOMMENDATION_WINDOW_DAYS * 24 * 60 * 60 * 1000
        ).toISOString();

        const { rows, source } = await fetchTaskActionPerformance({
            customerId,
            taskName,
            agentId: agentId ?? null,
            windowStart,
        });

        const actions: ActionPerformance[] = rows.map((row) => {
            const mlScoreRaw = row.ml_score;
            return {
                action_id: String(row.action_id),
                action_name: String(row.action_name),
                total_count: Number(row.total_count),
                effective_sample_count: Number(row.effective_sample_count ?? row.total_count ?? 0),
                success_count: Number(row.success_count),
                success_rate: Number(row.success_rate),
                resolution_rate: Number(row.resolution_rate ?? row.success_rate ?? 0),
                ml_score: mlScoreRaw !== null
                    && mlScoreRaw !== undefined
                    ? Number(mlScoreRaw)
                    : null,
                last_seen_at: typeof row.last_seen_at === 'string' ? row.last_seen_at : null,
                shadow_signal: null,
                shadow_weight: 0,
            };
        });

        let simulationShadowAppliedCount = 0;
        if (rolloutConfig.simulationShadowEnabled) {
            const shadowSignals = await fetchCounterfactualShadowSignals(
                actions.map((action) => action.action_id),
                customerId,
                agentId ?? null,
                rolloutConfig,
            );

            for (const action of actions) {
                const shadowSignal = shadowSignals.get(action.action_id);
                const shadowWeight = shadowSignal === undefined
                    ? 0
                    : computeShadowBlendWeight(effectiveSampleCount(action), rolloutConfig);

                action.shadow_signal = shadowSignal ?? null;
                action.shadow_weight = shadowWeight;

                if (shadowSignal !== undefined && shadowWeight > 0) {
                    simulationShadowAppliedCount += 1;
                }
            }
        }

        const simulationMetaBase: RecommendationSimulationGuardrailMeta = {
            ...defaultSimulationMeta,
            shadow_applied: simulationShadowAppliedCount > 0,
            assisted_actions: simulationShadowAppliedCount,
        };

        if (actions.length < 2) {
            const solo = actions[0] ?? null;
            const soloHasMinimumEvidence =
                !!solo && effectiveSampleCount(solo) >= rolloutConfig.normalWarmupSamples;

            return withGuardrailMeta({
                ...makeResult(
                    'no_data',
                    actions,
                    null,
                    null,
                    source,
                ),
                min_sample_count: Number((solo ? effectiveSampleCount(solo) : 0).toFixed(4)),
                _qualification_context: {
                    qualified_count: soloHasMinimumEvidence ? 1 : 0,
                    unqualified_count: solo ? (soloHasMinimumEvidence ? 0 : 1) : 0,
                    leading_action: solo
                        ? {
                            name: solo.action_name,
                            total: Number(effectiveSampleCount(solo).toFixed(2)),
                            rate: solo.resolution_rate,
                        }
                        : null,
                    actions_needing_more: solo && !soloHasMinimumEvidence
                        ? [{
                            action_name: solo.action_name,
                            current: Number(effectiveSampleCount(solo).toFixed(2)),
                            needed: Number((rolloutConfig.normalWarmupSamples - effectiveSampleCount(solo)).toFixed(2)),
                        }]
                        : [],
                },
                _silent_failure_warning: false,
                registered_actions: registeredActions,
                action_mismatch: false,
            }, {
                ...defaultNoiseMeta,
                effective_samples: Number((solo ? effectiveSampleCount(solo) : 0).toFixed(4)),
            }, simulationMetaBase);
        }

        // QUALIFIED PAIR FIX: only compare actions with sufficient sample size.
        // Prevents a 2-outcome action from silencing a 62-outcome clear winner.
        const sortedAll = [...actions].sort(
            (a, b) => rankingScore(b) - rankingScore(a)
        );
        const leader = sortedAll[0] ?? null;
        const trailer = sortedAll[sortedAll.length - 1] ?? null;

        const noiseAssessment = assessTaskNoise(leader, trailer, rolloutConfig);
        const evidenceThresholds = resolveEvidenceThresholds(noiseAssessment, rolloutConfig);

        const noiseMetaBase: RecommendationNoiseGateMeta = {
            enabled: rolloutConfig.noiseAwareGateEnabled,
            is_noisy_task: noiseAssessment.isNoisyTask,
            task_noise_score: noiseAssessment.score,
            best_action_win_rate: noiseAssessment.bestWinRate,
            absolute_gap: noiseAssessment.absoluteGap,
            effective_samples: Number((leader ? effectiveSampleCount(leader) : 0).toFixed(4)),
            required_samples: evidenceThresholds.warmupSamples,
            stable_samples: evidenceThresholds.stableSamples,
            high_confidence_samples: evidenceThresholds.highConfidenceSamples,
            decision_gate_reason: evidenceThresholds.reason,
        };

        const qualifiedActions = actions.filter(
            (action) => effectiveSampleCount(action) >= evidenceThresholds.warmupSamples,
        );

        if (qualifiedActions.length < 2) {
            const unqualifiedCount = actions.length - qualifiedActions.length;
            const needMore = actions
                .filter((action) => effectiveSampleCount(action) < evidenceThresholds.warmupSamples)
                .map((a) => ({
                    action_name: a.action_name,
                    current: Number(effectiveSampleCount(a).toFixed(2)),
                    needed: Number((evidenceThresholds.warmupSamples - effectiveSampleCount(a)).toFixed(2)),
                }));

            // Production fallback: emit a conservative early signal once the leading
            // action has enough direct evidence and at least one comparator exists.
            // This avoids an extended "no_data" state for active tasks while still
            // preserving low confidence when comparator samples are sparse.
            const leaderHasMinimumEvidence =
                !!leader && effectiveSampleCount(leader) >= evidenceThresholds.warmupSamples;
            const hasComparator = !!leader && !!trailer && leader.action_id !== trailer.action_id;

            if (leaderHasMinimumEvidence && hasComparator) {
                const best = leader!;
                const worst = trailer!;
                const rawConfidenceUncapped = confidenceFromSamplesAndLift(
                    effectiveSampleCount(best),
                    Math.max(1, effectiveSampleCount(worst)),
                    Math.max(0, best.resolution_rate - worst.resolution_rate),
                    evidenceThresholds.highConfidenceSamples,
                );
                const { confidence: rawConfidence, applied: confidenceCeilingApplied, topShadowWeight } =
                    applyConfidenceCeiling(rawConfidenceUncapped, best, rolloutConfig);
                const minSamples = Number(
                    Math.min(effectiveSampleCount(best), effectiveSampleCount(worst)).toFixed(4),
                );
                const silentFailureActive = await hasSilentFailureAlertForActions(
                    [best.action_id, worst.action_id],
                    customerId,
                );

                const simulationMeta: RecommendationSimulationGuardrailMeta = {
                    ...simulationMetaBase,
                    top_action_shadow_weight: topShadowWeight,
                    confidence_ceiling_applied: confidenceCeilingApplied,
                    exploit_gate_applied: false,
                };

                return withGuardrailMeta({
                    ...makeResult('early_signal', actions, best, worst),
                    confidence: rawConfidence,
                    min_sample_count: minSamples,
                    _qualification_context: {
                        qualified_count: qualifiedActions.length,
                        unqualified_count: unqualifiedCount,
                        leading_action: {
                            name: best.action_name,
                            total: Number(effectiveSampleCount(best).toFixed(2)),
                            rate: best.resolution_rate,
                        },
                        actions_needing_more: needMore,
                    },
                    _silent_failure_warning: silentFailureActive,
                    registered_actions: registeredActions,
                    action_mismatch: registeredActions.length > 0
                        && !registeredActions.includes(best.action_name),
                    _data_source: source,
                }, {
                    ...noiseMetaBase,
                    effective_samples: minSamples,
                }, simulationMeta);
            }

            return withGuardrailMeta({
                task: taskName,
                state: 'no_data',
                best_action: null,
                worst_action: null,
                confidence: null,
                improvement: null,
                min_sample_count: Number((leader ? effectiveSampleCount(leader) : 0).toFixed(4)),
                all_actions: actions,
                _qualification_context: {
                    qualified_count: qualifiedActions.length,
                    unqualified_count: unqualifiedCount,
                    leading_action: leader
                        ? {
                            name: leader.action_name,
                            total: Number(effectiveSampleCount(leader).toFixed(2)),
                            rate: leader.resolution_rate,
                        }
                        : null,
                    actions_needing_more: needMore,
                },
                _silent_failure_warning: false,
                generated_at: generatedAt,
                agent_id: agentId ?? null,
                registered_actions: registeredActions,
                action_mismatch: false,
                _data_source: source,
            }, noiseMetaBase, simulationMetaBase);
        }

        const sorted = [...qualifiedActions].sort(
            (a, b) => rankingScore(b) - rankingScore(a)
        );
        const best = sorted[0]!;
        const worst = sorted[sorted.length - 1]!;
        const qualifiedActionIds = qualifiedActions.map((a) => a.action_id);
        const silentFailureActive = await hasSilentFailureAlertForActions(
            qualifiedActionIds,
            customerId,
        );

        const minSamples = Number(
            Math.min(effectiveSampleCount(best), effectiveSampleCount(worst)).toFixed(4),
        );
        const { confidence: rawConfidenceBase, applied: confidenceCeilingApplied, topShadowWeight } =
            applyConfidenceCeiling(
                confidenceFromSamplesAndLift(
                    effectiveSampleCount(best),
                    effectiveSampleCount(worst),
                    Math.max(0, best.resolution_rate - worst.resolution_rate),
                    evidenceThresholds.highConfidenceSamples,
                ),
                best,
                rolloutConfig,
            );

        const simulationMeta: RecommendationSimulationGuardrailMeta = {
            ...simulationMetaBase,
            top_action_shadow_weight: topShadowWeight,
            confidence_ceiling_applied: confidenceCeilingApplied,
            exploit_gate_applied: false,
        };

        if (minSamples < evidenceThresholds.warmupSamples) {
            return withGuardrailMeta({
                ...makeResult('no_data', actions, best, worst),
                min_sample_count: minSamples,
                _silent_failure_warning: false,
                registered_actions: registeredActions,
                action_mismatch: false,
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
            }, simulationMeta);
        }

        if (minSamples < evidenceThresholds.stableSamples) {
            return withGuardrailMeta({
                ...makeResult('early_signal', actions, best, worst),
                confidence: rawConfidenceBase,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
                registered_actions: registeredActions,
                action_mismatch: registeredActions.length > 0
                    && !registeredActions.includes(best.action_name),
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
            }, simulationMeta);
        }

        const absoluteDelta = best.resolution_rate - worst.resolution_rate;
        if (absoluteDelta < 0.08) {
            // Near-equal actions: confidence represents "how sure are we
            // that they're truly similar?" — based on sample size only.
            // We use a fixed lift of 0.08 (the threshold itself) as the
            // signal floor, so confidence is driven by sample adequacy.
            const closeConfidence = confidenceFromSamplesAndLift(
                effectiveSampleCount(best),
                effectiveSampleCount(worst),
                0.08,   // ← use threshold as floor lift, not the tiny actual delta
                evidenceThresholds.highConfidenceSamples,
            );
            const confidenceCapped = applyConfidenceCeiling(closeConfidence, best, rolloutConfig);
            return withGuardrailMeta({
                ...makeResult('early_signal', actions, best, worst),
                confidence: confidenceCapped.confidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
                registered_actions: registeredActions,
                action_mismatch: registeredActions.length > 0
                    && !registeredActions.includes(best.action_name),
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
            }, {
                ...simulationMeta,
                top_action_shadow_weight: confidenceCapped.topShadowWeight,
                confidence_ceiling_applied: confidenceCapped.applied,
            });
        }

        const relativeDelta = worst.resolution_rate > 0
            ? absoluteDelta / worst.resolution_rate
            : 1.0;

        if (relativeDelta < 0.15) {
            const closeConfidence2 = confidenceFromSamplesAndLift(
                effectiveSampleCount(best),
                effectiveSampleCount(worst),
                Math.max(absoluteDelta, 0.08),  // ← floor at 0.08, not raw tiny delta
                evidenceThresholds.highConfidenceSamples,
            );
            const confidenceCapped = applyConfidenceCeiling(closeConfidence2, best, rolloutConfig);
            return withGuardrailMeta({
                ...makeResult('early_signal', actions, best, worst),
                confidence: confidenceCapped.confidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
                registered_actions: registeredActions,
                action_mismatch: registeredActions.length > 0
                    && !registeredActions.includes(best.action_name),
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
            }, {
                ...simulationMeta,
                top_action_shadow_weight: confidenceCapped.topShadowWeight,
                confidence_ceiling_applied: confidenceCapped.applied,
            });
        }

        const rawConfidence = rawConfidenceBase;

        // Guardrail: avoid presenting low-confidence outputs as stable decisions.
        if (rawConfidence < 0.2) {
            return withGuardrailMeta({
                ...makeResult('early_signal', actions, best, worst),
                confidence: rawConfidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
                registered_actions: registeredActions,
                action_mismatch: registeredActions.length > 0
                    && !registeredActions.includes(best.action_name),
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
            }, simulationMeta);
        }

        if (shouldApplySimulationExploitGate(best, rolloutConfig)) {
            return withGuardrailMeta({
                ...makeResult('early_signal', actions, best, worst),
                confidence: rawConfidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
                registered_actions: registeredActions,
                action_mismatch: registeredActions.length > 0
                    && !registeredActions.includes(best.action_name),
                _data_source: source,
            }, {
                ...noiseMetaBase,
                effective_samples: minSamples,
                decision_gate_reason: `${noiseMetaBase.decision_gate_reason}+simulation_exploit_gate`,
            }, {
                ...simulationMeta,
                exploit_gate_applied: true,
            });
        }

        return withGuardrailMeta({
            task: taskName,
            state: 'stable',
            best_action: best,
            worst_action: worst,
            confidence: rawConfidence,
            improvement: {
                baseline_rate: Number(worst.resolution_rate.toFixed(4)),
                improved_rate: Number(best.resolution_rate.toFixed(4)),
                absolute_delta: Number(absoluteDelta.toFixed(4)),
                relative_delta: Number(relativeDelta.toFixed(4)),
            },
            min_sample_count: minSamples,
            all_actions: actions,
            _silent_failure_warning: silentFailureActive,
            _data_source: source,
            agent_id: agentId ?? null,
            generated_at: generatedAt,
            registered_actions: registeredActions,
            action_mismatch: registeredActions.length > 0
                && !registeredActions.includes(best.action_name),
        }, {
            ...noiseMetaBase,
            effective_samples: minSamples,
        }, simulationMeta);
    } catch (err: any) {
        console.error('[engine] unexpected error:', err.message);
        return withGuardrailMeta(makeResult('no_data', []));
    }
}
