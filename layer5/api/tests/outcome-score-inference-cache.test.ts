import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
    },
}));

import {
    __resetActionBaselineCacheForTests,
    fetchActionBaseline,
    invalidateActionBaselineCache,
} from '../lib/outcome-score-inference.js';
import { supabase } from '../lib/supabase.js';

function makeFactOutcomesChain(result: { data: Array<{ response_time_ms: number | null; success: boolean }> | null }) {
    const q: any = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.order = vi.fn(() => q);
    q.limit = vi.fn(async () => result);
    return q;
}

describe('fetchActionBaseline cache', () => {
    const prevTtl = process.env.ACTION_BASELINE_CACHE_TTL_MS;

    beforeEach(() => {
        vi.clearAllMocks();
        __resetActionBaselineCacheForTests();
        process.env.ACTION_BASELINE_CACHE_TTL_MS = '120000';
    });

    afterEach(() => {
        if (prevTtl === undefined) delete process.env.ACTION_BASELINE_CACHE_TTL_MS;
        else process.env.ACTION_BASELINE_CACHE_TTL_MS = prevTtl;
        __resetActionBaselineCacheForTests();
    });

    it('caches baseline for repeated (agent_id, action_id) calls', async () => {
        const rows = [
            { response_time_ms: 120, success: true },
            { response_time_ms: 180, success: true },
            { response_time_ms: 250, success: false },
            { response_time_ms: 210, success: true },
            { response_time_ms: 160, success: true },
        ];

        vi.mocked((supabase as any).from).mockImplementation((table: string) => {
            if (table !== 'fact_outcomes') throw new Error(`Unexpected table: ${table}`);
            return makeFactOutcomesChain({ data: rows }) as any;
        });

        const first = await fetchActionBaseline('agent-1', 'action-1');
        const second = await fetchActionBaseline('agent-1', 'action-1');

        expect(first).not.toBeNull();
        expect(second).toEqual(first);
        expect((supabase as any).from).toHaveBeenCalledTimes(1);
    });

    it('caches null baselines when history is insufficient', async () => {
        const rows = [
            { response_time_ms: 120, success: true },
            { response_time_ms: 180, success: true },
            { response_time_ms: 250, success: false },
            { response_time_ms: 210, success: true },
        ];

        vi.mocked((supabase as any).from).mockImplementation((table: string) => {
            if (table !== 'fact_outcomes') throw new Error(`Unexpected table: ${table}`);
            return makeFactOutcomesChain({ data: rows }) as any;
        });

        const first = await fetchActionBaseline('agent-1', 'action-1');
        const second = await fetchActionBaseline('agent-1', 'action-1');

        expect(first).toBeNull();
        expect(second).toBeNull();
        expect((supabase as any).from).toHaveBeenCalledTimes(1);
    });

    it('supports targeted invalidation by (agent_id, action_id)', async () => {
        const rows = [
            { response_time_ms: 120, success: true },
            { response_time_ms: 180, success: true },
            { response_time_ms: 250, success: false },
            { response_time_ms: 210, success: true },
            { response_time_ms: 160, success: true },
        ];

        vi.mocked((supabase as any).from).mockImplementation((table: string) => {
            if (table !== 'fact_outcomes') throw new Error(`Unexpected table: ${table}`);
            return makeFactOutcomesChain({ data: rows }) as any;
        });

        await fetchActionBaseline('agent-1', 'action-1');
        invalidateActionBaselineCache('agent-1', 'action-1');
        await fetchActionBaseline('agent-1', 'action-1');

        expect((supabase as any).from).toHaveBeenCalledTimes(2);
    });
});
