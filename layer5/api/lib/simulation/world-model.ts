/**
 * Layerinfinite — lib/simulation/world-model.ts
 * ══════════════════════════════════════════════════════════════
 * Loads, caches, and evaluates the Tier 2 LightGBM world model.
 * Model trained in Python, serialized as JSON trees, stored in
 * world_model_artifacts. Evaluated in TypeScript via tree walking.
 *
 * Cache: module-level, 30 min TTL, one per edge function instance.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from '../supabase.js';
import type {
  WorldModelArtifact,
  LGBMTree,
  WorldModelPrediction,
} from './types.js';

// ── Module-level cache ───────────────────────────────────────
let cachedModel: WorldModelArtifact | null = null;
let cacheLoadedAt: Date | null = null;
let cachedCanaryModel: WorldModelArtifact | null = null;
let canaryLoadedAt: Date | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load the active Tier 2 world model from world_model_artifacts.
 * Caches in module scope for edge function instance lifetime.
 * Returns null if no trained model exists yet.
 */
export async function loadWorldModel(): Promise<WorldModelArtifact | null> {
  if (
    cachedModel &&
    cacheLoadedAt &&
    Date.now() - cacheLoadedAt.getTime() < CACHE_TTL_MS
  ) {
    return cachedModel;
  }

  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('model_data, trained_at, version, training_episodes')
    .eq('tier', 2)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    cachedModel = null;
    return null;
  }

  const model = data.model_data as WorldModelArtifact;
  model.trained_at = data.trained_at;
  model.version = data.version;
  model.training_episodes = data.training_episodes;
  model.is_canary = false;
  model.canary_traffic_pct = 0;

  cachedModel = model;
  cacheLoadedAt = new Date();
  return cachedModel;
}

/**
 * Load the active canary model (is_canary=true) if one exists.
 * Returns null if no canary model is deployed.
 */
async function loadCanaryModel(): Promise<WorldModelArtifact | null> {
  if (
    cachedCanaryModel &&
    canaryLoadedAt &&
    Date.now() - canaryLoadedAt.getTime() < CACHE_TTL_MS
  ) {
    return cachedCanaryModel;
  }

  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('model_data, trained_at, version, training_episodes, canary_traffic_pct')
    .eq('tier', 2)
    .eq('is_canary', true)
    .maybeSingle();

  if (error || !data) {
    cachedCanaryModel = null;
    return null;
  }

  const model = data.model_data as WorldModelArtifact;
  model.trained_at = data.trained_at;
  model.version = data.version;
  model.training_episodes = data.training_episodes;
  model.is_canary = true;
  model.canary_traffic_pct = data.canary_traffic_pct ?? 0;

  cachedCanaryModel = model;
  canaryLoadedAt = new Date();
  return cachedCanaryModel;
}

/**
 * Invalidate the model cache (production and canary).
 * Called when a new model is activated.
 */
export function invalidateModelCache(): void {
  cachedModel = null;
  cacheLoadedAt = null;
  cachedCanaryModel = null;
  canaryLoadedAt = null;
}

/**
 * Evaluate a single LightGBM tree on the feature vector.
 * Walks the tree from root to leaf and returns the leaf value.
 *
 * LightGBM tree encoding:
 *   - Internal nodes have non-negative indices
 *   - Leaf nodes are encoded as negative: leaf = -(index + 1)
 */
export function evaluateTree(
  tree: LGBMTree,
  features: number[],
): number {
  let nodeIndex = 0; // start at root (index 0)

  while (nodeIndex >= 0) {
    const featureIndex = tree.split_feature[nodeIndex]!;
    const threshold = tree.threshold[nodeIndex] as number;
    const leftChild = tree.left_child[nodeIndex]!;
    const rightChild = tree.right_child[nodeIndex]!;

    const featureValue = features[featureIndex] ?? 0;

    if (featureValue <= threshold) {
      nodeIndex = leftChild;
    } else {
      nodeIndex = rightChild;
    }

    // Negative index means leaf node
    if (nodeIndex < 0) {
      const leafIndex = -(nodeIndex + 1);
      return tree.leaf_value[leafIndex] ?? 0;
    }
  }

  return 0; // fallback (should not reach here with valid tree)
}

/**
 * Run full LightGBM ensemble prediction.
 * Sums all trees with learning rate scaling.
 */
