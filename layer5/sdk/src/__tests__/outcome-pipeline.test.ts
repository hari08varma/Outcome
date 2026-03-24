import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CausalGraph } from '../tracing/causal-graph.js';
import { _pendingEmissions, drainEmissions } from '../interceptor.js';
import { deriveOutcomeParams } from '../pipeline/outcome-deriver.js';
import { OutcomePipeline } from '../pipeline/outcome-pipeline.js';

function makeClient(logOutcomeImpl?: ReturnType<typeof vi.fn>) {
    return {
        logOutcome: logOutcomeImpl ?? vi.fn().mockResolvedValue({ ok: true }),
        getScores: vi.fn().mockResolvedValue({ ranked_actions: [] }),
        getApiKey: () => 'test-key',
        getBaseUrl: () => 'http://localhost',
    };
}

function makeGraph(actionId: string, values: Array<{ value: unknown; confidence: number }>): CausalGraph {
    const graph = new CausalGraph();
    for (const item of values) {
        graph.recordComparison({
            actionId,
            fieldPath: 'result.ok',
            value: item.value,
            hint: 'boolean_check',
            depth: 0,
            confidence: item.confidence,
        });
    }
    return graph;
}

function makeEmission(actionId = 'action_1'): {
    actionId: string;
    actionName: string;
    graph: CausalGraph;
    responseMs: number;
    httpSuccess?: boolean;
    dbSuccess?: boolean;
    exitCode?: number;
} {
    return {
        actionId,
        actionName: `fetch/${actionId}`,
        graph: makeGraph(actionId, [{ value: true, confidence: 0.9 }]),
        responseMs: 10,
        httpSuccess: true,
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    drainEmissions();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

afterEach(() => {
    drainEmissions();
    vi.useRealTimers();
});

describe('OutcomePipeline + outcome derivation', () => {
    it('Test 1: deriveOutcomeParams defaults to neutral score when no comparisons exist', () => {
        const graph = new CausalGraph();

        const params = deriveOutcomeParams(graph, 'a1');

        expect(params.action_id).toBe('a1');
        expect(params.outcome_score).toBe(0.5);
        expect(params.confidence).toBe(0.5);
        expect(params.derivation_method).toBe('causal_graph_v1');
    });

    it('Test 2: deriveOutcomeParams computes score ratio and max confidence', () => {
        const graph = makeGraph('a2', [
            { value: true, confidence: 0.65 },
            { value: false, confidence: 0.9 },
            { value: true, confidence: 0.7 },
        ]);

        const params = deriveOutcomeParams(graph, 'a2', { source: 'unit_test' });

        expect(params.outcome_score).toBeCloseTo(2 / 3, 5);
        expect(params.confidence).toBe(0.9);
        expect(params.metadata.source).toBe('unit_test');
        expect(params.metadata.derivation_method).toBe('causal_graph_v1');
    });

    it('Test 3: start drains queued emissions and logs outcomes', async () => {
        const client = makeClient();
        _pendingEmissions.push(makeEmission('a3'));

        const pipeline = new OutcomePipeline(client as any);
        pipeline.start();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(1);
        pipeline.stop();
    });

    it('Test 4: microtask scheduler coalesces multiple rapid emissions', async () => {
        const client = makeClient();
        _pendingEmissions.push(makeEmission('a4_1'));
        _pendingEmissions.push(makeEmission('a4_2'));
        _pendingEmissions.push(makeEmission('a4_3'));

        const pipeline = new OutcomePipeline(client as any);
        pipeline.start();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(3);
        pipeline.stop();
    });

    it('Test 5: stop prevents further draining from being processed', async () => {
        const client = makeClient();
        const pipeline = new OutcomePipeline(client as any);

        pipeline.start();
        pipeline.stop();

        _pendingEmissions.push(makeEmission('a5'));
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(0);
    });

    it('Test 6: retries once after failure and then succeeds', async () => {
        vi.useFakeTimers();
        const client = makeClient(
            vi
                .fn()
                .mockRejectedValueOnce(new Error('transient'))
                .mockResolvedValueOnce({ ok: true }),
        );

        _pendingEmissions.push(makeEmission('a6'));
        const pipeline = new OutcomePipeline(client as any, { retryBackoffMs: 20 });
        pipeline.start();

        await flushMicrotasks();
        await vi.runAllTimersAsync();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(2);
        pipeline.stop();
    });

    it('Test 7: drops emission after second failure without throwing', async () => {
        vi.useFakeTimers();
        const client = makeClient(vi.fn().mockRejectedValue(new Error('hard-fail')));

        _pendingEmissions.push(makeEmission('a7'));
        const pipeline = new OutcomePipeline(client as any, { retryBackoffMs: 20 });
        pipeline.start();

        await flushMicrotasks();
        await vi.runAllTimersAsync();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(2);
        pipeline.stop();
    });

    it('Test 8: processes all emissions across multiple batches', async () => {
        const client = makeClient();
        _pendingEmissions.push(makeEmission('a8_1'));
        _pendingEmissions.push(makeEmission('a8_2'));
        _pendingEmissions.push(makeEmission('a8_3'));

        const pipeline = new OutcomePipeline(client as any, { maxBatchSize: 2 });
        pipeline.start();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(3);
        pipeline.stop();
    });

    it('Test 9: sends expected metadata fields to logOutcome', async () => {
        const client = makeClient();
        _pendingEmissions.push({
            ...makeEmission('a9'),
            dbSuccess: false,
            exitCode: 0,
        });

        const pipeline = new OutcomePipeline(client as any);
        pipeline.start();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(1);
        const call = client.logOutcome.mock.calls[0]![0];
        expect(call.metadata.action_name).toBe('fetch/a9');
        expect(call.metadata.response_ms).toBe(10);
        expect(call.metadata.http_success).toBe(true);
        expect(call.metadata.db_success).toBe(false);
        expect(call.metadata.exit_code).toBe(0);
        pipeline.stop();
    });

    it('Test 10: derivation filters comparisons by action id', () => {
        const graph = new CausalGraph();
        graph.recordComparison({
            actionId: 'target',
            fieldPath: 'x',
            value: true,
            hint: 'h1',
            depth: 0,
            confidence: 0.4,
        });
        graph.recordComparison({
            actionId: 'other',
            fieldPath: 'x',
            value: false,
            hint: 'h2',
            depth: 0,
            confidence: 1,
        });

        const params = deriveOutcomeParams(graph, 'target');

        expect(params.outcome_score).toBe(1);
        expect(params.confidence).toBe(0.4);
    });

    it('Test 11: timeout fallback drains queue with fake timers', async () => {
        vi.useFakeTimers();
        const client = makeClient();
        _pendingEmissions.push(makeEmission('a11'));

        const pipeline = new OutcomePipeline(client as any, { maxQueueDelayMs: 1000 });
        pipeline.start();

        await vi.runAllTimersAsync();
        await flushMicrotasks();

        expect(client.logOutcome).toHaveBeenCalledTimes(1);
        pipeline.stop();
    });

    it('Test 12: pipeline keeps draining emissions that arrive during in-flight send', async () => {
        let released = false;
        const client = makeClient(
            vi.fn().mockImplementation(async () => {
                if (!released) {
                    await new Promise<void>((resolve) => setTimeout(resolve, 5));
                    released = true;
                }
                return { ok: true };
            }),
        );

        _pendingEmissions.push(makeEmission('a12_1'));
        const pipeline = new OutcomePipeline(client as any);
        pipeline.start();

        _pendingEmissions.push(makeEmission('a12_2'));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(client.logOutcome).toHaveBeenCalledTimes(2);
        pipeline.stop();
    });
});
