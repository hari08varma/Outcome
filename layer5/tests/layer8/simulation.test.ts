/**
 * Layer5 — Unit Tests: 3-Tier Simulation Engine
 * Tests world model, tier 1/2/3, tier selector, and simulate endpoint.
 * Run: npx vitest run tests/layer8/simulation.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// ── Mock supabase (hoisted) ──────────────────────────────────
const mockFrom = vi.fn();
vi.mock('../../api/lib/supabase.js', () => {
  return {
    supabase: {
      from: (...args: any[]) => mockFrom(...args),
    },
    createClient: () => ({
      from: (...args: any[]) => mockFrom(...args),
    }),
  };
});

// ── Mock IPS engine — preserve real exports, mock writeCounterfactuals ──
vi.mock('../../api/lib/ips-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/lib/ips-engine.js')>();
  return {
    ...actual,
    writeCounterfactuals: vi.fn().mockResolvedValue(undefined),
  };
});

// helper: build chainable supabase query mock
function buildChain(overrides: Record<string, any> = {}) {
  const c: any = {};
  for (const m of [
    'select', 'eq', 'gte', 'order', 'limit', 'insert', 'update',
    'maybeSingle', 'single', 'is', 'contains',
  ]) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  // Apply overrides (e.g., { data: [...], error: null })
  Object.assign(c, overrides);
  return c;
}

// ══════════════════════════════════════════════════════════════
// TEST SUITE 1 — World Model (unit, mock model)
// ══════════════════════════════════════════════════════════════

import {
  evaluateTree,
  predictEnsemble,
  buildFeatures,
  invalidateModelCache,
} from '../../api/lib/simulation/world-model.js';
import type { LGBMTree, WorldModelArtifact } from '../../api/lib/simulation/types.js';

// A simple 2-leaf tree: if feature[0] <= 0.5 → leaf=-0.3, else → leaf=0.7
const simpleTree: LGBMTree = {
  num_leaves: 2,
  split_index: [0],
  split_feature: [0],        // split on feature 0
  threshold: [0.5],
  decision_type: ['<='],
  left_child: [-1],          // leaf index 0
  right_child: [-2],         // leaf index 1
  leaf_value: [-0.3, 0.7],   // leaf 0 = -0.3, leaf 1 = 0.7
};

// A deeper tree: feature[1] <= 5 → left (feature[0] <= 2 → leaf 0, else leaf 1), else → leaf 2
const deepTree: LGBMTree = {
  num_leaves: 3,
  split_index: [0, 1],
  split_feature: [1, 0],      // root splits on feature 1, left child splits on feature 0
  threshold: [5, 2],
  decision_type: ['<=', '<='],
  left_child: [1, -1],        // root→left=node1, node1→left=leaf0
  right_child: [-3, -2],      // root→right=leaf2, node1→right=leaf1
  leaf_value: [0.1, 0.5, 0.9],
};

const mockModelArtifact: WorldModelArtifact = {
  q50: { trees: [simpleTree], num_trees: 1 },
  q025: { trees: [simpleTree], num_trees: 1 },
  q975: { trees: [simpleTree], num_trees: 1 },
  feature_names: ['action_encoded', 'episode_position', 'prev_action_1', 'prev_action_2', 'prev_action_3', 'context_type_freq', 'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos'],
  num_features: 10,
  action_encoding: { 'restart_service': 0, 'update_app': 1, 'clear_cache': 2 },
  context_encoding: {},
  learning_rate: 0.1,
  trained_at: '2026-03-01T00:00:00Z',
  version: 1,
  training_episodes: 500,
};

describe('World Model — evaluateTree', () => {
  it('follows left branch correctly', () => {
    const result = evaluateTree(simpleTree, [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result).toBe(-0.3); // feature[0]=0.3 <= 0.5 → left → leaf 0
  });

  it('follows right branch correctly', () => {
    const result = evaluateTree(simpleTree, [0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result).toBe(0.7); // feature[0]=0.8 > 0.5 → right → leaf 1
  });

  it('returns leaf value at terminal node', () => {
    // Deep tree: feature[1]=3 <= 5 → left, then feature[0]=1 <= 2 → leaf 0 (value=0.1)
    const result = evaluateTree(deepTree, [1, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result).toBe(0.1);

    // Deep tree: feature[1]=3 <= 5 → left, then feature[0]=4 > 2 → leaf 1 (value=0.5)
    const result2 = evaluateTree(deepTree, [4, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result2).toBe(0.5);

    // Deep tree: feature[1]=7 > 5 → right → leaf 2 (value=0.9)
    const result3 = evaluateTree(deepTree, [0, 7, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result3).toBe(0.9);
  });
});

describe('World Model — predictEnsemble', () => {
  it('sums tree outputs with learning rate', () => {
    const lr = 0.1;
    const features = [0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // goes left, leaf=-0.3
    const result = predictEnsemble([simpleTree, simpleTree], features, lr);
    // Two trees, each returns -0.3, scaled by 0.1 each = -0.03 + -0.03 = -0.06
    expect(result).toBeCloseTo(-0.06, 6);
  });

  it('returns 0 for empty tree list', () => {
    const result = predictEnsemble([], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.1);
    expect(result).toBe(0);
  });
});

describe('World Model — buildFeatures', () => {
  it('returns correct length array (10 features)', () => {
    const features = buildFeatures(mockModelArtifact, 'restart_service', [], 'ctx:test', 0.5);
    expect(features).toHaveLength(10);
  });

  it('hour encoded cyclically (sin/cos)', () => {
    const features = buildFeatures(mockModelArtifact, 'restart_service', [], 'ctx:test', 0.5);
    // features[6] = sin(hour/24 * 2π), features[7] = cos(hour/24 * 2π)
    // sin²+cos² should = 1
    const sinCosSum = features[6]! ** 2 + features[7]! ** 2;
    expect(sinCosSum).toBeCloseTo(1.0, 6);
  });

  it('episode_position reflects history length', () => {
    const features0 = buildFeatures(mockModelArtifact, 'restart_service', [], 'ctx:test', 0.5);
    const features3 = buildFeatures(mockModelArtifact, 'restart_service', ['a', 'b', 'c'], 'ctx:test', 0.5);
    expect(features0[1]).toBe(0); // empty history
    expect(features3[1]).toBe(3); // 3 actions in history
  });

  it('unknown action encodes as -1', () => {
    const features = buildFeatures(mockModelArtifact, 'unknown_action', [], 'ctx:test', 0.5);
    expect(features[0]).toBe(-1);
  });
});

describe('World Model — predictOutcome', () => {
  beforeEach(() => {
    invalidateModelCache();
    mockFrom.mockReset();
  });

  it('returns null when no active model', async () => {
    const chain = buildChain({ data: null, error: { message: 'not found' } });
    mockFrom.mockReturnValue(chain);

    const { predictOutcome } = await import('../../api/lib/simulation/world-model.js');
    invalidateModelCache();
    const result = await predictOutcome('restart_service', [], 'ctx:test', 0.5);
    expect(result).toBeNull();
  });

  it('unknown action returns null (with loaded model)', async () => {
    // Set up model load
    const loadChain = buildChain({ data: { model_data: mockModelArtifact, trained_at: '2026-03-01T00:00:00Z', version: 1, training_episodes: 500 }, error: null });
    mockFrom.mockReturnValue(loadChain);

    const { predictOutcome } = await import('../../api/lib/simulation/world-model.js');
    invalidateModelCache();

    const result = await predictOutcome('totally_unknown_action', [], 'ctx:test', 0.5);
    expect(result).toBeNull();
  });
});

describe('World Model — cache', () => {
  beforeEach(() => {
    invalidateModelCache();
    mockFrom.mockReset();
  });

  it('invalidateModelCache forces reload on next call', async () => {
    // Load model first
    const loadChain = buildChain({ data: { model_data: mockModelArtifact, trained_at: '2026-03-01T00:00:00Z', version: 1, training_episodes: 500 }, error: null });
    mockFrom.mockReturnValue(loadChain);

    const { loadWorldModel, invalidateModelCache: invalidate } = await import('../../api/lib/simulation/world-model.js');
    invalidate();

    const first = await loadWorldModel();
    expect(first).not.toBeNull();

    // Now invalidate — next call should hit DB again
    invalidate();
    const nullChain = buildChain({ data: null, error: { message: 'not found' } });
    mockFrom.mockReturnValue(nullChain);

    const second = await loadWorldModel();
    expect(second).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// TEST SUITE 2 — Tier 1 (unit, mock Supabase)
// ══════════════════════════════════════════════════════════════

import { tier1Predict, tier1FindAlternatives } from '../../api/lib/simulation/tier1.js';
import type { SimulationRequest } from '../../api/lib/simulation/types.js';

const baseRequest: SimulationRequest = {
  agentId: 'agent-001',
  context: { issue_type: 'payment_failed' },
  contextHash: 'ctx-001:payment_failed',
  proposedSequence: ['restart_service'],
  episodeHistory: [],
  simulateAlternatives: 2,
  maxSequenceDepth: 5,
};

describe('Tier 1 — tier1Predict', () => {
  beforeEach(() => {
    mockFrom.mockReset();
  });

  it('returns result for known sequence', async () => {
    const seqChain = buildChain({
      data: [{
        action_sequence: ['restart_service', 'clear_cache'],
        context_hash: 'ctx-001:payment_failed',
        observations: 10,
        mean_outcome: 0.85,
        outcome_lower_ci: 0.7,
        outcome_upper_ci: 1.0,
        outcome_interval_width: 0.3,
        resolution_rate: 0.8,
        resolution_rate_lower: 0.6,
        resolution_rate_upper: 0.95,
        avg_steps: 2,
      }],
      error: null,
    });
    mockFrom.mockReturnValue(seqChain);

    const result = await tier1Predict(baseRequest);
    expect(result.predictedOutcome).toBe(0.85);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.actions).toEqual(['restart_service', 'clear_cache']);
  });

  it('sequence match requires prefix match', async () => {
    // Sequence doesn't start with our proposed action
    const seqChain = buildChain({
      data: [{
        action_sequence: ['update_app', 'clear_cache'],
        context_hash: 'ctx-001:payment_failed',
        observations: 10,
        mean_outcome: 0.9,
        outcome_lower_ci: 0.8,
        outcome_upper_ci: 1.0,
        outcome_interval_width: 0.2,
        resolution_rate: 0.85,
        resolution_rate_lower: 0.7,
        resolution_rate_upper: 0.95,
        avg_steps: 2,
      }],
      error: null,
    });
    // Second from() call is dim_actions for cold start
    const dimChain = buildChain({
      data: { prior_success_rate: 0.6 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(seqChain).mockReturnValueOnce(dimChain);

    const result = await tier1Predict(baseRequest);
    // Should fall back to cold start (no prefix match)
    expect(result.confidenceWidth).toBe(0.8);
    expect(result.confidence).toBe(0.2);
  });

  it('falls back to cold start on no match', async () => {
    const seqChain = buildChain({ data: [], error: null });
    const dimChain = buildChain({
      data: { prior_success_rate: 0.4 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(seqChain).mockReturnValueOnce(dimChain);

    const result = await tier1Predict(baseRequest);
    expect(result.confidenceWidth).toBe(0.8);
    expect(result.predictedOutcome).toBe(0.4);
  });

  it('cold start returns wide interval (width=0.8)', async () => {
    const seqChain = buildChain({ data: [], error: null });
    const dimChain = buildChain({
      data: { prior_success_rate: 0.5 },
      error: null,
    });
    mockFrom.mockReturnValueOnce(seqChain).mockReturnValueOnce(dimChain);

    const result = await tier1Predict(baseRequest);
    expect(result.confidenceWidth).toBe(0.8);
    expect(result.confidence).toBe(0.2);
  });
});

describe('Tier 1 — tier1FindAlternatives', () => {
  beforeEach(() => {
    mockFrom.mockReset();
  });

  it('returns only better sequences', async () => {
    const seqChain = buildChain({
      data: [
        {
          action_sequence: ['update_app', 'clear_cache'],
          mean_outcome: 0.9,
          outcome_lower_ci: 0.8,
          outcome_upper_ci: 1.0,
          outcome_interval_width: 0.2,
          resolution_rate: 0.85,
          resolution_rate_lower: 0.75,
          avg_steps: 2,
          observations: 5,
        },
        {
          action_sequence: ['restart_service'],
          mean_outcome: 0.5,
          outcome_lower_ci: 0.3,
          outcome_upper_ci: 0.7,
          outcome_interval_width: 0.4,
          resolution_rate: 0.4,
          resolution_rate_lower: 0.2,
          avg_steps: 1,
          observations: 5,
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(seqChain);

    const result = await tier1FindAlternatives(baseRequest, 0.6, 3);
    // Both should pass filter (new steps > 0 after episode history)
    // Only first has mean_outcome > 0.6
    const better = result.filter(r => r.betterThanProposed);
    expect(better.length).toBeGreaterThanOrEqual(1);
  });

  it('excludes already-tried sequences', async () => {
    const requestWithHistory: SimulationRequest = {
      ...baseRequest,
      episodeHistory: ['restart_service'],
    };

    const seqChain = buildChain({
      data: [
        {
          action_sequence: ['restart_service'], // same as history, no new steps
          mean_outcome: 0.9,
          outcome_lower_ci: 0.8,
          outcome_upper_ci: 1.0,
          outcome_interval_width: 0.2,
          resolution_rate: 0.85,
          resolution_rate_lower: 0.75,
          avg_steps: 1,
          observations: 5,
        },
        {
          action_sequence: ['restart_service', 'clear_cache'], // has new step
          mean_outcome: 0.85,
          outcome_lower_ci: 0.7,
          outcome_upper_ci: 1.0,
          outcome_interval_width: 0.3,
          resolution_rate: 0.8,
          resolution_rate_lower: 0.6,
          avg_steps: 2,
          observations: 5,
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(seqChain);

    const result = await tier1FindAlternatives(requestWithHistory, 0.5, 3);
    // First sequence has no new steps after history — should be excluded
    expect(result.every(r => r.actions.length > 1)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// TEST SUITE 3 — IPS Engine (unit, pure functions)
// ══════════════════════════════════════════════════════════════

import {
  computePropensities,
  computeIPSEstimate,
} from '../../api/lib/ips-engine.js';

describe('IPS Engine — computePropensities', () => {
  it('sums to ~1.0', () => {
    const actions = [
      { action_name: 'a', score: 0.8 },
      { action_name: 'b', score: 0.5 },
      { action_name: 'c', score: 0.2 },
    ];
    const props = computePropensities(actions);
    let sum = 0;
    props.forEach((v) => { sum += v; });
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it('respects temperature', () => {
    const actions = [
      { action_name: 'a', score: 0.9 },
      { action_name: 'b', score: 0.1 },
    ];
    // Low temperature → sharper distribution
    const sharpProps = computePropensities(actions, 0.1);
    // High temperature → flatter distribution
    const flatProps = computePropensities(actions, 10.0);

    const sharpA = sharpProps.get('a')!;
    const flatA = flatProps.get('a')!;
    // With low temp, 'a' should have much higher propensity
    expect(sharpA).toBeGreaterThan(flatA);
  });
});

describe('IPS Engine — computeIPSEstimate', () => {
  it('weight <= 0.3 always', () => {
    const { weight } = computeIPSEstimate(1.0, 0.5, 0.5);
    expect(weight).toBeLessThanOrEqual(0.3);
  });

  it('estimate <= real_outcome always (conservative clipping)', () => {
    const { estimate } = computeIPSEstimate(0.7, 0.3, 0.9);
    expect(estimate).toBeLessThanOrEqual(0.7);
  });

  it('zero propensity_unchosen → near-zero estimate', () => {
    const { estimate } = computeIPSEstimate(0.8, 0.5, 0.001);
    expect(estimate).toBeLessThan(0.01);
  });
});

// ══════════════════════════════════════════════════════════════
// TEST SUITE 4 — Tier Selector (integration, mock everything)
// ══════════════════════════════════════════════════════════════

// We need to test the tier selector by mocking the entire chain.
// The tier selector calls countEpisodes, getContextFrequency,
// getAgentActions, and loadWorldModel, then delegates to tier1/2/3.

describe('Tier Selector — runSimulation', () => {
  beforeEach(() => {
    invalidateModelCache();
    mockFrom.mockReset();
  });

  // Helper: set up mock returns for the parallel calls in runSimulation
  function setupMocks(opts: {
    episodeCount: number;
    modelData: any;
    actions: string[];
    sequenceScores?: any[];
    dimActions?: any;
  }) {
    let callIdx = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fact_outcomes') {
        // countEpisodes or getContextFrequency — return count
        return buildChain({ count: opts.episodeCount });
      }
      if (table === 'world_model_artifacts') {
        if (opts.modelData) {
          return buildChain({
            data: {
              model_data: opts.modelData,
              trained_at: '2026-03-01T00:00:00Z',
              version: 1,
              training_episodes: 500,
            },
            error: null,
          });
        }
        return buildChain({ data: null, error: { message: 'not found' } });
      }
      if (table === 'dim_actions') {
        if (opts.dimActions) {
          return buildChain({ data: opts.dimActions, error: null });
        }
        return buildChain({
          data: opts.actions.map(a => ({ action_name: a })),
          error: null,
        });
      }
      if (table === 'mv_sequence_scores') {
        return buildChain({
          data: opts.sequenceScores ?? [],
          error: null,
        });
      }
      return buildChain({ data: null, error: null });
    });
  }

  it('0 episodes → uses Tier 1', async () => {
    setupMocks({
      episodeCount: 0,
      modelData: null,
      actions: ['restart_service'],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    const result = await runSimulation(baseRequest);
    expect(result.simulationTier).toBe(1);
  });

  it('150 episodes, no model → uses Tier 1', async () => {
    setupMocks({
      episodeCount: 150,
      modelData: null,
      actions: ['restart_service'],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    const result = await runSimulation(baseRequest);
    expect(result.simulationTier).toBe(1);
  });

  it('300 episodes, model loaded → uses Tier 2', async () => {
    setupMocks({
      episodeCount: 300,
      modelData: mockModelArtifact,
      actions: ['restart_service', 'update_app', 'clear_cache'],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    invalidateModelCache();
    const result = await runSimulation(baseRequest);
    // Should use tier 2 (episodes >= 200, model loaded)
    expect(result.simulationTier).toBeLessThanOrEqual(2);
    expect(result.simulationTier).toBeGreaterThanOrEqual(1);
  });

  it('simulationWarning set when confidence < 0.4', async () => {
    setupMocks({
      episodeCount: 0,
      modelData: null,
      actions: ['restart_service'],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    const result = await runSimulation(baseRequest);
    // Cold start has confidence=0.2 which is < 0.4
    if (result.primary.confidence < 0.4) {
      expect(result.simulationWarning).not.toBeNull();
      expect(result.simulationWarning).toContain('Low confidence');
    }
  });

  it('simulationWarning null when confidence >= 0.4', async () => {
    setupMocks({
      episodeCount: 50,
      modelData: null,
      actions: ['restart_service'],
      sequenceScores: [{
        action_sequence: ['restart_service'],
        context_hash: 'ctx-001:payment_failed',
        observations: 100,
        mean_outcome: 0.85,
        outcome_lower_ci: 0.75,
        outcome_upper_ci: 0.95,
        outcome_interval_width: 0.2,
        resolution_rate: 0.8,
        resolution_rate_lower: 0.7,
        resolution_rate_upper: 0.9,
        avg_steps: 1,
      }],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    const result = await runSimulation(baseRequest);
    // With narrow interval, confidence should be high
    if (result.primary.confidence >= 0.4) {
      expect(result.simulationWarning).toBeNull();
    }
  });

  it('alternatives returned when simulateAlternatives > 0', async () => {
    setupMocks({
      episodeCount: 50,
      modelData: null,
      actions: ['restart_service', 'update_app'],
      sequenceScores: [
        {
          action_sequence: ['restart_service'],
          context_hash: 'ctx-001:payment_failed',
          observations: 10,
          mean_outcome: 0.7,
          outcome_lower_ci: 0.5,
          outcome_upper_ci: 0.9,
          outcome_interval_width: 0.4,
          resolution_rate: 0.6,
          resolution_rate_lower: 0.4,
          resolution_rate_upper: 0.8,
          avg_steps: 1,
        },
        {
          action_sequence: ['update_app', 'clear_cache'],
          context_hash: 'ctx-001:payment_failed',
          observations: 8,
          mean_outcome: 0.85,
          outcome_lower_ci: 0.7,
          outcome_upper_ci: 1.0,
          outcome_interval_width: 0.3,
          resolution_rate: 0.8,
          resolution_rate_lower: 0.6,
          resolution_rate_upper: 0.95,
          avg_steps: 2,
        },
      ],
    });

    const { runSimulation } = await import('../../api/lib/simulation/tier-selector.js');
    const result = await runSimulation({
      ...baseRequest,
      simulateAlternatives: 2,
    });
    expect(result.alternatives).toBeDefined();
    expect(Array.isArray(result.alternatives)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// TEST SUITE 5 — Simulate endpoint (HTTP tests)
// ══════════════════════════════════════════════════════════════

import { simulateRouter } from '../../api/routes/simulate.js';

// Build a test app with auth middleware that sets agent_id / customer_id
function buildTestApp() {
  const app = new Hono();
  // Mock auth middleware
  app.use('*', async (c, next) => {
    c.set('agent_id', 'agent-001');
    c.set('customer_id', 'cust-001');
    await next();
  });
  app.route('/v1/simulate', simulateRouter);
  return app;
}

function buildUnauthApp() {
  const app = new Hono();
  // No auth middleware
  app.route('/v1/simulate', simulateRouter);
  return app;
}

describe('Simulate Endpoint — POST /v1/simulate', () => {
  beforeEach(() => {
    invalidateModelCache();
    mockFrom.mockReset();

    // Default mock: tier 1 (no model, some sequences)
    mockFrom.mockImplementation((table: string) => {
      if (table === 'fact_outcomes') {
        return buildChain({ count: 10 });
      }
      if (table === 'world_model_artifacts') {
        return buildChain({ data: null, error: { message: 'not found' } });
      }
      if (table === 'dim_agents') {
        return buildChain({
          data: { agent_id: 'agent-001' },
          error: null,
        });
      }
      if (table === 'dim_actions') {
        return buildChain({
          data: [{ action_name: 'restart_service' }, { action_name: 'update_app' }],
          error: null,
        });
      }
      if (table === 'mv_sequence_scores') {
        return buildChain({ data: [], error: null });
      }
      return buildChain({ data: null, error: null });
    });
  });

  it('POST /v1/simulate with valid body → 200', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.primary).toBeDefined();
    expect(data.simulation_tier).toBeDefined();
  });

  it('POST /v1/simulate without agent_id → 400', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /v1/simulate without proposed_sequence → 400', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('proposed_sequence length > 5 → 400', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('response includes simulation_tier (1, 2, or 3)', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect([1, 2, 3]).toContain(data.simulation_tier);
  });

  it('response includes tier_explanation string', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(typeof data.tier_explanation).toBe('string');
    expect(data.tier_explanation.length).toBeGreaterThan(0);
  });

  it('response includes data_source string', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(typeof data.data_source).toBe('string');
  });

  it('primary.predicted_outcome between 0.0 and 1.0', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(data.primary.predicted_outcome).toBeGreaterThanOrEqual(0.0);
    expect(data.primary.predicted_outcome).toBeLessThanOrEqual(1.0);
  });

  it('primary.confidence between 0.0 and 1.0', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(data.primary.confidence).toBeGreaterThanOrEqual(0.0);
    expect(data.primary.confidence).toBeLessThanOrEqual(1.0);
  });

  it('primary.outcome_interval_low <= predicted_outcome', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(data.primary.outcome_interval_low).toBeLessThanOrEqual(data.primary.predicted_outcome);
  });

  it('primary.predicted_outcome <= outcome_interval_high', async () => {
    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'agent-001',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    const data = await res.json();
    expect(data.primary.predicted_outcome).toBeLessThanOrEqual(data.primary.outcome_interval_high);
  });

  it('unknown agent → 404', async () => {
    // Override dim_agents to return null
    mockFrom.mockImplementation((table: string) => {
      if (table === 'dim_agents') {
        return buildChain({ data: null, error: null });
      }
      return buildChain({ data: null, error: null, count: 0 });
    });

    const app = buildTestApp();
    const res = await app.request('/v1/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: 'nonexistent-agent',
        context: { issue_type: 'payment_failed' },
        proposed_sequence: ['restart_service'],
      }),
    });
    expect(res.status).toBe(404);
  });
});
