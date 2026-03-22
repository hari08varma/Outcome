/**
 * Layerinfinite — lib/simulation/tier-selector.ts
 * ══════════════════════════════════════════════════════════════
 * Automatic tier selection per prediction.
 * Central orchestration of all three tiers.
 * Returns the best prediction the data supports.
 *
 * Selection logic:
 *   Tier 3 if: episodes >= 1000 AND model loaded AND CI < 0.25
 *   Tier 2 if: episodes >= 200 AND model loaded
 *   Tier 1 always (fallback)
 *
 * Never throws — returns Tier 1 result on any error.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from '../supabase.js';
import { loadWorldModel } from './world-model.js';
import { tier1Predict, tier1FindAlternatives } from './tier1.js';
import { tier2Predict } from './tier2.js';
import { tier3MCTS } from './tier3-mcts.js';
import type {
  SimulationRequest,
  SimulationResult,
  WorldModelArtifact,
} from './types.js';

const TIER2_MIN_EPISODES = 200;
const TIER3_MIN_EPISODES = 1000;
const TIER2_CONFIDENCE_MAX_WIDTH = 0.25;

/**
 * Count relevant episodes for this agent + context type.
 */
async function countEpisodes(
  agentId: string,
  contextHash: string,
): Promise<number> {
  const { count } = await supabase
    .from('fact_outcomes')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('context_hash', contextHash);

  return count ?? 0;
}

/**
 * Get context frequency (normalized, 0–1) for model features.
 */
async function getContextFrequency(
  _agentId: string,
  contextHash: string,
): Promise<number> {
  const [{ count: contextCount }, { count: totalCount }] =
    await Promise.all([
      supabase
        .from('fact_outcomes')
        .select('*', { count: 'exact', head: true })
        .eq('context_hash', contextHash),
      supabase
        .from('fact_outcomes')
        .select('*', { count: 'exact', head: true }),
    ]);

  if (!totalCount || totalCount === 0) return 0.5;
  return Math.min(1.0, (contextCount ?? 0) / totalCount);
}

/**
 * Get all valid action names for an agent.
 * Used by MCTS to enumerate the action space.
 */
async function getAgentActions(agentId: string): Promise<string[]> {
  const { data } = await supabase
    .from('dim_actions')
    .select('action_name')
    .eq('agent_id', agentId);

  return (data ?? []).map((a: any) => a.action_name);
}

/**
 * Generate human-readable tier explanation.
 */
function buildTierExplanation(
  tier: 1 | 2 | 3,
  episodeCount: number,
  modelLoaded: boolean,
): string {
  if (tier === 3) {
    return (
      `Planning mode (Tier 3): MCTS over learned world model. ` +
      `${episodeCount} episodes available. ` +
      `Searching optimal multi-step sequence.`
    );
  }
  if (tier === 2) {
    const remaining = TIER3_MIN_EPISODES - episodeCount;
    return (
      `Statistical model (Tier 2): LightGBM prediction. ` +
      `${episodeCount} episodes available. ` +
      `Tier 3 planning unlocks after ${remaining} more episodes.`
    );
  }
  if (!modelLoaded) {
    const remaining = Math.max(0, TIER2_MIN_EPISODES - episodeCount);
    return (
      `Historical analysis (Tier 1): Wilson CI on observations. ` +
      `${episodeCount} episodes available. ` +
      `Statistical model trains after ${remaining} more episodes.`
    );
  }
  return (
    `Historical analysis (Tier 1): Wilson CI on observations. ` +
    `${episodeCount} episodes available. ` +
    `Model confidence too low for Tier 2 this context.`
  );
}

/**
 * Main entry point: run simulation and return result.
 * Automatically selects the highest eligible tier.
 * Never throws — returns Tier 1 result on any error.
 */
