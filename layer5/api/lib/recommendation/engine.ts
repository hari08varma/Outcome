import { supabase } from '../supabase.js';

export const MIN_SAMPLES = 10;
export const MIN_SAMPLES_STABLE = 20;
export const MIN_SAMPLES_HIGH_CONFIDENCE = 50;
export const TRUST_GATE_STATUSES: string[] = ['suspended'];
export const TRUST_GATE_MIN_SCORE = 0.10;

export type RecommendationState =
    | 'no_data'
    | 'early_signal'
    | 'stable';

export interface ActionPerformance {
    action_id: string;
    action_name: string;
    total_count: number;
    success_count: number;
    success_rate: number;
    ml_score: number | null;
    last_seen_at: string;
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
    agent_id: string | null;
    generated_at: string;
}

function rankingScore(a: ActionPerformance): number {
    // Prefer the ML composite score from mv_action_scores —
    // it already applies Bayesian smoothing and multi-factor weighting.
    if (a.ml_score !== null && a.ml_score !== undefined) {
        return a.ml_score;
    }

    // Fallback: apply Laplace (add-1) smoothing to raw success rate.
    // Prevents low-sample actions from dominating on perfect-but-tiny scores.
    // Formula: (successes + 1) / (total + 2)
    // = (rate * n + 1) / (n + 2)
    const n = a.total_count;
    const smoothed = (a.success_rate * n + 1) / (n + 2);
    return smoothed;
}

