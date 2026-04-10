/**
 * Layerinfinite — lib/ips-engine.ts
 * ══════════════════════════════════════════════════════════════
 * Computes IPS (Inverse Propensity Scoring) estimates
 * for unchosen actions and writes them to
 * fact_outcome_counterfactuals.
 *
 * Called from log-outcome.ts after every outcome is logged.
 * Runs asynchronously — never blocks the log-outcome response.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

const TEMPERATURE = 1.0;        // softmax temperature
// IPS_WEIGHT_MIN: matches the filter threshold in writeCounterfactuals.
// Weights at or below this value are filtered before DB insert.
// Setting the clamp floor here is redundant with the filter,
// but makes the intent explicit at the computation level.
const IPS_WEIGHT_MIN = 0.001;   // min IPS weight
export const IPS_WEIGHT_CAP = 0.3;     // max IPS weight (intentional conservative cap)
const MIN_PROPENSITY = 0.001;   // floor to prevent division by zero

export interface RankedActionEntry {
    action_name: string;
    action_id: string;
    score: number;
    rank: number;
    propensity: number;
}

export interface IPSInput {
    decisionId: string;
    realOutcomeId: string;
    realOutcomeScore: number;   // 0.0–1.0
    chosenActionName: string;
    rankedActions: RankedActionEntry[];
    contextHash: string;
    episodePosition: number;
}

/**
 * Compute softmax propensities from raw scores.
 * Uses temperature scaling to control exploration.
 * Returns propensities that sum to 1.0.
 */
export function computePropensities(
    rankedActions: Array<{ action_name: string; score: number }>,
    temperature: number = TEMPERATURE
): Map<string, number> {
    const scores = rankedActions.map(a => a.score / temperature);
    const maxScore = Math.max(...scores);  // numerical stability

    const expScores = scores.map(s => Math.exp(s - maxScore));
    const sumExp = expScores.reduce((a, b) => a + b, 0);

    const propensityMap = new Map<string, number>();
    rankedActions.forEach((action, i) => {
        propensityMap.set(
            action.action_name,
            Math.max(expScores[i]! / sumExp, MIN_PROPENSITY)
        );
    });

    // Re-normalize after MIN_PROPENSITY floors to restore sum-to-1.
    // Floor application can shift the total above 1.0 for skewed distributions.
    const total = Array.from(propensityMap.values()).reduce((a, b) => a + b, 0);
    if (total > 0) {
        for (const [key, val] of propensityMap.entries()) {
            propensityMap.set(key, val / total);
        }
    }

    return propensityMap;
}

/**
 * Compute IPS estimate for one unchosen action.
 *
 * Formula:
 *   ratio    = p_unchosen / p_chosen
 *   estimate = clip(real_outcome * ratio, 0, real_outcome)
 *   weight   = clip(p_unchosen * (1 - |estimate - real_outcome|),
 *                   IPS_WEIGHT_MIN, IPS_WEIGHT_CAP)
 *
 * Weight cap of 0.3 is intentional and conservative. This bounds
 * the variance contribution of any single counterfactual in the
 * Python DR training pipeline. The Python trainer must be aware
 * of this cap when computing DR corrections.
 * NOTE: The cap means weights never reach 1.0 — the DR formula
 * reward_hat + w*(observed - reward_hat) is proportionally dampened.
 */
