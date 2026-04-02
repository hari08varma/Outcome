// TODO: observe.test.ts — pending fix of /observe route.
// The route is currently broken (missing context_id resolution).
// See: https://github.com/hari08varma/Outcome/issues/[issue number]
// Add end-to-end test once fixed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const eqSpy = vi.fn();

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        rpc: (...args: any[]) => mockRpc(...args),
        from: (...args: any[]) => mockFrom(...args),
    },
}));

import { findClosestContext } from '../lib/context-embed.js';

type DimContextRow = {
    context_id: string;
    context_vector: string;
    embedding_model: string;
    source_text: string;
    embedding_schema_version: number;
};

function makeDimContextsQuery(tenantRows: Map<string, DimContextRow[]>) {
    let customerIdFilter: string | null = null;
    let schemaVersionFilter: number | null = null;

    const q: any = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn((column: string, value: any) => {
        eqSpy(column, value);
        if (column === 'customer_id') customerIdFilter = String(value);
        if (column === 'embedding_schema_version') schemaVersionFilter = Number(value);
        return q;
    });
    q.not = vi.fn(() => q);
    q.then = (resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) => {
        const rows = customerIdFilter ? (tenantRows.get(customerIdFilter) ?? []) : [];
        const filtered = schemaVersionFilter === null
            ? rows
            : rows.filter((r) => r.embedding_schema_version === schemaVersionFilter);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    };
    return q;
}

describe('findClosestContext tenant isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC unavailable' } });
    });

    it('returns context for the correct tenant', async () => {
        const tenantRows = new Map<string, DimContextRow[]>([
            ['customer_A', [{ context_id: 'ctx-A', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
            ['customer_B', [{ context_id: 'ctx-B', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
        ]);

        mockFrom.mockImplementation(() => makeDimContextsQuery(tenantRows));

        const result = await findClosestContext([1, 0, 0], 'customer_A');

        expect(result?.context_id).toBe('ctx-A');
        expect(result?.context_id).not.toBe('ctx-B');
    });

    it('returns null when tenant has no matching context', async () => {
        const tenantRows = new Map<string, DimContextRow[]>([
            ['customer_B', [{ context_id: 'ctx-B', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
        ]);

        mockFrom.mockImplementation(() => makeDimContextsQuery(tenantRows));

        const result = await findClosestContext([1, 0, 0], 'customer_A');

        expect(result).toBeNull();
    });

    it('does not leak customer_B context to customer_A query', async () => {
        const tenantRows = new Map<string, DimContextRow[]>([
            ['customer_B', [{ context_id: 'ctx-B', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
        ]);

        mockFrom.mockImplementation(() => makeDimContextsQuery(tenantRows));

        const result = await findClosestContext([1, 0, 0], 'customer_A');

        expect(result).toBeNull();
        expect(eqSpy).toHaveBeenCalledWith('customer_id', 'customer_A');
    });

    it('same issue_type across two tenants returns correct ctx for each', async () => {
        const tenantRows = new Map<string, DimContextRow[]>([
            ['customer_A', [{ context_id: 'ctx-A', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
            ['customer_B', [{ context_id: 'ctx-B', context_vector: '[1,0,0]', embedding_model: 'gte-small', source_text: 'billing', embedding_schema_version: 2 }]],
        ]);

        mockFrom.mockImplementation(() => makeDimContextsQuery(tenantRows));

        const resultA = await findClosestContext([1, 0, 0], 'customer_A');
        const resultB = await findClosestContext([1, 0, 0], 'customer_B');

        expect(resultA?.context_id).toBe('ctx-A');
        expect(resultB?.context_id).toBe('ctx-B');
    });
});
