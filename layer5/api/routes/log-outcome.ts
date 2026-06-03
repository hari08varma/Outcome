import { insertOutcomeRecord } from '../lib/ingest-core.js';
import { Context, Hono } from 'hono';
import { z } from 'zod';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { invalidateCache, getCachedScore, getScores } from '../lib/scoring.js';
import {
    getPolicyDecision,
} from '../lib/policy-engine.js';
import type { AgentTrustScore, CustomerPolicyConfig } from '../lib/policy-engine.js';
import { sanitizeContext, sanitizeString } from '../lib/sanitize.js';
import { resolveVerifiedSuccess } from '../lib/verifier.js';
import { orchestrateOutcome } from '../lib/outcome-orchestrator.js';
import * as contextEmbed from '../lib/context-embed.js';
import { inferTask, isGenericTaskName, validateTaskName, TASK_MAPPING_CONFIDENCE } from '../lib/recommendation/task-infer.js';
import type { TaskInferResult } from '../lib/recommendation/task-infer.js';
import {
    inferSemanticActionCluster,
    type SemanticActionClusterResult,
} from '../lib/recommendation/semantic-action-cluster.js';
import {
    inferOutcomeScore,
    fetchActionBaseline,
    invalidateActionBaselineCache,
} from '../lib/outcome-score-inference.js';
import {
    OUTCOME_INGEST_WORKER_BYPASS_HEADER,
    enqueueDurable,
    getOutcomeQueueMode,
} from '../lib/outcome-ingest-queue.js';

export const logOutcomeRouter = new Hono();

// ── Data Quality Scoring ──────────────────────────────────────
// Computes a 0.0–1.0 quality score for each incoming event.
// High-quality events get full weight in the scoring engine.
// Low-quality events are stored but their influence is reduced.
//
// Based on what the SDK actually sends automatically:
//   ALWAYS present (SDK captures automatically):
//     agent_id, action_name, issue_type, success, session_id, response_ms
//   ONLY present if developer provides score_fn:
//     outcome_score
//   NEVER sent by SDK auto-logging:
//     business_outcome, task_name (always inferred from issue_type)
//
// Deductions (cumulative, floored at 0.0):
//   -0.25  outcome_score absent     (no score_fn provided — primary signal missing)
//   -0.20  is_inconsistent          (success=true but score < 0.3)
//   -0.20  mapping_confidence < 0.7 (issue_type → task mapping is uncertain)
//   -0.10  business_outcome absent  (SDK never sends this — developer must add explicitly)
//
// NOT penalised (SDK always provides these):
//   session_id  — SDK generates UUID per call
//   response_ms — SDK measures latency automatically
//
// Never throws. Returns a value in [0.0, 1.0].
interface DataQualityInput {
    outcomeScoreRaw: number | null | undefined;
    isInconsistent: boolean;
    mappingConfidence: number;
    businessOutcome: string | null | undefined;
    inferenceConfidence?: number | null;
}

function computeDataQuality(input: DataQualityInput): number {
    let score = 1.0;

    if (input.outcomeScoreRaw === null || input.outcomeScoreRaw === undefined) {
        // Score was inferred — penalize by inverse of inference confidence.
        // High confidence inference (0.75) → penalty ~0.06
        // Low confidence inference (0.30)  → penalty ~0.18
        // No inference at all              → penalty 0.25 (original behavior)
        const conf = input.inferenceConfidence ?? 0;
        const penalty = conf > 0
            ? Math.max(0.05, 0.25 * (1 - conf))
            : 0.25;
        score -= penalty;
    }
    if (input.isInconsistent) {
        score -= 0.20;
    }
    if (input.mappingConfidence < 0.70) {
        score -= 0.20;
    }
    if (!input.businessOutcome) {
        score -= 0.10;
    }

    return Number(Math.max(0.0, score).toFixed(4));
}

// ── Payload size guard (64KB) ─────────────────────────────────
const MAX_RAW_CONTEXT_BYTES = 64 * 1024;

const LOCAL_DEFAULT_TRUST: AgentTrustScore = {
    trust_score: 0.5,
    trust_status: 'new',
    consecutive_failures: 0,
};

const LOCAL_DEFAULT_POLICY_CONFIG: CustomerPolicyConfig = {
    risk_tolerance: 'balanced',
    escalation_score: 0.20,
    exploration_rate: 0.05,
    min_confidence: 0.30,
};

interface InconsistencyEvaluation {
    isInconsistent: boolean;
    type: string | null;
    reason: string | null;
    ruleVersion: string | null;
}

interface RetryChainState {
    retryChainId: string | null;
    retryAttempt: number | null;
    crossEventAttemptCount: number | null;
    canonicalOutcomeId: string | null;
}

type ExecutionStatus = 'COMPLETED' | 'FAILED';
type StatusOrigin = 'explicit' | 'inferred_from_success' | 'inferred_from_score' | 'reconciled_feedback';

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function normalizeExecutionStatus(value: unknown): ExecutionStatus | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === 'COMPLETED') return 'COMPLETED';
    if (normalized === 'FAILED') return 'FAILED';
    return null;
}

function normalizeFailureToken(value: unknown, maxLen: number): string | null {
    if (typeof value !== 'string') return null;
    const normalized = sanitizeString(value, maxLen)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) return null;
    return normalized.slice(0, maxLen);
}

const FAILURE_REASON_CODE_VOCAB = new Set([
    'execution_failed',
    'timeout_error',
    'validation_failed',
    'dependency_failure',
    'policy_blocked',
    'feedback_marked_failure',
    'cross_event_conflict',
    'unknown_failure',
]);

const FAILURE_STAGE_VOCAB = new Set([
    'action_selection',
    'action_execution',
    'ingest_validation',
    'verification',
    'delayed_feedback',
    'downstream_signal',
    'policy_gate',
    'unknown_stage',
]);

function normalizeFailureReasonCode(value: unknown): string | null {
    const token = normalizeFailureToken(value, 80);
    if (!token) return null;
    return FAILURE_REASON_CODE_VOCAB.has(token)
        ? token
        : 'unknown_failure';
}

function normalizeFailureStage(value: unknown): string | null {
    const token = normalizeFailureToken(value, 40);
    if (!token) return null;
    return FAILURE_STAGE_VOCAB.has(token)
        ? token
        : 'unknown_stage';
}

function statusFromOutcomeScore(score: number | null): ExecutionStatus | null {
    if (score === null || !Number.isFinite(score)) return null;
    return score >= 0.5 ? 'COMPLETED' : 'FAILED';
}

