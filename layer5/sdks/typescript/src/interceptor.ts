import { AsyncLocalStorage } from 'async_hooks';
import { exec as nodeExec, spawn as nodeSpawn } from 'child_process';
import { promisify } from 'util';
import { executionStore, generateActionId, inferActionName } from './tracing/execution-context.js';
import { CausalGraph } from './tracing/causal-graph.js';
import { createTracedResponse } from './tracing/traced-response.js';
import type { ExecutionContext } from './tracing/execution-context.js';

// ── PoolLike — module-level interface avoids runtime dep on pg package ──────
export interface PoolLike {
    query: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

// ── Pipeline emission shape — Phase 4 OutcomePipeline drains these ──────────
export interface InterceptEmission {
    actionId: string;
    actionName: string;
    graph: CausalGraph;
    httpSuccess?: boolean;
    dbSuccess?: boolean;
    exitCode?: number;
    responseMs: number;
    responseForPipeline?: Response;
    result?: unknown;
}

// ── Module-level emission queue — exported so Phase 4 can drain it ──────────
export const _pendingEmissions: InterceptEmission[] = [];

let emissionScheduler: (() => void) | null = null;

export function registerEmissionScheduler(scheduler: (() => void) | null): void {
    emissionScheduler = scheduler;
}

export function drainEmissions(): InterceptEmission[] {
    return _pendingEmissions.splice(0, _pendingEmissions.length);
}

// ── Module-private stubs — Phase 4 replaces these with real pipeline logic ──
async function emitToPipeline(data: InterceptEmission): Promise<void> {
    _pendingEmissions.push(data);
    emissionScheduler?.();
}

async function emitDbToPipeline(data: InterceptEmission): Promise<void> {
    _pendingEmissions.push(data);
    emissionScheduler?.();
}

async function emitProcessToPipeline(data: InterceptEmission): Promise<void> {
    _pendingEmissions.push(data);
    emissionScheduler?.();
}

// ── IOInterceptor ────────────────────────────────────────────────────────────
export class IOInterceptor {
    private readonly store: AsyncLocalStorage<ExecutionContext>;
    private readonly alreadyInstrumented: Set<string>;

    constructor(store: AsyncLocalStorage<ExecutionContext>) {
        this.store = store;
        this.alreadyInstrumented = new Set();
    }

