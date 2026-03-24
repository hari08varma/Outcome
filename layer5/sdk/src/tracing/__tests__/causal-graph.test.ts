import { CausalGraph } from '../causal-graph.js';
import { computeConfidence } from '../provenance.js';
import { createTracedPrimitive } from '../traced-primitive.js';
import { createTracedResponse } from '../traced-response.js';

type TestCase = {
    name: string;
    run: () => void | Promise<void>;
};

const tests: TestCase[] = [];

function test(name: string, run: () => void | Promise<void>): void {
    tests.push({ name, run });
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
    if (typeof actual === 'number' && typeof expected === 'number') {
        const difference = Math.abs(actual - expected);
        if (difference > 1e-12) {
            throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}`);
        }
        return;
    }

    if (!Object.is(actual, expected)) {
        throw new Error(`${message}. Expected ${String(expected)}, got ${String(actual)}`);
    }
}

function assertTrue(value: boolean, message: string): void {
    if (!value) {
        throw new Error(message);
    }
}

test('Test 1 — Direct field access attribution', () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { status: 'succeeded', id: 'ref_123' },
        { actionId: 'a1', actionName: 'stripe_refund', fieldPath: '', depth: 0 },
        graph,
    ) as { status: unknown };

    void response.status;

    const accesses = graph.getFieldAccesses();
    assertEqual(accesses.length, 1, 'Expected one field access');
    assertEqual(accesses[0]?.actionId, 'a1', 'Expected actionId=a1');
    assertEqual(accesses[0]?.fieldPath, 'status', 'Expected fieldPath=status');
});

test('Test 2 — Comparison recording via Symbol.toPrimitive', () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { status: 'succeeded', id: 'ref_123' },
        { actionId: 'a1', actionName: 'stripe_refund', fieldPath: '', depth: 0 },
        graph,
    ) as { status: unknown };

    const ok = (response.status as string) == 'succeeded';

    assertEqual(ok, true, 'Expected comparison to evaluate true');

    const comparisons = graph.getComparisons();
    assertEqual(comparisons.length, 1, 'Expected one comparison record');
    assertEqual(comparisons[0]?.actionId, 'a1', 'Expected comparison actionId=a1');
    assertEqual(comparisons[0]?.value, 'succeeded', 'Expected comparison value=succeeded');
});

test('Test 3 — Depth decay', () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { status: 'succeeded', nested: { field: 'x' } },
        { actionId: 'a1', actionName: 'stripe_refund', fieldPath: '', depth: 0 },
        graph,
    ) as { status: unknown; nested: { field: unknown } };

    void response.status;
    void response.nested.field;

    const accesses = graph.getFieldAccesses();
    assertEqual(accesses[0]?.confidence, 0.9, 'Depth 0 confidence mismatch');
    assertEqual(accesses[2]?.confidence, 0.86, 'Depth 1 confidence mismatch');

    assertEqual(computeConfidence(0), 0.9, 'computeConfidence(0) mismatch');
    assertEqual(computeConfidence(8), 0.58, 'computeConfidence(8) mismatch');
    assertEqual(computeConfidence(9), 0, 'computeConfidence(9) mismatch');
});

test('Test 4 — Tag retirement at depth 9', () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { deep: 'value' },
        { actionId: 'a1', actionName: 'stripe_refund', fieldPath: 'a.b.c.d.e.f.g.h.i', depth: 9 },
        graph,
    ) as { deep: string };

    const before = graph.getFieldAccesses().length;
    const value = response.deep;
    const after = graph.getFieldAccesses().length;

    assertEqual(value, 'value', 'Expected raw value at retired depth');
    assertEqual(after, before, 'Expected no additional field access record');
});

test('Test 5 — Concurrent action isolation', () => {
    const graph1 = new CausalGraph();
    const graph2 = new CausalGraph();

    const response1 = createTracedResponse(
        { status: 'ok1' },
        { actionId: 'a1', actionName: 'action_1', fieldPath: '', depth: 0 },
        graph1,
    ) as { status: unknown };

    const response2 = createTracedResponse(
        { status: 'ok2' },
        { actionId: 'a2', actionName: 'action_2', fieldPath: '', depth: 0 },
        graph2,
    ) as { status: unknown };

    void response1.status;
    void response2.status;

    assertTrue(graph1.getFieldAccesses().every((record) => record.actionId === 'a1'), 'graph1 contamination detected');
    assertTrue(graph2.getFieldAccesses().every((record) => record.actionId === 'a2'), 'graph2 contamination detected');
});

test('Test 6 — toString tag survival', () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { status: 'succeeded' },
        { actionId: 'a1', actionName: 'stripe_refund', fieldPath: '', depth: 0 },
        graph,
    ) as { status: { toString: () => unknown } };

    const traced = response.status.toString() as Record<symbol, unknown>;
    assertEqual(Symbol.toPrimitive in traced, true, 'Expected Symbol.toPrimitive on toString result');

    const ok = (traced as unknown as string) == 'succeeded';
    assertEqual(ok, true, 'Expected toString traced comparison true');

    const comparisons = graph.getComparisons();
    assertTrue(comparisons.length >= 1, 'Expected at least one comparison record');
    assertEqual(comparisons[comparisons.length - 1]?.value, 'succeeded', 'Expected comparison value=succeeded');
});

test('Test 7 — valueOf returns raw primitive (no infinite recursion)', () => {
    const graph = new CausalGraph();
    const wrapped = createTracedPrimitive(
        42,
        { actionId: 'a1', actionName: 'num_action', fieldPath: 'answer', depth: 0 },
        graph,
    );

    const value = wrapped.valueOf();

    assertEqual(value, 42, 'Expected raw number 42');
    assertEqual(typeof value, 'number', 'Expected valueOf to return number');
});

test('Test 8 — then passthrough (no thenable treatment)', async () => {
    const graph = new CausalGraph();
    const response = createTracedResponse(
        { status: 'ok' },
        { actionId: 'a1', actionName: 'plain', fieldPath: '', depth: 0 },
        graph,
    ) as { then?: unknown; status: string };

    assertEqual(response.then, undefined, 'Expected then to pass through as undefined');

    const resolved = await Promise.resolve(response);
    assertEqual(resolved, response, 'Expected Promise.resolve to return same object');
    assertEqual((resolved.status as unknown as string) == 'ok', true, 'Expected resolved status to remain ok');
});

test('Test 9 — deriveOutcome()', () => {
    const graph = new CausalGraph();

    graph.recordComparison({
        actionId: 'a1',
        fieldPath: 'status',
        value: true,
        hint: 'default',
        depth: 0,
        confidence: 0.9,
    });

    graph.recordComparison({
        actionId: 'a1',
        fieldPath: 'id',
        value: false,
        hint: 'default',
        depth: 1,
        confidence: 0.86,
    });

    const outcome = graph.deriveOutcome();

    assertTrue(outcome !== null, 'Expected non-null outcome');
    assertEqual(outcome?.success, true, 'Expected success=true');
    assertEqual(outcome?.confidence, 0.9, 'Expected max confidence=0.9');
});

test('Test 10 — deriveOutcome() with no comparisons', () => {
    const graph = new CausalGraph();
    const outcome = graph.deriveOutcome();

    assertEqual(outcome, null, 'Expected null when no comparisons');
});

export async function runCausalGraphTests(): Promise<void> {
    for (const testCase of tests) {
        await testCase.run();
    }
}
