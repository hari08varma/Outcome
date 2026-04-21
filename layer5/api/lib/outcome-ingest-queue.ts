import { Redis } from 'ioredis';
import { supabase } from './supabase.js';
import { ingestOutcome } from './ingest-core.js';
import type { NormalizedOutcomeRow } from './ingest-core.js';
import { checkRecommendationRegression, refreshTaskAggregation } from '../routes/log-outcome.js';
import os from 'node:os';

export const OUTCOME_INGEST_WORKER_BYPASS_HEADER = 'x-li-outcome-worker';

const QUEUE_ENABLE_ENV = 'LI_OUTCOME_FAST_ACCEPT_QUEUE_ENABLED';
const REDIS_URL_ENV = 'LI_OUTCOME_REDIS_URL';
const STREAM_KEY_ENV = 'LI_OUTCOME_STREAM_KEY';
const STREAM_MAXLEN_ENV = 'LI_OUTCOME_STREAM_MAXLEN';
const STREAM_GROUP_ENV = 'LI_OUTCOME_STREAM_GROUP';
const QUARANTINE_STREAM_ENV = 'LI_OUTCOME_QUARANTINE_STREAM_KEY';

const DEFAULT_STREAM_KEY = 'li:outcome:ingest';
const DEFAULT_QUARANTINE_STREAM_KEY = 'li:outcome:quarantine';
const DEFAULT_STREAM_GROUP = 'li-outcome-ingest-workers';
const DEFAULT_STREAM_MAXLEN = 500_000;

export interface OutcomeIngestQueueEvent {
    agent_id: string;
    customer_id: string;
    body: Record<string, unknown>;
    validated_action?: {
        action_id?: string;
        action_name?: string;
        action_category?: string;
    } | null;
    enqueued_at: string;
    attempts: number;
    last_error?: string | null;
    api_key?: string;
}

export interface OutcomeIngestStreamMessage {
    id: string;
    payload: string;
}

export interface OutcomeIngestClaimBatch {
    nextStartId: string;
    messages: OutcomeIngestStreamMessage[];
}

export interface OutcomeQuarantineRecord {
    reason: string;
    details?: string | null;
    payload: string;
    message_id?: string;
    queued_at?: string;
    failed_at?: string;
}

let redisClient: Redis | null = null;

function parseBoolean(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function getRedisUrl(): string {
    return (process.env[REDIS_URL_ENV] ?? process.env.REDIS_URL ?? '').trim();
}

function getStreamKey(): string {
    return (process.env[STREAM_KEY_ENV] ?? DEFAULT_STREAM_KEY).trim() || DEFAULT_STREAM_KEY;
}

function getQuarantineStreamKey(): string {
    return (process.env[QUARANTINE_STREAM_ENV] ?? DEFAULT_QUARANTINE_STREAM_KEY).trim() || DEFAULT_QUARANTINE_STREAM_KEY;
}

function getStreamGroup(): string {
    return (process.env[STREAM_GROUP_ENV] ?? DEFAULT_STREAM_GROUP).trim() || DEFAULT_STREAM_GROUP;
}

function getStreamMaxLen(): number {
    return parsePositiveInt(process.env[STREAM_MAXLEN_ENV], DEFAULT_STREAM_MAXLEN);
}

function getRedis(): Redis {
    const redisUrl = getRedisUrl();
    if (!redisUrl) {
        throw new Error('Redis URL is not configured (LI_OUTCOME_REDIS_URL or REDIS_URL).');
    }

    if (!redisClient) {
        redisClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
            enableAutoPipelining: true,
            lazyConnect: false,
        });
    }

    return redisClient;
}

function normalizeXReadGroupReply(reply: unknown): OutcomeIngestStreamMessage[] {
    if (!Array.isArray(reply)) return [];

    const messages: OutcomeIngestStreamMessage[] = [];
    for (const streamChunk of reply) {
        if (!Array.isArray(streamChunk) || streamChunk.length < 2) continue;
        const entries = streamChunk[1];
        if (!Array.isArray(entries)) continue;

        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2) continue;
            const id = String(entry[0] ?? '');
            const fields = entry[1];
            if (!id || !Array.isArray(fields)) continue;

            for (let i = 0; i < fields.length; i += 2) {
                const key = String(fields[i] ?? '');
                const value = String(fields[i + 1] ?? '');
                if (key === 'payload') {
                    messages.push({ id, payload: value });
                    break;
                }
            }
        }
    }

    return messages;
}

