/**
 * Layerinfinite — lib/scoring.ts
 * ══════════════════════════════════════════════════════════════
 * 5-Factor Composite Scoring Engine
 * ══════════════════════════════════════════════════════════════
 *
 * FORMULA:
 *   composite_score = (
 *     w_success  * weighted_success_rate  +
 *     w_conf     * confidence             +
 *     w_trend    * trend_factor           +
 *     w_salience * salience_factor        +
 *     w_recency  * recency_factor
 *   )
 *
 * Weights sum to 1.0. All inputs are normalised to [0, 1].
 *
 * Salience = importance weight of this action (from database).
 * Cold-start (confidence < MIN_CONFIDENCE): returns institutional priors.
 *
 * IN-MEMORY CACHE (5 min TTL):
 *   One entry per (action_id, context_id, customer_id).
 *   Refreshed on scoring-engine cron or on-demand.
 *   Falls back to DB query on cache miss.
 */

import { supabase, ActionScore } from './supabase.js';

// ── Weights ──────────────────────────────────────────────────
const W_SUCCESS = 0.40;  // primary driver
const W_CONF = 0.20;  // uncertainty penalty
const W_TREND = 0.20;  // directional momentum
const W_SALIENCE = 0.10;  // action importance
const W_RECENCY = 0.10;  // freshness bonus

// Bayesian (Laplace) smoothing priors for composite score calculation.
// Used in computeCompositeScore(): (successes + α) / (total + α + β).
// NOTE: These are NOT used in updateAgentTrust() (outcome-orchestrator.ts),
// which uses exponential smoothing independently.
export const PRIOR_ALPHA = 1.0;  // Laplace prior successes (neutral = 1)
export const PRIOR_BETA  = 1.0;  // Laplace prior failures  (neutral = 1)

// ── Thresholds ───────────────────────────────────────────────
const MIN_CONFIDENCE = 0.30;  // below this → cold-start fallback
const ESCALATION_SCORE = 0.20;  // below this → escalate_human
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

// ── In-Memory Score Cache ─────────────────────────────────────
interface CacheEntry {
    scores: ScoredAction[];
    expires_at: number;
}

const scoreCache = new Map<string, CacheEntry>();

// Evict expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000;
setInterval(() => {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of scoreCache.entries()) {
        if (entry.expires_at < now) {
            scoreCache.delete(key);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.info(`[cache-cleanup] Evicted ${evicted} expired entries from scoreCache`);
    }
}, CLEANUP_INTERVAL_MS).unref();

setInterval(() => {
    console.info(`[cache-size] scoreCache: ${scoreCache.size} entries`);
}, 15 * 60_000).unref();

function cacheKey(customerId: string, contextId: string): string {
    return `${customerId}:${contextId}`;
}

export function invalidateCache(customerId?: string, contextId?: string): void {
    if (customerId && contextId) {
        scoreCache.delete(cacheKey(customerId, contextId));
    } else {
        scoreCache.clear();
    }
}

/**
 * Returns the cached composite score for a specific action in a context.
 * Used by log-outcome.ts for salience sampling:
 *   if (score > 0.9 && success) → salience = 0.1 (sampled down)
 * Returns null on cache miss (caller defaults to salience=1.0).
 */
export function getCachedScore(
    actionId: string,
    contextId: string,
    customerId: string
): number | null {
    // Scan the cache for this customer+context
    const key = cacheKey(customerId, contextId);
    const cached = scoreCache.get(key);
    if (!cached || cached.expires_at <= Date.now()) return null;

    const match = cached.scores.find(s => s.action_id === actionId);
    return match ? match.composite_score : null;
}

// ── Scoring types ─────────────────────────────────────────────
export type TrendLabel = 'stable' | 'improving' | 'degrading' | 'critical';

export function trendLabel(trendDelta: number | null): TrendLabel {
    if (trendDelta === null) return 'stable';
    if (trendDelta < -0.15) return 'critical';
    if (trendDelta < -0.05) return 'degrading';
    if (trendDelta > 0.05) return 'improving';
    return 'stable';
}

export interface ScoredAction {
    action_id: string;
    action_name: string;
    action_category: string;
    composite_score: number;
    confidence: number;
    trend_delta: number | null;
    trend: TrendLabel;
    total_attempts: number;
    is_cold_start: boolean;
    is_low_sample: boolean;
    recommendation: 'recommend' | 'neutral' | 'avoid' | 'escalate';
}

export interface ScoringResult {
    ranked_actions: ScoredAction[];
    top_action: ScoredAction;
    should_escalate: boolean;
    cold_start: boolean;
    context_id: string;
    customer_id: string;
    view_refreshed_at: string | null;
    served_from_cache: boolean;
}

