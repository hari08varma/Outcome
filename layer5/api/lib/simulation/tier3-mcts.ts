/**
 * Layerinfinite — lib/simulation/tier3-mcts.ts
 * ══════════════════════════════════════════════════════════════
 * Tier 3: Monte Carlo Tree Search over the Tier 2 world model.
 * Finds the optimal multi-step sequence, not just scores
 * a proposed one.
 *
 * Available after 1000 real episodes.
 * 500 simulations per call. Inference: <100ms.
 * ══════════════════════════════════════════════════════════════
 */

import { predictOutcome, loadWorldModel } from './world-model.js';
import type { SequencePrediction, SimulationRequest } from './types.js';

const UCT_C = Math.SQRT2;       // exploration constant
const MAX_DEPTH = 5;             // max sequence length
const NUM_SIMS = 500;            // simulations per call
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _MIN_VISITS_EXPAND = 1;    // expand after 1 visit

interface MCTSNode {
  action: string | null;         // null for root
  parent: MCTSNode | null;
  children: MCTSNode[];
  visits: number;
  totalValue: number;
  untriedActions: string[];
  depth: number;
}

/**
 * Compute UCT score for node selection.
 * UCT = exploitation + exploration
 *     = Q/N + C * sqrt(ln(N_parent) / N)
 */
function uctScore(node: MCTSNode): number {
  if (node.visits === 0) return Infinity;

  const exploitation = node.totalValue / node.visits;
  const exploration =
    UCT_C * Math.sqrt(Math.log(node.parent!.visits) / node.visits);

  return exploitation + exploration;
}

/**
 * Get the sequence of actions from root to this node.
 */
function pathToNode(node: MCTSNode): string[] {
  const path: string[] = [];
  let current: MCTSNode | null = node;

  while (current && current.action !== null) {
    path.unshift(current.action);
    current = current.parent;
  }

  return path;
}

/**
 * Select the most promising leaf using UCT.
 */
function select(root: MCTSNode): MCTSNode {
  let node = root;

  while (node.children.length > 0 && node.untriedActions.length === 0) {
    node = node.children.reduce((best, child) =>
      uctScore(child) > uctScore(best) ? child : best,
    );
  }

  return node;
}

/**
 * Expand the node by adding one untried child.
 */
function expand(
  node: MCTSNode,
  allActions: string[],
): MCTSNode {
  if (node.untriedActions.length === 0) return node;

  // Pick random untried action
  const idx = Math.floor(Math.random() * node.untriedActions.length);
  const action = node.untriedActions.splice(idx, 1)[0]!;

  const child: MCTSNode = {
    action,
    parent: node,
    children: [],
    visits: 0,
    totalValue: 0,
    untriedActions:
      node.depth + 1 < MAX_DEPTH ? [...allActions] : [],
    depth: node.depth + 1,
  };

  node.children.push(child);
  return child;
}

/**
 * Simulate (rollout) from a node using the Tier 2 world model.
 * Returns predicted outcome value for the sequence.
 */
async function rollout(
  node: MCTSNode,
  episodeHistory: string[],
  contextHash: string,
  contextFreq: number,
): Promise<number> {
  const sequence = pathToNode(node);

  if (sequence.length === 0) return 0.5; // root node default

  const fullHistory = [...episodeHistory, ...sequence.slice(0, -1)];
  const action = sequence[sequence.length - 1]!;

  const prediction = await predictOutcome(
    action,
    fullHistory,
    contextHash,
    contextFreq,
  );

  return prediction?.q50 ?? 0.5; // fallback to 0.5 if unknown
}

/**
 * Backpropagate value from leaf to root.
 */
function backpropagate(node: MCTSNode, value: number): void {
  let current: MCTSNode | null = node;

  while (current !== null) {
    current.visits += 1;
    current.totalValue += value;
    current = current.parent;
  }
}

/**
 * Extract the best sequence from the MCTS tree.
 * Uses most-visited child at each level (robust policy).
 */