function parseOptionalNumber(value: unknown): number | null {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

function evaluateInconsistency(params: {
    finalSuccess: boolean;
    outcomeScoreRaw: number | null;
    businessOutcome: string | null | undefined;
    verifierDiscrepancy: boolean;
}): InconsistencyEvaluation {
    const lowThreshold = clamp01(
        parseOptionalNumber(process.env.LI_INCONSISTENCY_THRESHOLD) ?? 0.3,
    );
    const highThreshold = clamp01(
        parseOptionalNumber(process.env.LI_INCONSISTENCY_HIGH_THRESHOLD) ?? 0.7,
    );

    if (params.verifierDiscrepancy) {
        return {
            isInconsistent: true,
            type: 'verifier_discrepancy',
            reason: 'Verifier signal contradicted self-reported outcome.',
            ruleVersion: 'v2:verifier_discrepancy',
        };
    }

    if (
        params.finalSuccess === true
        && params.outcomeScoreRaw !== null
        && params.outcomeScoreRaw < lowThreshold
    ) {
        return {
            isInconsistent: true,
            type: 'success_low_score',
            reason: `success=true but outcome_score_raw=${params.outcomeScoreRaw.toFixed(4)} is below threshold ${lowThreshold.toFixed(4)}.`,
            ruleVersion: `v2:success_low_score:threshold=${lowThreshold.toFixed(4)}`,
        };
    }

    if (
        params.finalSuccess === false
        && params.outcomeScoreRaw !== null
        && params.outcomeScoreRaw > highThreshold
    ) {
        return {
            isInconsistent: true,
            type: 'failure_high_score',
            reason: `success=false but outcome_score_raw=${params.outcomeScoreRaw.toFixed(4)} exceeds threshold ${highThreshold.toFixed(4)}.`,
            ruleVersion: `v2:failure_high_score:threshold=${highThreshold.toFixed(4)}`,
        };
    }

    if (
        params.finalSuccess === true
        && (params.businessOutcome === 'partial' || params.businessOutcome === 'failed')
    ) {
        return {
            isInconsistent: true,
            type: 'success_business_conflict',
            reason: `success=true but business_outcome=${params.businessOutcome}.`,
            ruleVersion: 'v2:success_business_conflict',
        };
    }

    return {
        isInconsistent: false,
        type: null,
        reason: null,
        ruleVersion: null,
    };
}

// ── Request schema ────────────────────────────────────────────
const LogOutcomeBody = z.object({
    session_id: z.string().uuid().optional(),
    idempotency_key: z.string().max(255).optional(),
    action_name: z.string().min(1).max(255).optional(),
    // Legacy alias still used by older SDK/manual clients.
    action_id: z.string().optional(),
    action_id_input: z.string().optional(),
    action_params: z.record(z.string(), z.unknown()).optional(),
    issue_type: z
        .string()
        .min(1)
        .max(255)
        .transform(val => {
            // Canonicalize to match the import route's canonicalizeIssueType():
            // lowercase, spaces/hyphens → underscores, strip non-alphanumeric.
            // Ensures "Payment_Failed" from import and "payment_failed" from SDK
            // resolve to the same context_id and task_name bucket.
            const sanitized = sanitizeString(val, 255).trim();
            return sanitized
                .toLowerCase()
                .replace(/[\s\-]+/g, '_')
                .replace(/[^a-z0-9_]/g, '')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');
        })
        .refine(val => val.length > 0, { message: 'issue_type cannot be blank' }),
    success: z.preprocess(
        (val) => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'string') {
                const lower = val.trim().toLowerCase();
                if (['true', '1', 'yes', 'ok', 'pass', 'resolved'].includes(lower)) return true;
                if (['false', '0', 'no', 'fail', 'failed'].includes(lower)) return false;
            }
            if (typeof val === 'number') return val === 1;
            return val;
        },
        z.boolean(),
    ),
    response_time_ms: z.preprocess(
        (val) => {
            if (typeof val === 'number') {
                return Number.isFinite(val) && val > 0 ? Math.round(val) : undefined;
            }
            if (typeof val === 'string') {
                const parsed = Number(val);
                return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
            }
            return val;
        },
        z.number().int().positive().optional(),
    ),
    response_ms: z.preprocess(
        (val) => {
            if (typeof val === 'number') {
                return Number.isFinite(val) && val > 0 ? Math.round(val) : undefined;
            }
            if (typeof val === 'string') {
                const parsed = Number(val);
                return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
            }
            return val;
        },
        z.number().int().positive().optional(),
    ), // SDK alias — maps to response_time_ms
    error_code: z.string().max(100).optional(),
    error_message: z.string().max(1000).optional(),
    raw_context: z.record(z.string(), z.unknown()).optional(),
    // Any string is accepted. Common abbreviations are normalized.
    // Unknown values default to 'production'. Field is metadata-only —
    // not referenced by any conditional branch in scoring or policy.
    environment: z
        .string()
        .max(50)
        .optional()
        .default('production')
        .transform(val => {
            const normalized = val.trim().toLowerCase();
            const aliases: Record<string, string> = {
                'prod': 'production',
                'dev': 'development',
                'develop': 'development',
                'stage': 'staging',
                'stg': 'staging',
                'qa': 'staging',
                'test': 'staging',
                'uat': 'staging',
            };
            if (aliases[normalized]) return aliases[normalized] as 'production' | 'staging' | 'development';
            const known = ['production', 'staging', 'development'] as const;
            return (known as readonly string[]).includes(normalized)
                ? (normalized as typeof known[number])
                : 'production';
        }),
    customer_tier: z.enum(['free', 'pro', 'enterprise']).optional(),

    outcome_score: z.preprocess(
        (val) => {
            if (val === undefined || val === null) return undefined;
            const num = Number(val);
            if (!Number.isFinite(num)) return val; // let Zod reject non-numeric
            // Percentage auto-detection: values >=2 and <=100 → divide by 100
            // Values between 1.0 and 2.0 are rejected as invalid (ambiguous range).
            if (num >= 2 && num <= 100) return num / 100;
            return num;
        },
        z.number().min(0.0).max(1.0, {
            message: 'outcome_score must be between 0.0 and 1.0 (or 2-100 for percentage)',
        }).optional(),
    ),

    business_outcome: z
        .string()
        .max(100)
        .optional()
        .transform(val => {
            if (val === undefined || val === null) return undefined;
            const normalized = val.trim().toLowerCase();
            const known = ['resolved', 'partial', 'failed', 'unknown'] as const;
            return (known as readonly string[]).includes(normalized)
                ? (normalized as typeof known[number])
                : 'unknown';
        }),
    // Any string is accepted. Known values are normalized to lowercase.
    // Unknown values map to 'none' (neutral — no clear feedback signal).
    // Field is metadata-only — never read by scoring, trust, or policy.
    feedback_signal: z
        .string()
        .max(50)
        .optional()
        .transform(val => {
            if (val === undefined || val === null) return 'immediate';
            const normalized = val.trim().toLowerCase();
            const known = ['immediate', 'delayed', 'none'] as const;
            return (known as readonly string[]).includes(normalized)
                ? (normalized as typeof known[number])
                : 'none';
        }),
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

    // ── Phase 1: Real Outcome Signal Integration ──────────────
    // All four fields are optional. Callers that omit them get the
    // existing behaviour. real_agent.py sends none of them.
    signal_source: z.enum([
        'causal_graph',
        'signal_contract',
        'http_inference',
        'explicit',
    ]).optional().default('explicit'),
    // When signal_source is 'causal_graph', the Proxy interceptor
    // inferred which action this outcome belongs to.
    inferred_action_id: z.string().uuid().optional(),
    // Confidence of the signal: 0.90 at causal depth 0, decays by
    // 0.04 per depth level. NULL for explicit signals.
    causal_confidence: z.number().min(0).max(1).optional(),
    // How many transformation layers the traced value traversed.
    // NULL for explicit signals. 0–8 for causal graph signals.
    signal_depth: z.number().int().min(0).max(9).optional(),

    // ── Decision Recommendation Engine ───────────────────────
    // Optional semantic label for what the agent was trying to do.
    // Examples: "payment_failed", "ticket_escalation", "refund_request"
    // If absent: auto-inferred from issue_type via inferTask().
    // TASK RESOLUTION RULE: provided value ALWAYS wins over inferred.
    task_name: z.string().min(1).max(255).optional(),
    retry_chain_id: z.string().uuid().optional(),
    retry_attempt: z.number().int().min(0).max(1000).optional(),
    execution_status: z
        .preprocess(
            (val) => typeof val === 'string' ? val.trim().toUpperCase() : val,
            z.enum(['COMPLETED', 'FAILED']).optional(),
        ),
    failure_reason_code: z.string().max(80).optional(),
    failure_stage: z.string().max(40).optional(),

    // ── Resource cost tracking ────────────────────────────────
    // Tracks token usage, API call count, or compute cost per outcome.
    // Agent frameworks (LangChain, CrewAI) report token_usage.total_tokens;
    // this field captures that signal for cost-per-outcome analysis.
    resource_cost_units: z.preprocess(
        (val) => {
            if (val === undefined || val === null) return undefined;
            const num = Number(val);
            return Number.isFinite(num) && num >= 0 ? num : undefined;
        },
        z.number().min(0).optional(),
    ),
    resource_cost_type: z.enum(['tokens', 'api_calls', 'compute_seconds']).optional(),
});