export function computeIPSEstimate(
    realOutcome: number,
    propensityChosen: number,
    propensityUnchosen: number
): { estimate: number; weight: number } {
    const ratio = propensityUnchosen / propensityChosen;
    const unclippedEstimate = realOutcome * ratio;
    const estimate = Math.min(Math.max(unclippedEstimate, 0.0), realOutcome);

    // CUSTOM WEIGHT FORMULA (not standard IPS):
    //
    // Standard IPS: w = p_unchosen / p_chosen  (importance ratio)
    // Standard DR:  w = 1 / p_chosen
    //
    // This implementation uses a custom confidence-adjusted weight:
    //   weight = p_unchosen * (1 - |estimate - real_outcome|)
    //
    // Rationale:
    //   - p_unchosen: scales weight by how likely the unchosen action was.
    //     Rare actions (low p_unchosen) get lower weight, reducing variance.
    //   - (1 - |estimate - real_outcome|): proximity penalty. Downweights
    //     counterfactuals where the IPS estimate diverges from the real
    //     outcome — a heuristic signal that the ratio extrapolation is
    //     unreliable for this action.
    //
    // LIMITATION: estimate depends on real_outcome (estimate = clip(real *
    // ratio, 0, real)), so the weight is partially circular. When ratio ~= 1,
    // estimate ~= real_outcome, proximity = 1.0 -> maximum weight. This
    // means actions close in propensity to the chosen action get the
    // highest weights — opposite of standard IPS where rare actions
    // get high weights.
    //
    // This weight is used by the Python DR pipeline as a soft confidence
    // score, NOT as a standard importance ratio. The Python trainer must
    // NOT use this weight in the standard DR formula:
    //   reward_hat + w * (observed - reward_hat)
    // Instead it uses it as a sample weight / reliability score.
    // See: python/training/dr_estimator.py for the exact usage.
    const rawWeight = propensityUnchosen * (1.0 - Math.abs(estimate - realOutcome));
    const weight = Math.min(Math.max(rawWeight, IPS_WEIGHT_MIN), IPS_WEIGHT_CAP);

    return {
        estimate: Math.round(estimate * 10000) / 10000,
        weight: Math.round(weight * 10000) / 10000,
    };
}

/**
 * Write IPS estimates for all unchosen actions.
 * Called fire-and-forget from log-outcome.
 * Failures are logged but do not throw.
 */
export async function writeCounterfactuals(
    input: IPSInput
): Promise<void> {
    // Find the chosen action's propensity
    const chosenAction = input.rankedActions.find(
        a => a.action_name === input.chosenActionName
    );

    if (!chosenAction) {
        console.warn(
            '[IPS] Chosen action not in ranked list. ' +
            `action=${input.chosenActionName} ` +
            `decision=${input.decisionId}. ` +
            'Skipping counterfactual computation.'
        );
        return;
    }

    const propensityChosen = chosenAction.propensity;

    // Compute IPS for every unchosen action
    const counterfactuals = input.rankedActions
        .filter(a => a.action_name !== input.chosenActionName)
        .map(unchosenAction => {
            const { estimate, weight } = computeIPSEstimate(
                input.realOutcomeScore,
                propensityChosen,
                unchosenAction.propensity
            );

            return {
                decision_id: input.decisionId,
                real_outcome_id: input.realOutcomeId,
                unchosen_action_id: unchosenAction.action_id,
                unchosen_action_name: unchosenAction.action_name,
                propensity_unchosen: unchosenAction.propensity,
                propensity_chosen: propensityChosen,
                real_outcome_score: input.realOutcomeScore,
                counterfactual_est: estimate,
                ips_weight: weight,
                context_hash: input.contextHash,
                episode_position: input.episodePosition,
            };
        })
        .filter(c => c.ips_weight > IPS_WEIGHT_MIN);  // skip negligible weights

    if (counterfactuals.length === 0) {
        return;  // nothing to write
    }

    // Idempotent upsert: retries (Railway restart, HTTP timeout) are safe.
    // First write wins on (decision_id, unchosen_action_id) conflict.
    // Requires UNIQUE constraint — see migration TODO above.
    // TODO(migration):
    // ALTER TABLE fact_outcome_counterfactuals
    // ADD CONSTRAINT uq_counterfactual_decision_action
    // UNIQUE (decision_id, unchosen_action_id);
    const { error } = await supabase
        .from('fact_outcome_counterfactuals')
        .upsert(counterfactuals, {
            onConflict: 'decision_id,unchosen_action_id',
            ignoreDuplicates: true,
        });

    if (error) {
        // Log but do not throw — counterfactual failure must never
        // affect the real log-outcome response
        console.error(
            '[IPS] Failed to write counterfactuals:',
            error.message,
            `decision_id=${input.decisionId}`
        );
    }
}
