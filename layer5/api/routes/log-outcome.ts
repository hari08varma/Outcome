/**
 * Layer5 — routes/log-outcome.ts
 * POST /v1/log-outcome
 * ══════════════════════════════════════════════════════════════
 * Appends one outcome to fact_outcomes.
 * Action validation handled by validateActionMiddleware (upstream).
 * Returns outcome + policy recommendation from policy engine.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { invalidateCache, getCachedScore, getScores } from '../lib/scoring.js';
import {
    getPolicyDecision,
    DEFAULT_TRUST,
    DEFAULT_POLICY_CONFIG,
    AgentTrustScore,
    CustomerPolicyConfig,
} from '../lib/policy-engine.js';
import { writeCounterfactuals } from '../lib/ips-engine.js';
import { upsertSequence, closeSequence } from '../lib/sequence-tracker.js';

export const logOutcomeRouter = new Hono();

// ── Helper: fetch real agent trust (falls back to DEFAULT_TRUST) ──
async function getAgentTrust(agentId: string): Promise<AgentTrustScore> {
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

// ── Helper: fetch real customer config (falls back to DEFAULT_POLICY_CONFIG) ──
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

// ── Helper: update agent trust after outcome ──
async function updateAgentTrust(agentId: string, customerId: string, success: boolean): Promise<void> {
    const { data: trust } = await supabase
        .from('agent_trust_scores')
        .select('trust_id, trust_score, total_decisions, correct_decisions, consecutive_failures, trust_status')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (!trust) return;  // no trust row → skip (shouldn't happen with trigger)

    const oldScore = trust.trust_score;
    const oldStatus = trust.trust_status;
    let newScore: number;
    let newFailures: number;
    let newCorrect = trust.correct_decisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        newScore = Math.min(trust.trust_score * 1.03, 1.0);
    } else {
        newFailures = trust.consecutive_failures + 1;
        newScore = trust.trust_score * Math.pow(0.9, newFailures);
    }

    // Determine new status
    let newStatus: string;
    if (newScore < 0.3 || newFailures >= 5) {
        newStatus = 'suspended';
    } else if (newScore < 0.6) {
        newStatus = 'probation';
    } else {
        newStatus = 'trusted';
    }

    await supabase
        .from('agent_trust_scores')
        .update({
            trust_score: newScore,
            total_decisions: trust.total_decisions + 1,
            correct_decisions: newCorrect,
            consecutive_failures: newFailures,
            trust_status: newStatus,
            suspension_reason: newStatus === 'suspended'
                ? (newFailures >= 5 ? 'consecutive_failures_exceeded' : 'trust_score_below_threshold')
                : null,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);

    // Log to audit if status changed
    if (oldStatus !== newStatus) {
        await supabase.from('agent_trust_audit').insert({
            agent_id: agentId,
            customer_id: customerId,
            event_type: newStatus === 'suspended' ? 'suspended' : 'recalibrated',
            old_score: oldScore,
            new_score: newScore,
            old_status: oldStatus,
            new_status: newStatus,
            reason: newStatus === 'suspended'
                ? `Auto-suspended: score=${newScore.toFixed(3)}, consecutive_failures=${newFailures}`
                : `Trust recalibrated: ${oldStatus} → ${newStatus}`,
        });
    }
}

import type { SupabaseClient } from '@supabase/supabase-js';

// ── CONTEXT DRIFT DETECTION (Gap 2) ──────────────────────────
async function detectContextDrift(
    sb: SupabaseClient,
    customerId: string,
    contextType: string,
    agentId: string
): Promise<void> {
    // Count outcomes for this exact context_type
    const { count } = await sb
        .from('fact_outcomes')
        .select('outcome_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .contains('raw_context', { issue_type: contextType });

    const isNewContext = (count ?? 0) === 0;
    if (!isNewContext) return;

    // 24h dedup — don't spam on every request
    const { data: recentAlert } = await sb
        .from('degradation_alert_events')
        .select('alert_id')
        .eq('customer_id', customerId)
        .eq('alert_type', 'context_drift')
        .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

    if (recentAlert && recentAlert.length > 0) return;

    await sb.from('degradation_alert_events').insert({
        customer_id: customerId,
        alert_type: 'context_drift',
        severity: 'warning',
        message: `New context type detected: "${contextType}". No outcome history exists. Cold-start protocol will activate. Monitor this agent closely.`,
    });
}

// ── SILENT FAILURE DETECTION (Gap 5) ─────────────────────────
async function detectSilentFailure(
    sb: SupabaseClient,
    outcome: {
        outcome_id: string;
        customer_id: string;
        agent_id: string;
        action_id: string;
        action_name: string;
        success: boolean;
        outcome_score: number | null;
    }
): Promise<void> {
    // Pattern: success=true but outcome_score < 0.3
    const isSilentFailure =
        outcome.success === true &&
        outcome.outcome_score !== null &&
        outcome.outcome_score < 0.3;

    if (!isSilentFailure) return;

    await sb.from('degradation_alert_events').insert({
        customer_id: outcome.customer_id,
        action_id: outcome.action_id,
        alert_type: 'degradation',
        severity: 'warning',
        current_value: outcome.outcome_score,
        baseline_value: 1.0,
        message: `Silent failure detected on "${outcome.action_name}": success=true but outcome_score=${outcome.outcome_score}. Technical success, business failure. Score will reflect true outcome.`,
    });
}

// ── Request schema ────────────────────────────────────────────
const LogOutcomeBody = z.object({
    session_id: z.string().uuid(),
    // idempotency_key: Optional. Include a unique string
    // (UUID recommended) to make this call idempotent.
    // If you retry with the same key within 24 hours,
    // Layer5 returns the original result without creating
    // a duplicate outcome record.
    // Example: idempotency_key: crypto.randomUUID()
    idempotency_key: z.string().max(255).optional(),
    action_name: z.string().min(1).max(255),
    action_params: z.record(z.string(), z.unknown()).optional(),
    issue_type: z.string().min(1).max(255),
    success: z.boolean(),
    response_time_ms: z.number().int().positive().optional(),
    error_code: z.string().max(100).optional(),
    error_message: z.string().max(1000).optional(),
    raw_context: z.record(z.string(), z.unknown()).optional(),
    environment: z.enum(['production', 'staging', 'development']).optional().default('production'),
    customer_tier: z.enum(['free', 'pro', 'enterprise']).optional(),
    // 3-tier outcome scoring (all optional — backward compatible)
    outcome_score: z.number().min(0.0).max(1.0).optional(),
    business_outcome: z.enum(['resolved', 'partial', 'failed', 'unknown']).optional(),
    feedback_signal: z.enum(['immediate', 'delayed', 'none']).optional(),
    // Counterfactual & sequence fields (optional — backward compatible)
    decision_id: z.string().uuid().optional(),
    episode_id: z.string().uuid().optional(),
    episode_history: z.array(z.string()).optional(),
});

// ── Salience sampling (per implementation plan) ──────────────
function computeSalience(
    actionId: string,
    contextId: string,
    customerId: string,
    success: boolean
): number {
    const cachedScore = getCachedScore(actionId, contextId, customerId);
    if (cachedScore !== null && cachedScore > 0.9 && success) {
        return 0.1;  // downsample high-confidence successes
    }
    return 1.0;
}

// ── Payload size guard (64KB) ─────────────────────────────────
const MAX_RAW_CONTEXT_BYTES = 64 * 1024;

// ── POST /v1/log-outcome ──────────────────────────────────────
logOutcomeRouter.post('/', async (c) => {
    const agentId = c.get('agent_id') as string;
    const customerId = c.get('customer_id') as string;

    // Use parsed body from validate-action middleware if available
    let body: z.infer<typeof LogOutcomeBody>;
    try {
        const raw = c.get('parsed_body') ?? await c.req.json();
        body = LogOutcomeBody.parse(raw);
    } catch (err: any) {
        return c.json(
            { error: 'Invalid request body', details: err.errors ?? err.message, code: 'VALIDATION_ERROR' },
            400
        );
    }

    // ── Idempotency Check (FIX 2) ───────────────────────────
    if (body.idempotency_key) {
        const { data: existing } = await supabase
            .from('fact_outcome_idempotency')
            .select('outcome_id')
            .eq('idempotency_key', body.idempotency_key)
            .maybeSingle();

        if (existing) {
            // Return original outcome data
            const { data: originalOutcome } = await supabase
                .from('fact_outcomes')
                .select('outcome_id, action_id, context_id, timestamp, success')
                .eq('outcome_id', existing.outcome_id)
                .single();

            if (originalOutcome) {
                c.header('Idempotent-Replayed', 'true');
                return c.json({
                    success: originalOutcome.success,
                    outcome_id: originalOutcome.outcome_id,
                    action_id: originalOutcome.action_id,
                    context_id: originalOutcome.context_id,
                    timestamp: originalOutcome.timestamp,
                    message: `Outcome previously logged (idempotent replay). Action "${body.action_name}" — ${originalOutcome.success ? 'SUCCESS' : 'FAILURE'}`,
                    idempotency_replayed: true,
                }, 200);
            }
        }
    }

    // ── Payload size check ───────────────────────────────────
    if (body.raw_context) {
        const contextSize = new TextEncoder().encode(JSON.stringify(body.raw_context)).length;
        if (contextSize > MAX_RAW_CONTEXT_BYTES) {
            return c.json(
                { error: 'PAYLOAD_TOO_LARGE', message: 'raw_context exceeds 64KB limit' },
                413
            );
        }
    }

    // ── Get validated action from middleware context ──────────
    const validatedAction = c.get('validated_action') as
        { action_id: string; action_name: string; action_category: string } | undefined;

    let actionId: string;
    if (validatedAction) {
        actionId = validatedAction.action_id;
    } else {
        // Fallback: validate directly (when middleware not in chain)
        const { validateAction } = await import('../middleware/validate-action.js');
        const result = await validateAction(body.action_name, body.action_params);
        if (!result.valid) {
            return c.json({ error: result.error_code ?? 'UNKNOWN_ACTION', message: result.error }, 400);
        }
        actionId = result.action_id!;
    }

    // ── Resolve or create context ────────────────────────────
    let contextId: string;
    {
        const { data: existingCtx } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('issue_type', body.issue_type)
            .eq('environment', body.environment)
            .maybeSingle();

        if (existingCtx) {
            contextId = existingCtx.context_id;
        } else {
            const { data: newCtx, error: ctxErr } = await supabase
                .from('dim_contexts')
                .insert({
                    issue_type: body.issue_type,
                    environment: body.environment,
                    customer_tier: body.customer_tier ?? null,
                })
                .select('context_id')
                .single();

            if (ctxErr || !newCtx) {
                return c.json(
                    { error: 'Failed to resolve context', details: ctxErr?.message, code: 'CONTEXT_ERROR' },
                    500
                );
            }
            contextId = newCtx.context_id;
        }
    }

    // ── Insert outcome (APPEND-ONLY) ─────────────────────────
    const { data: outcome, error: insertErr } = await supabase
        .from('fact_outcomes')
        .insert({
            agent_id: agentId,
            action_id: actionId,
            context_id: contextId,
            customer_id: customerId,
            session_id: body.session_id,
            success: body.success,
            response_time_ms: body.response_time_ms ?? null,
            error_code: body.error_code ?? null,
            error_message: body.error_message ?? null,
            raw_context: body.raw_context ?? {},
            is_synthetic: false,
            salience_score: computeSalience(actionId, contextId, customerId, body.success),
            outcome_score: body.outcome_score ?? null,
            business_outcome: body.business_outcome ?? null,
            feedback_signal: body.feedback_signal ?? 'immediate',
        })
        .select('outcome_id, timestamp')
        .single();

    if (insertErr || !outcome) {
        return c.json(
            { error: 'Failed to log outcome', details: insertErr?.message, code: 'INSERT_ERROR' },
            500
        );
    }

    // ── Save Idempotency Key ─────────────────────────────────
    if (body.idempotency_key) {
        const { error: idempErr } = await supabase
            .from('fact_outcome_idempotency')
            .insert({
                idempotency_key: body.idempotency_key,
                outcome_id: outcome.outcome_id,
            });

        if (idempErr) {
            // 23505 = duplicate constraint violation
            if (idempErr.code === '23505') {
                return c.json(
                    {
                        error: 'Duplicate idempotency_key — this outcome was already logged. Pass the same key to retrieve the original outcome_id.',
                        code: 'CONFLICT'
                    },
                    409
                );
            }
            console.warn('[log-outcome] Failed to save idempotency key:', idempErr.message);
        }
    }

    // ── Invalidate score cache ───────────────────────────────
    invalidateCache(customerId, contextId);

    // ── Resolve decision_id (CHANGE 2) ───────────────────────
    let decisionResolved = false;
    let decisionRecord: any = null;
    if (body.decision_id) {
        try {
            const { data: decision, error: decErr } = await supabase
                .from('fact_decisions')
                .select('*')
                .eq('id', body.decision_id)
                .single();

            if (decErr || !decision) {
                console.warn(
                    '[log-outcome] decision_id not found:',
                    body.decision_id
                );
            } else if (decision.agent_id && decision.agent_id !== agentId) {
                return c.json(
                    { error: 'decision_id belongs to a different agent', code: 'DECISION_AGENT_MISMATCH' },
                    400
                );
            } else {
                decisionRecord = decision;
                // Update fact_decisions with resolution
                await supabase
                    .from('fact_decisions')
                    .update({
                        chosen_action_name: body.action_name,
                        chosen_action_id: actionId,
                        outcome_id: outcome.outcome_id,
                        resolved_at: new Date().toISOString(),
                    })
                    .eq('id', body.decision_id);
                decisionResolved = true;
            }
        } catch (err: any) {
            console.warn('[log-outcome] decision resolution error:', err.message);
        }
    }

    // ── Compute and write IPS counterfactuals (CHANGE 3) ─────
    let counterfactualsComputed = false;
    if (decisionResolved && decisionRecord?.ranked_actions) {
        counterfactualsComputed = true;
        const outcomeScore = body.outcome_score ?? (body.success ? 1.0 : 0.0);
        writeCounterfactuals({
            decisionId: body.decision_id!,
            realOutcomeId: outcome.outcome_id,
            realOutcomeScore: outcomeScore,
            chosenActionName: body.action_name,
            rankedActions: decisionRecord.ranked_actions,
            contextHash: decisionRecord.context_hash ?? '',
            episodePosition: decisionRecord.episode_position ?? 0,
        }).catch(err =>
            console.error('[LogOutcome] IPS write failed:', err)
        );
    }

    // ── Track action sequence (CHANGE 4) ─────────────────────
    let sequencePosition: number | null = null;
    if (body.episode_id) {
        upsertSequence({
            episodeId: body.episode_id,
            agentId: agentId,
            contextHash: decisionRecord?.context_hash ?? `${contextId}:${body.issue_type}`,
            actionName: body.action_name,
            responseMs: body.response_time_ms,
        }).then(result => {
            sequencePosition = result.isNew ? 0 : null;
        }).catch(err =>
            console.error('[LogOutcome] Sequence upsert failed:', err)
        );

        // Close sequence if episode is definitively over
        if (body.business_outcome === 'resolved' || body.business_outcome === 'failed') {
            const finalScore = body.outcome_score ?? (body.success ? 1.0 : 0.0);
            closeSequence({
                episodeId: body.episode_id,
                finalOutcome: finalScore,
            }).catch(err =>
                console.error('[LogOutcome] Sequence close failed:', err)
            );
        }

        sequencePosition = body.episode_history ? body.episode_history.length - 1 : 0;
    }

    // ── Update agent trust score (async, non-blocking) ───────
    updateAgentTrust(agentId, customerId, body.success).catch(err => {
        console.warn('[log-outcome] Trust update failed:', err.message);
    });

    // ── CONTEXT DRIFT DETECTION (Gap 2) — fire and forget ────
    detectContextDrift(supabase, customerId, body.issue_type, agentId).catch(err => {
        console.warn('[log-outcome] Context drift check failed:', err);
    });

    // ── SILENT FAILURE DETECTION (Gap 5) — fire and forget ───
    detectSilentFailure(supabase, {
        outcome_id: outcome.outcome_id,
        customer_id: customerId,
        agent_id: agentId,
        action_id: actionId,
        action_name: body.action_name,
        success: body.success,
        outcome_score: body.outcome_score ?? null,
    }).catch(err => {
        console.warn('[log-outcome] Silent failure check failed:', err);
    });

    // ── Get policy recommendation for next actions ───────────
    let policyResult;
    try {
        const [scores, agentTrust, customerConfig] = await Promise.all([
            getScores(customerId, contextId, body.issue_type, false),
            getAgentTrust(agentId),
            getCustomerConfig(customerId),
        ]);
        policyResult = getPolicyDecision({
            rankedActions: scores.ranked_actions,
            agentTrust: agentTrust,
            customerConfig: customerConfig,
            coldStartActive: scores.cold_start,
        });
    } catch {
        policyResult = null;
    }

    return c.json({
        success: true,
        outcome_id: outcome.outcome_id,
        action_id: actionId,
        context_id: contextId,
        timestamp: outcome.timestamp,
        message: `Outcome logged. Action "${body.action_name}" — ${body.success ? 'SUCCESS' : 'FAILURE'}`,
        recommendation: policyResult?.policy ?? null,
        next_actions: policyResult ? {
            policy: policyResult.policy,
            reason: policyResult.reason,
            selected_action: policyResult.selectedAction,
            exploration_target: policyResult.explorationTarget,
        } : null,
        // ── New fields (backward compatible) ──────────────────
        counterfactuals_computed: counterfactualsComputed,
        sequence_position: sequencePosition,
        idempotency_replayed: false,
    }, 201);
});
