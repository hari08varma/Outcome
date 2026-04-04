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
import { bufferDecision } from '../lib/decision-writer.js';
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
    const ALLOWED_TRUST_STATUSES: AgentTrustScore['trust_status'][] =
        ['trusted', 'probation', 'sandbox', 'suspended', 'new'];
    const rawStatus = String(data.trust_status ?? '').toLowerCase();
    const aliasedStatus = rawStatus === 'degraded' ? 'sandbox' : rawStatus;
    const normalizedStatus: AgentTrustScore['trust_status'] =
        ALLOWED_TRUST_STATUSES.includes(aliasedStatus as AgentTrustScore['trust_status'])
            ? (aliasedStatus as AgentTrustScore['trust_status'])
            : DEFAULT_TRUST.trust_status;

    return {
        trust_score: typeof data.trust_score === 'number'
            ? data.trust_score
            : DEFAULT_TRUST.trust_score,
        trust_status: normalizedStatus,
        consecutive_failures: typeof data.consecutive_failures === 'number'
            ? data.consecutive_failures
            : DEFAULT_TRUST.consecutive_failures,
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

const STALE_THRESHOLD_MINUTES = 10;

export const getScoresRouter = new Hono();

function normalizeEnvironment(value: string | undefined): 'production' | 'staging' | 'development' {
    const normalized = (value ?? 'production').trim().toLowerCase();
    const aliases: Record<string, 'production' | 'staging' | 'development'> = {
        prod: 'production',
        production: 'production',
        stage: 'staging',
        stg: 'staging',
        qa: 'staging',
        test: 'staging',
        uat: 'staging',
        staging: 'staging',
        dev: 'development',
        develop: 'development',
        development: 'development',
    };
    return aliases[normalized] ?? 'production';
}

// ── GET /v1/get-scores ────────────────────────────────────────
getScoresRouter.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const agentId = c.get('agent_id') as string | undefined;

    // ── Query params ──────────────────────────────────────────
    const issueType = c.req.query('issue_type');
    const contextId = c.req.query('context_id');
    const forceRefresh = c.req.query('force_refresh') === 'true' || c.req.query('refresh') === 'true';
    const requestedEnvironment = normalizeEnvironment(c.req.query('environment'));
    const _topNRaw = parseInt(c.req.query('top_n') ?? '10', 10);
    const topN = Number.isFinite(_topNRaw) && _topNRaw > 0
        ? Math.min(_topNRaw, 50)
        : 10;

    // ── New optional params (backward compatible) ─────────────
    const episodeId = c.req.query('episode_id') ?? null;
    const episodeHistoryRaw = c.req.query('episode_history') ?? null;
    let episodeHistory: string[] | null = null;
    if (episodeHistoryRaw) {
        try {
            const parsed = JSON.parse(episodeHistoryRaw);
            if (Array.isArray(parsed)) {
                // Hard cap: max 50 items, each truncated to 255 chars
                // Rationale: no real episode has >50 sequential actions; beyond that
                // is either a bug or an adversarial payload.
                episodeHistory = parsed
                    .slice(0, 50)
                    .map((item: unknown) => String(item).slice(0, 255));
            }
        } catch {
            // Invalid JSON — ignore, treat as no history
        }
    }

    // ── Fetch real trust + customer config in parallel ────────
    // NOTE: trust will be null only if agent_trust_scores row is missing.
    // fn_init_agent_trust() trigger (migration 058) prevents this for all
    // agents created via normal account setup. DEFAULT_TRUST in policy-engine.ts
    // handles the fallback; its trust_status='new' routes to forced exploration.
    const [agentTrust, customerConfig] = await Promise.all([
        getAgentTrust(agentId),
        getCustomerConfig(customerId),
    ]);

    if (!issueType && !contextId) {
        return c.json(
            { error: 'Provide either issue_type or context_id query parameter', code: 'MISSING_PARAM', agent_id: '', signal_contract: null },
            400
        );
    }

    // ── Resolve context_id ───────────────────────────────────
    let resolvedContextId = contextId;
    let contextMatch: number | null = null;  // null = exact match

    if (!resolvedContextId && issueType) {
        // Step 1: Try exact string match (fast path) — scoped to this customer
        const { data: exactCtx, error } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('customer_id', customerId)
            .eq('issue_type', issueType)
            .eq('environment', requestedEnvironment)
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
                const contextText = buildContextText(issueType, undefined, requestedEnvironment);
                const embedding = await generateEmbedding(contextText);

                if (embedding) {
                    const closest = await findClosestContext(embedding, customerId, {
                        environment: requestedEnvironment,
                    });
                    if (closest) {
                        resolvedContextId = closest.context_id;
                        contextMatch = closest.similarity;
                    }
                }
            } catch (err: any) {
                // Embedding failed — fall through to 404
                console.warn('[get-scores] Embedding fallback failed:', err.message);
            }

            // If still no context found → cold start (200, not 404)
            if (!resolvedContextId) {
                return c.json({
                    ranked_actions: [],
                    top_action: null,
                    suggested_action: null,
                    cold_start: true,
                    context_id: '',
                    agent_id: agentId ?? '',
                    policy: 'explore',
                    policy_reason: 'No prior context — cold start active',
                    served_from_cache: false,
                    cold_start_warning: {
                        message: `No context found for issue_type="${issueType}". Cold-start active.`,
                        recommendation: 'Log at least one outcome to seed this context.',
                    },
                    signal_contract: null,
                }, 200);
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
        let topActionForResponse: ScoredAction | null = result.top_action ?? null;
        let forcedColdStartExplore = false;

        // Cold-start guard: if fallback actions are entirely unknown to this customer,
        // suppress them so SDK clients enter their deterministic local cold-start path.
        if (result.cold_start && ranked.length > 0) {
            const { data: registeredActions, error: actionsError } = await supabase
                .from('dim_actions')
                .select('action_name')
                .eq('customer_id', customerId)
                .eq('is_active', true);

            if (actionsError) {
                console.warn('[get-scores] dim_actions lookup failed:', actionsError.message);
            } else {
                const registeredSet = new Set(
                    (registeredActions ?? []).map((row: any) => String(row.action_name))
                );
                const hasCustomerActionMatch = ranked.some((action) =>
                    registeredSet.has(action.action_name)
                );

                if (!hasCustomerActionMatch) {
                    ranked = [];
                    topActionForResponse = null;
                    forcedColdStartExplore = true;
                }
            }
        }

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
            decisionId = bufferDecision({
                agent_id: agentId ?? null,
                context_id: resolvedContextId!,
                context_hash: contextHash,
                ranked_actions: rankedWithPropensity,
                episode_id: episodeId,
                episode_position: episodePosition,
            });
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

        // ── Staleness signal ─────────────────────────────────
        const lastRefresh = result.view_refreshed_at ?? null;
        const ageMinutes = lastRefresh
            ? (Date.now() - new Date(lastRefresh).getTime()) / 60_000
            : null;
        const isStale = ageMinutes !== null && ageMinutes > STALE_THRESHOLD_MINUTES;

        return c.json({
            ranked_actions: ranked,
            top_action: topActionForResponse,
            should_escalate: result.should_escalate,
            cold_start: result.cold_start,
            context_id: resolvedContextId,
            agent_id: agentId ?? '',
            customer_id: customerId,
            issue_type: issueType ?? null,
            environment: requestedEnvironment,
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
            scoring_metadata: {
                view_refreshed_at: lastRefresh,
                is_stale: isStale,
                stale_threshold_minutes: STALE_THRESHOLD_MINUTES,
            },
            served_from_cache: result.served_from_cache,
            policy: forcedColdStartExplore ? 'explore' : policy.policy,
            policy_reason: forcedColdStartExplore
                ? 'cold_start_unregistered_global_fallback'
                : policy.reason,
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
            // ── Phase 1: Signal contract (always null until Phase 4) ──
            // Phase 4 will replace this with a real lookup when a Signal
            // Contract exists for the top_action. Phase 6's instrument.py
            // uses this to decide whether to use the contract or fall back
            // to Causal Graph Tracking.
            signal_contract: null,
        });
    } catch (err: any) {
        console.error('[get-scores] Error:', err.message);
        return c.json(
            { error: 'Scoring service error', details: err.message, code: 'SCORING_ERROR', signal_contract: null },
            500
        );
    }
});
