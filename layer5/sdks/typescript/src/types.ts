// Layer5 SDK — types.ts
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
    business_outcome: 'resolved' | 'failed' | 'pending';
    episode_id?: string;
    response_ms?: number;
    feedback_signal?: 'immediate' | 'delayed' | 'none';
}

export interface LogOutcomeResponse {
    logged: boolean;
    outcome_id: string;
    agent_trust_score: number;
    trust_status: string;
    policy: string;
}

export interface Layer5Config {
    apiKey: string;
    /** Default: https://your-app.railway.app */
    baseUrl?: string;
    /** Request timeout in ms. Default: 10000 */
    timeout?: number;
    /** Max retries on 429/5xx. Default: 3 */
    maxRetries?: number;
}