// ── Helper: fetch real agent trust ──
async function getAgentTrust(agentId: string): Promise<AgentTrustScore> {
    const { data, error } = await supabase
        .from('agent_trust_scores')
        .select('trust_score, trust_status, consecutive_failures')
        .eq('agent_id', agentId)
        .maybeSingle();
    if (error || !data) return LOCAL_DEFAULT_TRUST;
    const allowedStatuses: AgentTrustScore['trust_status'][] = ['trusted', 'probation', 'sandbox', 'suspended', 'new'];
    const rawStatus = String(data.trust_status ?? '').toLowerCase();
    const aliasedStatus = rawStatus === 'degraded' ? 'sandbox' : rawStatus;
    const normalizedStatus = allowedStatuses.includes(aliasedStatus as AgentTrustScore['trust_status'])
        ? (aliasedStatus as AgentTrustScore['trust_status'])
        : LOCAL_DEFAULT_TRUST.trust_status;
    return {
        trust_score: typeof data.trust_score === 'number' ? data.trust_score : LOCAL_DEFAULT_TRUST.trust_score,
        trust_status: normalizedStatus,
        consecutive_failures: typeof data.consecutive_failures === 'number' ? data.consecutive_failures : LOCAL_DEFAULT_TRUST.consecutive_failures,
    };
}

// ── Helper: fetch real customer config ──
async function getCustomerConfig(customerId: string): Promise<CustomerPolicyConfig> {
    const { data, error } = await supabase
        .from('dim_customers')
        .select('config')
        .eq('customer_id', customerId)
        .maybeSingle();
    if (error || !data?.config) return LOCAL_DEFAULT_POLICY_CONFIG;
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

// ── LOGICAL CONCERNS ─────────────────────────────────────────

export async function parseAndSanitizeRequest(c: Context) {
    let body: z.infer<typeof LogOutcomeBody>;
    try {
        const raw = c.get('parsed_body') ?? await c.req.json();
        body = LogOutcomeBody.parse(raw);
    } catch (err: any) {
        // Surface field-level zod errors so callers know exactly what's missing
        const details = err.errors
            ? err.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ')
            : err.message;
        throw new Error(`VALIDATION_ERROR:${details}`);
    }

    // Auto-generate session_id when not provided.
    // SDK always sends one (UUID per call), so this fallback is for
    // edge cases only (e.g. direct API callers). No quality penalty applied —
    // the SDK guarantees session_id is always present.
    if (!body.session_id) {
        body.session_id = crypto.randomUUID();
    }

    // Normalize response_ms (SDK alias) → response_time_ms
    (body as any).response_time_ms = body.response_time_ms ?? (body as any).response_ms ?? undefined;

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

async function handleIdempotency(idempotencyKey: string | undefined, customerId: string) {
    if (!idempotencyKey) return null;
    const { data: existing } = await supabase
        .from('fact_outcome_idempotency')
        .select('outcome_id')
        .eq('idempotency_key', idempotencyKey)
        .eq('customer_id', customerId)
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
        void supabase.from('degradation_alert_events').insert({
            customer_id: customerId,
            agent_id: agentId,
            alert_type: 'success_hallucination',
            severity: 'critical',
            message: `Agent self-reported success=true but verifier(${body.verifier_signal?.source}) returned failure. Outcome corrected to success=false. Scoring engine protected.`,
        }).then(({ error }) => {
            if (error) console.warn('[log-outcome] degradation alert insert failed:', error.message);
        });
    }
    return verification;
}

async function resolveActionId(c: Context, body: any, customerId: string): Promise<string> {
    // Phase 1: Causal Graph inferred action — use inferred_action_id directly.
    // The Proxy interceptor already validated this by watching what the agent called.
    if (body.signal_source === 'causal_graph' && body.inferred_action_id && !body.action_name) {
        const { data: actionRow } = await supabase
            .from('dim_actions')
            .select('action_id, action_name')
            .eq('action_id', body.inferred_action_id)
            .eq('customer_id', customerId)
            .maybeSingle();
        if (actionRow) {
            body.action_name = actionRow.action_name;
            return actionRow.action_id;
        }
        // Not found — fall through to normal resolution path
    }

    // Path 1: action_id provided (backward compat) — resolve to action_name
    if (!body.action_name && (body.action_id_input || body.action_id)) {
        const incomingId = body.action_id_input ?? body.action_id;
        const { data: actionRow } = await supabase
            .from('dim_actions')
            .select('action_id, action_name')
            .eq('action_id', incomingId)
            .eq('customer_id', customerId)
            .maybeSingle();

        if (actionRow) {
            body.action_name = actionRow.action_name;
            return actionRow.action_id;
        }
        // action_id came from our own get_scores response but the action row
        // doesn't exist yet (cold-start: scores returned a UUID before dim_actions
        // was seeded). Auto-register with a stable name derived from the UUID.
        const derivedName = `action_${(incomingId as string).slice(0, 8)}`;
        body.action_name = derivedName;
        // Fall through to Path 3 — validateAction() will auto-register via upsert.
    }

    // Path 2: action_name already resolved by middleware
    const validatedAction = c.get('validated_action') as any;
    if (validatedAction) return validatedAction.action_id;

    // Path 3: direct validation
    if (!body.action_name) {
        throw new Error('UNKNOWN_ACTION:MISSING_FIELD:action_name or action_id is required');
    }
    const { validateAction, normalizeActionName } = await import('../middleware/validate-action.js');
    body.action_name = normalizeActionName(body.action_name);
    const result = await validateAction(body.action_name, customerId, body.action_params);
    if (!result.valid) throw new Error(`UNKNOWN_ACTION:${result.error_code ?? 'UNKNOWN_ACTION'}:${result.error}`);
    return result.action_id!;
}

// ── FIX 2: resolveContextId now accepts and uses customerId ────
// BEFORE: context was looked up only by (issue_type, environment).
// This caused ALL customers with the same issue_type to share one
// context_id row, meaning Customer A's outcome scores bled into
// Customer B's recommendations — a complete multi-tenancy failure.
//
// AFTER: every SELECT and INSERT is scoped by customer_id.
// Each customer gets their own context row per (issue_type, environment).
// This means dim_contexts grows by (unique customers × unique issue_types)
// which is expected and correct — the composite unique index on
// (customer_id, issue_type, environment) prevents duplicates.
async function resolveContextId(body: any, customerId: string): Promise<string> {
    const { data: ctx, error } = await supabase
        .from('dim_contexts')
        .upsert(
            {
                customer_id: customerId,
                issue_type: body.issue_type,
                environment: body.environment,
                customer_tier: body.customer_tier ?? null,
            },
            {
                onConflict: 'customer_id,issue_type,environment',
                ignoreDuplicates: false,
            }
        )
        .select('context_id')
        .maybeSingle();

    if (error) {
        console.error('[log-outcome] resolveContextId upsert error:', error.message);
        throw new Error(`CONTEXT_ERROR:${error.message}`);
    }
    if (!ctx?.context_id) {
        // Edge case: upsert returned no row — try plain SELECT as fallback
        const { data: existing } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('customer_id', customerId)
            .eq('issue_type', body.issue_type)
            .eq('environment', body.environment)
            .maybeSingle();
        if (existing?.context_id) return existing.context_id;
        throw new Error('CONTEXT_ERROR:No context_id returned after upsert');
    }
    return ctx.context_id;
}

async function resolveRetryChainState(
    customerId: string,
    body: any,
): Promise<RetryChainState> {
    const fromRawContext = body.raw_context && typeof body.raw_context === 'object'
        ? body.raw_context
        : null;

    const derivedChain =
        body.retry_chain_id
        ?? (typeof fromRawContext?.retry_chain_id === 'string' ? fromRawContext.retry_chain_id : null)
        ?? null;

    const derivedAttemptRaw =
        body.retry_attempt
        ?? (typeof fromRawContext?.retry_attempt === 'number' ? fromRawContext.retry_attempt : null);

    const derivedAttempt = typeof derivedAttemptRaw === 'number' && Number.isFinite(derivedAttemptRaw)
        ? Math.max(0, Math.floor(derivedAttemptRaw))
        : null;

    if (!derivedChain) {
        return {
            retryChainId: null,
            retryAttempt: null,
            crossEventAttemptCount: null,
            canonicalOutcomeId: null,
        };
    }

    const { data: previous, error } = await supabase
        .from('fact_outcomes')
        .select('outcome_id, canonical_outcome_id, cross_event_attempt_count, retry_attempt')
        .eq('customer_id', customerId)
        .eq('retry_chain_id', derivedChain)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        console.warn('[log-outcome] retry chain lookup failed:', error.message);
    }

    const previousAttemptCount = typeof previous?.cross_event_attempt_count === 'number'
        ? previous.cross_event_attempt_count
        : null;

    const previousRetryAttempt = typeof previous?.retry_attempt === 'number'
        ? previous.retry_attempt
        : null;

    const resolvedAttempt = derivedAttempt
        ?? (previousRetryAttempt !== null ? previousRetryAttempt + 1 : 0);

    const crossEventAttemptCount = previousAttemptCount !== null
        ? Math.max(previousAttemptCount + 1, resolvedAttempt + 1)
        : resolvedAttempt + 1;

    return {
        retryChainId: derivedChain,
        retryAttempt: resolvedAttempt,
        crossEventAttemptCount,
        canonicalOutcomeId: previous?.canonical_outcome_id ?? previous?.outcome_id ?? null,
    };
}