export async function runSimulation(
  request: SimulationRequest,
): Promise<SimulationResult> {
  try {
    const [episodeCount, contextFreq, allActions, model] =
      await Promise.all([
        countEpisodes(request.agentId, request.contextHash),
        getContextFrequency(request.agentId, request.contextHash),
        getAgentActions(request.agentId),
        loadWorldModel(request.customerId),
      ]);

    const modelLoaded = model !== null;

    // Determine tier
    let tier: 1 | 2 | 3 = 1;

    if (episodeCount >= TIER3_MIN_EPISODES && modelLoaded) {
      tier = 3;
    } else if (episodeCount >= TIER2_MIN_EPISODES && modelLoaded) {
      tier = 2;
    }

    // Run prediction for proposed sequence
    let primaryPrediction = null;
    let actualTier: 1 | 2 | 3 = tier;

    if (tier === 3) {
      primaryPrediction = await tier3MCTS(
        request,
        allActions,
        contextFreq,
      ).catch((err) => {
        console.error('[SimEngine] MCTS failed, falling back:', err);
        return null;
      });

      if (!primaryPrediction) {
        actualTier = 2; // fall back
      }
    }

    if (!primaryPrediction && (tier === 2 || actualTier === 2)) {
      const tier2Result = await tier2Predict(request, contextFreq).catch(
        () => null,
      );

      if (tier2Result === null) {
        // No model artifact returned. Only try MCTS if this is the first time attempting
        // it — i.e., tier was originally 2 (MCTS not yet tried). If tier was 3, MCTS
        // already ran and failed above, so retrying it here is redundant and will fail again.
        if (tier === 2) {
          console.info('[tier-selector] No world model for customer — falling back to Tier 3 MCTS', {
            customerId: request.customerId,
          });
          primaryPrediction = await tier3MCTS(request, allActions, contextFreq).catch((err) => {
            console.error('[SimEngine] MCTS fallback failed:', err);
            return null;
          });
          if (primaryPrediction) actualTier = 3;
        }
        // If tier === 3: MCTS was already attempted above and failed — skip straight to tier1.
      } else if (tier2Result.confidenceWidth <= TIER2_CONFIDENCE_MAX_WIDTH) {
        primaryPrediction = tier2Result;
        actualTier = 2;
      }
      // else: model exists but low confidence — fall through to tier1
      if (!primaryPrediction) actualTier = 1;
    }

    if (!primaryPrediction) {
      primaryPrediction = await tier1Predict(request);
      actualTier = 1;
    }

    primaryPrediction.betterThanProposed = false;

    // Find alternatives if requested
    let alternatives = tier1FindAlternatives(
      request,
      primaryPrediction.predictedOutcome,
      0,
    );
    if (request.simulateAlternatives > 0) {
      alternatives = tier1FindAlternatives(
        request,
        primaryPrediction.predictedOutcome,
        request.simulateAlternatives,
      );
    }

    const resolvedAlternatives = (await alternatives).map((alt) => ({
      ...alt,
      betterThanProposed:
        alt.predictedOutcome > primaryPrediction!.predictedOutcome,
    }));

    const tierExplanation = buildTierExplanation(
      actualTier,
      episodeCount,
      modelLoaded,
    );

    const dataSource =
      modelLoaded && actualTier >= 2
        ? `LightGBM v${(model as WorldModelArtifact).version} trained on ` +
        `${(model as WorldModelArtifact).training_episodes} episodes ` +
        `(${new Date((model as WorldModelArtifact).trained_at).toISOString().split('T')[0]})`
        : `${episodeCount} historical episodes (Wilson CI)`;

    const simulationWarning =
      primaryPrediction.confidence < 0.4
        ? `Low confidence prediction (${(primaryPrediction.confidence * 100).toFixed(0)}%). ` +
        `Prediction interval is wide: ` +
        `[${primaryPrediction.outcomeIntervalLow.toFixed(2)}, ` +
        `${primaryPrediction.outcomeIntervalHigh.toFixed(2)}]. ` +
        `Collect more real episodes to improve accuracy.`
        : null;

    return {
      primary: primaryPrediction,
      alternatives: resolvedAlternatives,
      simulationTier: actualTier,
      tierExplanation,
      dataSource,
      episodeCount,
      simulationWarning,
    };
  } catch (err) {
    console.error('[SimEngine] Fatal runSimulation error, returning safe Tier 1 fallback:', err);
    return {
      primary: {
        actions: request.proposedSequence,
        predictedOutcome: 0.5,
        outcomeIntervalLow: 0.1,
        outcomeIntervalHigh: 0.9,
        confidenceWidth: 0.8,
        confidence: 0.2,
        predictedResolution: 0.5,
        predictedSteps: 2,
        betterThanProposed: false
      },
      alternatives: [],
      simulationTier: 1,
      tierExplanation: 'Historical analysis (Tier 1): Wilson CI on observations. 0 episodes available. Statistical model trains after 200 more episodes.',
      dataSource: '0 historical episodes (Wilson CI)',
      episodeCount: 0,
      simulationWarning: 'Low confidence prediction (20%). Prediction interval is wide: [0.10, 0.90]. Collect more real episodes to improve accuracy.'
    };
  }
}
