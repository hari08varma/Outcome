/**
 * LayerInfinite MCP Server — types.ts
 * ══════════════════════════════════════════════════════════════
 * Shared domain types for the V2 Gateway Proxy.
 * Imports config types from config.ts; defines gateway-specific types here.
 * ══════════════════════════════════════════════════════════════
 */

import type { LIMode } from './config.js';

/** Gateway operating mode (bootstrap = mode null, observe only). */
export type GatewayMode = 'bootstrap' | LIMode;

/** Enriched tool returned by tools/list interception. */
export interface EnrichedTool {
  name: string;
  /** ENRICHED description — original woven with historical context. Never modify inputSchema. */
  description: string;
  /** UNMODIFIED — passthrough from upstream. */
  inputSchema: Record<string, unknown>;
  /** Which upstream server owns this tool. */
  upstreamName: string;
  annotations?: {
    /** 1-based rank within task (best=1). */
    ranking?: number;
    category?: 'recommended' | 'neutral' | 'warning';
  };
}

/** Context gathered before enriching tool descriptions. */
export interface EnrichmentContext {
  taskType: string;
  customerId: string;
  agentId: string;
  mode: GatewayMode;
  scores: ScoredAction[];
  policyDecision: PolicyDecision | null;
}

/** A scored action from the LI scoring engine. */
export interface ScoredAction {
  actionName: string;
  compositeScore: number;
  successRate: number;
  sampleSize: number;
  trendLabel?: string;
}

/** Policy decision from the LI policy engine. */
export interface PolicyDecision {
  action: string;
  reason: string;
  confidence: number;
}

/** A decision record — one tool invocation tracked by the gateway. */
export interface DecisionRecord {
  /** Format: dec_{ts12}_{agent4}_{rand4} — lexicographically sortable. */
  decisionId: string;
  agentId: string;
  customerId: string;
  taskType: string;
  actionName: string;
  upstreamName: string;
  /** What the agent chose. */
  originalAction: string;
  /** What actually ran (may differ in Auto mode). */
  executedAction: string;
  mode: GatewayMode;
  rerouted: boolean;
  enrichmentScores: Record<string, number>;
  /** ISO 8601 timestamp. */
  timestamp: string;
}

/** An episode — a session containing multiple decisions. */
export interface Episode {
  episodeId: string;
  agentId: string;
  sessionStart: string;
  /** Ordered list of decisionIds. */
  decisions: string[];
  /** Max 3 coachings per episode. */
  coachingCount: number;
}

/** Webhook callback from Layer 2 (session) or Layer 3 (business). */
export interface WebhookCallback {
  decisionId: string;
  /** 2 = session outcome, 3 = business outcome. */
  layer: 2 | 3;
  success: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** MCP resource definition for gateway resources. */
export interface Resource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: () => Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
}

/** MCP prompt definition for gateway prompts. */
export interface Prompt {
  name: string;
  description: string;
  arguments: Array<{ name: string; description?: string; required?: boolean }>;
  handler: () => Promise<{
    messages: Array<{
      role: 'user' | 'assistant';
      content: { type: 'text'; text: string };
    }>;
  }>;
}

/** LLM-inferred outcome classification. Agent-explicit fields override LLM. */
export interface OutcomeClassification {
  task_type: string;
  context: string;
  success: boolean;
  error_message: string | null;
  result_summary: string;
  business_outcome: 'resolved' | 'partial' | 'failed' | 'unknown';
  confidence: number;
}

/** In-memory fail-open state for circuit breaker + health tracking. */
export interface FailOpenState {
  upstreamFailures: Map<string, number>;
  circuitBreakerOpen: Map<string, boolean>;
  lastHealthCheck: Map<string, number>;
  totalRequests: number;
  passthroughRequests: number;
}

/** Outcome payload sent to LI API for logging. Fields match the API's LogOutcomeBody schema. */
export interface OutcomePayload {
  /** Internal decision ID (dec_ format) — NOT sent to API (API expects UUID). */
  decision_id?: string;
  agent_id: string;
  customer_id: string;
  /** Maps to API's `issue_type` field. */
  issue_type: string;
  action_name: string;
  upstream_name: string;
  original_action: string;
  executed_action: string;
  mode: string;
  rerouted: boolean;
  /** Required by API. Defaults to true for fire-and-forget gateway logging. */
  success: boolean;
  /** Maps to API's `response_time_ms` field. */
  response_time_ms: number;
  timestamp: string;
  ingestion_source: 'mcp';
  environment: 'staging' | 'production';
  /** LLM-inferred: what the tool call was about. */
  context?: string;
  /** LLM-inferred: error message if the tool call failed. */
  error_message?: string | null;
  /** LLM-inferred: human-readable result summary. */
  result_summary?: string;
  /** LLM-inferred: business outcome classification. */
  business_outcome?: string;
  /** LLM-inferred: confidence of the classification (0-1). */
  classification_confidence?: number;
  /** Signal strategy: 'immediate' (default), 'delayed' (pending signal registration). */
  feedback_signal?: 'immediate' | 'delayed' | 'none';
}
