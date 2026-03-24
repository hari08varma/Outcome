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
const IPS_WEIGHT_MIN = 0.0;     // min IPS weight
const IPS_WEIGHT_CAP = 0.3;     // max IPS weight (conservative cap)
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

    return propensityMap;
}

/**
 * Compute IPS estimate for one unchosen action.
 *
 * Formula (doubly-robust compatible):
 *   weight   = clip(p_unchosen / p_chosen, IPS_WEIGHT_MIN, IPS_WEIGHT_CAP)
 *   estimate = clip(real_outcome * weight, 0, 1)
 *
 * The conservative propensity-ratio cap from the old implementation
 * has been removed — IPS weights now span [0.01, 100.0] to provide
 * sufficient signal range for the DR estimator in Python training.
 * DR corrects variance: reward_hat + weight * (observed - reward_hat).
 */
export function computeIPSEstimate(
    realOutcome: number,
    propensityChosen: number,
    propensityUnchosen: number
): { estimate: number; weight: number } {
    const ratio = propensityUnchosen / propensityChosen;
    const unclippedEstimate = realOutcome * ratio;
    const estimate = Math.min(Math.max(unclippedEstimate, 0.0), realOutcome);

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
        .filter(c => c.ips_weight > 0.001);  // skip negligible weights

    if (counterfactuals.length === 0) {
        return;  // nothing to write
    }

    const { error } = await supabase
        .from('fact_outcome_counterfactuals')
        .insert(counterfactuals);

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