async function insertCoreOutcome(
    agentId: string, customerId: string, actionId: string, contextId: string,
    body: any, finalSuccess: boolean, finalOutcomeScore: number | null, verification: any,
    executionStatus: ExecutionStatus,
    failureReasonCode: string | null,
    failureStage: string | null,
    statusOrigin: StatusOrigin,
    outcomeScoreRaw: number | null,
    dataQuality: number,
    isInconsistent: boolean,
    inconsistencyType: string | null,
    inconsistencyReason: string | null,
    mappingConfidence: number,
    scoreOrigin: 'provided' | 'inferred',
    mappingTier: string,
    inconsistencyRuleVersion: string | null,
    semanticCluster: SemanticActionClusterResult,
    crossEventStatus: 'none' | 'pending_signal' | 'confirmed' | 'conflict' | 'resolved',
    retryChain: RetryChainState,
    inferenceConfidence: number | null,
    outcomeClass: string | null,
) {
    // RULE: backprop_episode_id is INTERNAL — set by the backprop engine only.
    // NEVER map body.episode_id to this column. body.episode_id is the SDK's
    // sequence-tracking field; backprop_episode_id has a FK to fact_episodes which
    // only the backprop engine populates. Passing body.episode_id here causes FK
    // violation 23503 on every request that sends episode_id.
    const inserted = await insertOutcomeRecord({
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
        // All SDK-originated rows are explicitly marked 'sdk'.
        // Import rows written by the import route use 'import'.
        // Trust-update paths filter on this column to exclude imported history.
        ingestion_source: 'sdk',
        salience_score: computeSalience(actionId, contextId, customerId, finalSuccess),
        // outcome_score is NOT NULL in DB (migration 044 adds constraint + DEFAULT 0.5).
        // After inference engine (migration 102), finalOutcomeScore includes inferred
        // values when developer omits score_fn. The ?? 0.5 fallback is a last resort
        // if inference also failed (should never happen — defense in depth).
        // Raw developer signal preserved in outcome_score_raw.
        outcome_score: finalOutcomeScore ?? 0.5,
        business_outcome: body.business_outcome ?? null,
        feedback_signal: body.feedback_signal ?? 'immediate',
        verifier_source: body.verifier_signal?.source ?? null,
        verifier_value: body.verifier_signal?.value?.toString() ?? null,
        discrepancy_detected: verification.discrepancy_detected,
        backprop_episode_id: body.backprop_episode_id ?? null,
        // episode_id: the SDK's sequence-grouping field.
        // Stored as plain UUID string — no FK constraint.
        // Distinct from backprop_episode_id which has a FK to fact_episodes.
        episode_id: body.episode_id ?? null,
        // ── Phase 1: Signal columns ───────────────────────
        signal_source: body.signal_source ?? 'explicit',
        signal_confidence: body.causal_confidence ?? null,
        causal_depth: body.signal_depth ?? null,
        signal_pending: crossEventStatus === 'pending_signal',
        signal_updated_at: null,
        cross_event_status: crossEventStatus,
        cross_event_last_updated: new Date().toISOString(),
        retry_chain_id: retryChain.retryChainId,
        retry_attempt: retryChain.retryAttempt,
        cross_event_attempt_count: retryChain.crossEventAttemptCount,
        canonical_outcome_id: retryChain.canonicalOutcomeId,
        pending_registration_id: null,
        execution_status: executionStatus,
        failure_reason_code: failureReasonCode,
        failure_stage: failureStage,
        status_origin: statusOrigin,
        // ── Decision Recommendation Engine ───────────────────────
        // Task resolution rule: developer-provided wins, else infer.
        task_name: body._resolved_task_name ?? null,
        semantic_cluster_key: semanticCluster.clusterKey,
        semantic_cluster_domain: semanticCluster.domain,
        semantic_cluster_intent: semanticCluster.intent,
        semantic_cluster_confidence: semanticCluster.confidence,
        // ── Ingestion Quality Layer ───────────────────────────────
        // Raw developer signal — never fabricated, null if not provided.
        outcome_score_raw: outcomeScoreRaw,
        // 0.0–1.0 completeness score for this event.
        data_quality: dataQuality,
        // TRUE when success=true but outcome_score_raw < 0.3 — flagged, not overridden.
        is_inconsistent: isInconsistent,
        inconsistency_type: inconsistencyType,
        inconsistency_reason: inconsistencyReason,
        // Confidence of issue_type → task_name mapping (1.0 = developer provided).
        mapping_confidence: mappingConfidence,
        // 'provided' = developer sent outcome_score; 'inferred' = absent, fell back to binary.
        score_origin: scoreOrigin,
        // Exact tier from TaskInferResult: 'developer_provided' | 'exact_match' | etc.
        mapping_tier: mappingTier,
        // Encodes which rule/threshold flagged is_inconsistent (null if not flagged).
        inconsistency_rule_version: inconsistencyRuleVersion,
        // ── Inference Engine (migration 102) ─────────────────
        inference_confidence: inferenceConfidence,
        outcome_class: outcomeClass,
        ...(body.resource_cost_units != null ? { resource_cost_units: body.resource_cost_units } : {}),
        ...(body.resource_cost_type ? { resource_cost_type: body.resource_cost_type } : {}),
    });

    return {
        outcome_id: inserted.outcomeId,
        timestamp: inserted.timestamp,
    };
}

