/**
 * Layerinfinite — routes/log-outcome.ts
 * POST /v1/log-outcome
 * ══════════════════════════════════════════════════════════════
 * Appends one outcome to fact_outcomes.
 * Action validation handled by validateActionMiddleware (upstream).
 * Returns outcome + policy recommendation from policy engine.
 * ══════════════════════════════════════════════════════════════
 */

import { Context, Hono } from 'hono';
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
import { backpropagateReward } from '../lib/reward-backprop.js';
import { sanitizeContext, sanitizeString } from '../lib/sanitize.js';
import { resolveVerifiedSuccess } from '../lib/verifier.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export const logOutcomeRouter = new Hono();

// ── Payload size guard (64KB) ─────────────────────────────────
const MAX_RAW_CONTEXT_BYTES = 64 * 1024;

// ── Request schema ────────────────────────────────────────────
const LogOutcomeBody = z.object({
    session_id: z.string().uuid(),
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
    outcome_score: z.number().min(0.0).max(1.0).optional(),
    business_outcome: z.enum(['resolved', 'partial', 'failed', 'unknown']).optional(),
    feedback_signal: z.enum(['immediate', 'delayed', 'none']).optional(),
    decision_id: z.string().uuid().optional(),
    episode_id: z.string().uuid().optional(),
    episode_history: z.array(z.string()).optional(),
    verifier_signal: z.object({
        source: z.enum([
            'http_status_code',
            'database_row_count',
            'human_review',
            'downstream_webhook',
            'none',
        ]),
        value: z.union([
            z.number(),
            z.boolean(),
            z.string(),
        ]).optional(),
        verified_at: z.string().datetime().optional(),
    }).optional(),
});

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

    if (!trust) return;

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

    let newStatus: string;
    let newSuspensionReason = null;

    if (newScore < 0.1 || newFailures >= 10) {
        newStatus = 'suspended';
        newSuspensionReason = newScore < 0.1 ? 'trust_score_critically_low' : 'consecutive_failures_exceeded';
    } else if (newScore < 0.3 || newFailures >= 5) {
        newStatus = 'sandbox';
        newSuspensionReason = newFailures >= 5 ? 'consecutive_failures_exceeded' : null;
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
            suspension_reason: newSuspensionReason,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);

    if (oldStatus !== newStatus) {
        await supabase.from('agent_trust_audit').insert({
            agent_id: agentId,
            customer_id: customerId,
            event_type: newStatus === 'suspended' ? 'suspended' : 'recalibrated',
            old_score: oldScore,
            new_score: newScore,
            old_status: oldStatus,
            new_status: newStatus,
            reason: newStatus === 'suspended' || newStatus === 'sandbox'
                ? `Trust recalibrated: ${oldStatus} → ${newStatus}. Score: ${newScore.toFixed(3)}, Failures: ${newFailures}`
                : `Trust recalibrated: ${oldStatus} → ${newStatus}`,
        });
    }
}