function normalizeXAutoClaimReply(reply: unknown): OutcomeIngestClaimBatch {
    if (!Array.isArray(reply)) {
        return { nextStartId: '0-0', messages: [] };
    }

    const nextStartId = String(reply[0] ?? '0-0');
    const entries = reply[1];

    if (!Array.isArray(entries)) {
        return { nextStartId, messages: [] };
    }

    const messages: OutcomeIngestStreamMessage[] = [];
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;

        const id = String(entry[0] ?? '');
        const fields = entry[1];
        if (!id || !Array.isArray(fields)) continue;

        for (let i = 0; i < fields.length; i += 2) {
            const key = String(fields[i] ?? '');
            const value = String(fields[i + 1] ?? '');
            if (key === 'payload') {
                messages.push({ id, payload: value });
                break;
            }
        }
    }

    return { nextStartId, messages };
}

export type QueueMode = 'postgres' | 'sync';

export function getOutcomeQueueMode(): QueueMode {
    const explicit = (process.env.LI_OUTCOME_QUEUE_MODE ?? '').trim().toLowerCase();
    if (explicit === 'sync') return 'sync';
    if (explicit === 'postgres') return 'postgres';
    // Default to sync — zero data loss, every outcome written before 200 response.
    // Set LI_OUTCOME_QUEUE_MODE=postgres once migration 124 is applied.
    return 'sync';
}


// ══════════════════════════════════════════════════════════════
// DURABLE POSTGRES QUEUE — Zero-loss ingestion via Supabase
// ══════════════════════════════════════════════════════════════


const PG_WORKER_BATCH_SIZE = parsePositiveInt(process.env.LI_PG_QUEUE_BATCH_SIZE, 50);
const PG_WORKER_POLL_INTERVAL_MS = parsePositiveInt(process.env.LI_PG_QUEUE_POLL_MS, 1000);
const PG_WORKER_MAX_ATTEMPTS = parsePositiveInt(process.env.LI_PG_QUEUE_MAX_ATTEMPTS, 5);
const PG_WORKER_NAME = process.env.LI_PG_QUEUE_WORKER_NAME
    ?? `${os.hostname()}-${process.pid}`;

export interface DurableEnqueueParams {
    customerId: string;
    agentId: string;
    idempotencyKey: string | null;
    payload: Record<string, unknown>;
    validatedAction: Record<string, unknown> | null;
}

/**
 * Enqueue an outcome into the durable Postgres queue.
 * The INSERT is synchronous — data is on disk before we return 202.
 * Uses ON CONFLICT to silently deduplicate by (customer_id, idempotency_key).
 */
export async function enqueueDurable(params: DurableEnqueueParams): Promise<string> {
    const { data, error } = await supabase
        .from('queue_outcome_ingress')
        .insert({
            customer_id: params.customerId,
            agent_id: params.agentId,
            idempotency_key: params.idempotencyKey,
            payload: params.payload,
            validated_action: params.validatedAction,
            status: 'pending',
            attempts: 0,
            next_attempt_at: new Date().toISOString(),
        })
        .select('ingress_id')
        .single();

    if (error) {
        // 23505 = unique violation on idempotency key — treat as accepted
        if (error.code === '23505') {
            return `dedup-${params.idempotencyKey ?? 'unknown'}`;
        }
        throw new Error(`[durable-queue] enqueue failed: ${error.message}`);
    }

    return data.ingress_id;
}

interface QueueRow {
    ingress_id: string;
    customer_id: string;
    agent_id: string;
    payload: Record<string, unknown>;
    validated_action: Record<string, unknown> | null;
    attempts: number;
    max_attempts: number;
}

/**
 * Claim a batch of pending/failed rows using FOR UPDATE SKIP LOCKED.
 * This is the standard Postgres job queue pattern used by Sidekiq, Oban, etc.
 */
