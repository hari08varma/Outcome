/**
 * Layerinfinite — routes/get-scores.ts
 * GET /v1/get-scores
 * ══════════════════════════════════════════════════════════════
 * Returns ranked action scores for a given context.
 * Reads from mv_action_scores (never raw fact_outcomes).
 * Uses context-embed.ts for similarity matching.
 * Returns policy recommendation from policy engine.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getScores, ScoredAction } from '../lib/scoring.js';
import { supabase } from '../lib/supabase.js';
import { generateEmbedding, findClosestContext, buildContextText } from '../lib/context-embed.js';
import {
    getPolicyDecision,
    DEFAULT_TRUST,
    DEFAULT_POLICY_CONFIG,
    AgentTrustScore,
    CustomerPolicyConfig,
} from '../lib/policy-engine.js';
import { computePropensities, RankedActionEntry } from '../lib/ips-engine.js';

// ── Helper: fetch real agent trust from DB (falls back to DEFAULT_TRUST) ──
async function getAgentTrust(agentId: string | undefined): Promise<AgentTrustScore> {
    if (!agentId) return DEFAULT_TRUST;
    const { data, error } = await supabase
        .from('agent_trust_scores')
        .select('trust_score, trust_status, consecutive_failures')
        .eq('agent_id', agentId)
        .maybeSingle();
    if (error || !data) return DEFAULT_TRUST;
    return {
        trust_score: data.trust_score,
        trust_status: data.trust_status,
        consecutive_failures: data.consecutive_failures,
    };
}

// ── Helper: fetch real customer config from DB (falls back to DEFAULT_POLICY_CONFIG) ──
async function getCustomerConfig(customerId: string): Promise<CustomerPolicyConfig> {
    const { data, error } = await supabase
        .from('dim_customers')
        .select('config')
        .eq('customer_id', customerId)
        .maybeSingle();
    if (error || !data?.config) return DEFAULT_POLICY_CONFIG;
    const cfg = data.config as Record<string, unknown>;
    return {
        risk_tolerance: (['conservative', 'balanced', 'aggressive'].includes(cfg.risk_tolerance as string)
            ? cfg.risk_tolerance : 'balanced') as CustomerPolicyConfig['risk_tolerance'],
        escalation_score: typeof cfg.escalation_score === 'number' ? cfg.escalation_score : 0.20,
        exploration_rate: typeof cfg.exploration_rate === 'number' ? cfg.exploration_rate : 0.05,
        min_confidence: typeof cfg.min_confidence === 'number' ? cfg.min_confidence : 0.30,
    };
}

export const getScoresRouter = new Hono();

// ── GET /v1/get-scores ────────────────────────────────────────
getScoresRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const agentId = c.get('agent_id') as string | undefined;

    // ── Query params ──────────────────────────────────────────
    const issueType = c.req.query('issue_type');
    const contextId = c.req.query('context_id');
    const forceRefresh = c.req.query('refresh') === 'true';
    const topN = parseInt(c.req.query('top_n') ?? '10', 10);

    // ── New optional params (backward compatible) ─────────────
    const episodeId = c.req.query('episode_id') ?? null;
    const episodeHistoryRaw = c.req.query('episode_history') ?? null;
    let episodeHistory: string[] | null = null;
    if (episodeHistoryRaw) {
        try {
            const parsed = JSON.parse(episodeHistoryRaw);
            if (Array.isArray(parsed)) episodeHistory = parsed;
        } catch {
            // Invalid JSON — ignore, treat as no history
        }
    }

    // ── Fetch real trust + customer config in parallel ────────
    const [agentTrust, customerConfig] = await Promise.all([
        getAgentTrust(agentId),
        getCustomerConfig(customerId),
    ]);

    if (!issueType && !contextId) {
        return c.json(
            { error: 'Provide either issue_type or context_id query parameter', code: 'MISSING_PARAM' },
            400
        );
    }

    // ── Resolve context_id ───────────────────────────────────
    let resolvedContextId = contextId;
    let contextMatch: number | null = null;  // null = exact match

    if (!resolvedContextId && issueType) {
        // Step 1: Try exact string match (fast path)
        const { data: exactCtx, error } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('issue_type', issueType)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            return c.json({ error: 'Context lookup failed', details: error.message, code: 'DB_ERROR' }, 500);
        }

        if (exactCtx) {
            resolvedContextId = exactCtx.context_id;
            contextMatch = null;  // exact match → treated as 1.0
        } else {
            // Step 2: Try embedding similarity (graceful fallback)
            try {
                const contextText = buildContextText(issueType);
                const embedding = await generateEmbedding(contextText);

                if (embedding) {
                    const closest = await findClosestContext(embedding, customerId);
                    if (closest) {
                        resolvedContextId = closest.context_id;
                        contextMatch = closest.similarity;
                    }
                }
            } catch (err: any) {
                // Embedding failed — fall through to 404
                console.warn('[get-scores] Embedding fallback failed:', err.message);
            }

            // If still no context found → 404
            if (!resolvedContextId) {
                return c.json(
                    {
                        error: `No context found for issue_type="${issueType}". ` +
                            'Log at least one outcome first to create the context.',
                        code: 'CONTEXT_NOT_FOUND',
                    },
                    404
                );
            }
        }
    }

    // ── Fetch and score actions ───────────────────────────────
    try {
        const result = await getScores(
            customerId,
            resolvedContextId!,
            issueType ?? undefined,
            forceRefresh,
            contextMatch
        );

        // Trim to top_n
        let ranked = result.ranked_actions.slice(0, Math.min(topN, 50));

        // ── Deprioritize already-tried actions (CHANGE 4) ────
        if (episodeHistory && episodeHistory.length > 0) {
            ranked = ranked.map(action => {
                if (episodeHistory!.includes(action.action_name)) {
                    return {
                        ...action,
                        composite_score: action.composite_score * 0.3,
                        recommendation: 'avoid' as const,
                    };
                }
                return action;
            });
            // Re-sort after deprioritization
            ranked.sort((a, b) => b.composite_score - a.composite_score);
        }

        // ── Context drift check (Gap 2) ──────────────────────
        const { count: contextOutcomeCount } = await supabase
            .from('mv_action_scores')
            .select('action_id', { count: 'exact', head: true })
            .eq('customer_id', customerId)
            .eq('context_id', resolvedContextId!);

        const isUnknownContext = (contextOutcomeCount ?? 0) === 0;

        // ── Compute propensities for ranked actions ──────────
        const propensityMap = computePropensities(
            ranked.map(a => ({ action_name: a.action_name, score: a.composite_score }))
        );

        // Build ranked actions with propensities
        const rankedWithPropensity: RankedActionEntry[] = ranked.map((a, idx) => ({
            action_name: a.action_name,
            action_id: a.action_id,
            score: a.composite_score,
            rank: idx + 1,
            propensity: propensityMap.get(a.action_name) ?? 0,
        }));

        // ── Create fact_decisions record (CHANGE 2) ──────────
        let decisionId: string | null = null;
        const contextHash = `${resolvedContextId}:${issueType ?? ''}`;
        const episodePosition = episodeHistory ? episodeHistory.length : 0;
        
        if (episodeId) {
            decisionId = crypto.randomUUID();
            Promise.resolve(supabase.from('fact_decisions').insert({
                id: decisionId,
                agent_id: agentId ?? null,
                context_id: resolvedContextId,
                context_hash: contextHash,
                ranked_actions: rankedWithPropensity,
                episode_id: episodeId,
                episode_position: episodePosition,
            })).then(({ error }) => {
                if (error) console.error('[get-scores] fact_decisions insert failed:', error.message);
            }).catch((err: any) => {
                console.error('[get-scores] fact_decisions insert error:', err.message);
            });
        } else {
            console.warn('[get-scores] Skipped fact_decisions insert: missing episode_id');
        }

        // ── Sequence recommendation (CHANGE 3) ───────────────
        let recommendedSequence: {
            actions: string[];
            predicted_outcome: number;
            confidence: number;
            prediction_interval: [number, number];
            simulation_tier: 1 | 2 | 3;
            tier_explanation: string;
        } | null = null;

        if (episodeHistory && episodeHistory.length > 0) {
            try {
                const { data: seqData } = await supabase
                    .from('mv_sequence_scores')
                    .select('*')
                    .eq('context_hash', contextHash)
                    .gte('sample_count', 3);

                if (seqData && seqData.length > 0) {
                    // Find sequences that start with current episode history
                    const matching = seqData.filter((seq: any) => {
                        const seqActions: string[] = seq.action_sequence ?? [];
                        if (seqActions.length <= episodeHistory!.length) return false;
                        return episodeHistory!.every((a, i) => seqActions[i] === a);
                    });

                    if (matching.length > 0) {
                        // Pick highest mean_outcome
                        const best = matching.reduce((a: any, b: any) =>
                            (b.mean_outcome ?? 0) > (a.mean_outcome ?? 0) ? b : a
                        );
                        recommendedSequence = {
                            actions: best.action_sequence,
                            predicted_outcome: best.mean_outcome ?? 0,
                            confidence: best.wilson_ci_lower ?? 0,
                            prediction_interval: [best.wilson_ci_lower ?? 0, best.wilson_ci_upper ?? 1],
                            simulation_tier: 1,
                            tier_explanation: 'Tier 1: Empirical sequence scores from observed data',
                        };
                    }
                }
            } catch (err: any) {
                console.warn('[get-scores] Sequence lookup failed:', err.message);
            }
        }

        // ── Sequence context ─────────────────────────────────
        const sequenceContext = episodeHistory ? {
            episode_position: episodeHistory.length,
            actions_tried: episodeHistory,
            already_resolved: false,  // caller can check via episode state
        } : null;

        // ── Policy recommendation ────────────────────────────
        const policy = getPolicyDecision({
            rankedActions: ranked,
            agentTrust: agentTrust,
            customerConfig: customerConfig,
            coldStartActive: result.cold_start,
        });

        return c.json({
            ranked_actions: ranked,
            top_action: result.top_action,
            should_escalate: result.should_escalate,
            cold_start: result.cold_start,
            context_id: resolvedContextId,
            customer_id: customerId,
            issue_type: issueType ?? null,
            context_match: contextMatch,
            context_warning: isUnknownContext ? {
                type: 'context_drift',
                message: 'No outcome history for this context type.',
                recommendation: 'Cold-start protocol active. Scores are based on priors only.',
                confidence_cap: 0.3,
            } : null,
            view_refreshed_at: result.view_refreshed_at,
            scores_as_of: result.view_refreshed_at,
            scores_max_age_seconds: 300,
            served_from_cache: result.served_from_cache,
            policy: policy.policy,
            policy_reason: policy.reason,
            agent_trust: {
                score: agentTrust.trust_score,
                status: agentTrust.trust_status,
            },
            meta: {
                total_actions_scored: result.ranked_actions.length,
                top_n_returned: ranked.length,
                scoring_version: '1.0',
            },
            // ── New fields (backward compatible — null when unused) ──
            decision_id: decisionId,
            recommended_sequence: recommendedSequence,
            sequence_context: sequenceContext,
        });
    } catch (err: any) {
        console.error('[get-scores] Error:', err.message);
        return c.json(
            { error: 'Scoring service error', details: err.message, code: 'SCORING_ERROR' },
            500
        );
    }
});