// ── 5-Factor scoring formula ─────────────────────────────────
/**
 * @param contextMatch — cosine similarity from context-embed.ts.
 *   null means exact match (fallback) → treated as 1.0.
 */
export function computeCompositeScore(row: ActionScore, contextMatch: number | null = null): number {
    // Factor 1: Weighted success rate (primary)
    // Applied Bayesian smoothing (Laplace / Beta distribution prior):
    const rawSuccessRate = row.weighted_success_rate ?? row.raw_success_rate ?? 0;
    const n = row.total_attempts ?? 0;

    // Bayesian smoothed rate:
    // (successes + alpha) / (total + alpha + beta)
    const f_success = (rawSuccessRate * n + PRIOR_ALPHA) / (n + PRIOR_ALPHA + PRIOR_BETA);

    // Factor 2: Confidence (Wilson-style: n/(n+10))
    const f_conf = row.confidence ?? 0;

    // Factor 3: Trend delta → normalised to [0,1]
    const rawTrend = row.trend_delta ?? 0;
    const f_trend = Math.max(0, Math.min(1, (rawTrend + 0.5)));

    // Factor 4: Salience — currently 1.0 per row (Phase 5 extensibility)
    const f_salience = 1.0;

    // Factor 5: Recency — bonus if last outcome < 24h ago
    let f_recency = 0.5;  // neutral default
    if (row.last_outcome_at) {
        const ageHours = (Date.now() - new Date(row.last_outcome_at).getTime()) / 3_600_000;
        f_recency = Math.max(0, Math.min(1, 1 - (ageHours / 168)));  // decay over 7 days
    }

    // Context match factor: null → 1.0 (exact match assumed)
    const f_context = contextMatch ?? 1.0;

    return (
        W_SUCCESS * f_success +
        W_CONF * f_conf +
        W_TREND * f_trend +
        W_SALIENCE * f_salience +
        W_RECENCY * f_recency
    ) * f_context;  // scale by context similarity
}

function toRecommendation(score: number, isEscalate: boolean): ScoredAction['recommendation'] {
    if (isEscalate) return 'escalate';
    if (score >= 0.65) return 'recommend';
    if (score >= 0.40) return 'neutral';
    return 'avoid';
}

// ── Main query ────────────────────────────────────────────────
async function fetchScoresFromDB(
    customerId: string,
    contextId: string
): Promise<{ scores: ActionScore[]; view_refreshed_at: string | null }> {
    const { data, error } = await supabase
        .from('mv_action_scores')
        .select('*')
        .eq('customer_id', customerId)
        .eq('context_id', contextId)
        .order('weighted_success_rate', { ascending: false });

    if (error) throw new Error(`Score query failed: ${error.message}`);

    const refreshedAt = data && data.length > 0
        ? data[0].view_refreshed_at
        : null;

    return { scores: (data ?? []) as ActionScore[], view_refreshed_at: refreshedAt };
}

// ── Institutional knowledge fallback ─────────────────────────
async function fetchInstitutionalFallback(
    contextType: string
): Promise<ScoredAction[]> {
    // JOIN dim_actions so we get real action names, not just IDs
    const { data, error } = await supabase
        .from('dim_institutional_knowledge')
        .select(`
            action_id,
            avg_success_rate,
            sample_count,
            context_type,
            dim_actions!inner(action_id, action_name, action_category)
        `)
        .eq('context_type', contextType)
        .order('avg_success_rate', { ascending: false });

    if (error || !data || data.length === 0) return [];

    return data.map((row: any): ScoredAction => ({
        action_id: row.action_id,
        action_name: row.dim_actions?.action_name ?? row.action_id,
        action_category: row.dim_actions?.action_category ?? 'unknown',
        composite_score: Math.round((row.avg_success_rate ?? 0) * 10000) / 10000,
        confidence: 0,  // no per-customer data yet
        trend_delta: null,
        trend: 'stable',
        total_attempts: row.sample_count ?? 0,
        is_cold_start: true,
        is_low_sample: (row.sample_count ?? 0) < 3,
        recommendation: toRecommendation(row.avg_success_rate ?? 0, false),
    }));
}