export function predictEnsemble(
  trees: LGBMTree[],
  features: number[],
  learningRate: number,
): number {
  return trees.reduce(
    (sum, tree) => sum + evaluateTree(tree, features) * learningRate,
    0,
  );
}

/**
 * Build feature vector for the world model.
 * Feature order MUST match training-time feature order.
 *
 * Features:
 *   [0] action_encoded      — integer from action_encoding map
 *   [1] episode_position    — step number (0-based)
 *   [2] prev_action_1       — previous action integer (-1 if none)
 *   [3] prev_action_2       — 2nd previous (-1 if none)
 *   [4] prev_action_3       — 3rd previous (-1 if none)
 *   [5] context_type_freq   — how often this context appears (0–1)
 *   [6] hour_sin            — sin(hour/24 * 2π) cyclical
 *   [7] hour_cos            — cos(hour/24 * 2π) cyclical
 *   [8] dow_sin             — sin(dayOfWeek/7 * 2π) cyclical
 *   [9] dow_cos             — cos(dayOfWeek/7 * 2π) cyclical
 */
export function buildFeatures(
  model: WorldModelArtifact,
  actionName: string,
  episodeHistory: string[],
  _contextHash: string,
  contextFreq: number,
): number[] {
  const actionEnc = model.action_encoding[actionName] ?? -1;
  const now = new Date();
  const hour = now.getUTCHours();
  const dow = now.getUTCDay();

  const prevActions = episodeHistory.slice(-3).reverse();
  const prev1 = model.action_encoding[prevActions[0] ?? ''] ?? -1;
  const prev2 = model.action_encoding[prevActions[1] ?? ''] ?? -1;
  const prev3 = model.action_encoding[prevActions[2] ?? ''] ?? -1;

  return [
    actionEnc,
    episodeHistory.length,
    prev1,
    prev2,
    prev3,
    contextFreq,
    Math.sin((hour / 24) * 2 * Math.PI),
    Math.cos((hour / 24) * 2 * Math.PI),
    Math.sin((dow / 7) * 2 * Math.PI),
    Math.cos((dow / 7) * 2 * Math.PI),
  ];
}

/**
 * Predict outcome for a given action in given context.
 * Returns q50 (median), q025 (lower), q975 (upper), and model_source.
 * Routes a percentage of traffic to the canary model when one is deployed.
 * Returns null if action not in model encoding.
 */
export async function predictOutcome(
  actionName: string,
  episodeHistory: string[],
  contextHash: string,
  contextFreq: number = 0.5,
): Promise<WorldModelPrediction | null> {
  // Load production model first (always required as fallback)
  const productionModel = await loadWorldModel();
  if (!productionModel) return null;

  // Check if a canary model is deployed and should serve this request
  const canaryModel = await loadCanaryModel();
  const useCanary =
    canaryModel !== null &&
    canaryModel.canary_traffic_pct > 0 &&
    Math.random() * 100 < canaryModel.canary_traffic_pct;

  const model = useCanary ? canaryModel! : productionModel;
  const modelSource: 'production' | 'canary' = useCanary ? 'canary' : 'production';

  if (!(actionName in model.action_encoding)) {
    // If canary doesn't know this action, fall back to production
    if (useCanary && actionName in productionModel.action_encoding) {
      return runPrediction(productionModel, actionName, episodeHistory, contextHash, contextFreq, 'production');
    }
    return null;
  }

  return runPrediction(model, actionName, episodeHistory, contextHash, contextFreq, modelSource);
}

function runPrediction(
  model: WorldModelArtifact,
  actionName: string,
  episodeHistory: string[],
  contextHash: string,
  contextFreq: number,
  modelSource: 'production' | 'canary',
): WorldModelPrediction {
  const features = buildFeatures(model, actionName, episodeHistory, contextHash, contextFreq);

  const q50 = predictEnsemble(model.q50.trees, features, model.learning_rate);
  const q025 = predictEnsemble(model.q025.trees, features, model.learning_rate);
  const q975 = predictEnsemble(model.q975.trees, features, model.learning_rate);

  const clamp = (v: number) => Math.max(0.0, Math.min(1.0, v));

  if (modelSource === 'canary') {
    console.info(
      `[world-model] canary prediction — action=${actionName} ` +
      `version=${model.version} traffic_pct=${model.canary_traffic_pct}`
    );
  }

  return {
    q50: clamp(q50),
    q025: clamp(q025),
    q975: clamp(q975),
    width: clamp(q975) - clamp(q025),
    model_source: modelSource,
  };
}
