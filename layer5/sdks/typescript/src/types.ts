// Layerinfinite SDK — types.ts
// All interfaces and type definitions.

// ── Existing API types (keep exactly — wire format is snake_case) ──

export interface ScoredAction {
    action_id: string;
    action_name: string;
    action_category: string;
    composite_score: number;
    confidence: number;
    total_attempts: number;
    policy_reason?: string;
    is_cold_start?: boolean;
    is_low_sample?: boolean;
}

export interface GetScoresResponse {
    ranked_actions: ScoredAction[];
    top_action: ScoredAction | null;
    policy: 'exploit' | 'explore' | 'escalate' | 'SANDBOX';
    policy_selected_action?: string | null;
    policy_exploration_target?: string | null;
    runtime_guardrail?: {
        enabled: boolean;
        shadow_applied?: boolean;
        assisted_actions?: number;
        top_action_shadow_weight?: number;
        confidence_ceiling_applied: boolean;
        exploit_gate_applied: boolean;
        confidence_ceiling: number;
        exploit_gate_min_samples: number;
    } | null;
    cold_start: boolean;
    /** How many more outcomes to log before LI activates recommendations for this task. 0 when not cold-starting. */
    outcomes_needed: number;
    context_id: string;
    agent_id: string;
    served_from_cache?: boolean;
    /**
     * True when the top two actions are statistically indistinguishable
     * (score gap ≤ 0.05, both in the 40–65% win-rate band).
     * LI is abstaining correctly — exclude this task from accuracy metrics.
     */
    is_ambiguous_task?: boolean;
}

/**
 * Public log-outcome request shape (backward-compat).
 * Used by the deprecated li.logOutcome() public method only.
 * Internal auto-logging uses InternalLogPayload in client.ts.
 */
export interface LogOutcomeRequest {
    agent_id: string;
    action_id: string;
    context_id: string;
    issue_type: string;
    success: boolean;
    /** Must be between 0.0 and 1.0 */
    outcome_score: number;
    business_outcome?: string;
    episode_id?: string;
    response_ms?: number;
    feedback_signal?: string;
    /** Optional idempotency key for replay-safe outcome ingestion. */
    idempotency_key?: string;
}

export type TrustStatus =
    | 'trusted'
    | 'probation'
    | 'sandbox'
    | 'suspended'
    | 'new';

export interface IngestionQuality {
    /** 0.0–1.0 completeness score for this event. */
    data_quality: number;
    /** 'provided' = developer sent outcome_score; 'inferred' = absent, fell back to binary. */
    score_origin: 'provided' | 'inferred';
    /** TRUE when success=true but outcome_score < inconsistency threshold. */
    is_inconsistent: boolean;
    /** Exact tier from issue_type → task_name resolution. */
    mapping_tier: string;
    /** Confidence (0.0–1.0) of issue_type → task_name mapping. */
    mapping_confidence: number;
}

export interface LogOutcomeResponse {
    logged: boolean;
    outcome_id: string;
    agent_trust_score: number;
    trust_status: TrustStatus;
    policy: string;
    /** Ingestion quality metadata for this event. Present on all 201 responses. */
    ingestion_quality?: IngestionQuality;
}

export type PendingProviderHint = 'stripe' | 'sendgrid' | 'generic';

export interface PendingSignalRequest {
    outcome_id: string;
    action_name: string;
    provider_hint?: PendingProviderHint | null;
    feedback_signal?: 'delayed';
}

export interface PendingSignalResponse {
    registration_id: string;
    outcome_id: string;
    created_at: string;
    idempotent_replay: boolean;
    pending_state?: {
        signal_pending: boolean;
        cross_event_status: string;
    };
}

export interface OutcomeFeedbackRequest {
    outcome_id: string;
    final_score: number;
    business_outcome: string;
    feedback_notes?: string;
}

export interface OutcomeFeedbackResponse {
    updated: boolean;
    outcome_id: string;
    final_score: number;
    business_outcome: string;
    cross_event_status: string;
    cross_event_conflict: boolean;
}

