import { drainEmissions, registerEmissionScheduler, type InterceptEmission } from '../interceptor.js';
import type { LayerinfiniteClient } from '../client.js';
import { deriveOutcomeParams } from './outcome-deriver.js';

export interface OutcomePipelineOptions {
    maxBatchSize?: number;
    maxQueueDelayMs?: number;
    retryBackoffMs?: number;
}

const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_DELAY_MS = 50;
const DEFAULT_RETRY_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OutcomePipeline {
    private readonly client: LayerinfiniteClient;
    private readonly maxBatchSize: number;
    private readonly maxQueueDelayMs: number;
    private readonly retryBackoffMs: number;

    private started = false;
    private draining = false;
    private microtaskQueued = false;
    private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    constructor(client: LayerinfiniteClient, options: OutcomePipelineOptions = {}) {
        this.client = client;
        this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
        this.maxQueueDelayMs = options.maxQueueDelayMs ?? DEFAULT_MAX_QUEUE_DELAY_MS;
        this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    }

    start(): void {
        if (this.started) return;

        this.started = true;
        registerEmissionScheduler(this.scheduleDrain);
        this.scheduleDrain();
    }

    stop(): void {
        if (!this.started) return;

        this.started = false;
        registerEmissionScheduler(null);

        if (this.timeoutHandle !== null) {
            clearTimeout(this.timeoutHandle);
            this.timeoutHandle = null;
        }
    }

    private readonly scheduleDrain = (): void => {
        if (!this.started) return;

        if (!this.microtaskQueued) {
            this.microtaskQueued = true;
            queueMicrotask(() => {
                this.microtaskQueued = false;
                if (!this.started || this.draining) return;
                void this.drainLoop();
            });
        }

        if (this.timeoutHandle === null) {
            this.timeoutHandle = setTimeout(() => {
                this.timeoutHandle = null;
                if (!this.started || this.draining) return;
                void this.drainLoop();
            }, this.maxQueueDelayMs);
        }
    };

    private async drainLoop(): Promise<void> {
        if (this.draining) return;
        this.draining = true;

        try {
            while (this.started) {
                const drained = drainEmissions();
                if (drained.length === 0) {
                    break;
                }

                for (let index = 0; index < drained.length; index += this.maxBatchSize) {
                    const batch = drained.slice(index, index + this.maxBatchSize);
                    await Promise.all(batch.map((emission) => this.sendEmission(emission)));
                }
            }
        } finally {
            this.draining = false;

            if (this.timeoutHandle !== null) {
                clearTimeout(this.timeoutHandle);
                this.timeoutHandle = null;
            }

            if (this.started) this.scheduleDrain();
        }
    }

    private async sendEmission(emission: InterceptEmission): Promise<void> {
        const params = deriveOutcomeParams(emission.graph, emission.actionId, {
            action_name: emission.actionName,
            response_ms: emission.responseMs,
            http_success: emission.httpSuccess,
            db_success: emission.dbSuccess,
            exit_code: emission.exitCode,
        });

        try {
            await this.client.logOutcome(params);
        } catch {
            await sleep(this.retryBackoffMs);

            try {
                await this.client.logOutcome(params);
            } catch {
                // Intentionally drop after one retry to keep pipeline non-blocking.
            }
        }
    }
}