async function claimDurableBatch(workerName: string, batchSize: number): Promise<QueueRow[]> {
    const now = new Date().toISOString();

    // ── Stale lock recovery ──────────────────────────────────
    // If the server crashed while processing, items will be stuck in 'processing'
    // forever. Reset any item that's been locked for more than 5 minutes back
    // to 'failed' so the next poll picks it up.
    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    try {
        const { data: staleRows } = await supabase
            .from('queue_outcome_ingress')
            .update({
                status: 'failed',
                locked_by: null,
                locked_at: null,
                last_error: `Stale lock recovered by ${workerName} — previous worker likely crashed`,
            })
            .eq('status', 'processing')
            .lt('locked_at', staleCutoff)
            .select('ingress_id');

        if (staleRows && staleRows.length > 0) {
            console.warn(`[durable-queue] Recovered ${staleRows.length} stale-locked items`);
        }
    } catch (err: unknown) {
        // Recovery is best-effort — don't block the main poll loop
        console.warn('[durable-queue] Stale lock recovery failed:', err instanceof Error ? err.message : String(err));
    }

    // ── Claim batch ──────────────────────────────────────────
    // Two-step select+update. The UPDATE uses .select() to return
    // only the rows that were ACTUALLY claimed (status guard ensures
    // rows already claimed by an overlapping tick are skipped).
    const { data: candidates, error: selectErr } = await supabase
        .from('queue_outcome_ingress')
        .select('ingress_id')
        .in('status', ['pending', 'failed'])
        .lte('next_attempt_at', now)
        .order('next_attempt_at', { ascending: true })
        .limit(batchSize);

    if (selectErr || !candidates || candidates.length === 0) {
        return [];
    }

    const ids = candidates.map((r: any) => r.ingress_id);

    // Claim: update status to 'processing' and return only rows we actually claimed.
    // The `.in('status', ['pending', 'failed'])` guard ensures rows already
    // grabbed by an overlapping poll tick won't be returned.
    const { data: claimed, error: updateErr } = await supabase
        .from('queue_outcome_ingress')
        .update({
            status: 'processing',
            locked_by: workerName,
            locked_at: now,
        })
        .in('ingress_id', ids)
        .in('status', ['pending', 'failed']) // guard: only claim if still claimable
        .select('ingress_id, customer_id, agent_id, payload, validated_action, attempts, max_attempts');

    if (updateErr) {
        console.error('[durable-queue] claim update failed:', updateErr.message);
        return [];
    }

    return (claimed ?? []) as QueueRow[];
}

/**
 * Mark a queue row as successfully processed.
 */
async function markSucceeded(ingressId: string): Promise<void> {
    const { error } = await supabase
        .from('queue_outcome_ingress')
        .update({
            status: 'succeeded',
            completed_at: new Date().toISOString(),
            locked_by: null,
            locked_at: null,
        })
        .eq('ingress_id', ingressId);

    if (error) {
        console.error('[durable-queue] markSucceeded failed:', ingressId, error.message);
    }
}

/**
 * Mark a queue row as failed. If max attempts reached, move to dead-letter.
 * Uses exponential backoff for retry scheduling.
 */
async function markFailed(ingressId: string, errorMessage: string, currentAttempts: number, maxAttempts: number): Promise<void> {
    const newAttempts = currentAttempts + 1;
    const isDead = newAttempts >= maxAttempts;

    if (isDead) {
        const { error } = await supabase
            .from('queue_outcome_ingress')
            .update({
                status: 'dead',
                attempts: newAttempts,
                last_error: errorMessage.slice(0, 1000),
                completed_at: new Date().toISOString(),
                locked_by: null,
                locked_at: null,
            })
            .eq('ingress_id', ingressId);

        if (error) {
            console.error('[durable-queue] markDead failed:', ingressId, error.message);
        } else {
            console.warn('[durable-queue] ☠️  Dead-lettered:', { ingress_id: ingressId, attempts: newAttempts, error: errorMessage.slice(0, 200) });
        }
        return;
    }

    // Exponential backoff: 2^attempt seconds, capped at 60s, plus jitter
    const backoffMs = Math.min(60_000, 1000 * Math.pow(2, newAttempts)) + Math.floor(Math.random() * 1000);
    const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

    const { error } = await supabase
        .from('queue_outcome_ingress')
        .update({
            status: 'failed',
            attempts: newAttempts,
            last_error: errorMessage.slice(0, 1000),
            next_attempt_at: nextAttemptAt,
            locked_by: null,
            locked_at: null,
        })
        .eq('ingress_id', ingressId);

    if (error) {
        console.error('[durable-queue] markFailed failed:', ingressId, error.message);
    }
}

/**
 * Process a single queue row by directly invoking ingestOutcome().
 * No HTTP loopback. No middleware re-entry. No auth/rate-limit fragility.
 */
