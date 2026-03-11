/**
 * Layer5 SDK — TypeScript types for request/response payloads.
 *
 * Derived from the actual API contracts in:
 *   api/routes/get-scores.ts
 *   api/routes/log-outcome.ts
 *   api/routes/outcome-feedback.ts
 *
 * Mirrors the Python SDK models exactly.
 */

// ── Enums / string unions ─────────────────────────────────────

export type BusinessOutcome = 'resolved' | 'partial' | 'failed' | 'unknown';

export type FeedbackSignal = 'immediate' | 'delayed' | 'none';

export type PolicyDecision = 'exploit' | 'explore' | 'escalate';

export type TrendLabel = 'improving' | 'stable' | 'degrading' | 'critical';

export type ActionRecommendation = 'use' | 'consider' | 'avoid';

// ── Response sub-types ────────────────────────────────────────

export interface RankedAction {
  action_name: string;
  score: number;         // 0.0–1.0
  confidence: number;    // 0.0–1.0
  trend: TrendLabel;
  rank: number;
  recommendation: ActionRecommendation;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  top_action: string | null;
  explore_action: string | null;
}

export interface ContextWarning {
  type: string;
  message: string;
  recommendation: string;
  confidence_cap: number;
}

export interface AgentTrust {
  score: number;
  status: string;
}

export interface NextActions {
  policy: string;
  reason: string;
  selected_action: string | null;
  exploration_target: string | null;
}

// ── GET /v1/get-scores ────────────────────────────────────────

export interface GetScoresOptions {
  /** Agent identifier. Overrides client-level agentId. */
  agentId?: string;
  /** Context for scoring: must include issue_type or context_id. */
  context?: Record<string, unknown>;
  /** Max actions to return (default 10, max 50). */
  topN?: number;
  /** Force materialized view refresh. */
  refresh?: boolean;
  /** Episode identifier for sequence-aware scoring. */
  episodeId?: string;
  /** Actions already taken in this episode. */
  episodeHistory?: string[];
}

export interface GetScoresResponse {
  ranked_actions: RankedAction[];
  top_action: string | null;
  should_escalate: boolean | null;
  cold_start: boolean | null;
  context_id: string | null;
  customer_id: string | null;
  issue_type: string | null;
  context_match: number | null;
  context_warning: ContextWarning | null;
  view_refreshed_at: string | null;
  served_from_cache: boolean | null;
  policy: string | null;
  policy_reason: string | null;
  agent_trust: AgentTrust | null;
  meta: Record<string, unknown> | null;
  /** Decision identifier for counterfactual linking. */
  decisionId?: string | null;
  /** Recommended sequence prediction if available. */
  recommendedSequence?: SequencePrediction | null;
  /** SDK-added: round-trip latency in ms */
  latencyMs?: number;
}

// ── POST /v1/log-outcome ──────────────────────────────────────

export interface LogOutcomeOptions {
  /** Agent identifier. Overrides client-level agentId. */
  agentId?: string;
  /** The action your agent took. */
  actionName: string;
  /** Did the action technically succeed? */
  success: boolean;
  /** Context dict — mapped to raw_context + issue_type in API payload. */
  context?: Record<string, unknown>;
  /** How long the action took in ms. Alias for responseTimeMs. */
  responseMs?: number;
  /** UUID for this session/conversation. Defaults to 'sdk-auto'. */
  sessionId?: string;
  /** Issue type string. Derived from context.issue_type or actionName if omitted. */
  issueType?: string;
  /** Optional action parameters. */
  actionParams?: Record<string, unknown>;
  /** How long the action took in ms. */
  responseTimeMs?: number;
  /** Error code if action failed. */
  errorCode?: string;
  /** Error message if action failed. */
  errorMessage?: string;
  /** Raw context data. */
  rawContext?: Record<string, unknown>;
  /** Deployment environment (default: "production"). */
  environment?: string;
  /** Customer tier identifier. */
  customerTier?: string;
  /** Outcome score 0.0–1.0. */
  outcomeScore?: number;
  /** Business outcome classification. */
  businessOutcome?: BusinessOutcome;
  /** Whether feedback is immediate, delayed, or none. */
  feedbackSignal?: FeedbackSignal;
  /** Decision ID from get_scores for counterfactual linking. */
  decisionId?: string;
  /** Actions already taken in this episode. */
  episodeHistory?: string[];
}

export interface LogOutcomeResponse {
  success: boolean;
  outcome_id: string;
  action_id: string;
  context_id: string;
  timestamp: string;
  message: string;
  recommendation: string | null;
  next_actions: NextActions | null;
  /** Whether counterfactuals were computed for this outcome. */
  counterfactuals_computed?: boolean;
  /** Position in the episode sequence. */
  sequence_position?: number | null;
}

// ── POST /v1/outcome-feedback ─────────────────────────────────

export interface OutcomeFeedbackOptions {
  /** Outcome ID from the log_outcome response. */
  outcomeId: string;
  /** True outcome score (0.0–1.0). */
  finalScore: number;
  /** What actually happened. */
  businessOutcome: BusinessOutcome;
  /** Optional explanation. */
  feedbackNotes?: string;
}

export interface OutcomeFeedbackResponse {
  updated: boolean;
  outcome_id: string;
  final_score: number;
  business_outcome: string;
}

// ── Simulation types ──────────────────────────────────────────

export interface SequencePrediction {
  actions: string[];
  predicted_outcome: number;
  outcome_interval_low: number;
  outcome_interval_high: number;
  confidence: number;
  predicted_resolution: number;
  predicted_steps: number;
  better_than_proposed: boolean;
}

export interface SimulateResponse {
  primary: SequencePrediction;
  alternatives: SequencePrediction[];
  simulation_tier: 1 | 2 | 3;
  tier_explanation: string;
  data_source: string;
  episode_count: number;
  simulation_warning: string | null;
}

export interface SimulateOptions {
  /** List of action names to evaluate. */
  proposedSequence: string[];
  /** Situation descriptor. */
  context: Record<string, unknown>;
  /** Agent identifier. Overrides client-level agentId. */
  agentId?: string;
  /** Actions already taken in this episode. */
  episodeHistory?: string[];
  /** How many alternative sequences to return (0–3, default 2). */
  simulateAlternatives?: number;
  /** Maximum steps to plan ahead (1–5, default 5). */
  maxSequenceDepth?: number;
}

// ── Client options ────────────────────────────────────────────

export interface Layer5ClientOptions {
  /** API key. Falls back to LAYER5_API_KEY env var. */
  apiKey?: string;
  /** Base URL. Falls back to LAYER5_BASE_URL or https://api.layer5.dev. */
  baseUrl?: string;
  /** Request timeout in ms (default: 10000). */
  timeout?: number;
  /** Max retry attempts (default: 3). */
  maxRetries?: number;
  /** Default agent_id for all requests. */
  agentId?: string;
}
