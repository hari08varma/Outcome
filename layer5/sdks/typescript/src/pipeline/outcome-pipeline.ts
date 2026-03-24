import { drainEmissions, registerEmissionScheduler, type InterceptEmission } from '../interceptor.js';
import type { LayerinfiniteClient } from '../client.js';
import { deriveOutcome } from './outcome-deriver.js';
import { PendingSignalWriter } from './pending-signal-writer.js';

export interface OutcomePipelineOptions {
    maxBatchSize?: number;
    retryBackoffMs?: number;
}

const DEFAULT_MAX_BATCH_SIZE = 10;

export class OutcomePipeline {
    private readonly client: LayerinfiniteClient;
    private readonly maxBatchSize: number;
    private readonly pendingSignalWriter: PendingSignalWriter;

    private started = false;
    private draining = false;
    private microtaskQueued = false;

    constructor(client: LayerinfiniteClient, options: OutcomePipelineOptions = {}) {
        this.client = client;
        this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
        this.pendingSignalWriter = new PendingSignalWriter(client);
        void options.retryBackoffMs;
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
                    await this.processBatch(batch);
                }
            }
        } finally {
            this.draining = false;

            if (this.started) this.scheduleDrain();
        }
    }

    private async processBatch(batch: InterceptEmission[]): Promise<void> {
        for (const emission of batch) {
            try {
                const derivedOutcome = deriveOutcome(
                    emission.graph,
                    emission.actionId,
                    emission.actionName,
                );

                await this.client.logOutcome({
                    outcome_id: derivedOutcome.outcomeId,
                    action_name: derivedOutcome.actionName,
                    success: derivedOutcome.success,
                    outcome_score: derivedOutcome.outcomeScore,
                    feedback_signal: derivedOutcome.feedbackSignal,
                    is_pending: derivedOutcome.isPending,
                    confidence: derivedOutcome.confidence,
                    provider_hint: derivedOutcome.providerHint,
                    response_ms: emission.responseMs,
                    http_success: emission.httpSuccess,
                    db_success: emission.dbSuccess,
                    exit_code: emission.exitCode,
                });

                if (derivedOutcome.isPending) {
                    this.pendingSignalWriter.write(derivedOutcome).catch(() => { });
                }
            } catch {
                // Per-item isolation: failures do not stop batch processing.
            }
        }
    }
}
