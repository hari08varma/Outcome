/**
 * Layer5 — lib/simulation/tier1.ts
 * ══════════════════════════════════════════════════════════════
 * Tier 1 simulation using Wilson CI on historical sequences.
 * Always available. Day 1, zero training data.
 * Queries mv_sequence_scores directly.
 * Uses Wilson CI lower bound as conservative confidence.
 * Falls back to cold_start_priors when no sequence data.
 * Inference: <5ms (pure SQL).
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from '../supabase.js';
import type { SequencePrediction, SimulationRequest } from './types.js';

const MIN_CONFIDENCE_OBSERVATIONS = 3;

/**
 * Look up the best known sequence for a context using
 * mv_sequence_scores (Wilson CI on historical data).
 *
 * Strategy:
 *   1. Find sequences that START WITH the proposed sequence
 *      or episode_history (what's already been tried)
 *   2. Rank by wilson_lower (conservative estimate)
 *   3. Return the best match as SequencePrediction
 *   4. If no match: return cold_start_prior for the
 *      first action in the proposed sequence
 */
export async function tier1Predict(
  request: SimulationRequest,
): Promise<SequencePrediction> {
  // Build the full path to evaluate
  const fullPath = [
    ...request.episodeHistory,
    ...request.proposedSequence,
  ];

  // Query sequences that match the context
  const { data: sequences } = await supabase
    .from('mv_sequence_scores')
    .select('*')
    .eq('context_hash', request.contextHash)
    .gte('observations', MIN_CONFIDENCE_OBSERVATIONS)
    .order('mean_outcome', { ascending: false });

  // Find sequences that start with our full path
  // (Supabase doesn't support complex array prefix matching,
  //  so filter in TypeScript after fetching)
  const matchingSequences = (sequences ?? []).filter(
    (seq: any) => {
      if (seq.action_sequence.length < fullPath.length) return false;
      return fullPath.every(
        (action: string, i: number) => seq.action_sequence[i] === action,
      );
    },
  );

  if (matchingSequences.length > 0) {
    // Sort by wilson_lower (conservative) descending
    matchingSequences.sort(
      (a: any, b: any) =>
        (b.resolution_rate_lower ?? 0) - (a.resolution_rate_lower ?? 0),
    );
    const best = matchingSequences[0]!;

    const intervalWidth = best.outcome_interval_width ?? 0.8;
    const confidence = 1.0 - intervalWidth;

    return {
      actions: best.action_sequence,
      predictedOutcome: best.mean_outcome ?? 0.5,
      outcomeIntervalLow: best.outcome_lower_ci ?? 0.0,
      outcomeIntervalHigh: best.outcome_upper_ci ?? 1.0,
      confidenceWidth: intervalWidth,
      confidence: Math.max(0.0, confidence),
      predictedResolution: best.resolution_rate ?? 0.5,
      predictedSteps: best.avg_steps ?? 2,
      betterThanProposed: false,
    };
  }

  // No historical sequence found — cold start fallback.
  return await tier1ColdStartFallback(
    request.proposedSequence,
    request.contextHash,
  );
}

/**
 * Cold start fallback using seeded priors.
 * Returns wide confidence interval to signal uncertainty.
 */
async function tier1ColdStartFallback(
  sequence: string[],
  _contextHash: string,
): Promise<SequencePrediction> {
  const firstAction = sequence[0] ?? 'unknown';

  const { data: prior } = await supabase
    .from('dim_actions')
    .select('prior_success_rate')
    .eq('action_name', firstAction)
    .single();

  const priorScore = prior?.prior_success_rate ?? 0.5;

  // Wide interval — we are very uncertain
  return {
    actions: sequence,
    predictedOutcome: priorScore,
    outcomeIntervalLow: Math.max(0.0, priorScore - 0.4),
    outcomeIntervalHigh: Math.min(1.0, priorScore + 0.4),
    confidenceWidth: 0.8,
    confidence: 0.2,
    predictedResolution: priorScore >= 0.6 ? 0.5 : 0.3,
    predictedSteps: 2.0,
    betterThanProposed: false,
  };
}

/**
 * Find top-N alternative sequences from mv_sequence_scores
 * that are better than the proposed sequence for this context.
 */
export async function tier1FindAlternatives(
  request: SimulationRequest,
  proposedOutcome: number,
  limit: number,
): Promise<SequencePrediction[]> {
  const { data: sequences } = await supabase
    .from('mv_sequence_scores')
    .select('*')
    .eq('context_hash', request.contextHash)
    .gte('observations', MIN_CONFIDENCE_OBSERVATIONS)
    .gte('mean_outcome', proposedOutcome)
    .order('resolution_rate_lower', { ascending: false })
    .limit(limit + 5); // over-fetch to filter already-tried

  return (sequences ?? [])
    .filter((seq: any) => {
      // Exclude sequences that are just the episode history
      const newSteps = seq.action_sequence.slice(
        request.episodeHistory.length,
      );
      return newSteps.length > 0;
    })
    .slice(0, limit)
    .map((seq: any) => ({
      actions: seq.action_sequence,
      predictedOutcome: seq.mean_outcome ?? 0.5,
      outcomeIntervalLow: seq.outcome_lower_ci ?? 0.0,
      outcomeIntervalHigh: seq.outcome_upper_ci ?? 1.0,
      confidenceWidth: seq.outcome_interval_width ?? 0.8,
      confidence: Math.max(
        0.0,
        1.0 - (seq.outcome_interval_width ?? 0.8),
      ),
      predictedResolution: seq.resolution_rate ?? 0.5,
      predictedSteps: seq.avg_steps ?? 2,
      betterThanProposed: (seq.mean_outcome ?? 0) > proposedOutcome,
    }));
}
