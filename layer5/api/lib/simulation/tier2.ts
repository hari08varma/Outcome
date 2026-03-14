/**
 * Layerinfinite — lib/simulation/tier2.ts
 * ══════════════════════════════════════════════════════════════
 * Tier 2 simulation using LightGBM model.
 * Available after 200 episodes and model training.
 * Returns prediction intervals, not just point estimates.
 *
 * Multi-step aggregation:
 *   - Single-step → direct prediction
 *   - Multi-step → geometric mean (penalizes long sequences)
 *   - Intervals widen with sequence length
 * ══════════════════════════════════════════════════════════════
 */

import { predictOutcome, loadWorldModel } from './world-model.js';
import type { SequencePrediction, SimulationRequest } from './types.js';

/**
 * Predict outcome for a proposed sequence using Tier 2 model.
 *
 * For multi-step sequences, predict each step independently
 * and combine using conservative aggregation:
 *   - Predicted outcome = geometric mean of per-step probabilities
 *     (penalizes long sequences appropriately)
 *   - Confidence interval widens with sequence length
 */
export async function tier2Predict(
  request: SimulationRequest,
  contextFreq: number,
): Promise<SequencePrediction | null> {
  const model = await loadWorldModel();
  if (!model) return null;

  const sequence = [
    ...request.episodeHistory,
    ...request.proposedSequence,
  ];

  // Predict each step in the proposed sequence
  const stepPredictions = await Promise.all(
    request.proposedSequence.map(async (action, stepIdx) => {
      const history = sequence.slice(
        0,
        request.episodeHistory.length + stepIdx,
      );

      return predictOutcome(action, history, request.contextHash, contextFreq);
    }),
  );

  // If any action in the sequence is unknown to the model,
  // return null (fall back to Tier 1)
  if (stepPredictions.some((p) => p === null)) {
    return null;
  }

  const predictions = stepPredictions as NonNullable<
    (typeof stepPredictions)[0]
  >[];

  // Aggregate multi-step predictions
  let aggregateQ50: number;
  let aggregateQ025: number;
  let aggregateQ975: number;

  if (predictions.length === 1) {
    aggregateQ50 = predictions[0]!.q50;
    aggregateQ025 = predictions[0]!.q025;
    aggregateQ975 = predictions[0]!.q975;
  } else {
    // Multi-step: geometric mean penalizes long sequences
    const product = predictions.reduce((acc, p) => acc * p.q50, 1.0);
    aggregateQ50 = Math.pow(product, 1 / predictions.length);

    // Interval widens: outer predictions bound the aggregate
    aggregateQ025 = Math.min(...predictions.map((p) => p.q025));
    aggregateQ975 = Math.max(...predictions.map((p) => p.q975));
  }

  const width = aggregateQ975 - aggregateQ025;

  return {
    actions: [...request.episodeHistory, ...request.proposedSequence],
    predictedOutcome: Math.round(aggregateQ50 * 10000) / 10000,
    outcomeIntervalLow: Math.round(aggregateQ025 * 10000) / 10000,
    outcomeIntervalHigh: Math.round(aggregateQ975 * 10000) / 10000,
    confidenceWidth: Math.round(width * 10000) / 10000,
    confidence: Math.max(0.0, 1.0 - width),
    predictedResolution:
      aggregateQ50 >= 0.7 ? aggregateQ50 : aggregateQ50 * 0.8,
    predictedSteps: request.proposedSequence.length,
    betterThanProposed: false,
  };
}