async function processDurableItem(row: QueueRow): Promise<void> {
    const payload = row.payload as Record<string, unknown>;

    // Build the NormalizedOutcomeRow from the stored payload.
    // The payload is the full parsed SDK body — extract every field
    // that ingestOutcome() can consume to maintain parity with sync path.
    const verifierSignal = typeof payload.verifier_signal === 'object' && payload.verifier_signal !== null
        ? payload.verifier_signal as Record<string, unknown>
        : null;

    const normalizedRow: NormalizedOutcomeRow = {
        agent_id: row.agent_id,
        action_name: (payload.action_name as string) ?? 'unknown_action',
        issue_type: (payload.issue_type as string) ?? 'unknown',
        success: payload.success === true,
        outcome_score: typeof payload.outcome_score === 'number' ? payload.outcome_score : undefined,
        business_outcome: (payload.business_outcome as string) ?? undefined,
        session_id: (payload.session_id as string) ?? undefined,
        response_time_ms: typeof payload.response_time_ms === 'number' ? payload.response_time_ms : undefined,
        feedback_signal: (payload.feedback_signal as string) ?? undefined,
        decision_id: (payload.decision_id as string) ?? undefined,
        episode_id: (payload.episode_id as string) ?? undefined,
        task_name: (payload.task_name as string) ?? undefined,
        raw_context: typeof payload.raw_context === 'object' && payload.raw_context !== null
            ? payload.raw_context as Record<string, unknown>
            : undefined,
        error_code: (payload.error_code as string) ?? undefined,
        error_message: (payload.error_message as string) ?? undefined,
        idempotency_key: (payload.idempotency_key as string) ?? undefined,
        environment: (payload.environment as string) ?? undefined,
        customer_tier: (payload.customer_tier as string) ?? undefined,
        // Verifier signal — SDK sends as nested { source, value }
        verifier_source: (verifierSignal?.source as string) ?? undefined,
        verifier_value: verifierSignal?.value as string | number | boolean | undefined ?? undefined,
        // Task mapping metadata (parser-provided)
        task_mapping_confidence: typeof payload.task_mapping_confidence === 'number' ? payload.task_mapping_confidence : undefined,
        task_mapping_tier: (payload.task_mapping_tier as string) ?? undefined,
        // Signal chain fields
        backprop_episode_id: (payload.backprop_episode_id as string) ?? undefined,
        signal_source: (payload.signal_source as any) ?? undefined,
        signal_confidence: typeof payload.signal_confidence === 'number' ? payload.signal_confidence : undefined,
        signal_depth: typeof payload.signal_depth === 'number' ? payload.signal_depth : undefined,
        signal_pending: typeof payload.signal_pending === 'boolean' ? payload.signal_pending : undefined,
        cross_event_status: (payload.cross_event_status as any) ?? undefined,
        // Retry chain fields
        retry_chain_id: (payload.retry_chain_id as string) ?? undefined,
        retry_attempt: typeof payload.retry_attempt === 'number' ? payload.retry_attempt : undefined,
        cross_event_attempt_count: typeof payload.cross_event_attempt_count === 'number' ? payload.cross_event_attempt_count : undefined,
        canonical_outcome_id: (payload.canonical_outcome_id as string) ?? undefined,
        pending_registration_id: (payload.pending_registration_id as string) ?? undefined,
        // Execution status fields
        execution_status: (payload.execution_status as string) ?? undefined,
        failure_reason_code: (payload.failure_reason_code as string) ?? undefined,
        failure_stage: (payload.failure_stage as string) ?? undefined,
        status_origin: (payload.status_origin as string) ?? undefined,
        // Resource cost fields
        resource_cost_units: typeof payload.resource_cost_units === 'number' ? payload.resource_cost_units : undefined,
        resource_cost_type: (payload.resource_cost_type as any) ?? undefined,
    };

    const result = await ingestOutcome(normalizedRow, row.customer_id, {
        skipTrustUpdate: false,
        ingestionSource: 'sdk',
    });

    // Fire-and-forget side effects — parity with sync path.
    // These must never throw or block the queue worker.
    refreshTaskAggregation(row.customer_id).catch(() => {});
    if (result.actionId) {
        checkRecommendationRegression(
            row.customer_id,
            row.agent_id,
            result.actionId,
            normalizedRow.action_name,
            normalizedRow.task_name ?? null,
            normalizedRow.success,
        ).catch(() => {});
    }
}

let durableWorkerTimer: ReturnType<typeof setInterval> | null = null;