// ── CONTEXT DRIFT DETECTION (Gap 2) ──────────────────────────
async function detectContextDrift(
    sb: SupabaseClient,
    customerId: string,
    contextType: string,
    agentId: string
): Promise<void> {
    const { data: existingContext } = await sb
        .from('dim_contexts')
        .select('context_id')
        .eq('issue_type', contextType)
        .limit(1)
        .maybeSingle();

    if (existingContext) {
        const { count } = await sb
            .from('fact_outcomes')
            .select('outcome_id', { count: 'exact', head: true })
            .eq('customer_id', customerId)
            .eq('context_id', existingContext.context_id);

        if ((count ?? 0) > 0) return;
    }

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
        message: `New context type "${contextType}" encountered by agent ${agentId}. No prior outcomes for this customer. Cold-start protocol activated.`,
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

// ── Salience sampling ─────────────────────────────────────────
function computeSalience(
    actionId: string,
    contextId: string,
    customerId: string,
    success: boolean
): number {
    const cachedScore = getCachedScore(actionId, contextId, customerId);
    if (cachedScore !== null && cachedScore > 0.9 && success) {
        return 0.1;
    }
    return 1.0;
}

// ── LOGICAL CONCERNS (Extracted to resolve Bug 1) ─────────────

async function parseAndSanitizeRequest(c: Context) {
    let body: z.infer<typeof LogOutcomeBody>;
    const raw = c.get('parsed_body') ?? await c.req.json();
    body = LogOutcomeBody.parse(raw);

    if (body.raw_context) body.raw_context = sanitizeContext(body.raw_context);
    if (body.error_message) body.error_message = sanitizeString(body.error_message, 1000);
    if (body.error_code) body.error_code = sanitizeString(body.error_code, 100);

    // Payload size check
    if (body.raw_context) {
        const contextSize = new TextEncoder().encode(JSON.stringify(body.raw_context)).length;
        if (contextSize > MAX_RAW_CONTEXT_BYTES) {
            throw new Error('PAYLOAD_TOO_LARGE');
        }
    }
    return body;
}

async function handleIdempotency(idempotencyKey: string | undefined, actionName: string) {
    if (!idempotencyKey) return null;
    const { data: existing } = await supabase
        .from('fact_outcome_idempotency')
        .select('outcome_id')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();

    if (existing) {
        const { data: originalOutcome } = await supabase
            .from('fact_outcomes')
            .select('outcome_id, action_id, context_id, timestamp, success')
            .eq('outcome_id', existing.outcome_id)
            .single();
        if (originalOutcome) return originalOutcome;
    }
    return null;
}

async function verifyOutcome(body: any, customerId: string, agentId: string) {
    const verification = resolveVerifiedSuccess(
        body.success,
        body.outcome_score,
        body.verifier_signal as any
    );

    if (verification.discrepancy_detected) {
        Promise.resolve(
            supabase.from('degradation_alert_events').insert({
                customer_id: customerId,
                agent_id: agentId,
                alert_type: 'success_hallucination',
                severity: 'critical',
                message: `Agent self-reported success=true but verifier(${body.verifier_signal?.source}) returned failure. Outcome corrected to success=false. Scoring engine protected.`,
            })
        ).catch(() => { });
    }
    return verification;
}

async function resolveActionId(c: Context, body: any) {
    const validatedAction = c.get('validated_action') as any;
    if (validatedAction) return validatedAction.action_id;
    
    // Fallback: validate directly
    const { validateAction } = await import('../middleware/validate-action.js');
    const result = await validateAction(body.action_name, body.action_params);
    if (!result.valid) throw new Error(`UNKNOWN_ACTION:${result.error_code ?? 'UNKNOWN_ACTION'}:${result.error}`);
    return result.action_id!;
}

async function resolveContextId(body: any) {
    const { data: existingCtx } = await supabase
        .from('dim_contexts')
        .select('context_id')
        .eq('issue_type', body.issue_type)
        .eq('environment', body.environment)
        .maybeSingle();

    if (existingCtx) return existingCtx.context_id;

    const { data: newCtx, error: ctxErr } = await supabase
        .from('dim_contexts')
        .insert({
            issue_type: body.issue_type,
            environment: body.environment,
            customer_tier: body.customer_tier ?? null,
        })
        .select('context_id')
        .single();

    if (ctxErr || !newCtx) throw new Error('CONTEXT_ERROR');
    return newCtx.context_id;
}

async function insertCoreOutcome(
    agentId: string, customerId: string, actionId: string, contextId: string, 
    body: any, finalSuccess: boolean, finalOutcomeScore: number | null, verification: any
) {
    const { data: outcome, error: insertErr } = await supabase
        .from('fact_outcomes')
        .insert({
            agent_id: agentId,
            action_id: actionId,
            context_id: contextId,
            customer_id: customerId,
            session_id: body.session_id,
            success: finalSuccess,
            response_time_ms: body.response_time_ms ?? null,
            error_code: body.error_code ?? null,
            error_message: body.error_message ?? null,
            raw_context: body.raw_context ?? {},
            is_synthetic: false,
            salience_score: computeSalience(actionId, contextId, customerId, finalSuccess),
            outcome_score: finalOutcomeScore,
            business_outcome: body.business_outcome ?? null,
            feedback_signal: body.feedback_signal ?? 'immediate',
            verifier_source: body.verifier_signal?.source ?? null,
            verifier_value: body.verifier_signal?.value?.toString() ?? null,
            discrepancy_detected: verification.discrepancy_detected,
            backprop_episode_id: body.episode_id ?? null,
        })
        .select('outcome_id, timestamp')
        .single();

    if (insertErr || !outcome) throw new Error('INSERT_ERROR:' + (insertErr?.message || 'unknown error'));
    return outcome;
}

async function saveIdempotencyRecord(idempotencyKey: string | undefined, outcomeId: string) {
    if (!idempotencyKey) return;
    const { error: idempErr } = await supabase
        .from('fact_outcome_idempotency')
        .insert({
            idempotency_key: idempotencyKey,
            outcome_id: outcomeId,
        });

    if (idempErr) {
        if (idempErr.code === '23505') throw new Error('CONFLICT');
        console.warn('[log-outcome] Failed to save idempotency key:', idempErr.message);
    }
}

async function resolveDecisionId(body: any, agentId: string, actionId: string, outcomeId: string) {
    if (!body.decision_id) return null;
    
    try {
        const { data: decision, error: decErr } = await supabase
            .from('fact_decisions')
            .select('*')
            .eq('id', body.decision_id)
            .single();

        if (decErr || !decision) {
            console.warn('[log-outcome] decision_id not found:', body.decision_id);
            return null;
        } 
        if (decision.agent_id && decision.agent_id !== agentId) {
            throw new Error('DECISION_AGENT_MISMATCH');
        }
        
        await supabase
            .from('fact_decisions')
            .update({
                chosen_action_name: body.action_name,
                chosen_action_id: actionId,
                outcome_id: outcomeId,
                resolved_at: new Date().toISOString(),
            })
            .eq('id', body.decision_id);
        
        return decision;
    } catch (err: any) {
        if (err.message === 'DECISION_AGENT_MISMATCH') throw err;
        console.warn('[log-outcome] decision resolution error:', err.message);
        return null;
    }
}

async function computePolicyRecommendation(customerId: string, contextId: string, agentId: string, issueType: string) {
    try {
        const [scores, agentTrust, customerConfig] = await Promise.all([
            getScores(customerId, contextId, issueType, false),
            getAgentTrust(agentId),
            getCustomerConfig(customerId),
        ]);
        return getPolicyDecision({
            rankedActions: scores.ranked_actions,
            agentTrust: agentTrust,
            customerConfig: customerConfig,
            coldStartActive: scores.cold_start,
        });
    } catch {
        return null;
    }
}

// ── MAIN ORCHESTRATOR ──
logOutcomeRouter.post('/', async (c) => {
    const agentId = c.get('agent_id') as string;
    const customerId = c.get('customer_id') as string;

    try {
        // 1. Parsing & Sanitization
        const body = await parseAndSanitizeRequest(c);

        // 2. Idempotency Check
        const originalOutcome = await handleIdempotency(body.idempotency_key, body.action_name);
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

        // 3. Verification Layer
        const verification = await verifyOutcome(body, customerId, agentId);
        const finalSuccess = verification.verified_success;
        const finalOutcomeScore = verification.confidence_override ?? body.outcome_score ?? null;

        // 4. Resolve References
        const actionId = await resolveActionId(c, body);
        const contextId = await resolveContextId(body);
        
        // 5. Insert Core Fact
        const outcome = await insertCoreOutcome(agentId, customerId, actionId, contextId, body, finalSuccess, finalOutcomeScore, verification);
        
        // 6. Post-Insert Synchronous Updates
        await saveIdempotencyRecord(body.idempotency_key, outcome.outcome_id);
        invalidateCache(customerId, contextId);
        const decisionRecord = await resolveDecisionId(body, agentId, actionId, outcome.outcome_id);
        const decisionResolved = decisionRecord !== null;
        
        // 7. Fire-and-forget Asynchronous Pipelines
        let counterfactualsComputed = false;
        if (decisionResolved && decisionRecord?.ranked_actions) {
            counterfactualsComputed = true;
            const outcomeScore = finalOutcomeScore ?? (finalSuccess ? 1.0 : 0.0);
            writeCounterfactuals({
                decisionId: body.decision_id!,
                realOutcomeId: outcome.outcome_id,
                realOutcomeScore: outcomeScore,
                chosenActionName: body.action_name,
                rankedActions: decisionRecord.ranked_actions,
                contextHash: decisionRecord.context_hash ?? '',
                episodePosition: decisionRecord.episode_position ?? 0,
            }).catch(err => console.error('[LogOutcome] IPS write failed:', err));
        }

        // SEQUENCE TRACKING (Fix 7)
        let sequencePosition: number | null = null;
        if (body.episode_id) {
            sequencePosition = body.episode_history ? body.episode_history.length : 0;
            
            upsertSequence({
                episodeId: body.episode_id,
                agentId: agentId,
                contextHash: decisionRecord?.context_hash ?? `${contextId}:${body.issue_type}`,
                actionName: body.action_name,
                responseMs: body.response_time_ms,
            }).catch(err => console.error('[LogOutcome] Sequence upsert failed:', err));

            if (body.business_outcome === 'resolved' || body.business_outcome === 'failed') {
                const finalScore = finalOutcomeScore ?? (finalSuccess ? 1.0 : 0.0);
                closeSequence({
                    episodeId: body.episode_id,
                    finalOutcome: finalScore,
                }).catch(err => console.error('[LogOutcome] Sequence close failed:', err));
                
                backpropagateReward({
                    episode_id: body.episode_id,
                    final_outcome: finalScore,
                    gamma: 0.85,
                }).catch(err => console.error('[BackpropReward] failed:', err));
            }
        }

        updateAgentTrust(agentId, customerId, finalSuccess).catch(err => console.warn('[log-outcome] Trust update failed:', err.message));
        detectContextDrift(supabase, customerId, body.issue_type, agentId).catch(err => console.warn('[log-outcome] Context drift check failed:', err));
        detectSilentFailure(supabase, {
            outcome_id: outcome.outcome_id, customer_id: customerId, agent_id: agentId, action_id: actionId,
            action_name: body.action_name, success: finalSuccess, outcome_score: finalOutcomeScore,
        }).catch(err => console.warn('[log-outcome] Silent failure check failed:', err));

        // 8. Policy Engine Wrap-up
        const policyResult = await computePolicyRecommendation(customerId, contextId, agentId, body.issue_type);
        const finalValidatedAction = c.get('validated_action') as any;

        return c.json({
            success: true,
            outcome_id: outcome.outcome_id,
            action_id: actionId,
            context_id: contextId,
            timestamp: outcome.timestamp,
            message: `Outcome logged. Action "${body.action_name}" — ${finalSuccess ? 'SUCCESS' : 'FAILURE'}`,
            recommendation: policyResult?.policy ?? null,
            next_actions: policyResult ? {
                policy: policyResult.policy, reason: policyResult.reason,
                selected_action: policyResult.selectedAction, exploration_target: policyResult.explorationTarget,
            } : null,
            counterfactuals_computed: counterfactualsComputed,
            sequence_position: sequencePosition,
            idempotency_replayed: false,
            validation_warnings: finalValidatedAction?.validation_warnings ?? [],
        }, 201);

    } catch (err: any) {
        if (err.message === 'PAYLOAD_TOO_LARGE') {
            return c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'raw_context exceeds 64KB limit' }, 413);
        }
        if (err.message === 'CONFLICT') {
            return c.json({ error: 'Duplicate idempotency_key — this outcome was already logged. Pass the same key to retrieve the original outcome_id.', code: 'CONFLICT' }, 409);
        }
        if (err.message === 'DECISION_AGENT_MISMATCH') {
            return c.json({ error: 'decision_id belongs to a different agent', code: 'DECISION_AGENT_MISMATCH' }, 400);
        }
        if (err.message.startsWith('UNKNOWN_ACTION:')) {
            const parts = err.message.split(':');
            return c.json({ error: parts[1], message: parts[2] }, 400);
        }
        if (err.name === 'ZodError' || err.code === 'VALIDATION_ERROR') {
            return c.json({ error: 'Invalid request body', details: err.errors ?? err.message, code: 'VALIDATION_ERROR' }, 400);
        }
        if (err.message === 'CONTEXT_ERROR') {
            return c.json({ error: 'Failed to resolve context', details: err.message, code: 'CONTEXT_ERROR' }, 500);
        }
        if (err.message.startsWith('INSERT_ERROR:')) {
            return c.json({ error: 'Failed to log outcome', details: err.message.substring(13), code: 'INSERT_ERROR' }, 500);
        }
        return c.json({ error: 'Internal server error', details: err.message }, 500);
    }
});
