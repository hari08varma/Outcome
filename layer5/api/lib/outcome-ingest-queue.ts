import { Redis } from 'ioredis';

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

export type QueueMode = 'redis' | 'memory' | 'sync';

export function getOutcomeQueueMode(): QueueMode {
    if (process.env.LI_OUTCOME_QUEUE_MODE === 'sync') {
        return 'sync';
    }
    if (parseBoolean(process.env[QUEUE_ENABLE_ENV]) && getRedisUrl().length > 0) {
        return 'redis';
    }
    // Default to lightning-fast array queue to permanently prevent connection exhaustion!
    return 'memory';
}

export const localMemoryQueue: OutcomeIngestQueueEvent[] = [];

export async function enqueueOutcomeIngestEvent(event: OutcomeIngestQueueEvent): Promise<string> {
    const redis = getRedis();
    const streamKey = getStreamKey();
    const maxLen = getStreamMaxLen();

    const payload = JSON.stringify(event);
    const messageId = await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        String(maxLen),
        '*',
        'payload',
        payload,
    );

    if (!messageId) {
        throw new Error('Failed to enqueue outcome ingest event: Redis returned empty message id.');
    }

    return messageId;
}

export async function ensureOutcomeIngestConsumerGroup(): Promise<void> {
    const redis = getRedis();
    const streamKey = getStreamKey();
    const group = getStreamGroup();

    try {
        await redis.xgroup('CREATE', streamKey, group, '0', 'MKSTREAM');
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('BUSYGROUP')) {
            throw err;
        }
    }
}

export async function readOutcomeIngestBatch(
    consumerName: string,
    batchSize: number,
    blockMs: number,
): Promise<OutcomeIngestStreamMessage[]> {
    const redis = getRedis();
    const streamKey = getStreamKey();
    const group = getStreamGroup();

    const reply = await redis.xreadgroup(
        'GROUP',
        group,
        consumerName,
        'COUNT',
        String(Math.max(1, batchSize)),
        'BLOCK',
        String(Math.max(0, blockMs)),
        'STREAMS',
        streamKey,
        '>',
    );

    return normalizeXReadGroupReply(reply);
}

export async function claimStaleOutcomeIngestMessages(
    consumerName: string,
    batchSize: number,
    minIdleTimeMs: number,
    startId = '0-0',
): Promise<OutcomeIngestClaimBatch> {
    const redis = getRedis();
    const streamKey = getStreamKey();
    const group = getStreamGroup();

    const count = Math.max(1, Math.floor(batchSize));
    const minIdle = Math.max(1, Math.floor(minIdleTimeMs));

    const reply = await redis.call(
        'XAUTOCLAIM',
        streamKey,
        group,
        consumerName,
        String(minIdle),
        startId,
        'COUNT',
        String(count),
    );

    return normalizeXAutoClaimReply(reply);
}

export async function ackOutcomeIngestMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    const redis = getRedis();
    const streamKey = getStreamKey();
    const group = getStreamGroup();

    await redis.xack(streamKey, group, ...messageIds);
}

export async function writeOutcomeQuarantineRecord(record: OutcomeQuarantineRecord): Promise<void> {
    const redis = getRedis();
    const quarantineStream = getQuarantineStreamKey();
    const maxLen = getStreamMaxLen();

    await redis.xadd(
        quarantineStream,
        'MAXLEN',
        '~',
        String(maxLen),
        '*',
        'reason',
        record.reason,
        'details',
        record.details ?? '',
        'payload',
        record.payload,
        'message_id',
        record.message_id ?? '',
        'queued_at',
        record.queued_at ?? '',
        'failed_at',
        record.failed_at ?? new Date().toISOString(),
    );
}

export async function closeOutcomeQueueRedis(): Promise<void> {
    if (!redisClient) return;
    const client = redisClient;
    redisClient = null;
    await client.quit();
}

export function startMemoryQueueWorker(app: any): void {
    setInterval(async () => {
        if (localMemoryQueue.length === 0) return;
        const batch = localMemoryQueue.splice(0, 50);
        
        for (const item of batch) {
            try {
                const res = await app.request('http://localhost/v1/log-outcome', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        [OUTCOME_INGEST_WORKER_BYPASS_HEADER]: '1',
                        'Authorization': item.api_key ?? '',
                    },
                    body: JSON.stringify(item.body)
                });
                
                if (!res.ok) {
                    const text = await res.text();
                    console.error('[memory-queue] Background loopback failed!', res.status, text);
                }
            } catch (err: unknown) {
                console.error('[memory-queue] Background loopback error:', err instanceof Error ? err.message : String(err));
            }
        }
    }, 1500);
}
