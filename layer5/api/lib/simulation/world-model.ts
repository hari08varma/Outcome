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

// ── Module-level cache (keyed by customer_id for multi-tenant isolation) ─
const modelCache = new Map<string, WorldModelArtifact>();
const modelCacheLoadedAt = new Map<string, Date>();
const canaryCache = new Map<string, WorldModelArtifact>();
const canaryCacheLoadedAt = new Map<string, Date>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load the active Tier 2 world model for a specific customer.
 * Caches per customer_id for edge function instance lifetime.
 * Returns null if no trained model exists yet for this customer.
 */
export async function loadWorldModel(customerId: string): Promise<WorldModelArtifact | null> {
  const cached = modelCache.get(customerId);
  const loadedAt = modelCacheLoadedAt.get(customerId);
  if (cached && loadedAt && Date.now() - loadedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('model_data, trained_at, version, training_episodes')
    .eq('tier', 2)
    .eq('is_active', true)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error || !data) {
    modelCache.delete(customerId);
    return null;
  }

  const model = data.model_data as WorldModelArtifact;
  model.trained_at = data.trained_at;
  model.version = data.version;
  model.training_episodes = data.training_episodes;
  model.is_canary = false;
  model.canary_traffic_pct = 0;

  modelCache.set(customerId, model);
  modelCacheLoadedAt.set(customerId, new Date());
  return model;
}

/**
 * Load the active canary model (is_canary=true) for a specific customer.
 * Returns null if no canary model is deployed for this customer.
 */
async function loadCanaryModel(customerId: string): Promise<WorldModelArtifact | null> {
  const cached = canaryCache.get(customerId);
  const loadedAt = canaryCacheLoadedAt.get(customerId);
  if (cached && loadedAt && Date.now() - loadedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }

  const { data, error } = await supabase
    .from('world_model_artifacts')
    .select('model_data, trained_at, version, training_episodes, canary_traffic_pct')
    .eq('tier', 2)
    .eq('is_canary', true)
    .eq('customer_id', customerId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    canaryCache.delete(customerId);
    return null;
  }

  const model = data.model_data as WorldModelArtifact;
  model.trained_at = data.trained_at;
  model.version = data.version;
  model.training_episodes = data.training_episodes;
  model.is_canary = true;
  model.canary_traffic_pct = data.canary_traffic_pct ?? 0;

  canaryCache.set(customerId, model);
  canaryCacheLoadedAt.set(customerId, new Date());
  return model;
}

/**
 * Invalidate the model cache for a specific customer (production and canary).
 * Called when a new model is activated. Pass customerId to clear one tenant,
 * or omit to clear all cached models.
 */
export function invalidateModelCache(customerId?: string): void {
  if (customerId) {
    modelCache.delete(customerId);
    modelCacheLoadedAt.delete(customerId);
    canaryCache.delete(customerId);
    canaryCacheLoadedAt.delete(customerId);
  } else {
    modelCache.clear();
    modelCacheLoadedAt.clear();
    canaryCache.clear();
    canaryCacheLoadedAt.clear();
  }
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
  customerId: string,
  actionName: string,
  episodeHistory: string[],
  contextHash: string,
  contextFreq: number = 0.5,
): Promise<WorldModelPrediction | null> {
  // Load production model first (always required as fallback)
  const productionModel = await loadWorldModel(customerId);
  if (!productionModel) return null;

  // Check if a canary model is deployed and should serve this request
  const canaryModel = await loadCanaryModel(customerId);
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
