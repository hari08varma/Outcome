import { IOInterceptor, type PoolLike } from './interceptor.js';
import { executionStore } from './tracing/execution-context.js';
import type { LayerinfiniteClient } from './client.js';
import { OutcomePipeline, type OutcomePipelineOptions } from './pipeline/outcome-pipeline.js';

export interface InstrumentOptions {
    pool?: PoolLike;
    pipeline?: OutcomePipelineOptions;
}

export interface InstrumentResult {
    interceptor: IOInterceptor;
    pipeline: OutcomePipeline;
}

export function instrument(
    client: LayerinfiniteClient,
    options?: InstrumentOptions,
): InstrumentResult {

    const interceptor = new IOInterceptor(executionStore);
    const pipeline = new OutcomePipeline(client, options?.pipeline);

    // Always instrument fetch — universal I/O layer
    interceptor.instrumentFetch();

    // Only instrument database if pool provided
    if (options?.pool) {
        interceptor.instrumentDatabase(options.pool);
    }

    // Wire up child process helpers (exec/spawn are available on the returned interceptor)
    interceptor.instrumentChildProcess();

    pipeline.start();

    return { interceptor, pipeline };
}
