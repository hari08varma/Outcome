import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        rpc: (...args: any[]) => mockRpc(...args),
        from: (...args: any[]) => mockFrom(...args),
    },
}));

import { findClosestContext, generateEmbedding } from '../../api/lib/context-embed.js';

function makeDimContextsQuery(result: { data: any; error: any }) {
    const q: any = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.not = vi.fn(() => q);
    q.then = (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return q;
}

describe('context-embed RPC and fallback behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env['SUPABASE_URL'] = 'https://example.supabase.co';
        process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role-key';
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('findClosestContext calls RPC with customerId and does not trigger fallback on success', async () => {
        mockRpc.mockResolvedValue({
            data: [{ context_id: 'ctx-1', similarity: 0.93 }],
            error: null,
        });

        const queryEmbedding = [0.1, 0.2, 0.3];
        const result = await findClosestContext(queryEmbedding, 'cust-123');

        expect(mockRpc).toHaveBeenCalledWith('match_context_vector', {
            query_vector: queryEmbedding,
            p_customer_id: 'cust-123',
            p_model: 'gte-small',
            p_threshold: 0.6,
            p_limit: 1,
        });
        expect(mockFrom).not.toHaveBeenCalled();
        expect(result).toEqual({ context_id: 'ctx-1', similarity: 0.93 });
    });

    it('findClosestContext falls back to customer-scoped scan when RPC errors', async () => {
        mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } });

        const fallbackQuery = makeDimContextsQuery({
            data: [
                {
                    context_id: 'ctx-fallback',
                    context_vector: '[1,0,0]',
                    embedding_model: 'gte-small',
                    source_text: 'billing prod',
                    embedding_schema_version: 2,
                },
            ],
            error: null,
        });

        mockFrom.mockReturnValue(fallbackQuery);

        const result = await findClosestContext([1, 0, 0], 'cust-fallback');

        expect(mockFrom).toHaveBeenCalledWith('dim_contexts');
        const eqCalls = fallbackQuery.eq.mock.calls as Array<[string, any]>;
        expect(eqCalls).toContainEqual(['customer_id', 'cust-fallback']);
        expect(eqCalls).toContainEqual(['embedding_schema_version', 2]);
        expect(result).toEqual({ context_id: 'ctx-fallback', similarity: 1 });
    });

    it('parseVector malformed inputs are skipped in fallback and return null match', async () => {
        const malformedInputs = ['', 'abc,def', '[NaN,1,2]'];

        for (const malformed of malformedInputs) {
            mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC unavailable' } });

            const fallbackQuery = makeDimContextsQuery({
                data: [
                    {
                        context_id: `ctx-bad-${malformed}`,
                        context_vector: malformed,
                        embedding_model: 'gte-small',
                        source_text: 'bad vector',
                        embedding_schema_version: 2,
                    },
                ],
                error: null,
            });

            mockFrom.mockReturnValueOnce(fallbackQuery);
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            const result = await findClosestContext([1, 0, 0], 'cust-parse');
            expect(result).toBeNull();

            const messages = warnSpy.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => m.includes('failed to parse stored vector string'))).toBe(true);
            warnSpy.mockRestore();
        }
    });

    it('generateSupabaseEmbedding aborts after 5s and returns null', async () => {
        vi.useFakeTimers();

        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            return new Promise((_resolve, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                if (!signal) {
                    reject(new Error('missing signal'));
                    return;
                }

                signal.addEventListener('abort', () => {
                    const abortErr = new Error('aborted');
                    (abortErr as any).name = 'AbortError';
                    reject(abortErr);
                });
            });
        });

        vi.stubGlobal('fetch', fetchMock as any);

        const promise = generateEmbedding('context text that hangs');
        await vi.advanceTimersByTimeAsync(5001);

        await expect(promise).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
    });
});
