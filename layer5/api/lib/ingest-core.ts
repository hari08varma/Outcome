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

// ── Types ─────────────────────────────────────────────────────

export type IngestionSource = 'sdk' | 'import';

export interface IngestCoreOptions {
    /** Never triggers trust update when true (used for 'import' rows). */
    skipTrustUpdate: boolean;
    /** Column value written to fact_outcomes.ingestion_source */
    ingestionSource: IngestionSource;
    /** Original event timestamp from imported log file. NULL for SDK rows. */
    sourceEventAt?: Date | null;
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
}

export interface IngestCoreResult {
    outcomeId: string;
    timestamp: string;
    ingestionQuality: {
        data_quality: number;
        score_origin: 'provided' | 'inferred';
        is_inconsistent: boolean;
        mapping_tier: string;
        mapping_confidence: number;
    };
}

// ── Internal types ────────────────────────────────────────────

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

// ── Helper: data quality scoring ─────────────────────────────

function clamp01(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function computeDataQuality(params: {
    outcomeScoreRaw: number | null | undefined;
    isInconsistent: boolean;
    mappingConfidence: number;
    businessOutcome: string | null | undefined;
}): number {
    let score = 1.0;
    if (params.outcomeScoreRaw === null || params.outcomeScoreRaw === undefined) score -= 0.25;
    if (params.isInconsistent) score -= 0.20;
    if (params.mappingConfidence < 0.70) score -= 0.20;
    if (!params.businessOutcome) score -= 0.10;
    return Number(Math.max(0.0, score).toFixed(4));
}

function evaluateInconsistency(params: {
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
            // Return existing outcome — no duplicate insert
            return {
                outcomeId: existing,
                timestamp: new Date().toISOString(),
                ingestionQuality: {
                    data_quality: 1.0,
                    score_origin: 'provided',
                    is_inconsistent: false,
                    mapping_tier: 'idempotent_replay',
                    mapping_confidence: 1.0,
                },
            };
        }
    }

    // 3. Verification (import rows skip webhook verifier — signal_source=explicit)
    const verification = resolveVerifiedSuccess(row.success, row.outcome_score ?? null, undefined);

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

    // 4. Inconsistency + quality
    const computedInconsistency = evaluateInconsistency({
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

    const mappingConfidence = opts.precomputed?.mappingConfidence ?? taskInferResult.confidence;
    const mappingTier = opts.precomputed?.mappingTier ?? taskInferResult.tier;
    const dataQuality = opts.precomputed?.dataQuality ?? computeDataQuality({
        outcomeScoreRaw,
        isInconsistent: inconsistency.isInconsistent,
        mappingConfidence,
        businessOutcome: row.business_outcome ?? null,
    });

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

    // 10. timestamp — use source_event_at if provided (preserves historical ordering),
    // else let the DB default to now().
    const timestampOverride = opts.sourceEventAt
        ? opts.sourceEventAt.toISOString()
        : undefined;

    // 11. Insert
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
        outcome_score: finalOutcomeScore ?? 0.5,
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
        score_origin: scoreOrigin,
        mapping_tier: mappingTier,
        inconsistency_rule_version: inconsistency.ruleVersion,
        // source_event_at: only set for import rows
        ...(opts.sourceEventAt ? { source_event_at: opts.sourceEventAt.toISOString() } : {}),
        // Override the DB timestamp for historical imports
        ...(timestampOverride ? { timestamp: timestampOverride } : {}),
    };

    const insertedOutcome = await insertOutcomeRecord(insertPayload);

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
        timestamp: insertedOutcome.timestamp,
        ingestionQuality: {
            data_quality: dataQuality,
            score_origin: scoreOrigin,
            is_inconsistent: inconsistency.isInconsistent,
            mapping_tier: mappingTier,
            mapping_confidence: mappingConfidence,
        },
    };
}
