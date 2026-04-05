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
    cold_start: boolean;
    context_id: string;
    agent_id: string;
    served_from_cache?: boolean;
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
}

export type TrustStatus =
    | 'trusted'
    | 'probation'
    | 'sandbox'
    | 'suspended'
    | 'new';

export interface LogOutcomeResponse {
    logged: boolean;
    outcome_id: string;
    agent_trust_score: number;
    trust_status: TrustStatus;
    policy: string;
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