function extractBestSequence(root: MCTSNode): {
  sequence: string[];
  expectedOutcome: number;
  visits: number;
} {
  const sequence: string[] = [];
  let current = root;

  while (current.children.length > 0) {
    const best = current.children.reduce((a, b) =>
      a.visits > b.visits ? a : b,
    );

    if (best.action) sequence.push(best.action);
    current = best;

    if (sequence.length >= MAX_DEPTH) break;
  }

  const expectedOutcome =
    current.visits > 0 ? current.totalValue / current.visits : 0.5;

  return {
    sequence,
    expectedOutcome: Math.max(0.0, Math.min(1.0, expectedOutcome)),
    visits: current.visits,
  };
}

/**
 * Run MCTS to find the optimal action sequence.
 *
 * @param request         Simulation request
 * @param allActionNames  All valid action names for this agent
 * @param contextFreq     Context frequency (0–1 normalized)
 * @returns Best sequence found and its predicted outcome
 */
const MCTS_TIMEOUT_MS = 8000;

export async function tier3MCTS(
  request: SimulationRequest,
  allActionNames: string[],
  contextFreq: number,
): Promise<SequencePrediction | null> {
  const timeoutPromise = new Promise<'TIMEOUT'>((resolve) =>
    setTimeout(() => resolve('TIMEOUT'), MCTS_TIMEOUT_MS)
  );

  const mctsPromise = runTier3MCTS(request, allActionNames, contextFreq);

  const result = await Promise.race([mctsPromise, timeoutPromise]);

  if (result === 'TIMEOUT') {
    console.warn(`[MCTS] Timeout after ${MCTS_TIMEOUT_MS}ms — falling back to Tier 1`);
    return null;
  }

  return result as SequencePrediction | null;
}

async function runTier3MCTS(
  request: SimulationRequest,
  allActionNames: string[],
  contextFreq: number,
): Promise<SequencePrediction | null> {
  const model = await loadWorldModel();
  if (!model) return null;

  // Filter to actions known to the model
  const validActions = allActionNames.filter(
    (a) => a in model.action_encoding,
  );

  if (validActions.length === 0) return null;

  // Exclude already-tried actions from root expansion
  // (they can still appear in deeper nodes)
  const initialActions = validActions.filter(
    (a) => !request.episodeHistory.includes(a),
  );

  const root: MCTSNode = {
    action: null,
    parent: null,
    children: [],
    visits: 0,
    totalValue: 0,
    untriedActions: [...initialActions],
    depth: 0,
  };

  // Run MCTS simulations in batches of 10
  const BATCH_SIZE = 10;
  for (let i = 0; i < NUM_SIMS; i += BATCH_SIZE) {
    const promises = [];
    for (let j = 0; j < BATCH_SIZE && i + j < NUM_SIMS; j++) {
      const selected = select(root);
      const expanded =
        selected.untriedActions.length > 0
          ? expand(selected, validActions)
          : selected;
      promises.push(
        rollout(
          expanded,
          request.episodeHistory,
          request.contextHash,
          contextFreq,
        ).then(value => ({ expanded, value }))
      );
    }
    const results = await Promise.all(promises);
    for (const { expanded, value } of results) {
      backpropagate(expanded, value);
    }
  }

  // Extract best sequence
  const { sequence, expectedOutcome } = extractBestSequence(root);

  if (sequence.length === 0) return null;

  // Get Tier 2 confidence interval for the best sequence
  const tier2Pred = await predictOutcome(
    sequence[sequence.length - 1]!,
    [...request.episodeHistory, ...sequence.slice(0, -1)],
    request.contextHash,
    contextFreq,
  );

  const intervalLow =
    tier2Pred?.q025 ?? Math.max(0, expectedOutcome - 0.15);
  const intervalHigh =
    tier2Pred?.q975 ?? Math.min(1, expectedOutcome + 0.15);
  const width = intervalHigh - intervalLow;

  return {
    actions: [...request.episodeHistory, ...sequence],
    predictedOutcome: Math.round(expectedOutcome * 10000) / 10000,
    outcomeIntervalLow: Math.round(intervalLow * 10000) / 10000,
    outcomeIntervalHigh: Math.round(intervalHigh * 10000) / 10000,
    confidenceWidth: Math.round(width * 10000) / 10000,
    confidence: Math.max(0.0, 1.0 - width),
    predictedResolution:
      expectedOutcome >= 0.7 ? expectedOutcome : expectedOutcome * 0.8,
    predictedSteps: sequence.length,
    betterThanProposed: false, // filled by tier-selector
  };
}
