import os from 'node:os';
import process from 'node:process';

import { logOutcomeRouter } from '../routes/log-outcome.js';
import {
    OUTCOME_INGEST_WORKER_BYPASS_HEADER,
    ackOutcomeIngestMessages,
    claimStaleOutcomeIngestMessages,
    closeOutcomeQueueRedis,
    enqueueOutcomeIngestEvent,
    ensureOutcomeIngestConsumerGroup,
    getOutcomeQueueMode,
    readOutcomeIngestBatch,
    writeOutcomeQuarantineRecord,
    type OutcomeIngestQueueEvent,
} from '../lib/outcome-ingest-queue.js';

const WORKER_BATCH_SIZE = Number.parseInt(process.env.LI_OUTCOME_WORKER_BATCH_SIZE ?? '100', 10);
const WORKER_BLOCK_MS = Number.parseInt(process.env.LI_OUTCOME_WORKER_BLOCK_MS ?? '5000', 10);
const WORKER_MAX_ATTEMPTS = Number.parseInt(process.env.LI_OUTCOME_WORKER_MAX_ATTEMPTS ?? '6', 10);
const WORKER_BACKOFF_MAX_MS = Number.parseInt(process.env.LI_OUTCOME_WORKER_BACKOFF_MAX_MS ?? '30000', 10);
const WORKER_BACKOFF_JITTER_MS = Number.parseInt(process.env.LI_OUTCOME_WORKER_BACKOFF_JITTER_MS ?? '500', 10);
const WORKER_RECLAIM_MIN_IDLE_MS = Number.parseInt(process.env.LI_OUTCOME_WORKER_RECLAIM_MIN_IDLE_MS ?? '60000', 10);
const WORKER_RECLAIM_SWEEP_LIMIT = Number.parseInt(process.env.LI_OUTCOME_WORKER_RECLAIM_SWEEP_LIMIT ?? '5', 10);
const WORKER_CONSUMER_NAME = process.env.LI_OUTCOME_WORKER_CONSUMER_NAME
    ?? `${os.hostname()}-${process.pid}`;

const postRouteHandler = logOutcomeRouter.routes.find(
    (route) => route.method === 'POST' && route.path === '/',
)?.handler;

if (!postRouteHandler) {
    throw new Error('Unable to resolve POST / route handler from logOutcomeRouter.');
}

let shuttingDown = false;

function clampPositiveInt(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
}

