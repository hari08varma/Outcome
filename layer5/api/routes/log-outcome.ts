import { Context, Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { invalidateCache, getCachedScore, getScores } from '../lib/scoring.js';
import {
    getPolicyDecision, DEFAULT_TRUST, DEFAULT_POLICY_CONFIG, AgentTrustScore, CustomerPolicyConfig,
} from '../lib/policy-engine.js';
import { sanitizeContext, sanitizeString } from '../lib/sanitize.js';
import { resolveVerifiedSuccess } from '../lib/verifier.js';
import { orchestrateOutcome } from '../lib/outcome-orchestrator.js';

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

// ── Helper: fetch real agent trust ──
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

// ── Helper: fetch real customer config ──
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
    try {
        const raw = c.get('parsed_body') ?? await c.req.json();
        body = LogOutcomeBody.parse(raw);
    } catch (err: any) {
        throw new Error(`VALIDATION_ERROR:${err.errors ?? err.message}`);
    }

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

async function handleIdempotency(idempotencyKey: string | undefined) {
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

async function resolveActionId(c: Context, body: any, customerId: string) {
    const validatedAction = c.get('validated_action') as any;
    if (validatedAction) return validatedAction.action_id;
    
    // Fallback: validate directly
    const { validateAction } = await import('../middleware/validate-action.js');
    const result = await validateAction(body.action_name, customerId, body.action_params);
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

    if (existingCtx && existingCtx.context_id) return existingCtx.context_id;

    const { data: newCtx, error: ctxErr } = await supabase
        .from('dim_contexts')
        .insert({
            issue_type: body.issue_type,
            environment: body.environment,
            customer_tier: body.customer_tier ?? null,
        })
        .select('context_id')
        .single();

    if (ctxErr || !newCtx || !newCtx.context_id) throw new Error(`CONTEXT_ERROR:${ctxErr?.message || 'Missing context_id'}`);
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

    if (insertErr || !outcome) throw new Error(`INSERT_ERROR:${insertErr?.message}`);
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
        const originalOutcome = await handleIdempotency(body.idempotency_key);
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
        const actionId = await resolveActionId(c, body, customerId);
        const contextId = await resolveContextId(body);
        
        // 5. Insert Core Fact
        const outcome = await insertCoreOutcome(agentId, customerId, actionId, contextId, body, finalSuccess, finalOutcomeScore, verification);
        
        // 6. Post-Insert Synchronous Updates
        await saveIdempotencyRecord(body.idempotency_key, outcome.outcome_id);
        invalidateCache(customerId, contextId);
        const decisionRecord = await resolveDecisionId(body, agentId, actionId, outcome.outcome_id);
        
        // 7. Fire-and-forget Asynchronous Pipelines via Orchestrator
        orchestrateOutcome({
            agentId, customerId, outcomeId: outcome.outcome_id, actionId, actionName: body.action_name,
            contextId, issueType: body.issue_type, finalSuccess, finalOutcomeScore,
            responseMs: body.response_time_ms ?? null, episodeId: body.episode_id,
            businessOutcome: body.business_outcome, decisionId: body.decision_id, decisionRecord,
        }).catch(err => console.error('[log-outcome] orchestrator failed:', { error: err.message, outcomeId: outcome.outcome_id }));

        // 8. Policy Engine Wrap-up
        const policyResult = await computePolicyRecommendation(customerId, contextId, agentId, body.issue_type);
        const finalValidatedAction = c.get('validated_action') as any;

        const counterfactualsComputed = !!(decisionRecord?.ranked_actions);
        const sequencePosition = body.episode_id ? (body.episode_history ? body.episode_history.length : 0) : null;

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
        if (err.message.startsWith('VALIDATION_ERROR:')) {
            return c.json({ error: 'Invalid request body', details: err.message.substring(17), code: 'VALIDATION_ERROR' }, 400);
        }
        if (err.message.startsWith('CONTEXT_ERROR:')) {
            return c.json({ error: 'Failed to resolve context', details: err.message.substring(14), code: 'CONTEXT_ERROR' }, 500);
        }
        if (err.message.startsWith('INSERT_ERROR:')) {
            return c.json({ error: 'Failed to log outcome', details: err.message.substring(13), code: 'INSERT_ERROR' }, 500);
        }
        return c.json({ error: 'Internal server error', details: err.message }, 500);
    }
});
