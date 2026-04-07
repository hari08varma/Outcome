import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn(async () => ({ error: null }));
const from = vi.fn(() => ({ upsert }));

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from,
    },
}));

const { persistDecision } = await import('../../api/lib/decision-writer.js');

const baseDecision = {
    agent_id: '00000000-0000-0000-0000-000000000001',
    context_id: '00000000-0000-0000-0000-000000000002',
    context_hash: 'ctx:test',
    ranked_actions: [{ action_name: 'retry', action_id: 'a1', score: 0.8, rank: 1, propensity: 0.6 }],
    episode_position: 0,
};

describe('decision-writer persistDecision', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        upsert.mockResolvedValue({ error: null });
    });

    it('omits episode_id from insert when episode_id is null', async () => {
        const id = await persistDecision({
            ...baseDecision,
            episode_id: null,
        });

        expect(id).toMatch(/^[0-9a-f\-]{36}$/i);
        expect(from).toHaveBeenCalledWith('fact_decisions');

        const insertedRows = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
        expect(insertedRows[0]).not.toHaveProperty('episode_id');
    });

    it('retains episode_id in insert when provided', async () => {
        const episodeId = '00000000-0000-0000-0000-000000000099';

        const id = await persistDecision({
            ...baseDecision,
            episode_id: episodeId,
            episode_position: 2,
        });

        expect(id).toMatch(/^[0-9a-f\-]{36}$/i);

        const insertedRows = upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
        expect(insertedRows[0]).toHaveProperty('episode_id', episodeId);
    });

    it('returns null when insert fails', async () => {
        upsert.mockResolvedValueOnce({ error: { message: 'insert failed' } });

        const id = await persistDecision({
            ...baseDecision,
            episode_id: null,
        });

        expect(id).toBeNull();
    });
});