async function saveIdempotencyRecord(idempotencyKey: string | undefined, outcomeId: string, customerId: string) {
    if (!idempotencyKey) return;
    const { error: idempErr } = await supabase
        .from('fact_outcome_idempotency')
        .insert({
            idempotency_key: idempotencyKey,
            outcome_id: outcomeId,
            customer_id: customerId,
        });

    if (idempErr) {
        if (idempErr.code === '23505') throw new Error('CONFLICT');
        console.warn('[log-outcome] Failed to save idempotency key:', idempErr.message);
    }
}

async function resolveDecisionId(body: any, agentId: string, actionId: string, outcomeId: string, customerId: string) {
    if (!body.decision_id) return null;

    try {
        const { data: decision, error: decErr } = await supabase
            .from('fact_decisions')
            .select('*')
            .eq('id', body.decision_id)
            .maybeSingle();

        if (decErr || !decision) {
            console.warn('[log-outcome] decision_id not found:', body.decision_id);
            return null;
        }

        const { data: owningAgent, error: ownerErr } = await supabase
            .from('dim_agents')
            .select('agent_id')
            .eq('agent_id', decision.agent_id)
            .eq('customer_id', customerId)
            .maybeSingle();

        if (ownerErr || !owningAgent) {
            console.warn('[log-outcome] decision_id is outside tenant scope:', body.decision_id);
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
            .eq('id', body.decision_id)
            .eq('agent_id', agentId);

        return decision;
    } catch (err: any) {
        if (err.message === 'DECISION_AGENT_MISMATCH') throw err;
        console.warn('[log-outcome] decision resolution error:', err.message);
        return null;
    }
}

async function computePolicyRecommendation(
    customerId: string, contextId: string, agentId: string, issueType: string
): Promise<{ policy: ReturnType<typeof getPolicyDecision>; trust: AgentTrustScore } | null> {
    try {
        // NOTE: trust will be null only if agent_trust_scores row is missing.
        // fn_init_agent_trust() trigger (migration 058) prevents this for all
        // agents created via normal account setup. DEFAULT_TRUST in policy-engine.ts
        // handles the fallback; its trust_status='new' routes to forced exploration.
        const [scores, agentTrust, customerConfig] = await Promise.all([
            getScores(customerId, contextId, issueType, false),
            getAgentTrust(agentId),
            getCustomerConfig(customerId),
        ]);
        const policy = getPolicyDecision({
            rankedActions: scores.ranked_actions,
            agentTrust,
            customerConfig,
            coldStartActive: scores.cold_start,
        });
        return { policy, trust: agentTrust };
    } catch {
        return null;
    }
}

// ISSUE 9: Detect post-recommendation regression.
// If a developer followed a recommendation (switched to a new action) and
// performance got WORSE, surface a warning alert in degradation_alert_events.
// Fire-and-forget - never throws, never blocks outcome logging.
export async function checkRecommendationRegression(
    customerId: string,
    agentId: string,
    actionId: string,
    actionName: string,
    taskName: string | null,
    finalSuccess: boolean,
): Promise<void> {
    if (!taskName) return;
    try {
        const { data: recentOutcomes, error } = await supabase
            .from('fact_outcomes')
            .select('success, timestamp')
            .eq('customer_id', customerId)
            .eq('action_id', actionId)
            .eq('task_name', taskName)
            .eq('environment', 'production')
            .order('timestamp', { ascending: false })
            .limit(20);

        if (error || !recentOutcomes || recentOutcomes.length < 10) return;

        // Recent 10 outcomes success rate
        const recent10 = recentOutcomes.slice(0, 10);
        const recentRate = recent10.filter((o: any) => o.success).length / 10;

        // Baseline: full 20-outcome rolling window
        const baselineRate = recentOutcomes.filter((o: any) => o.success).length
            / recentOutcomes.length;

        // Regression threshold: recent 10 are 15%+ worse than 20-outcome baseline
        const isRegression =
            baselineRate > 0.1 &&
            (baselineRate - recentRate) > 0.15;

        if (!isRegression) return;

        await supabase.from('degradation_alert_events').insert({
            customer_id: customerId,
            agent_id: agentId,
            alert_type: 'recommendation_regression',
            severity: 'warning',
            message:
                `Post-recommendation regression detected for action "${actionName}" ` +
                `on task "${taskName}". ` +
                `Recent 10-outcome rate: ${(recentRate * 100).toFixed(1)}% vs ` +
                `baseline ${(baselineRate * 100).toFixed(1)}%. ` +
                `This recommendation may not have improved performance. ` +
                `Review in Dashboard -> Discrepancies.`,
        });

        console.warn('[log-outcome] recommendation_regression', {
            customer_id: customerId,
            agent_id: agentId,
            action_name: actionName,
            task_name: taskName,
            recent_rate: recentRate,
            baseline_rate: baselineRate,
        });
    } catch (err: any) {
        // Never propagate - regression check must NEVER affect outcome logging
        console.warn('[log-outcome] regression check threw (suppressed):', err.message);
    }
}

// ── MAIN ORCHESTRATOR ──
logOutcomeRouter.post('/', async (c) => {
    const agentId = c.get('agent_id') as string;
    const customerId = c.get('customer_id') as string;

    if (!customerId) {
        return c.json({ error: 'Missing customer context', code: 'MISSING_CUSTOMER_ID' }, 401);
    }

    try {
        // 1. Parsing & Sanitization
        const body = await parseAndSanitizeRequest(c);

        // Ensure all ingestion paths carry an idempotency key.
        body.idempotency_key = body.idempotency_key ?? crypto.randomUUID();

        // ── Early validation (before queue fast-path) ──────────
        // STATUS_CONFLICT checks are pure in-memory — no DB round-trips needed.
        // Run them BEFORE the durable queue fast-accept so invalid payloads
        // are rejected immediately (400) instead of being silently queued.
        const earlyRequestedStatus = normalizeExecutionStatus(body.execution_status ?? null);
        // body.success is already boolean after Zod parsing — no need to re-preprocess
        const successResult = body.success as boolean;
        const earlyScore = (() => {
            if (body.outcome_score === undefined || body.outcome_score === null) return null;
            const num = Number(body.outcome_score);
            if (!Number.isFinite(num)) return null;
            if (num >= 2 && num <= 100) return num / 100;
            return num;
        })();
        const earlyScoreDerivedStatus = earlyScore !== null && Number.isFinite(earlyScore)
            ? (earlyScore >= 0.5 ? 'COMPLETED' as const : 'FAILED' as const)
            : null;
        if (earlyRequestedStatus && ((earlyRequestedStatus === 'COMPLETED') !== successResult)) {
            throw new Error('STATUS_CONFLICT:execution_status conflicts with resolved success value');
        }
        if (earlyRequestedStatus && earlyScoreDerivedStatus && earlyRequestedStatus !== earlyScoreDerivedStatus) {
            throw new Error('STATUS_CONFLICT:execution_status conflicts with outcome_score_raw polarity');
        }

        const queueBypass = (c.req.header(OUTCOME_INGEST_WORKER_BYPASS_HEADER) ?? '').trim() === '1';
        const queueMode = getOutcomeQueueMode();

        // Fast-accept path: enqueue to Postgres durable queue and return 202 immediately.
        // Worker processes the full ingestion path asynchronously.
        if (queueMode !== 'sync' && !queueBypass) {
            const validatedAction = c.get('validated_action') as {
                action_id?: string;
                action_name?: string;
                action_category?: string;
            } | null;

            // ── Durable Postgres queue ────────────────────────────────
            // Data is persisted to disk via INSERT before we return 202.
            // Worker processes asynchronously via direct function call.
            if (queueMode === 'postgres') {
                try {
                    const ingressId = await enqueueDurable({
                        customerId,
                        agentId,
                        idempotencyKey: body.idempotency_key ?? null,
                        payload: body as Record<string, unknown>,
                        validatedAction: validatedAction as Record<string, unknown> | null,
                    });

                    return c.json({
                        logged: true,
                        outcome_id: ingressId,
                        agent_trust_score: 1.0,
                        trust_status: 'trusted',
                        policy: 'explore',
                        accepted: true,
                        queued: true,
                        queue_backend: 'postgres_durable',
                        idempotency_key: body.idempotency_key,
                        message: 'Outcome durably queued for asynchronous ingestion.',
                    }, 202);
                } catch (pgQueueErr: any) {
                    // Safety: if Postgres queue INSERT fails, fall through to sync path.
                    console.error('[log-outcome] postgres queue enqueue failed, falling to sync:', pgQueueErr?.message ?? pgQueueErr);
                }
            }
        }

        // ── Task resolution (Decision Recommendation Engine) ──────
        // Apply BEFORE idempotency check so the task_name is part of the record.
        // RULE: developer-provided task_name always wins — confidence 1.0.
        //       If absent, inferTask() returns a tiered confidence result.
        const rawTask = body.task_name?.trim() || null;
        let taskInferResult: TaskInferResult;
        if (rawTask) {
            const normalizedProvidedTask = validateTaskName(rawTask);

            if (isGenericTaskName(normalizedProvidedTask)) {
                // Generic placeholders (e.g. unknown_task) should not override
                // a potentially more specific issue_type-derived task.
                taskInferResult = inferTask(body.issue_type);

                // If issue_type is still not informative, keep the generic task
                // but do not mark it as developer-authoritative.
                if (taskInferResult.tier === 'unknown') {
                    taskInferResult = {
                        task: normalizedProvidedTask,
                        confidence: TASK_MAPPING_CONFIDENCE.slugified_fallback,
                        tier: 'slugified_fallback',
                    };
                }
            } else {
                // Developer explicitly provided a specific task_name.
                taskInferResult = {
                    task: normalizedProvidedTask,
                    confidence: TASK_MAPPING_CONFIDENCE.developer_provided,
                    tier: 'developer_provided',
                };
            }
        } else {
            // Auto-infer from issue_type with confidence tier.
            taskInferResult = inferTask(body.issue_type);
        }
        (body as any)._resolved_task_name = taskInferResult.task;
        (body as any)._mapping_confidence = taskInferResult.confidence;

        // Logging for ingestion traceability
        console.info('[log-outcome] task_resolved', {
            provided: body.task_name ?? null,
            inferred_from: rawTask ? null : body.issue_type,
            resolved: taskInferResult.task,
            tier: taskInferResult.tier,
            confidence: taskInferResult.confidence,
            customer_id: customerId,
            agent_id: agentId,
        });

        // 2. Idempotency Check
        const originalOutcome = await handleIdempotency(body.idempotency_key, customerId);
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

        // outcome_score_raw: the exact value the developer sent — never fabricated.
        // NULL if the developer did not provide one. Preserved permanently.
        const outcomeScoreRaw: number | null =
            (body.outcome_score !== undefined && body.outcome_score !== null)
                ? body.outcome_score
                : null;

        // If the verifier overrides confidence, use that as the effective score.
        // Otherwise: use developer score if provided, else null (no fabrication).
        // The scoring engine in task-performance.ts handles null via fallback to
        // binary success (0 or 1) — but now it knows the signal is inferred, not real.
        const finalOutcomeScore: number | null =
            verification.confidence_override !== null
                ? verification.confidence_override
                : outcomeScoreRaw;

        // score_origin: was outcome_score explicitly provided by the developer?
        const scoreOrigin: 'provided' | 'inferred' = outcomeScoreRaw !== null ? 'provided' : 'inferred';

        const requestedExecutionStatus = normalizeExecutionStatus(body.execution_status ?? null);
        if (requestedExecutionStatus && ((requestedExecutionStatus === 'COMPLETED') !== finalSuccess)) {
            throw new Error('STATUS_CONFLICT:execution_status conflicts with resolved success value');
        }

        const scoreDerivedStatus = statusFromOutcomeScore(outcomeScoreRaw);
        if (requestedExecutionStatus && scoreDerivedStatus && requestedExecutionStatus !== scoreDerivedStatus) {
            throw new Error('STATUS_CONFLICT:execution_status conflicts with outcome_score_raw polarity');
        }

        const executionStatus: ExecutionStatus = requestedExecutionStatus
            ?? (finalSuccess ? 'COMPLETED' : 'FAILED');

        const statusOrigin: StatusOrigin = requestedExecutionStatus
            ? 'explicit'
            : scoreOrigin === 'inferred'
                ? 'inferred_from_score'
                : 'inferred_from_success';

        let failureReasonCode = normalizeFailureReasonCode(body.failure_reason_code);
        let failureStage = normalizeFailureStage(body.failure_stage);

        if (executionStatus === 'COMPLETED') {
            failureReasonCode = null;
            failureStage = null;
        } else {
            if (!failureReasonCode) {
                failureReasonCode = normalizeFailureReasonCode(body.error_code) ?? 'execution_failed';
            }
            if (!failureStage) {
                failureStage = body.feedback_signal === 'delayed'
                    ? 'delayed_feedback'
                    : 'action_execution';
            }
        }

        // mapping_tier: exact tier string from TaskInferResult (persisted for audit trail).
        const mappingTier: string = taskInferResult.tier;

        const inconsistency = evaluateInconsistency({
            finalSuccess,
            outcomeScoreRaw,
            businessOutcome: body.business_outcome ?? null,
            verifierDiscrepancy: verification.discrepancy_detected === true,
        });

        // Data quality score: 0.0–1.0 completeness of this event.
        let mappingConfidence: number = (body as any)._mapping_confidence ?? 1.0;

        // 4. Resolve References
        const [actionId, contextId, retryChain] = await Promise.all([
            resolveActionId(c, body, customerId),
            resolveContextId(body, customerId),
            resolveRetryChainState(customerId, body),
        ]);

        // Best-effort context vector upkeep. This never blocks outcome ingestion.
        const ensureEmbedding = contextEmbed.ensureContextEmbedding?.({
            contextId,
            customerId,
            issueType: body.issue_type,
            customerTier: body.customer_tier ?? null,
            environment: body.environment ?? null,
            rawContext: body.raw_context ?? null,
        });
        if (ensureEmbedding) {
            ensureEmbedding.catch((err: any) => {
                console.warn('[log-outcome] ensureContextEmbedding failed:', err?.message ?? err);
            });
        }

        const semanticCluster = inferSemanticActionCluster({
            actionName: body.action_name ?? 'unknown_action',
            issueType: body.issue_type,
            taskName: (body as any)._resolved_task_name ?? null,
        });

        const crossEventStatus: 'none' | 'pending_signal' | 'confirmed' | 'conflict' | 'resolved' =
            body.feedback_signal === 'delayed'
                ? 'pending_signal'
                : 'none';

        // 4a. Outcome Score Inference — 3-layer engine
        // When developer omits outcome_score, infer from hard + soft + relative signals.
        // When developer provides outcome_score (score_fn), skip inference entirely.
        let resolvedOutcomeScore = finalOutcomeScore;
        let resolvedScoreOrigin = scoreOrigin;
        let inferenceConfidence: number | null = null;
        let outcomeClass: string | null = null;

        if (resolvedOutcomeScore === null) {
            const baseline = await fetchActionBaseline(agentId, actionId);
            const inferred = inferOutcomeScore({
                success: finalSuccess,
                retryAttempt: retryChain.retryAttempt,
                responseMs: body.response_time_ms ?? null,
                errorCode: body.error_code ?? null,
                errorMessage: body.error_message ?? null,
                businessOutcome: body.business_outcome ?? null,
                feedbackSignal: body.feedback_signal ?? null,
                crossEventStatus: crossEventStatus,
                verifierSource: body.verifier_signal?.source ?? null,
                verifierValue: body.verifier_signal?.value ?? null,
                actionBaseline: baseline,
            });
            resolvedOutcomeScore = inferred.score;
            resolvedScoreOrigin = 'inferred';
            inferenceConfidence = inferred.confidence;
            outcomeClass = inferred.class;
        }


        // 4b. Signal contradiction feedback — degraded/uncertain outcomes
        // degrade mapping confidence (task mapping is less meaningful when signals disagree).
        if (outcomeClass === 'degraded' || outcomeClass === 'uncertain') {
            mappingConfidence = Math.max(0, mappingConfidence - 0.05);
        }

        // Data quality score: 0.0–1.0 completeness of this event.
        // Computed AFTER inference so the penalty reflects inference confidence.
        const dataQuality = computeDataQuality({
            outcomeScoreRaw,
            isInconsistent: inconsistency.isInconsistent,
            mappingConfidence,
            businessOutcome: body.business_outcome ?? null,
            inferenceConfidence,
        });

        // 5. Insert Core Fact
        const outcome = await insertCoreOutcome(
            agentId, customerId, actionId, contextId,
            body, finalSuccess, resolvedOutcomeScore, verification,
            executionStatus,
            failureReasonCode,
            failureStage,
            statusOrigin,
            outcomeScoreRaw,
            dataQuality,
            inconsistency.isInconsistent,
            inconsistency.type,
            inconsistency.reason,
            mappingConfidence,
            resolvedScoreOrigin,
            mappingTier,
            inconsistency.ruleVersion,
            semanticCluster,
            crossEventStatus,
            retryChain,
            inferenceConfidence,
            outcomeClass,
        );

        invalidateActionBaselineCache(agentId, actionId);

        // 6. Post-Insert Synchronous Updates
        await saveIdempotencyRecord(body.idempotency_key, outcome.outcome_id, customerId);
        invalidateCache(customerId, contextId);
        const decisionRecord = await resolveDecisionId(body, agentId, actionId, outcome.outcome_id, customerId);

        // 7. Fire-and-forget Asynchronous Pipelines via Orchestrator
        orchestrateOutcome({
            agentId, customerId, outcomeId: outcome.outcome_id, actionId, actionName: body.action_name ?? 'unknown',
            contextId, issueType: body.issue_type, finalSuccess, finalOutcomeScore: resolvedOutcomeScore,
            responseMs: body.response_time_ms ?? null, episodeId: body.episode_id,
            errorCode: body.error_code ?? null,
            businessOutcome: body.business_outcome, decisionId: body.decision_id, decisionRecord,
            signalConfidence: body.causal_confidence ?? null,
        }).catch(err => console.error('[log-outcome] orchestrator failed:', { error: err.message, outcomeId: outcome.outcome_id }));

        checkRecommendationRegression(
            customerId,
            agentId,
            actionId,
            body.action_name ?? 'unknown',
            (body as any)._resolved_task_name ?? null,
            finalSuccess,
        ).catch(() => {
            // Silent - regression check must never affect outcome logging
        });

        // ── Refresh task aggregation (debounced in the store) ─────
        // Fires async — never blocks the response.
        // mv_task_action_performance stays fresh within ~30s of each write.
        refreshTaskAggregation(customerId).catch(() => {
            // Silent — aggregation refresh failure must NEVER affect outcome logging
        });

        // 8. Response Wrap-up (non-blocking)
        // Do not synchronously compute policy here: it can read stale MV data
        // during the refresh debounce window and repopulate cold-start cache.
        const agentTrust = LOCAL_DEFAULT_TRUST;
        const finalValidatedAction = c.get('validated_action') as any;

        const counterfactualsComputed = !!(decisionRecord?.ranked_actions);
        const sequencePosition = body.episode_id ? (body.episode_history ? body.episode_history.length : 0) : null;

        return c.json({
            success: true,
            outcome_id: outcome.outcome_id,
            action_id: actionId,
            context_id: contextId,
            timestamp: outcome.timestamp,
            message: `Outcome logged. Action "${body.action_name ?? 'unknown'}" — ${finalSuccess ? 'SUCCESS' : 'FAILURE'}`,
            // ── SDK required response fields ──────────────────
            logged: true,
            agent_trust_score: agentTrust.trust_score,
            trust_status: agentTrust.trust_status,
            policy: 'explore',
            recommendation: null,
            next_actions: null,
            counterfactuals_computed: counterfactualsComputed,
            sequence_position: sequencePosition,
            idempotency_replayed: false,
            validation_warnings: finalValidatedAction?.validation_warnings ?? [],
            // ── Ingestion quality feedback — lets SDK callers see exactly what was stored.
            ingestion_quality: {
                data_quality: dataQuality,
                score_origin: resolvedScoreOrigin,
                is_inconsistent: inconsistency.isInconsistent,
                inconsistency_type: inconsistency.type,
                inconsistency_reason: inconsistency.reason,
                inconsistency_rule_version: inconsistency.ruleVersion,
                mapping_tier: mappingTier,
                mapping_confidence: mappingConfidence,
                inference_confidence: inferenceConfidence,
                outcome_class: outcomeClass,
                execution_status: executionStatus,
                failure_reason_code: failureReasonCode,
                failure_stage: failureStage,
                status_origin: statusOrigin,
                semantic_cluster: {
                    key: semanticCluster.clusterKey,
                    domain: semanticCluster.domain,
                    intent: semanticCluster.intent,
                    confidence: semanticCluster.confidence,
                    matched_tokens: semanticCluster.matchedTokens,
                },
                retry_chain: {
                    retry_chain_id: retryChain.retryChainId,
                    retry_attempt: retryChain.retryAttempt,
                    attempt_count: retryChain.crossEventAttemptCount,
                    canonical_outcome_id: retryChain.canonicalOutcomeId,
                },
                cross_event_status: crossEventStatus,
            },
            // ISSUE 4: Tell developer exactly when and how to improve logging quality.
            // outcome_score_tip is null when they already provided outcome_score (no nagging).
            logging_guidance: {
                when_to_log:
                    'Log AFTER the action result is known - not when you start it. ' +
                    'Examples: after API response received, after retry completes, ' +
                    'after ticket closes, after payment confirms.',
                outcome_score_tip: (body.outcome_score === undefined || body.outcome_score === null)
                    ? 'Pass outcome_score (0.0-1.0) for richer signal. ' +
                    'Example: partial_success=0.6, full_success=1.0, failure=0.0'
                    : null,
                silent_failure_explanation: finalSuccess === false && (finalOutcomeScore === null || finalOutcomeScore < 0.3)
                    ? 'This outcome was logged as a silent failure - the agent reported a result but did not resolve the issue. Silent failures are scored separately and used to detect patterns. See Dashboard -> Alerts -> Silent Failures for aggregated data.'
                    : null,
                dashboard_lag_notice:
                    'Dashboard charts update within 500ms of this log. If data appears missing, wait 1-2 seconds and refresh.',
                next_milestone: (body as any)._resolved_task_name
                    ? `Keep logging for task "${(body as any)._resolved_task_name}" ` +
                    `to improve recommendation confidence.`
                    : 'Add task_name to your log_outcome calls for task-specific recommendations.',
                inconsistency_diagnostics: inconsistency.isInconsistent
                    ? {
                        type: inconsistency.type,
                        reason: inconsistency.reason,
                        resolution_hint:
                            'Align success, outcome_score, and business_outcome to the same real-world truth. ' +
                            'If delayed signal is expected, register pending signal and send final feedback later.',
                    }
                    : null,
                delayed_signal_hint: body.feedback_signal === 'delayed'
                    ? 'This outcome was marked as pending delayed validation. Register /v1/pending-signals and send /v1/outcome-feedback or webhook confirmation to close the lifecycle.'
                    : null,
            },
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
        if (err.message.startsWith('STATUS_CONFLICT:')) {
            return c.json({
                error: 'execution_status conflicts with resolved success',
                details: err.message.substring(16),
                code: 'STATUS_CONFLICT',
            }, 400);
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

const _taskPerfRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _actionScoresRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Debounce duration: controlled by env var.
// Default 15s for production (safe under load), 2s for development.
const REFRESH_DEBOUNCE_MS = process.env.NODE_ENV === 'production'
    ? Number(process.env.MV_REFRESH_DEBOUNCE_MS ?? 15_000)
    : 2_000;

const ACTION_SCORES_DEBOUNCE_MS = Number(process.env.ACTION_SCORES_DEBOUNCE_MS ?? 500);

/**
 * Debounced materialized view refresh coordinator.
 *
 * - mv_action_scores refresh: fast debounce (default 500ms) for SDK decision freshness.
 * - mv_task_action_performance refresh: slower debounce (default 15s in production)
 *   for dashboard/task aggregation workloads.
 *
 * ⚠️  NEVER AWAIT THIS FUNCTION.
 * The returned Promise resolves when both debounce timers fire. Awaiting can
 * stall the HTTP response and must be avoided in request handlers.
 *
 * Always call as fire-and-forget:
 *   refreshTaskAggregation(customerId).catch(() => {});
 *
 * SIGTERM behaviour: timers in _taskPerfRefreshTimers / _actionScoresRefreshTimers are lost if the process
 * exits during a debounce window. This is acceptable — mv_task_action_performance
 * is eventually consistent and will self-heal on the next outcome log.
 * decision-writer.ts has a SIGTERM flush for decisions (which are durable);
 * MV refreshes deliberately do not, since they are idempotent and cheap.
 */
async function refreshTaskPerformance(customerId: string): Promise<void> {
    const existing = _taskPerfRefreshTimers.get(customerId);
    if (existing) clearTimeout(existing);

    return new Promise((resolve) => {
        const timer = setTimeout(async () => {
            _taskPerfRefreshTimers.delete(customerId);
            try {
                const { error } = await supabase.rpc('refresh_task_action_performance');
                if (error) {
                    // Log but never throw — refresh failure must not affect logging
                    console.warn('[log-outcome] MV refresh RPC failed:', {
                        customer_id: customerId,
                        error: error.message,
                        hint: 'Data is stale - check mv_tap_unique_idx exists in Supabase',
                    });
                } else {
                    console.info('[log-outcome] MV refresh OK', { customer_id: customerId });
                }
            } catch (err: any) {
                console.warn('[log-outcome] MV refresh threw:', err.message);
            }
            resolve();
        }, REFRESH_DEBOUNCE_MS);
        _taskPerfRefreshTimers.set(customerId, timer);
    });
}

async function refreshActionScores(customerId: string): Promise<void> {
    const existing = _actionScoresRefreshTimers.get(customerId);
    if (existing) clearTimeout(existing);

    return new Promise((resolve) => {
        const timer = setTimeout(async () => {
            _actionScoresRefreshTimers.delete(customerId);
            try {
                const { error } = await supabase.rpc('refresh_action_scores');
                if (error) {
                    console.warn('[log-outcome] MV refresh_action_scores RPC failed:', {
                        customer_id: customerId,
                        error: error.message,
                        hint: 'Data is stale - check mv_action_scores unique index exists in Supabase',
                    });
                }
            } catch (err: any) {
                console.warn('[log-outcome] MV refresh_action_scores threw:', err.message);
            }
            resolve();
        }, ACTION_SCORES_DEBOUNCE_MS);
        _actionScoresRefreshTimers.set(customerId, timer);
    });
}

export async function refreshTaskAggregation(customerId: string): Promise<void> {
    await Promise.allSettled([
        refreshTaskPerformance(customerId),
        refreshActionScores(customerId),
    ]);
}