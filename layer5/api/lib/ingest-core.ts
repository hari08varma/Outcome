/**
 * LAYERINFINITE — lib/ingest-core.ts
 * ══════════════════════════════════════════════════════════════
 * Shared outcome insertion logic reused by:
 *   - log-outcome route (SDK real-time ingestion)
 *   - import route (historical file upload ingestion)
 *
 * Extracts the data pipeline from the HTTP layer so both callers
 * get identical normalization, FK resolution, quality scoring,
 * and DB insertion without duplicated logic.
 *
 * KEY INVARIANT: ingestion_source must always be set by the caller.
 *   'sdk'    → real-time SDK outcome
 *   'import' → historical file upload
 *
 * Trust side-effects (orchestrateOutcome + upsertLiveTrustScore)
 * are NEVER triggered for 'import' rows — controlled via skipTrustUpdate.
 * ══════════════════════════════════════════════════════════════
 */

import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { invalidateCache, getCachedScore } from './scoring.js';
import { orchestrateOutcome } from './outcome-orchestrator.js';
import { resolveVerifiedSuccess } from './verifier.js';
import { inferTask, isGenericTaskName, validateTaskName, TASK_MAPPING_CONFIDENCE } from './recommendation/task-infer.js';
import type { TaskInferResult, TaskMappingTier } from './recommendation/task-infer.js';
import { inferSemanticActionCluster } from './recommendation/semantic-action-cluster.js';
import type { SemanticActionClusterResult } from './recommendation/semantic-action-cluster.js';
import { sanitizeContext, sanitizeString } from './sanitize.js';
import * as contextEmbed from './context-embed.js';
import {
    inferOutcomeScore,
    fetchActionBaseline,
    invalidateActionBaselineCache,
} from './outcome-score-inference.js';
import type { InferredOutcomeScore } from './outcome-score-inference.js';

// ── Types ─────────────────────────────────────────────────────

export type IngestionSource = 'sdk' | 'import';
export type ExecutionStatus = 'COMPLETED' | 'FAILED';
export type StatusOrigin =
    | 'explicit'
    | 'inferred_from_success'
    | 'inferred_from_score'
    | 'reconciled_feedback';

export interface IngestCoreOptions {
    /** Never triggers trust update when true (used for 'import' rows). */
    skipTrustUpdate: boolean;
    /** Column value written to fact_outcomes.ingestion_source */
    ingestionSource: IngestionSource;
    /**
     * Allows score inference even when skipTrustUpdate=true (import path).
     * Default false keeps historical import behavior stable.
     */
    enableInferenceWhenSkipTrust?: boolean;
    /** Original event timestamp from imported log file. NULL for SDK rows. */
    sourceEventAt?: Date | null;
    /**
     * Optional near-duplicate suppression window (milliseconds).
     * When set for import rows, an existing row in this window is reused
     * instead of inserting a duplicate event.
     */
    dedupWindowMs?: number;
    /** FK to import_jobs row. NULL for SDK rows. */
    importJobId?: string | null;
    /** Optional resolved refs from caller to avoid duplicate lookups. */
    resolvedActionId?: string;
    resolvedActionName?: string;
    resolvedContextId?: string;
    /** Optional precomputed scoring/quality values from caller. */
    precomputed?: {
        finalSuccess: boolean;
        finalOutcomeScore: number | null;
        outcomeScoreRaw: number | null;
        scoreOrigin: 'provided' | 'inferred';
        discrepancyDetected: boolean;
        dataQuality: number;
        isInconsistent: boolean;
        inconsistencyType: string | null;
        inconsistencyReason: string | null;
        mappingConfidence: number;
        mappingTier: string;
        inconsistencyRuleVersion: string | null;
    };
    /** Skip orchestrator side-effects even for sdk rows (caller handles it). */
    skipOrchestration?: boolean;
}

/**
 * Normalized row shape accepted by ingestOutcome().
 * Mirrors the LogOutcomeBody zod schema fields that the import parser
 * must produce after parsing the raw log file.
 */
export interface NormalizedOutcomeRow {
    agent_id: string;
    action_name: string;
    issue_type: string;
    success: boolean;
    outcome_score?: number | null;
    business_outcome?: string | null;
    session_id?: string | null;
    response_time_ms?: number | null;
    feedback_signal?: string;
    decision_id?: string | null;
    episode_id?: string | null;
    task_name?: string | null;
    raw_context?: Record<string, unknown>;
    error_code?: string | null;
    error_message?: string | null;
    idempotency_key?: string | null;
    environment?: string | null;
    customer_tier?: string | null;
    task_mapping_confidence?: number | null;
    task_mapping_tier?: string | null;
    verifier_source?: string | null;
    verifier_value?: string | number | boolean | null;
    backprop_episode_id?: string | null;
    signal_source?: 'causal_graph' | 'signal_contract' | 'http_inference' | 'explicit';
    signal_confidence?: number | null;
    signal_depth?: number | null;
    signal_pending?: boolean;
    cross_event_status?: 'none' | 'pending_signal' | 'confirmed' | 'conflict' | 'resolved';
    retry_chain_id?: string | null;
    retry_attempt?: number | null;
    cross_event_attempt_count?: number | null;
    canonical_outcome_id?: string | null;
    pending_registration_id?: string | null;
    execution_status?: ExecutionStatus | 'completed' | 'failed' | string | null;
    failure_reason_code?: string | null;
    failure_stage?: string | null;
    status_origin?: StatusOrigin | string | null;
    resource_cost_units?: number | null;
    resource_cost_type?: 'tokens' | 'api_calls' | 'compute_seconds' | null;
}