    // ── Fetch interception ───────────────────────────────────────────────────
    instrumentFetch(): void {
        // TRAP 4: idempotency guard — double-wrapping doubles outcomes
        if (this.alreadyInstrumented.has('fetch')) return;
        this.alreadyInstrumented.add('fetch');

        // TRAP 1: save BEFORE reassigning — otherwise _originalFetch IS the wrapper
        const _originalFetch = globalThis.fetch;

        globalThis.fetch = async function layerinfiniteFetch(
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> {
            const url = typeof input === 'string' ? input
                : input instanceof URL ? input.toString()
                    : (input as Request).url;
            const actionId = generateActionId();
            const actionName = inferActionName(url, init as { method?: string } | undefined);
            const graph = new CausalGraph();
            const startMs = Date.now();

            return executionStore.run({ actionId, actionName, graph }, async () => {
                let response!: Response;
                let httpSuccess = true;

                try {
                    response = await _originalFetch(input, init);
                    httpSuccess = response.ok;
                } catch (err) {
                    // Record network error in graph, then re-throw (TRAP 5)
                    graph.recordFieldAccess({
                        actionId,
                        fieldPath: 'networkError',
                        value: String(err),
                        depth: 0,
                        confidence: 0.90,
                    });
                    emitToPipeline({
                        actionId, actionName, graph,
                        httpSuccess: false,
                        responseMs: Date.now() - startMs,
                    }).catch(() => { });
                    throw err;
                }

                const responseMs = Date.now() - startMs;

                // TRAP 2: clone before wrapping — Response body is single-consume
                const responseForPipeline = response.clone();
                const responseForAgent = createTracedResponse(
                    response,
                    { actionId, actionName, fieldPath: '', depth: 0 },
                    graph,
                );

                emitToPipeline({
                    actionId, actionName, graph, responseForPipeline, httpSuccess, responseMs,
                }).catch(() => { });

                return responseForAgent as unknown as Response;
            });
        };
    }

    // ── Database interception ────────────────────────────────────────────────
    instrumentDatabase(pool?: PoolLike): void {
        if (!pool) return;
        // TRAP 4: idempotency guard
        if (this.alreadyInstrumented.has('database')) return;
        this.alreadyInstrumented.add('database');

        // TRAP 3: .bind(pool) preserves `this` — pg Pool.query uses it internally
        const _originalQuery = pool.query.bind(pool);

        pool.query = async function layerinfiniteQuery(
            ...args: unknown[]
        ): Promise<{ rows: unknown[]; rowCount: number | null }> {
            const queryText = typeof args[0] === 'string' ? args[0]
                : (args[0] as { text?: string })?.text ?? 'db_query';
            const actionId = generateActionId();
            const actionName = `db/${queryText.slice(0, 40).replace(/\s+/g, '_')}`;
            const graph = new CausalGraph();
            const startMs = Date.now();

            return executionStore.run({ actionId, actionName, graph }, async () => {
                let result: { rows: unknown[]; rowCount: number | null };

                try {
                    result = await _originalQuery(...args);
                } catch (err) {
                    graph.recordFieldAccess({
                        actionId,
                        fieldPath: 'dbError',
                        value: String(err),
                        depth: 0,
                        confidence: 0.90,
                    });
                    emitDbToPipeline({
                        actionId, actionName, graph,
                        dbSuccess: false,
                        responseMs: Date.now() - startMs,
                    }).catch(() => { });
                    throw err;  // re-throw (TRAP 5)
                }

                const responseMs = Date.now() - startMs;
                const tracedResult = createTracedResponse(
                    result,
                    { actionId, actionName, fieldPath: '', depth: 0 },
                    graph,
                );

                emitDbToPipeline({
                    actionId, actionName, graph, result, dbSuccess: true, responseMs,
                }).catch(() => { });

                return tracedResult as unknown as typeof result;
            });
        };
    }

    // ── Child process interception ───────────────────────────────────────────
    // Does NOT patch child_process module globals — unsafe in Node.js v22.
    // execTracked / spawnTracked are the API surface agents call directly.
    instrumentChildProcess(): void {
        if (this.alreadyInstrumented.has('childprocess')) return;
        this.alreadyInstrumented.add('childprocess');
        // No globals to patch — see execTracked / spawnTracked below
    }

    async execTracked(
        command: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const execAsync = promisify(nodeExec);
        const actionId = generateActionId();
        const actionName = `exec/${command.slice(0, 40).replace(/\s+/g, '_')}`;
        const graph = new CausalGraph();
        const startMs = Date.now();

        return executionStore.run({ actionId, actionName, graph }, async () => {
            let exitCode = 0;
            let stdout = '';
            let stderr = '';

            try {
                const out = await execAsync(command);
                stdout = out.stdout ?? '';
                stderr = out.stderr ?? '';
                exitCode = 0;
            } catch (err: unknown) {
                // TRAP 6: exec non-zero exit is an expected outcome — do NOT re-throw
                const e = err as { code?: number; stdout?: string; stderr?: string };
                exitCode = e.code ?? 1;
                stdout = e.stdout ?? '';
                stderr = e.stderr ?? '';
            }

            const result = { exitCode, stdout, stderr };
            const tracedResult = createTracedResponse(
                result,
                { actionId, actionName, fieldPath: '', depth: 0 },
                graph,
            );

            emitProcessToPipeline({
                actionId, actionName, graph, exitCode,
                responseMs: Date.now() - startMs,
            }).catch(() => { });

            return tracedResult as unknown as typeof result;
        });
    }

    async spawnTracked(
        cmd: string,
        args: string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const actionId = generateActionId();
        const actionName = `spawn/${cmd.slice(0, 40).replace(/\s+/g, '_')}`;
        const graph = new CausalGraph();
        const startMs = Date.now();

        return executionStore.run({ actionId, actionName, graph }, () =>
            new Promise((resolve) => {
                const proc = nodeSpawn(cmd, args);
                let stdout = '';
                let stderr = '';

                proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
                proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

                proc.on('close', (code: number | null) => {
                    const exitCode = code ?? 1;
                    const result = { exitCode, stdout, stderr };
                    const tracedResult = createTracedResponse(
                        result,
                        { actionId, actionName, fieldPath: '', depth: 0 },
                        graph,
                    );

                    emitProcessToPipeline({
                        actionId, actionName, graph, exitCode,
                        responseMs: Date.now() - startMs,
                    }).catch(() => { });

                    resolve(tracedResult as unknown as typeof result);
                });
            })
        );
    }
}
