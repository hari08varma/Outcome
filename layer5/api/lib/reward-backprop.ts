import { supabase } from './supabase.js';

export interface BackpropInput {
    episode_id: string;
    final_outcome: number;
    gamma?: number;
}

export interface BackpropResult {
    steps_adjusted: number;
    episode_id: string;
    final_outcome: number;
    mv_refresh_triggered: boolean;
}

export async function backpropagateReward(input: BackpropInput): Promise<BackpropResult> {
    const gamma = input.gamma ?? 0.85;

    try {
        const { data: steps, error } = await supabase
            .from('fact_outcomes')
            .select('outcome_id, backprop_adjusted')
            .eq('session_id', input.episode_id)
            .order('timestamp', { ascending: true });

        if (error || !steps || steps.length === 0) {
            return {
                steps_adjusted: 0,
                episode_id: input.episode_id,
                final_outcome: input.final_outcome,
                mv_refresh_triggered: false,
            };
        }

        let stepsAdjusted = 0;
        const totalSteps = steps.length;

        for (let i = 0; i < totalSteps; i++) {
            const step = steps[i];

            if (step.backprop_adjusted === true) {
                continue;  // idempotent
            }

            // For Temporal Difference decay:
            // Calculate penalty distance for preceding steps in identical episode grouping.
            // Notice: final_outcome * Math.pow(...) calculates exponential score damping.
            // Failures (0.0) evaluate to 0.0 synchronously masking earlier steps identically.
            // Success (1.0) evaluations map strictly to geometric curve.
            const adjusted = input.final_outcome * Math.pow(gamma, totalSteps - 1 - i);
            const roundedAdjusted = Math.round(adjusted * 10000) / 10000;

            const { data } = await supabase
                .from('fact_outcomes')
                .update({
                    outcome_score: roundedAdjusted,
                    backprop_adjusted: true,
                    backprop_episode_id: input.episode_id
                })
                .eq('outcome_id', step.outcome_id)
                .select();

            if (data && data.length > 0) {
                stepsAdjusted++;
            }
        }

        let mvRefreshTriggered = false;
        if (stepsAdjusted > 0) {
            try {
                const { error: refreshErr } = await supabase
                    .rpc('refresh_task_action_performance');
                if (refreshErr) {
                    console.warn(
                        '[backprop] MV refresh failed after backprop:',
                        refreshErr.message,
                        `episode_id=${input.episode_id}`
                    );
                } else {
                    mvRefreshTriggered = true;
                    console.info(
                        '[backprop] MV refresh triggered after backprop',
                        { episode_id: input.episode_id, steps_adjusted: stepsAdjusted }
                    );
                }
            } catch (refreshErr: any) {
                console.warn('[backprop] MV refresh threw:', refreshErr.message);
            }
        }

        return {
            steps_adjusted: stepsAdjusted,
            episode_id: input.episode_id,
            final_outcome: input.final_outcome,
            mv_refresh_triggered: mvRefreshTriggered,
        };

    } catch (err) {
        console.error('[BackpropReward] Exception:', err);
        return {
            steps_adjusted: 0,
            episode_id: input.episode_id,
            final_outcome: input.final_outcome,
            mv_refresh_triggered: false,
        };
    }
}
