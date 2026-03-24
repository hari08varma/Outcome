import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractClient } from '../src/contracts/contract-client.js';
import { PendingSignalWriter } from '../src/pipeline/pending-signal-writer.js';
import { OutcomePipeline } from '../src/pipeline/outcome-pipeline.js';
import { CausalGraph } from '../src/tracing/causal-graph.js';
import { _pendingEmissions, drainEmissions } from '../src/interceptor.js';

describe('Phase 5', () => {
    beforeEach(() => {
        drainEmissions();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        drainEmissions();
        vi.restoreAllMocks();
    });

    it('Test 1: ContractClient.registerSignalContract sends correct POST body', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'c1',
                customer_id: 'cust_1',
                action_name: 'refund',
                success_condition: 'payload.ok == true',
                score_expression: '1',
                timeout_hours: 24,
                fallback_strategy: 'use_http_status',
                is_active: true,
                created_at: '2026-01-01T00:00:00.000Z',
            }),
        });
        vi.stubGlobal('fetch', fetchMock as any);

        const client = new ContractClient({ apiKey: 'k1', baseUrl: 'https://x.test' });
        await client.registerSignalContract({
            actionName: 'refund',
            successCondition: 'payload.ok == true',
            scoreExpression: '1',
            timeoutHours: 12,
            fallbackStrategy: 'explicit_only',
        });

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://x.test/v1/contracts');
        expect(call[1].method).toBe('POST');
        expect(JSON.parse(call[1].body)).toEqual({
            action_name: 'refund',
            success_condition: 'payload.ok == true',
            score_expression: '1',
            timeout_hours: 12,
            fallback_strategy: 'explicit_only',
        });
    });

    it('Test 2: registerSignalContract returns camelCase-converted SignalContract', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'c2',
                customer_id: 'cust_2',
                action_name: 'issue_refund',
                success_condition: 'payload.ok == true',
                score_expression: 'payload.score',
                timeout_hours: 24,
                fallback_strategy: 'always_pending',
                is_active: true,
                created_at: '2026-01-01T00:00:00.000Z',
            }),
        }) as any);

        const client = new ContractClient({ apiKey: 'k2', baseUrl: 'https://x.test' });
        const out = await client.registerSignalContract({
            actionName: 'issue_refund',
            successCondition: 'payload.ok == true',
            scoreExpression: 'payload.score',
        });

        expect(out.customerId).toBe('cust_2');
        expect(out.actionName).toBe('issue_refund');
        expect(out.successCondition).toBe('payload.ok == true');
        expect(out.scoreExpression).toBe('payload.score');
        expect(out.timeoutHours).toBe(24);
    });

    it('Test 3: registerSignalContract throws on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' }) as any);
        const client = new ContractClient({ apiKey: 'k3', baseUrl: 'https://x.test' });

        await expect(client.registerSignalContract({
            actionName: 'a',
            successCondition: 'x',
            scoreExpression: 'y',
        })).rejects.toThrow('registerSignalContract failed');
    });

    it('Test 4: ContractClient.listSignalContracts sends GET with auth header', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
        vi.stubGlobal('fetch', fetchMock as any);
        const client = new ContractClient({ apiKey: 'k4', baseUrl: 'https://x.test' });

        await client.listSignalContracts();

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://x.test/v1/contracts');
        expect(call[1].method).toBe('GET');
        expect(call[1].headers.Authorization).toBe('Bearer k4');
    });

    it('Test 5: listSignalContracts returns array of SignalContract', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => [{
                id: 'c5',
                customer_id: 'cust_5',
                action_name: 'x',
                success_condition: 'a',
                score_expression: 'b',
                timeout_hours: 1,
                fallback_strategy: 'use_http_status',
                is_active: true,
                created_at: '2026-01-01T00:00:00.000Z',
            }],
        }) as any);

        const client = new ContractClient({ apiKey: 'k5', baseUrl: 'https://x.test' });
        const out = await client.listSignalContracts();

        expect(out).toHaveLength(1);
        expect(out[0].customerId).toBe('cust_5');
    });

    it('Test 6: ContractClient.deactivateSignalContract sends DELETE to correct URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock as any);
        const client = new ContractClient({ apiKey: 'k6', baseUrl: 'https://x.test' });

        await client.deactivateSignalContract('abc');

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://x.test/v1/contracts/abc');
        expect(call[1].method).toBe('DELETE');
    });

    it('Test 7: deactivateSignalContract throws on 404 response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }) as any);
        const client = new ContractClient({ apiKey: 'k7', baseUrl: 'https://x.test' });

        await expect(client.deactivateSignalContract('missing')).rejects.toThrow('deactivateSignalContract failed');
    });

    it('Test 8: PendingSignalWriter.write sends correct POST body', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock as any);

        const writer = new PendingSignalWriter({
            logOutcome: vi.fn(),
            getScores: vi.fn(),
            getApiKey: () => 'api_8',
            getBaseUrl: () => 'https://base.test',
        });

        await writer.write({
            outcomeId: 'o8',
            actionName: 'stripe/refund',
            success: true,
            outcomeScore: 1,
            feedbackSignal: 'delayed',
            isPending: true,
            confidence: 0.9,
            providerHint: 'stripe',
        });

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://base.test/v1/pending-signals');
        expect(JSON.parse(call[1].body)).toEqual({
            outcome_id: 'o8',
            action_name: 'stripe/refund',
            provider_hint: 'stripe',
            feedback_signal: 'delayed',
        });
    });

    it('Test 9: PendingSignalWriter.write does NOT throw when fetch fails (fire-and-forget)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')) as any);

        const writer = new PendingSignalWriter({
            logOutcome: vi.fn(),
            getScores: vi.fn(),
            getApiKey: () => 'api_9',
            getBaseUrl: () => 'https://base.test',
        });

        await expect(writer.write({
            outcomeId: 'o9',
            actionName: 'stripe/refund',
            success: true,
            outcomeScore: 1,
            feedbackSignal: 'delayed',
            isPending: true,
            confidence: 0.9,
            providerHint: 'stripe',
        })).resolves.toBeUndefined();
    });

    it('Test 10: PendingSignalWriter.write uses client.getBaseUrl() and client.getApiKey()', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock as any);

        const writer = new PendingSignalWriter({
            logOutcome: vi.fn(),
            getScores: vi.fn(),
            getApiKey: () => 'api_10',
            getBaseUrl: () => 'https://base10.test',
        });

        await writer.write({
            outcomeId: 'o10',
            actionName: 'stripe/refund',
            success: true,
            outcomeScore: 1,
            feedbackSignal: 'delayed',
            isPending: true,
            confidence: 0.9,
            providerHint: 'stripe',
        });

        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://base10.test/v1/pending-signals');
        expect(call[1].headers.Authorization).toBe('Bearer api_10');
    });

    it('Test 11: OutcomePipeline — item with isPending=true triggers write() on PendingSignalWriter', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }) as any);
        const logOutcome = vi.fn().mockResolvedValue({ ok: true });

        const pipeline = new OutcomePipeline({
            logOutcome,
            getScores: vi.fn(),
            getApiKey: () => 'api_11',
            getBaseUrl: () => 'https://base11.test',
        });

        const graph = new CausalGraph();
        graph.recordComparison({ actionId: 'a11', fieldPath: 'x', value: true, hint: 'h', depth: 0, confidence: 0.9 });
        _pendingEmissions.push({ actionId: 'a11', actionName: 'stripe/refund', graph, responseMs: 1, httpSuccess: true });

        pipeline.start();
        await Promise.resolve();
        await Promise.resolve();
        pipeline.stop();

        const fetchMock = globalThis.fetch as any;
        expect(logOutcome).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/pending-signals');
    });

    it('Test 12: OutcomePipeline — item with isPending=false does NOT trigger write()', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }) as any);
        const logOutcome = vi.fn().mockResolvedValue({ ok: true });

        const pipeline = new OutcomePipeline({
            logOutcome,
            getScores: vi.fn(),
            getApiKey: () => 'api_12',
            getBaseUrl: () => 'https://base12.test',
        });

        const graph = new CausalGraph();
        graph.recordComparison({ actionId: 'a12', fieldPath: 'x', value: true, hint: 'h', depth: 0, confidence: 0.9 });
        _pendingEmissions.push({ actionId: 'a12', actionName: 'internal/action', graph, responseMs: 1, httpSuccess: true });

        pipeline.start();
        await Promise.resolve();
        await Promise.resolve();
        pipeline.stop();

        const fetchMock = globalThis.fetch as any;
        expect(logOutcome).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('Test 13: ContractClient defaults baseUrl to https://api.layerinfinite.com', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
        vi.stubGlobal('fetch', fetchMock as any);

        const client = new ContractClient({ apiKey: 'k13' });
        await client.listSignalContracts();

        expect(fetchMock.mock.calls[0][0]).toBe('https://api.layerinfinite.com/v1/contracts');
    });

    it('Test 14: registerSignalContract sends timeoutHours=24 when not specified', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                id: 'c14',
                customer_id: 'cust_14',
                action_name: 'refund',
                success_condition: 'a',
                score_expression: 'b',
                timeout_hours: 24,
                fallback_strategy: 'use_http_status',
                is_active: true,
                created_at: '2026-01-01T00:00:00.000Z',
            }),
        });
        vi.stubGlobal('fetch', fetchMock as any);

        const client = new ContractClient({ apiKey: 'k14', baseUrl: 'https://x.test' });
        await client.registerSignalContract({
            actionName: 'refund',
            successCondition: 'a',
            scoreExpression: 'b',
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.timeout_hours).toBe(24);
    });
});
