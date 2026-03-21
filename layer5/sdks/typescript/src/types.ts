// Layerinfinite SDK — types.ts
// Shared TypeScript interfaces for request/response payloads.

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
    policy: 'exploit' | 'explore' | 'escalate';
    cold_start: boolean;
    context_id: string;
    agent_id: string;
    served_from_cache?: boolean;
}

export interface LogOutcomeRequest {
    agent_id: string;
    action_id: string;
    context_id: string;
    issue_type: string;
    success: boolean;
    /** Must be between 0.0 and 1.0 */
    outcome_score: number;
    /**
     * Outcome label for reporting. API accepts any string and normalizes:
     * - 'resolved' | 'partial' | 'failed' | 'unknown' → stored as-is
     * - any other value (e.g. 'unresolved', 'escalated') → stored as 'unknown'
     * @example 'resolved' | 'partial' | 'failed' | 'unknown'
     */
    business_outcome?: string;
    episode_id?: string;
    response_ms?: number;
    /**
     * When feedback was received. API accepts any string and normalizes:
     * - 'immediate' | 'delayed' | 'none' → stored as-is
     * - any other value (e.g. 'async', 'webhook') → stored as 'none'
     * @example 'immediate' | 'delayed' | 'none'
     */
    feedback_signal?: string;
}

export interface LogOutcomeResponse {
    logged: boolean;
    outcome_id: string;
    agent_trust_score: number;
    trust_status: string;
    policy: string;
}

export interface LayerinfiniteConfig {
    apiKey: string;
    /** Default: https://outcome-production.up.railway.app */
    baseUrl?: string;
    /** Request timeout in ms. Default: 10000 */
    timeout?: number;
    /** Max retries on 429/5xx. Default: 3 */
    maxRetries?: number;
}