export interface IngestCoreResult {
    outcomeId: string;
    actionId: string;
    timestamp: string;
    ingestionQuality: {
        data_quality: number;
        score_origin: 'provided' | 'inferred';
        is_inconsistent: boolean;
        mapping_tier: string;
        mapping_confidence: number;
        inference_confidence: number | null;
        outcome_class: string | null;
        execution_status: ExecutionStatus;
        status_origin: StatusOrigin;
    };
}

// ── Internal types ────────────────────────────────────────────

export interface InconsistencyEvaluation {
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

// ── Helper: data quality scoring ─────────────────────────────

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function normalizeExecutionStatus(value: unknown): ExecutionStatus | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase();
    if (normalized === 'COMPLETED') return 'COMPLETED';
    if (normalized === 'FAILED') return 'FAILED';
    return null;
}

function normalizeStatusOrigin(value: unknown): StatusOrigin | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'explicit') return 'explicit';
    if (normalized === 'inferred_from_success') return 'inferred_from_success';
    if (normalized === 'inferred_from_score') return 'inferred_from_score';
    if (normalized === 'reconciled_feedback') return 'reconciled_feedback';
    return null;
}

function normalizeFailureToken(value: string | null | undefined, maxLen: number): string | null {
    if (!value) return null;
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

function normalizeFailureReasonCode(value: string | null | undefined): string | null {
    const token = normalizeFailureToken(value, 80);
    if (!token) return null;
    return FAILURE_REASON_CODE_VOCAB.has(token)
        ? token
        : 'unknown_failure';
}

function normalizeFailureStage(value: string | null | undefined): string | null {
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

export function computeOutcomeDataQuality(params: {
    outcomeScoreRaw: number | null | undefined;
    isInconsistent: boolean;
    mappingConfidence: number;
    businessOutcome: string | null | undefined;
    inferenceConfidence?: number | null;
}): number {
    let score = 1.0;

    if (params.outcomeScoreRaw === null || params.outcomeScoreRaw === undefined) {
        // Score was inferred — penalize by inverse of inference confidence.
        // High confidence inference (0.75) → penalty ~0.06
        // Low confidence inference (0.30)  → penalty ~0.18
        // No inference at all              → penalty 0.25 (original behavior)
        const conf = params.inferenceConfidence ?? 0;
        const penalty = conf > 0
            ? Math.max(0.05, 0.25 * (1 - conf))
            : 0.25;
        score -= penalty;
    }

    if (params.isInconsistent) score -= 0.20;
    if (params.mappingConfidence < 0.70) score -= 0.20;
    if (!params.businessOutcome) score -= 0.10;
    
    return Number(Math.max(0.0, score).toFixed(4));
}

export function evaluateInconsistencyRules(params: {
    finalSuccess: boolean;
    outcomeScoreRaw: number | null;
    businessOutcome: string | null | undefined;
}): InconsistencyEvaluation {
    const lowThreshold = clamp01(
        Number(process.env.LI_INCONSISTENCY_THRESHOLD ?? 0.3)
    );
    const highThreshold = clamp01(
        Number(process.env.LI_INCONSISTENCY_HIGH_THRESHOLD ?? 0.7)
    );

    if (params.finalSuccess && params.outcomeScoreRaw !== null && params.outcomeScoreRaw < lowThreshold) {
        return {
            isInconsistent: true,
            type: 'success_low_score',
            reason: `success=true but outcome_score_raw=${params.outcomeScoreRaw.toFixed(4)} < threshold ${lowThreshold.toFixed(4)}.`,
            ruleVersion: `v2:success_low_score:threshold=${lowThreshold.toFixed(4)}`,
        };
    }
    if (!params.finalSuccess && params.outcomeScoreRaw !== null && params.outcomeScoreRaw > highThreshold) {
        return {
            isInconsistent: true,
            type: 'failure_high_score',
            reason: `success=false but outcome_score_raw=${params.outcomeScoreRaw.toFixed(4)} > threshold ${highThreshold.toFixed(4)}.`,
            ruleVersion: `v2:failure_high_score:threshold=${highThreshold.toFixed(4)}`,
        };
    }
    if (params.finalSuccess && (params.businessOutcome === 'partial' || params.businessOutcome === 'failed')) {
        return {
            isInconsistent: true,
            type: 'success_business_conflict',
            reason: `success=true but business_outcome=${params.businessOutcome}.`,
            ruleVersion: 'v2:success_business_conflict',
        };
    }
    return { isInconsistent: false, type: null, reason: null, ruleVersion: null };
}

function computeSalience(
    actionId: string,
    contextId: string,
    customerId: string,
    success: boolean
): number {
    const cached = getCachedScore(actionId, contextId, customerId);
    if (cached !== null && cached > 0.9 && success) return 0.1;
    return 1.0;
}

const UUID_V4ISH_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TASK_MAPPING_TIERS: ReadonlySet<TaskMappingTier> = new Set([
    'developer_provided',
    'exact_match',
    'prefix_match',
    'slugified_fallback',
    'unknown',
]);

function isUuid(value: string | null | undefined): value is string {
    return !!value && UUID_V4ISH_RE.test(value);
}

function isTaskMappingTier(value: string): value is TaskMappingTier {
    return TASK_MAPPING_TIERS.has(value as TaskMappingTier);
}

function deterministicUuidFromSeed(seed: string): string {
    const chars = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
    // RFC 4122 version + variant bits
    chars[12] = '5';
    const variantNibble = Number.parseInt(chars[16], 16);
    chars[16] = ((variantNibble & 0x3) | 0x8).toString(16);
    const hex = chars.join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── FK resolution ─────────────────────────────────────────────

/**
 * Resolves or auto-registers an action in dim_actions.
 * Reuses the same path as the log-outcome route (Path 3: direct validation).
 * Import rows always go through this path — no causal_graph or backward-compat paths.
 */
export async function resolveActionIdForIngest(
    actionName: string,
    customerId: string,
): Promise<{ actionId: string; resolvedActionName: string }> {
    const { normalizeActionName } = await import('../middleware/validate-action.js');
    const normalized = normalizeActionName(actionName);

    const rawLower = actionName
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (rawLower && rawLower !== normalized) {
        const mergeReason = rawLower.match(/_v\d|_(final|new|old|temp|test|prod|dev|handler|fn|func|impl)$/)
            ? 'version_strip'
            : 'camel_normalize';
        void (async () => {
            try {
                const { error } = await supabase
                    .from('dim_action_aliases')
                    .upsert({
                        raw_name: rawLower,
                        canonical_name: normalized,
                        customer_id: customerId,
                        merge_reason: mergeReason,
                        merge_confidence: 1.0,
                        similarity: null,
                    }, {
                        onConflict: 'raw_name,customer_id',
                        ignoreDuplicates: true,
                    });

                if (error && error.code !== '23505') {
                    console.warn('[ingest-core] alias upsert failed:', error.message);
                }
            } catch (err: unknown) {
                console.warn('[ingest-core] alias upsert threw:', (err as Error).message);
            }
        })();
    }

    // Import payloads frequently contain historical/novel action names.
    // Resolve existing action first, then auto-register on first use.
    const { data: existing, error: lookupError } = await supabase
        .from('dim_actions')
        .select('action_id, action_name, is_active')
        .eq('action_name', normalized)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (lookupError) {
        throw new Error(`ACTION_LOOKUP_ERROR:${lookupError.message}`);
    }

    if (existing) {
        if (!existing.is_active) {
            throw new Error(`ACTION_DISABLED:Action "${normalized}" is currently disabled`);
        }
        return { actionId: existing.action_id, resolvedActionName: existing.action_name };
    }

    const { data: registered, error: registerError } = await supabase
        .from('dim_actions')
        .upsert(
            {
                action_name: normalized,
                customer_id: customerId,
                is_active: true,
                action_category: 'auto-discovered',
                action_description: 'Auto-registered on first use by historical import',
                required_params: {},
                validation_mode: 'advisory',
            },
            {
                onConflict: 'action_name,customer_id',
                ignoreDuplicates: false,
            }
        )
        .select('action_id, action_name, is_active')
        .maybeSingle();

    if (registerError || !registered) {
        throw new Error(`ACTION_REGISTER_ERROR:${registerError?.message ?? 'No action row returned'}`);
    }

    if (!registered.is_active) {
        throw new Error(`ACTION_DISABLED:Action "${normalized}" is currently disabled`);
    }

    return { actionId: registered.action_id, resolvedActionName: registered.action_name };
}

/**
 * Upserts a context row scoped to (customer_id, issue_type, environment).
 * Identical logic to resolveContextId in log-outcome.ts.
 */
export async function resolveContextIdForIngest(
    customerId: string,
    issueType: string,
    environment: string | null | undefined,
    customerTier: string | null | undefined,
): Promise<string> {
    const { data: ctx, error } = await supabase
        .from('dim_contexts')
        .upsert(
            {
                customer_id: customerId,
                issue_type: issueType,
                environment: environment ?? null,
                customer_tier: customerTier ?? null,
            },
            { onConflict: 'customer_id,issue_type,environment', ignoreDuplicates: false }
        )
        .select('context_id')
        .maybeSingle();

    if (error) throw new Error(`CONTEXT_ERROR:${error.message}`);

    if (!ctx?.context_id) {
        const { data: existing } = await supabase
            .from('dim_contexts')
            .select('context_id')
            .eq('customer_id', customerId)
            .eq('issue_type', issueType)
            .eq('environment', environment ?? null)
            .maybeSingle();
        if (existing?.context_id) return existing.context_id;
        throw new Error('CONTEXT_ERROR:No context_id returned after upsert');
    }
    return ctx.context_id;
}

// ── Idempotency ───────────────────────────────────────────────

export async function checkIdempotency(
    idempotencyKey: string,
    customerId: string,
): Promise<string | null> {
    const { data } = await supabase
        .from('fact_outcome_idempotency')
        .select('outcome_id')
        .eq('idempotency_key', idempotencyKey)
        .eq('customer_id', customerId)
        .maybeSingle();
    return data?.outcome_id ?? null;
}

async function saveIdempotencyRecord(
    idempotencyKey: string | null | undefined,
    outcomeId: string,
    customerId: string,
): Promise<void> {
    if (!idempotencyKey) return;
    const { error } = await supabase
        .from('fact_outcome_idempotency')
        .insert({ idempotency_key: idempotencyKey, outcome_id: outcomeId, customer_id: customerId });
    if (error && error.code !== '23505') {
        console.warn('[ingest-core] Failed to save idempotency key:', error.message);
    }
}

function parseNearDedupWindowMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

function normalizedTextToken(value: string | null | undefined): string | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function isNearDuplicateCandidate(
    candidate: {
        outcome_score_raw: number | null;
        response_time_ms: number | null;
        error_code: string | null;
        business_outcome: string | null;
    },
    target: {
        outcomeScoreRaw: number | null;
        responseTimeMs: number | null;
        errorCode: string | null;
        businessOutcome: string | null;
    },
): boolean {
    const candidateError = normalizedTextToken(candidate.error_code);
    const targetError = normalizedTextToken(target.errorCode);
    if (candidateError !== targetError) return false;

    const candidateOutcome = normalizedTextToken(candidate.business_outcome);
    const targetOutcome = normalizedTextToken(target.businessOutcome);
    if (candidateOutcome !== targetOutcome) return false;

    if (typeof candidate.response_time_ms === 'number' && typeof target.responseTimeMs === 'number') {
        if (Math.abs(candidate.response_time_ms - target.responseTimeMs) > 250) {
            return false;
        }
    }

    if (typeof candidate.outcome_score_raw === 'number' && typeof target.outcomeScoreRaw === 'number') {
        if (Math.abs(candidate.outcome_score_raw - target.outcomeScoreRaw) > 0.05) {
            return false;
        }
    }

    return true;
}

async function findNearDuplicateOutcome(params: {
    customerId: string;
    agentId: string;
    actionId: string;
    contextId: string;
    taskName: string;
    success: boolean;
    sourceEventAt: Date;
    dedupWindowMs: number;
    outcomeScoreRaw: number | null;
    responseTimeMs: number | null;
    errorCode: string | null;
    businessOutcome: string | null;
}): Promise<string | null> {
    const start = new Date(params.sourceEventAt.getTime() - params.dedupWindowMs).toISOString();
    const end = new Date(params.sourceEventAt.getTime() + params.dedupWindowMs).toISOString();

    const { data, error } = await supabase
        .from('fact_outcomes')
        .select('outcome_id, outcome_score_raw, response_time_ms, error_code, business_outcome')
        .eq('customer_id', params.customerId)
        .eq('agent_id', params.agentId)
        .eq('action_id', params.actionId)
        .eq('context_id', params.contextId)
        .eq('task_name', params.taskName)
        .eq('success', params.success)
        .eq('is_deleted', false)
        .eq('is_synthetic', false)
        .eq('ingestion_source', 'import')
        .gte('timestamp', start)
        .lte('timestamp', end)
        .order('timestamp', { ascending: false })
        .limit(5);

    if (error) {
        console.warn('[ingest-core] near-duplicate lookup failed:', error.message);
        return null;
    }

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const candidateOutcomeId = typeof row.outcome_id === 'string' ? row.outcome_id : null;
        if (!candidateOutcomeId) continue;

        const matches = isNearDuplicateCandidate(
            {
                outcome_score_raw: typeof row.outcome_score_raw === 'number' ? row.outcome_score_raw : null,
                response_time_ms: typeof row.response_time_ms === 'number' ? row.response_time_ms : null,
                error_code: typeof row.error_code === 'string' ? row.error_code : null,
                business_outcome: typeof row.business_outcome === 'string' ? row.business_outcome : null,
            },
            {
                outcomeScoreRaw: params.outcomeScoreRaw,
                responseTimeMs: params.responseTimeMs,
                errorCode: params.errorCode,
                businessOutcome: params.businessOutcome,
            },
        );

        if (matches) {
            return candidateOutcomeId;
        }
    }

    return null;
}

// ── Task resolution ───────────────────────────────────────────

export function resolveTaskName(
    providedTaskName: string | null | undefined,
    issueType: string,
): TaskInferResult {
    const rawTask = providedTaskName?.trim() || null;
    if (rawTask) {
        const normalized = validateTaskName(rawTask);
        if (!isGenericTaskName(normalized)) {
            return {
                task: normalized,
                confidence: TASK_MAPPING_CONFIDENCE.developer_provided,
                tier: 'developer_provided',
            };
        }
        // Generic placeholder — try issue_type instead
        const inferred = inferTask(issueType);
        if (inferred.tier !== 'unknown') return inferred;
        return {
            task: normalized,
            confidence: TASK_MAPPING_CONFIDENCE.slugified_fallback,
            tier: 'slugified_fallback',
        };
    }
    return inferTask(issueType);
}

/**
 * Shared insert helper for both import and log-outcome paths.
 * Keeps fact_outcomes write behavior aligned between ingestion routes.
 */
export async function insertOutcomeRecord(
    insertPayload: Record<string, unknown>,
): Promise<{ outcomeId: string; timestamp: string }> {
    const { data: outcome, error: insertErr } = await supabase
        .from('fact_outcomes')
        .insert(insertPayload)
        .select('outcome_id, timestamp')
        .single();

    if (insertErr || !outcome) {
        const message = insertErr?.message ?? 'Unknown insert error';
        const migrationHint = /column .* does not exist/i.test(message)
            ? ' Run missing schema migrations before retrying the ingest path.'
            : '';
        throw new Error(`INSERT_ERROR:${message}${migrationHint}`);
    }

    return {
        outcomeId: outcome.outcome_id,
        timestamp: typeof outcome.timestamp === 'string' ? outcome.timestamp : new Date().toISOString(),
    };
}

// ── Core insertion ────────────────────────────────────────────

/**
 * Insert a single normalized outcome row into fact_outcomes.
 * All callers (SDK route + import route) go through this function.
 */
export async function ingestOutcome(
    row: NormalizedOutcomeRow,
    customerId: string,
    opts: IngestCoreOptions,
): Promise<IngestCoreResult> {
    // 1. Resolve task name
    const taskInferResult = resolveTaskName(row.task_name, row.issue_type);

    // Preserve parser-provided mapping metadata when available.
    if (
        typeof row.task_mapping_confidence === 'number'
        && Number.isFinite(row.task_mapping_confidence)
        && typeof row.task_mapping_tier === 'string'
        && isTaskMappingTier(row.task_mapping_tier)
    ) {
        taskInferResult.confidence = Math.max(0, Math.min(1, row.task_mapping_confidence));
        taskInferResult.tier = row.task_mapping_tier;
        if (row.task_name && row.task_name.trim().length > 0) {
            taskInferResult.task = row.task_name;
        }
    }

    // 2. Idempotency check
    if (row.idempotency_key) {
        const existing = await checkIdempotency(row.idempotency_key, customerId);
        if (existing) {
            const replayRequestedStatus = normalizeExecutionStatus(row.execution_status ?? null);
            const replayExecutionStatus: ExecutionStatus = replayRequestedStatus
                ?? (row.success ? 'COMPLETED' : 'FAILED');
            const replayStatusOrigin: StatusOrigin = normalizeStatusOrigin(row.status_origin)
                ?? (replayRequestedStatus ? 'explicit' : 'inferred_from_success');

            // Return existing outcome — no duplicate insert
            return {
                outcomeId: existing,
                actionId: '', // Not available for idempotent replays
                timestamp: new Date().toISOString(),
                ingestionQuality: {
                    data_quality: 1.0,
                    score_origin: 'provided',
                    is_inconsistent: false,
                    mapping_tier: 'idempotent_replay',
                    mapping_confidence: 1.0,
                    inference_confidence: null,
                    outcome_class: null,
                    execution_status: replayExecutionStatus,
                    status_origin: replayStatusOrigin,
                },
            };
        }
    }

    // 3. Verification — reconstruct VerifierSignal from NormalizedOutcomeRow fields.
    // The sync path gets verifier_signal from the SDK body directly (log-outcome.ts:1203).
    // The queued path stores it as verifier_source/verifier_value in the NormalizedOutcomeRow.
    // Both paths must apply the same hallucination correction logic.
    const verifierSignal = row.verifier_source
        ? { source: row.verifier_source as any, value: row.verifier_value ?? undefined }
        : undefined;
    const verification = resolveVerifiedSuccess(row.success, row.outcome_score ?? null, verifierSignal);

    const computedOutcomeScoreRaw: number | null =
        row.outcome_score !== undefined && row.outcome_score !== null
            ? Math.max(0, Math.min(1, row.outcome_score))
            : null;

    const computedFinalSuccess = verification.verified_success;
    const computedFinalOutcomeScore: number | null =
        verification.confidence_override !== null
            ? verification.confidence_override
            : computedOutcomeScoreRaw;

    const finalSuccess = opts.precomputed?.finalSuccess ?? computedFinalSuccess;
    const finalOutcomeScore = opts.precomputed?.finalOutcomeScore ?? computedFinalOutcomeScore;
    const outcomeScoreRaw = opts.precomputed?.outcomeScoreRaw ?? computedOutcomeScoreRaw;
    const scoreOrigin: 'provided' | 'inferred' =
        opts.precomputed?.scoreOrigin
        ?? (outcomeScoreRaw !== null ? 'provided' : 'inferred');

    const requestedStatus = normalizeExecutionStatus(row.execution_status ?? null);
    if (requestedStatus && ((requestedStatus === 'COMPLETED') !== finalSuccess)) {
        throw new Error('STATUS_CONFLICT:execution_status conflicts with resolved success value');
    }

    const scoreDerivedStatus = statusFromOutcomeScore(outcomeScoreRaw);
    if (requestedStatus && scoreDerivedStatus && requestedStatus !== scoreDerivedStatus) {
        throw new Error('STATUS_CONFLICT:execution_status conflicts with outcome_score_raw polarity');
    }

    const executionStatus: ExecutionStatus = requestedStatus
        ?? (finalSuccess ? 'COMPLETED' : 'FAILED');

    const statusOrigin: StatusOrigin = normalizeStatusOrigin(row.status_origin)
        ?? (requestedStatus
            ? 'explicit'
            : scoreOrigin === 'inferred'
                ? 'inferred_from_score'
                : 'inferred_from_success');

    // 4. Inconsistency + quality
    const computedInconsistency = evaluateInconsistencyRules({
        finalSuccess,
        outcomeScoreRaw,
        businessOutcome: row.business_outcome ?? null,
    });

    const inconsistency = {
        isInconsistent: opts.precomputed?.isInconsistent ?? computedInconsistency.isInconsistent,
        type: opts.precomputed?.inconsistencyType ?? computedInconsistency.type,
        reason: opts.precomputed?.inconsistencyReason ?? computedInconsistency.reason,
        ruleVersion: opts.precomputed?.inconsistencyRuleVersion ?? computedInconsistency.ruleVersion,
    };

    let mappingConfidence = opts.precomputed?.mappingConfidence ?? taskInferResult.confidence;
    const mappingTier = opts.precomputed?.mappingTier ?? taskInferResult.tier;
    // dataQuality computed after inference — see step 10 below

    // 5. FK resolution
    const resolvedAction = opts.resolvedActionId
        ? {
            actionId: opts.resolvedActionId,
            resolvedActionName: opts.resolvedActionName ?? row.action_name,
        }
        : await resolveActionIdForIngest(row.action_name, customerId);

    const actionId = resolvedAction.actionId;
    const resolvedActionName = resolvedAction.resolvedActionName;

    const contextId = opts.resolvedContextId
        ?? await resolveContextIdForIngest(
            customerId,
            row.issue_type,
            row.environment,
            row.customer_tier,
        );

    // Best-effort context vector upkeep. Never blocks ingestion.
    const ensureEmbedding = contextEmbed.ensureContextEmbedding?.({
        contextId,
        customerId,
        issueType: row.issue_type,
        customerTier: row.customer_tier ?? null,
        environment: row.environment ?? null,
        rawContext: row.raw_context ?? null,
    });
    if (ensureEmbedding) {
        ensureEmbedding.catch((err: any) => {
            console.warn('[ingest-core] ensureContextEmbedding failed:', err?.message ?? err);
        });
    }

    // 6. Semantic cluster
    const semanticCluster: SemanticActionClusterResult = inferSemanticActionCluster({
        actionName: resolvedActionName,
        issueType: row.issue_type,
        taskName: taskInferResult.task,
    });

    // 7. Business outcome normalization
    const VALID_BUSINESS_OUTCOMES = new Set(['resolved', 'partial', 'failed', 'unknown']);
    const normalizedBusinessOutcome = row.business_outcome
        ? (VALID_BUSINESS_OUTCOMES.has(row.business_outcome) ? row.business_outcome : 'unknown')
        : null;

    // 8. Session ID — import rows get a stable UUID derived from idempotency key
    // so replay is safe. Real SDK rows always have their own session_id.
    const incomingSessionId = typeof row.session_id === 'string' ? row.session_id.trim() : null;
    const sessionId = isUuid(incomingSessionId)
        ? incomingSessionId
        : row.idempotency_key
            ? deterministicUuidFromSeed(`session:${row.idempotency_key}`)
            : crypto.randomUUID();

    // 9. Sanitize free-text fields
    const safeErrorMessage = row.error_message ? sanitizeString(row.error_message, 1000) : null;
    const safeErrorCode = row.error_code ? sanitizeString(row.error_code, 100) : null;

    let failureReasonCode = normalizeFailureReasonCode(row.failure_reason_code);
    let failureStage = normalizeFailureStage(row.failure_stage);

    if (executionStatus === 'COMPLETED') {
        failureReasonCode = null;
        failureStage = null;
    } else {
        if (!failureReasonCode) {
            failureReasonCode = normalizeFailureReasonCode(safeErrorCode) ?? 'execution_failed';
        }
        if (!failureStage) {
            failureStage = row.feedback_signal === 'delayed'
                ? 'delayed_feedback'
                : 'action_execution';
        }
    }

    // 10. Outcome Score Inference — 3-layer engine
    // When developer omits outcome_score, infer from hard + soft + relative signals.
    // By default this runs for live SDK rows only.
    // Import rows can opt in via enableInferenceWhenSkipTrust=true.
    let resolvedScore = finalOutcomeScore;
    let resolvedScoreOrigin = scoreOrigin;
    let resolvedScoreConfidence: number | null = null;
    let resolvedOutcomeClass: string | null = null;

    const shouldInferScore =
        resolvedScore === null
        && (!opts.skipTrustUpdate || opts.enableInferenceWhenSkipTrust === true);

    if (shouldInferScore) {
        const baseline = await fetchActionBaseline(row.agent_id, actionId);
        const inferred = inferOutcomeScore({
            success: finalSuccess,
            retryAttempt: row.retry_attempt ?? null,
            responseMs: row.response_time_ms ?? null,
            errorCode: safeErrorCode,
            errorMessage: safeErrorMessage,
            businessOutcome: normalizedBusinessOutcome,
            feedbackSignal: row.feedback_signal ?? null,
            crossEventStatus: row.cross_event_status ?? null,
            verifierSource: row.verifier_source ?? null,
            verifierValue: row.verifier_value ?? null,
            actionBaseline: baseline,
        });
        resolvedScore = inferred.score;
        resolvedScoreOrigin = 'inferred';
        resolvedScoreConfidence = inferred.confidence;
        resolvedOutcomeClass = inferred.class;
    }

    // 10a. Signal contradiction feedback — degraded/uncertain outcomes
    // degrade mapping confidence. The outcome score itself is already adjusted
    // by inference; this penalizes the TASK MAPPING quality when signals disagree.
    if (resolvedOutcomeClass === 'degraded' || resolvedOutcomeClass === 'uncertain') {
        mappingConfidence = Math.max(0, mappingConfidence - 0.05);
    }

    // 10b. Data quality — computed AFTER inference so penalty reflects confidence.
    const dataQuality = opts.precomputed?.dataQuality ?? computeOutcomeDataQuality({
        outcomeScoreRaw,
        isInconsistent: inconsistency.isInconsistent,
        mappingConfidence,
        businessOutcome: row.business_outcome ?? null,
        inferenceConfidence: resolvedScoreConfidence,
    });

    // Import replay safety: suppress near-duplicate writes around the same
    // source event timestamp when payloads are semantically equivalent.
    const nearDuplicateWindowMs = parseNearDedupWindowMs(opts.dedupWindowMs);
    if (
        opts.ingestionSource === 'import'
        && nearDuplicateWindowMs > 0
        && opts.sourceEventAt
    ) {
        const nearDuplicateOutcomeId = await findNearDuplicateOutcome({
            customerId,
            agentId: row.agent_id,
            actionId,
            contextId,
            taskName: taskInferResult.task,
            success: finalSuccess,
            sourceEventAt: opts.sourceEventAt,
            dedupWindowMs: nearDuplicateWindowMs,
            outcomeScoreRaw,
            responseTimeMs: row.response_time_ms ?? null,
            errorCode: safeErrorCode,
            businessOutcome: normalizedBusinessOutcome,
        });

        if (nearDuplicateOutcomeId) {
            await saveIdempotencyRecord(row.idempotency_key, nearDuplicateOutcomeId, customerId);
            return {
                outcomeId: nearDuplicateOutcomeId,
                actionId,
                timestamp: opts.sourceEventAt.toISOString(),
                ingestionQuality: {
                    data_quality: dataQuality,
                    score_origin: resolvedScoreOrigin,
                    is_inconsistent: inconsistency.isInconsistent,
                    mapping_tier: 'near_duplicate_replay',
                    mapping_confidence: mappingConfidence,
                    inference_confidence: resolvedScoreConfidence,
                    outcome_class: resolvedOutcomeClass,
                    execution_status: executionStatus,
                    status_origin: statusOrigin,
                },
            };
        }
    }

    // 11. timestamp — use source_event_at if provided (preserves historical ordering),
    // else let the DB default to now().
    const timestampOverride = opts.sourceEventAt
        ? opts.sourceEventAt.toISOString()
        : undefined;

    // 12. Insert
    const insertPayload: Record<string, unknown> = {
        agent_id: row.agent_id,
        action_id: actionId,
        context_id: contextId,
        customer_id: customerId,
        session_id: sessionId,
        success: finalSuccess,
        response_time_ms: row.response_time_ms ?? null,
        error_code: safeErrorCode,
        error_message: safeErrorMessage,
        raw_context: row.raw_context ?? {},
        is_synthetic: false,
        ingestion_source: opts.ingestionSource,
        import_job_id: opts.importJobId ?? null,
        salience_score: computeSalience(actionId, contextId, customerId, finalSuccess),
        outcome_score: resolvedScore ?? 0.5,
        business_outcome: normalizedBusinessOutcome,
        feedback_signal: row.feedback_signal ?? 'immediate',
        verifier_source: row.verifier_source ?? null,
        verifier_value: row.verifier_value != null ? String(row.verifier_value) : null,
        discrepancy_detected: opts.precomputed?.discrepancyDetected ?? verification.discrepancy_detected,
        backprop_episode_id: row.backprop_episode_id ?? null,
        episode_id: row.episode_id ?? null,
        signal_source: row.signal_source ?? 'explicit',
        signal_confidence: row.signal_confidence ?? null,
        causal_depth: row.signal_depth ?? null,
        signal_pending: row.signal_pending ?? false,
        signal_updated_at: null,
        cross_event_status: row.cross_event_status ?? 'none',
        cross_event_last_updated: new Date().toISOString(),
        retry_chain_id: row.retry_chain_id ?? null,
        retry_attempt: row.retry_attempt ?? null,
        cross_event_attempt_count: row.cross_event_attempt_count ?? null,
        canonical_outcome_id: row.canonical_outcome_id ?? null,
        pending_registration_id: row.pending_registration_id ?? null,
        execution_status: executionStatus,
        failure_reason_code: failureReasonCode,
        failure_stage: failureStage,
        status_origin: statusOrigin,
        task_name: taskInferResult.task,
        semantic_cluster_key: semanticCluster.clusterKey,
        semantic_cluster_domain: semanticCluster.domain,
        semantic_cluster_intent: semanticCluster.intent,
        semantic_cluster_confidence: semanticCluster.confidence,
        outcome_score_raw: outcomeScoreRaw,
        data_quality: dataQuality,
        is_inconsistent: inconsistency.isInconsistent,
        inconsistency_type: inconsistency.type,
        inconsistency_reason: inconsistency.reason,
        mapping_confidence: mappingConfidence,
        score_origin: resolvedScoreOrigin,
        inference_confidence: resolvedScoreConfidence,
        outcome_class: resolvedOutcomeClass,
        mapping_tier: mappingTier,
        inconsistency_rule_version: inconsistency.ruleVersion,
        // source_event_at: only set for import rows
        ...(opts.sourceEventAt ? { source_event_at: opts.sourceEventAt.toISOString() } : {}),
        // Override the DB timestamp for historical imports
        ...(timestampOverride ? { timestamp: timestampOverride } : {}),
        // Resource cost tracking (token usage, API calls, compute time)
        ...(row.resource_cost_units != null ? { resource_cost_units: row.resource_cost_units } : {}),
        ...(row.resource_cost_type ? { resource_cost_type: row.resource_cost_type } : {}),
    };

    const insertedOutcome = await insertOutcomeRecord(insertPayload);

    invalidateActionBaselineCache(row.agent_id, actionId);

    // 12. Idempotency record
    await saveIdempotencyRecord(row.idempotency_key, insertedOutcome.outcomeId, customerId);

    // 13. Cache invalidation (always — import rows also need fresh scores)
    invalidateCache(customerId, contextId);

    // 14. Fire orchestrator — only for SDK rows
    if (!opts.skipTrustUpdate && opts.skipOrchestration !== true) {
        orchestrateOutcome({
            agentId: row.agent_id,
            customerId,
            outcomeId: insertedOutcome.outcomeId,
            actionId,
            actionName: resolvedActionName,
            contextId,
            issueType: row.issue_type,
            finalSuccess,
            finalOutcomeScore,
            responseMs: row.response_time_ms ?? null,
            episodeId: row.episode_id ?? undefined,
            errorCode: safeErrorCode,
            businessOutcome: normalizedBusinessOutcome ?? undefined,
            decisionId: row.decision_id ?? undefined,
            signalConfidence: row.signal_confidence ?? null,
            skipTrust: false,
        }).catch(err =>
            console.error('[ingest-core] orchestrator failed:', {
                error: (err as Error).message,
                outcomeId: insertedOutcome.outcomeId,
            })
        );
    }

    return {
        outcomeId: insertedOutcome.outcomeId,
        actionId,
        timestamp: insertedOutcome.timestamp,
        ingestionQuality: {
            data_quality: dataQuality,
            score_origin: resolvedScoreOrigin,
            is_inconsistent: inconsistency.isInconsistent,
            mapping_tier: mappingTier,
            mapping_confidence: mappingConfidence,
            inference_confidence: resolvedScoreConfidence,
            outcome_class: resolvedOutcomeClass,
            execution_status: executionStatus,
            status_origin: statusOrigin,
        },
    };
}
