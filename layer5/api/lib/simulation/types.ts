/**
 * Layerinfinite — lib/simulation/types.ts
 * ══════════════════════════════════════════════════════════════
 * Shared type definitions for the 3-tier simulation engine.
 * Everything depends on this — no runtime code, types only.
 * ══════════════════════════════════════════════════════════════
 */

export interface SimulationRequest {
  agentId:              string;
  context:              Record<string, unknown>;
  contextHash:          string;
  proposedSequence:     string[];   // sequence to evaluate
  episodeHistory:       string[];   // actions already taken
  simulateAlternatives: number;     // how many alternatives (0-3)
  maxSequenceDepth:     number;     // max steps to plan (default 5)
}

export interface SequencePrediction {
  actions:             string[];
  predictedOutcome:    number;      // 0.0–1.0 point estimate
  outcomeIntervalLow:  number;     // lower 95% bound
  outcomeIntervalHigh: number;     // upper 95% bound
  confidenceWidth:     number;     // interval width (key metric)
  confidence:          number;     // 1 - (confidenceWidth / 2)
  predictedResolution: number;     // probability of resolving
  predictedSteps:      number;     // expected steps to resolution
  betterThanProposed:  boolean;    // is this better than primary?
}

export interface SimulationResult {
  primary:            SequencePrediction;
  alternatives:       SequencePrediction[];
  simulationTier:     1 | 2 | 3;
  tierExplanation:    string;
  dataSource:         string;
  episodeCount:       number;
  simulationWarning:  string | null;
}

export interface WorldModelPrediction {
  q50:   number;   // median prediction
  q025:  number;   // lower 95% bound
  q975:  number;   // upper 95% bound
  width: number;   // q975 - q025
}

// LightGBM tree structure (JSON-serialized from Python)
export interface LGBMTree {
  num_leaves:    number;
  split_index:   number[];
  split_feature: number[];
  threshold:     (number | string)[];
  decision_type: string[];
  left_child:    number[];
  right_child:   number[];
  leaf_value:    number[];
}

export interface WorldModelArtifact {
  q50:              { trees: LGBMTree[]; num_trees: number };
  q025:             { trees: LGBMTree[]; num_trees: number };
  q975:             { trees: LGBMTree[]; num_trees: number };
  feature_names:    string[];
  num_features:     number;
  action_encoding:  Record<string, number>;
  context_encoding: Record<string, Record<string, number>>;
  learning_rate:    number;
  trained_at:       string;
  version:          number;
  training_episodes: number;
}