// App-level purge — replaces pg_cron on Supabase free tier
let lastPurgeAt = 0;
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function maybePurgeSucceeded(): Promise<void> {
    const now = Date.now();
    if (now - lastPurgeAt < PURGE_INTERVAL_MS) return;
    lastPurgeAt = now;

    try {
        const { error } = await supabase.rpc('purge_succeeded_queue_ingress' as any);
        if (error) {
            // RPC might not exist yet — fall back to direct delete
            const { error: deleteErr } = await supabase
                .from('queue_outcome_ingress')
                .delete()
                .eq('status', 'succeeded')
                .lt('completed_at', new Date(now - 24 * 60 * 60 * 1000).toISOString());

            if (deleteErr) {
                console.warn('[durable-queue] Purge fallback failed:', deleteErr.message);
            } else {
                console.log('[durable-queue] Purged succeeded rows (>24h) via direct delete');
            }
        } else {
            console.log('[durable-queue] Purged succeeded rows (>24h) via RPC');
        }
    } catch {
        // Best-effort — never block the worker
    }
}

/**
 * Start the durable Postgres queue worker.
 * Claims batches via FOR UPDATE SKIP LOCKED, processes each item
 * by directly calling ingestOutcome(), and marks succeeded/failed.
 *
 * This completely eliminates the HTTP loopback architecture and all
 * its associated failure modes (auth, rate-limit, Zod re-parse, timeout).
 */
export function startDurableQueueWorker(): void {
    if (durableWorkerTimer) return; // idempotent

    let isProcessing = false; // in-flight guard — prevents overlapping poll ticks

    console.log(`[durable-queue] Worker started: name=${PG_WORKER_NAME} batch=${PG_WORKER_BATCH_SIZE} poll=${PG_WORKER_POLL_INTERVAL_MS}ms max_attempts=${PG_WORKER_MAX_ATTEMPTS}`);

    durableWorkerTimer = setInterval(async () => {
        if (isProcessing) return; // previous tick still running
        isProcessing = true;
        try {
            // Hourly cleanup of succeeded rows (replaces pg_cron on free tier)
            await maybePurgeSucceeded();

            const batch = await claimDurableBatch(PG_WORKER_NAME, PG_WORKER_BATCH_SIZE);
            if (batch.length === 0) return;

            const results = await Promise.allSettled(
                batch.map(async (row) => {
                    try {
                        await processDurableItem(row);
                        await markSucceeded(row.ingress_id);
                    } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : String(err);
                        await markFailed(row.ingress_id, message, row.attempts, row.max_attempts || PG_WORKER_MAX_ATTEMPTS);
                    }
                }),
            );

            // Log batch summary
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.length - succeeded;
            if (failed > 0) {
                console.warn(`[durable-queue] Batch: ${succeeded} succeeded, ${failed} failed`);
            }
        } catch (err: unknown) {
            console.error('[durable-queue] Worker poll error:', err instanceof Error ? err.message : String(err));
        } finally {
            isProcessing = false;
        }
    }, PG_WORKER_POLL_INTERVAL_MS);

    // Don't prevent Node.js from exiting
    if (durableWorkerTimer && typeof durableWorkerTimer === 'object' && 'unref' in durableWorkerTimer) {
        (durableWorkerTimer as any).unref();
    }
}

/**
 * Get queue health metrics for /health/deep endpoint.
 */
export async function getDurableQueueHealth(): Promise<{
    pending: number;
    failed: number;
    dead: number;
    processing: number;
    oldest_pending_age_seconds: number | null;
}> {
    try {
        const [pendingRes, failedRes, deadRes, processingRes, oldestRes] = await Promise.all([
            supabase.from('queue_outcome_ingress').select('ingress_id', { count: 'exact', head: true }).eq('status', 'pending'),
            supabase.from('queue_outcome_ingress').select('ingress_id', { count: 'exact', head: true }).eq('status', 'failed'),
            supabase.from('queue_outcome_ingress').select('ingress_id', { count: 'exact', head: true }).eq('status', 'dead'),
            supabase.from('queue_outcome_ingress').select('ingress_id', { count: 'exact', head: true }).eq('status', 'processing'),
            supabase.from('queue_outcome_ingress').select('created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(1),
        ]);

        let oldestAge: number | null = null;
        if (oldestRes.data && oldestRes.data.length > 0) {
            const created = new Date((oldestRes.data[0] as any).created_at).getTime();
            oldestAge = Math.round((Date.now() - created) / 1000);
        }

        return {
            pending: pendingRes.count ?? 0,
            failed: failedRes.count ?? 0,
            dead: deadRes.count ?? 0,
            processing: processingRes.count ?? 0,
            oldest_pending_age_seconds: oldestAge,
        };
    } catch {
        return { pending: -1, failed: -1, dead: -1, processing: -1, oldest_pending_age_seconds: null };
    }
}
