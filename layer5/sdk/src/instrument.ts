import { IOInterceptor, type PoolLike } from './interceptor.js';
import { executionStore } from './tracing/execution-context.js';
import type { LayerinfiniteClient } from './client.js';

export interface InstrumentOptions {
    pool?: PoolLike;
    // Future options added here (Phase 4: pipeline config, etc.)
}

export function instrument(
    client: LayerinfiniteClient,
    options?: InstrumentOptions,
): IOInterceptor {
    void client;  // Phase 4 OutcomePipeline will use client.logOutcome()

    const interceptor = new IOInterceptor(executionStore);

    // Always instrument fetch — universal I/O layer
    interceptor.instrumentFetch();

    // Only instrument database if pool provided
    if (options?.pool) {
        interceptor.instrumentDatabase(options.pool);
    }

    // Wire up child process helpers (exec/spawn are available on the returned interceptor)
    interceptor.instrumentChildProcess();

    // OutcomePipeline NOT started here — Phase 4's responsibility.
    // Phase 3 only builds the interceptors. Phase 4 drains _pendingEmissions.

    return interceptor;
}