// ── Global fallback (Tier 3) ──────────────────────────────────
// Used when no context-specific priors exist for the given issue_type.
// Queries context_type = 'global' — always non-empty after migration 066.
// After this tier, ranked_actions is never empty.
async function fetchGlobalFallback(): Promise<ScoredAction[]> {
    const { data, error } = await supabase
        .from('dim_institutional_knowledge')
        .select(`
            action_id,
            avg_success_rate,
            sample_count,
            context_type,
            dim_actions!inner(action_id, action_name, action_category)
        `)
        .eq('context_type', 'global')
        .order('avg_success_rate', { ascending: false });

    if (error || !data || data.length === 0) return [];

    return data.map((row: any): ScoredAction => ({
        action_id:       row.action_id,
        action_name:     row.dim_actions?.action_name ?? row.action_id,
        action_category: row.dim_actions?.action_category ?? 'unknown',
        composite_score: Math.round((row.avg_success_rate ?? 0) * 10000) / 10000,
        confidence:      0,
        trend_delta:     null,
        trend:           'stable',
        total_attempts:  row.sample_count ?? 0,
        is_cold_start:   true,
        is_low_sample:   false,
        recommendation:  toRecommendation(row.avg_success_rate ?? 0, false),
    }));
}

// ── Public API ────────────────────────────────────────────────
export async function getScores(
    customerId: string,
    contextId: string,
    contextType?: string,
    forceRefresh = false,
    contextMatch: number | null = null
): Promise<ScoringResult> {
    const key = cacheKey(customerId, contextId);
    const cached = scoreCache.get(key);

    // Serve from cache if valid and not forced
    if (!forceRefresh && cached && cached.expires_at > Date.now()) {
        const top = cached.scores[0];
        return {
            ranked_actions: cached.scores,
            top_action: top,
            should_escalate: top?.composite_score < ESCALATION_SCORE,
            cold_start: top?.is_cold_start ?? false,
            context_id: contextId,
            customer_id: customerId,
            view_refreshed_at: null,
            served_from_cache: true,
        };
    }

    // Fetch from materialized view
    const { scores: rawScores, view_refreshed_at } = await fetchScoresFromDB(customerId, contextId);

    let scoredActions: ScoredAction[];
    let isColdStart = false;

    if (rawScores.length === 0 || rawScores.every(r => r.confidence < MIN_CONFIDENCE)) {
        isColdStart = true;

        // Tier 2: context-specific institutional priors
        let fallback = contextType
            ? await fetchInstitutionalFallback(contextType)
            : [];

        // Tier 3: global fallback — ranked_actions is NEVER empty after migration 066
        if (fallback.length === 0) {
            console.info(
                `[scoring] No priors for context_type="${contextType ?? 'none'}". ` +
                `Using global fallback.`
            );
            fallback = await fetchGlobalFallback();
        }

        scoredActions = fallback;
    } else {
        scoredActions = rawScores.map((row): ScoredAction => {
            const score = computeCompositeScore(row, contextMatch);
            return {
                action_id: row.action_id,
                action_name: row.action_name,
                action_category: row.action_category,
                composite_score: Math.round(score * 10000) / 10000,
                confidence: row.total_attempts < 3 ? Math.min(row.confidence, 0.25) : row.confidence,
                trend_delta: row.trend_delta,
                trend: trendLabel(row.trend_delta),
                total_attempts: row.total_attempts,
                is_cold_start: false,
                is_low_sample: row.total_attempts < 3,
                recommendation: toRecommendation(score, false),
            };
        }).sort((a, b) => b.composite_score - a.composite_score);
    }

    // Store in cache
    scoreCache.set(key, { scores: scoredActions, expires_at: Date.now() + CACHE_TTL_MS });

    const top = scoredActions[0] ?? null;

    return {
        ranked_actions: scoredActions,
        top_action: top,
        should_escalate: !top || top.composite_score < ESCALATION_SCORE,
        cold_start: isColdStart,
        context_id: contextId,
        customer_id: customerId,
        view_refreshed_at: view_refreshed_at,
        served_from_cache: false,
    };
}

// Export constants for tests
export { MIN_CONFIDENCE, ESCALATION_SCORE, W_SUCCESS, W_CONF, W_TREND, W_SALIENCE, W_RECENCY };

/**
 * Compute the effective score for an outcome.
 * If outcome_score is provided and valid (0.0–1.0), use it.
 * Otherwise fall back to binary: success=1.0, failure=0.0.
 *
 * This mirrors the DB-level COALESCE(outcome_score, success::FLOAT)
 * used in mv_action_scores, but for application-level logic.
 */
export function computeEffectiveScore(
    success: boolean,
    outcomeScore?: number
): number {
    if (outcomeScore !== undefined && outcomeScore >= 0.0 && outcomeScore <= 1.0) {
        return outcomeScore;
    }
    return success ? 1.0 : 0.0;
}