function confidenceFromSamplesAndLift(
    bestCount: number,
    worstCount: number,
    lift: number,
): number {
    // Harmonic mean penalizes when one arm is under-sampled
    const harmonicSamples =
        (2 * bestCount * worstCount) / (bestCount + worstCount);

    // sampleWeight: how much data do we have? [0, 1]
    const sampleWeight = Math.min(
        1,
        harmonicSamples / MIN_SAMPLES_HIGH_CONFIDENCE
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

async function hasSilentFailureAlert(
    customerId: string,
    taskName: string,
): Promise<boolean> {
    // FIXED: scope alert lookup to the actions involved in this
    // specific task. First find action_ids for this task+customer,
    // then check if any of those actions have a degradation alert.
    // This prevents cross-task alert bleed (BUG 2).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Step 1: Get action_ids for this task scoped to this customer
    const { data: taskRows, error: taskErr } = await supabase
        .from('mv_task_action_performance')
        .select('action_id')
        .eq('customer_id', customerId)
        .eq('task_name', taskName);

    if (taskErr || !taskRows || taskRows.length === 0) return false;

    const actionIds = taskRows.map((r: any) => r.action_id as string);

    // Step 2: Check degradation alerts for those specific actions
    const { count, error } = await supabase
        .from('degradation_alert_events')
        .select('alert_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .in('agent_id', actionIds)
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

    // Suspended / critically low-trust agents must not emit recommendations.
    if (agentId) {
        const trustState = await getAgentTrustStatus(agentId);
        if (trustState) {
            const isBlocked =
                TRUST_GATE_STATUSES.includes(trustState.trust_status) ||
                (trustState.trust_score !== null &&
                    trustState.trust_score < TRUST_GATE_MIN_SCORE);
            if (isBlocked) {
                return {
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
                } as any;
            }
        }
    }

    function makeResult(
        state: RecommendationState,
        actions: ActionPerformance[],
        best: ActionPerformance | null = null,
        worst: ActionPerformance | null = null,
    ): RecommendationResult {
        return {
            task: taskName,
            state,
            best_action: best,
            worst_action: worst,
            confidence: null,
            improvement: null,
            min_sample_count: (best && worst)
                ? Math.min(best.total_count, worst.total_count)
                : (best?.total_count ?? 0),
            all_actions: actions,
            agent_id: agentId ?? null,
            generated_at: generatedAt,
        };
    }

    try {
        // Build query — scope to agent when provided, else customer-wide
        let query = supabase
            .from('mv_task_action_performance')
            .select(
                'action_id, action_name, total_count, success_count, ' +
                'success_rate, ml_score, last_seen_at'
            )
            .eq('customer_id', customerId)
            .eq('task_name', taskName);

        if (agentId) {
            // Agent-scoped: only show outcomes for this specific agent
            query = query.eq('agent_id', agentId);
        } else {
            // Customer-blended (All Agents): exclude zero-UUID sentinel rows
            // (outcomes logged without an agent_id — stored as 00000000-... by migration 076)
            query = query.neq('agent_id', '00000000-0000-0000-0000-000000000000');
        }

        const { data, error } = await query;

        if (error) {
            console.error(
                '[engine] DB error fetching task actions:',
                error.message
            );
            return makeResult('no_data', []);
        }

        const rows = (data ?? []) as unknown as Record<string, unknown>[];
        const actions: ActionPerformance[] = rows.map((row) => {
            const mlScoreRaw = row['ml_score'];
            return {
                action_id: String(row['action_id']),
                action_name: String(row['action_name']),
                total_count: Number(row['total_count']),
                success_count: Number(row['success_count']),
                success_rate: Number(row['success_rate']),
                ml_score: mlScoreRaw !== null
                    && mlScoreRaw !== undefined
                    && mlScoreRaw !== 'null'
                    ? Number(mlScoreRaw)
                    : null,
                last_seen_at: String(row['last_seen_at'] ?? ''),
            };
        });

        if (actions.length < 2) {
            return makeResult('no_data', actions);
        }

        // QUALIFIED PAIR FIX: only compare actions with sufficient sample size.
        // Prevents a 2-outcome action from silencing a 62-outcome clear winner.
        const qualifiedActions = actions.filter((a) => a.total_count >= MIN_SAMPLES);

        if (qualifiedActions.length < 2) {
            const leader = [...actions].sort(
                (a, b) => rankingScore(b) - rankingScore(a)
            )[0] ?? null;

            const unqualifiedCount = actions.length - qualifiedActions.length;
            const needMore = actions
                .filter((a) => a.total_count < MIN_SAMPLES)
                .map((a) => ({
                    action_name: a.action_name,
                    current: a.total_count,
                    needed: MIN_SAMPLES - a.total_count,
                }));

            return {
                task: taskName,
                state: 'no_data',
                best_action: qualifiedActions[0] ?? null,
                worst_action: null,
                confidence: null,
                improvement: null,
                min_sample_count: leader?.total_count ?? 0,
                all_actions: actions,
                _qualification_context: {
                    qualified_count: qualifiedActions.length,
                    unqualified_count: unqualifiedCount,
                    leading_action: leader
                        ? {
                            name: leader.action_name,
                            total: leader.total_count,
                            rate: leader.success_rate,
                        }
                        : null,
                    actions_needing_more: needMore,
                },
                _silent_failure_warning: false,
                generated_at: generatedAt,
                agent_id: agentId ?? null,
            };
        }

        const sorted = [...qualifiedActions].sort(
            (a, b) => rankingScore(b) - rankingScore(a)
        );
        const best = sorted[0]!;
        const worst = sorted[sorted.length - 1]!;
        const silentFailureActive = await hasSilentFailureAlert(
            customerId,
            taskName,
        );

        const minSamples = Math.min(best.total_count, worst.total_count);

        if (minSamples < MIN_SAMPLES) {
            return {
                ...makeResult('no_data', actions, best, worst),
                _silent_failure_warning: false,
            };
        }

        if (minSamples < MIN_SAMPLES_STABLE) {
            const rawConfidence = confidenceFromSamplesAndLift(
                best.total_count,
                worst.total_count,
                best.success_rate - worst.success_rate,
            );
            return {
                ...makeResult('early_signal', actions, best, worst),
                confidence: rawConfidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
            };
        }

        const absoluteDelta = best.success_rate - worst.success_rate;
        if (absoluteDelta < 0.08) {
            // Near-equal actions: confidence represents "how sure are we
            // that they're truly similar?" — based on sample size only.
            // We use a fixed lift of 0.08 (the threshold itself) as the
            // signal floor, so confidence is driven by sample adequacy.
            const closeConfidence = confidenceFromSamplesAndLift(
                best.total_count,
                worst.total_count,
                0.08,   // ← use threshold as floor lift, not the tiny actual delta
            );
            return {
                ...makeResult('early_signal', actions, best, worst),
                confidence: closeConfidence,
                min_sample_count: minSamples,
                _silent_failure_warning: false,
            };
        }

        const relativeDelta = worst.success_rate > 0
            ? absoluteDelta / worst.success_rate
            : 1.0;

        if (relativeDelta < 0.15) {
            const closeConfidence2 = confidenceFromSamplesAndLift(
                best.total_count,
                worst.total_count,
                Math.max(absoluteDelta, 0.08),  // ← floor at 0.08, not raw tiny delta
            );
            return {
                ...makeResult('early_signal', actions, best, worst),
                confidence: closeConfidence2,
                min_sample_count: minSamples,
                _silent_failure_warning: false,
            };
        }

        const rawConfidence = confidenceFromSamplesAndLift(
            best.total_count,
            worst.total_count,
            best.success_rate - worst.success_rate,
        );

        // Guardrail: avoid presenting low-confidence outputs as stable decisions.
        if (rawConfidence < 0.2) {
            return {
                ...makeResult('early_signal', actions, best, worst),
                confidence: rawConfidence,
                min_sample_count: minSamples,
                _silent_failure_warning: silentFailureActive,
            };
        }

        return {
            task: taskName,
            state: 'stable',
            best_action: best,
            worst_action: worst,
            confidence: rawConfidence,
            improvement: {
                baseline_rate: Number(worst.success_rate.toFixed(4)),
                improved_rate: Number(best.success_rate.toFixed(4)),
                absolute_delta: Number(absoluteDelta.toFixed(4)),
                relative_delta: Number(relativeDelta.toFixed(4)),
            },
            min_sample_count: minSamples,
            all_actions: actions,
            _silent_failure_warning: silentFailureActive,
            agent_id: agentId ?? null,
            generated_at: generatedAt,
        };
    } catch (err: any) {
        console.error('[engine] unexpected error:', err.message);
        return makeResult('no_data', []);
    }
}
