import { supabase } from '../supabase.js';

export const MIN_SAMPLES = 10;
export const MIN_SAMPLES_STABLE = 20;
export const MIN_SAMPLES_HIGH_CONFIDENCE = 50;

export type RecommendationState =
    | 'no_data'
    | 'early_signal'
    | 'close'
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
    agent_id: string | null;
    generated_at: string;
}

function rankingScore(a: ActionPerformance): number {
    return a.ml_score !== null ? a.ml_score : a.success_rate;
}

function confidenceFromSamplesAndLift(
    bestCount: number,
    worstCount: number,
    lift: number,
): number {
    // Use harmonic mean so confidence is penalized when one arm is under-sampled.
    const harmonicSamples = (2 * bestCount * worstCount) / (bestCount + worstCount);
    const sampleWeight = Math.min(1, harmonicSamples / MIN_SAMPLES_HIGH_CONFIDENCE);
    return Math.max(0, Number((sampleWeight * lift).toFixed(4)));
}

export async function getRecommendation(
    customerId: string,
    taskName: string,
    agentId?: string | null,
): Promise<RecommendationResult> {
    const generatedAt = new Date().toISOString();

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
            query = query.eq('agent_id', agentId);
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
                ml_score: mlScoreRaw !== null && mlScoreRaw !== undefined
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
                generated_at: generatedAt,
                agent_id: agentId ?? null,
            };
        }

        const sorted = [...qualifiedActions].sort(
            (a, b) => rankingScore(b) - rankingScore(a)
        );
        const best = sorted[0]!;
        const worst = sorted[sorted.length - 1]!;

        const minSamples = Math.min(best.total_count, worst.total_count);

        if (minSamples < MIN_SAMPLES) {
            return makeResult('no_data', actions, best, worst);
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
            };
        }

        const absoluteDelta = best.success_rate - worst.success_rate;
        if (absoluteDelta < 0.08) {
            return {
                ...makeResult('close', actions, best, worst),
                min_sample_count: minSamples,
            };
        }

        const relativeDelta = worst.success_rate > 0
            ? absoluteDelta / worst.success_rate
            : 1.0;

        if (relativeDelta < 0.15) {
            return {
                ...makeResult('close', actions, best, worst),
                min_sample_count: minSamples,
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
            agent_id: agentId ?? null,
            generated_at: generatedAt,
        };
    } catch (err: any) {
        console.error('[engine] unexpected error:', err.message);
        return makeResult('no_data', []);
    }
}