export interface DiscrepancyDetectResponse {
    detected: number;
    cases: {
        expired: number;
        mismatch: number;
        low_confidence: number;
    };
    advanced_cases: {
        cross_event_conflict: number;
        pending_state_mismatch: number;
        ingestion_inconsistency: number;
    };
}

export interface DiscrepancySummaryResponse {
    total: number;
    by_type: Record<string, number>;
}

export interface DiscrepancyDriftOptions {
    /** If set, rates are computed against this denominator; otherwise only share metrics are returned. */
    observedOutcomes?: number;
    /** Run /v1/discrepancies/detect before reading summary. Default: true. */
    runDetection?: boolean;
}

export interface DiscrepancyDriftSnapshot {
    open_total_discrepancies: number;
    open_conflict_discrepancies: number;
    open_conflict_share: number;
    discrepancy_rate: number | null;
    conflict_rate: number | null;
    detected_now: number | null;
    detected_conflicts_now: number | null;
    by_type: Record<string, number>;
}

export interface DelayedSignalMetadata {
    outcome_id: string;
    stripe: {
        metadata: {
            layerinfinite_outcome_id: string;
        };
    };
    sendgrid: {
        unique_args: {
            outcome_id: string;
        };
    };
    generic: {
        outcome_id: string;
    };
}

// ── v0.3.0 Config ──────────────────────────────────────────────────

export interface LayerinfiniteConfig {
    /** Required. Must start with 'layerinfinite_'. */
    apiKey: string;
    /** Required. Identifies your agent in the dashboard. */
    agentId: string;
    /** 'recommend' | 'assist' | 'auto'. Default: 'recommend'. */
    mode?: 'recommend' | 'assist' | 'auto';
    /** Confidence threshold for auto mode (0.0–1.0). Default: 0.7. */
    confidenceThreshold?: number;
    /** Auto-try next action on failure in auto mode. Default: true. */
    autoFallback?: boolean;
    /** Sync action names to dashboard on registration. Default: true. */
    autoRegister?: boolean;
    /** Default: 'https://api.layerinfinite.app' */
    baseUrl?: string;
    /** Optional fallback API URLs (used after baseUrl on network/server failures). */
    baseUrls?: string[];
    /** Request timeout in ms. Default: 10000. */
    timeout?: number;
    /** Max retries on 429/5xx/timeouts/network errors. Default: 3. */
    maxRetries?: number;
}

// ── Action Registry ────────────────────────────────────────────────

export type ActionFunction<TArgs extends any[] = any[], TReturn = any> =
    (...args: TArgs) => TReturn | Promise<TReturn>;

export type WrappedActionFunction<TArgs extends any[] = any[], TReturn = any> =
    (...args: TArgs) => Promise<TReturn>;

export interface ActionEntry {
    fn: ActionFunction;
    name: string;
    task: string;
    registeredVia: 'wrapper' | 'manual';
    createdAt: string; // ISO timestamp
}

// ── Suggest / Recommend / Observe ──────────────────────────────────

export interface RankedAction {
    actionName: string;
    score: number;
    confidence: number;
}

export interface Suggestion {
    actionName: string;
    confidence: number;
    reason: string;
    ranked: RankedAction[];
}

export interface RecommendationDataFreshness {
    source: 'mv' | 'fact_fallback' | 'unknown';
    lastSeenAt: string | null;
    ageHours: number | null;
    isStale: boolean;
    staleThresholdHours: number;
}

export interface Recommendation {
    task: string;
    state: 'no_data' | 'early_signal' | 'close' | 'stable';
    problem: string | null;
    recommendation: string | null;
    expectedImprovement: {
        baseline: string;
        improved: string;
        delta: string;
    } | null;
    dataFreshness: RecommendationDataFreshness | null;
    reason: string | null;
    confidence: number | null;
}

export interface ObservationSummary {
    task: string;
    totalRuns: number;
    successRate: number;
    actionsSeen: string[];
    bestPerforming: string | null;
    worstPerforming: string | null;
    lastRun: string | null;
}