function isNonRetryableStatus(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function computeBackoffMs(attempt: number): number {
    const cappedAttempt = Math.max(0, attempt);
    const exponential = Math.min(WORKER_BACKOFF_MAX_MS, 1000 * (2 ** cappedAttempt));
    const jitter = Math.floor(Math.random() * (Math.max(0, WORKER_BACKOFF_JITTER_MS) + 1));
    return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function asErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function buildWorkerContext(event: OutcomeIngestQueueEvent): any {
    return {
        req: {
            json: async () => event.body,
            header: (name: string) => {
                if (name.toLowerCase() === OUTCOME_INGEST_WORKER_BYPASS_HEADER) {
                    return '1';
                }
                return undefined;
            },
        },
        get: (key: string) => {
            if (key === 'agent_id') return event.agent_id;
            if (key === 'customer_id') return event.customer_id;
            if (key === 'parsed_body') return event.body;
            if (key === 'validated_action') return event.validated_action ?? null;
            return null;
        },
        set: () => undefined,
        header: () => undefined,
        json: (data: unknown, status = 200) => ({ data, status }),
    };
}

async function invokeLogOutcomeSync(event: OutcomeIngestQueueEvent): Promise<{ status: number; body: unknown }> {
    const fakeContext = buildWorkerContext(event);
    const result = await postRouteHandler!(fakeContext, async () => undefined);

    if (result instanceof Response) {
        let body: unknown = null;
        try {
            body = await result.json();
        } catch {
            body = null;
        }
        return { status: result.status, body };
    }

    const status = Number((result as { status?: number } | undefined)?.status ?? 200);
    const body = (result as { data?: unknown } | undefined)?.data ?? null;
    return { status, body };
}

async function quarantineMessage(
    reason: string,
    payload: string,
    details: string,
    messageId: string,
): Promise<void> {
    try {
        await writeOutcomeQuarantineRecord({
            reason,
            payload,
            details,
            message_id: messageId,
            failed_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[outcome-worker] Failed to write quarantine record:', asErrorMessage(err));
    }
}

async function processStreamMessage(messageId: string, payload: string): Promise<boolean> {
    let event: OutcomeIngestQueueEvent;

    try {
        event = JSON.parse(payload) as OutcomeIngestQueueEvent;
    } catch (err) {
        await quarantineMessage('invalid_json', payload, asErrorMessage(err), messageId);
        return true;
    }

    const attempts = Math.max(0, Number(event.attempts ?? 0));

    if (!event.agent_id || !event.customer_id || !event.body || typeof event.body !== 'object') {
        await quarantineMessage('invalid_event_shape', payload, 'Missing required event fields.', messageId);
        return true;
    }

    try {
        const { status, body } = await invokeLogOutcomeSync(event);

        if (status >= 200 && status < 300) {
            return true;
        }

        const details = typeof body === 'string'
            ? body
            : JSON.stringify(body ?? {});

        if (isNonRetryableStatus(status)) {
            await quarantineMessage(`http_${status}`, payload, details, messageId);
            return true;
        }

        if (attempts + 1 >= clampPositiveInt(WORKER_MAX_ATTEMPTS, 6)) {
            await quarantineMessage(`max_attempts_http_${status}`, payload, details, messageId);
            return true;
        }

        // Fast re-queue: no sleep. Appending to the back of the Redis Stream
        // acts as a natural delay under load. Under low load, max-attempts (6)
        // prevents infinite spins.
        await enqueueOutcomeIngestEvent({
            ...event,
            attempts: attempts + 1,
            last_error: `http_${status}`,
            enqueued_at: new Date().toISOString(),
        });

        return true;
    } catch (err) {
        const message = asErrorMessage(err);
        if (attempts + 1 >= clampPositiveInt(WORKER_MAX_ATTEMPTS, 6)) {
            await quarantineMessage('max_attempts_exception', payload, message, messageId);
            return true;
        }

        // Fast re-queue
        try {
            await enqueueOutcomeIngestEvent({
                ...event,
                attempts: attempts + 1,
                last_error: message,
                enqueued_at: new Date().toISOString(),
            });
            return true;
        } catch (requeueErr) {
            await quarantineMessage('requeue_failed', payload, asErrorMessage(requeueErr), messageId);
            return true;
        }
    }
}

async function claimStaleMessages(
    consumerName: string,
    batchSize: number,
): Promise<Array<{ id: string; payload: string }>> {
    const reclaimLimit = Math.max(1, clampPositiveInt(WORKER_RECLAIM_SWEEP_LIMIT, 5));
    const minIdleMs = Math.max(1, Number.isFinite(WORKER_RECLAIM_MIN_IDLE_MS) ? WORKER_RECLAIM_MIN_IDLE_MS : 60_000);

    let cursor = '0-0';
    const reclaimed: Array<{ id: string; payload: string }> = [];

    for (let sweep = 0; sweep < reclaimLimit; sweep++) {
        const claim = await claimStaleOutcomeIngestMessages(
            consumerName,
            batchSize,
            minIdleMs,
            cursor,
        );

        if (claim.messages.length === 0) {
            break;
        }

        reclaimed.push(...claim.messages);
        if (reclaimed.length >= batchSize) {
            break;
        }

        if (!claim.nextStartId || claim.nextStartId === cursor) {
            break;
        }

        cursor = claim.nextStartId;
    }

    return reclaimed.slice(0, batchSize);
}

async function run(): Promise<void> {
    if (getOutcomeQueueMode() !== 'redis') {
        console.error(
            '[outcome-worker] Redis Queue mode is disabled. Use LI_OUTCOME_QUEUE_MODE=redis to run this external worker.',
        );
        process.exitCode = 1;
        return;
    }

    const batchSize = clampPositiveInt(WORKER_BATCH_SIZE, 100);
    const blockMs = Math.max(0, Number.isFinite(WORKER_BLOCK_MS) ? WORKER_BLOCK_MS : 5000);

    await ensureOutcomeIngestConsumerGroup();
    console.log(
        `[outcome-worker] Started consumer=${WORKER_CONSUMER_NAME} batch=${batchSize} blockMs=${blockMs}`,
    );

    while (!shuttingDown) {
        const staleBatch = await claimStaleMessages(WORKER_CONSUMER_NAME, batchSize);
        const batch = staleBatch.length > 0
            ? staleBatch
            : await readOutcomeIngestBatch(WORKER_CONSUMER_NAME, batchSize, blockMs);

        if (batch.length === 0) {
            continue;
        }

        const settled = await Promise.allSettled(
            batch.map(async (message) => {
                const shouldAck = await processStreamMessage(message.id, message.payload);
                return shouldAck ? message.id : null;
            }),
        );

        const ackIds: string[] = [];
        for (const result of settled) {
            if (result.status === 'fulfilled' && result.value) {
                ackIds.push(result.value);
            } else if (result.status === 'rejected') {
                console.error('[outcome-worker] Message processing promise rejected:', asErrorMessage(result.reason));
            }
        }

        if (ackIds.length > 0) {
            await ackOutcomeIngestMessages(ackIds);
        }
    }

    await closeOutcomeQueueRedis();
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
    console.log(`[outcome-worker] Received ${signal}. Stopping...`);
    shuttingDown = true;
}

process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});

void run().catch(async (err) => {
    console.error('[outcome-worker] Fatal error:', asErrorMessage(err));
    try {
        await closeOutcomeQueueRedis();
    } catch {
        // no-op
    }
    process.exitCode = 1;
});
