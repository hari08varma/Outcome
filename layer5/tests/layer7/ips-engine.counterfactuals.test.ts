import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.fn();

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from: (...args: any[]) => mockFrom(...args),
    },
}));

import {
    computePropensities,
    computeIPSEstimate,
    writeCounterfactuals,
} from '../../api/lib/ips-engine.js';

describe('IPS Engine fixes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('re-normalizes skewed propensities so total remains 1.0', () => {
        const actions = [
            { action_name: 'dominant', score: 1000 },
            { action_name: 'tiny_a', score: -1000 },
            { action_name: 'tiny_b', score: -1000 },
            { action_name: 'tiny_c', score: -1000 },
            { action_name: 'tiny_d', score: -1000 },
        ];

        const props = computePropensities(actions);
        const total = Array.from(props.values()).reduce((a, b) => a + b, 0);

        expect(total).toBeCloseTo(1.0, 12);
    });

    it('computeIPSEstimate with equal propensities follows documented custom weight behavior', () => {
        const realOutcome = 0.8;
        const propensityChosen = 0.5;
        const propensityUnchosen = 0.5;

        const result = computeIPSEstimate(realOutcome, propensityChosen, propensityUnchosen);

        // ratio=1 -> estimate=realOutcome; rawWeight=p_unchosen*(1-|estimate-real|)=0.5
        // then capped at 0.3 by IPS_WEIGHT_CAP.
        expect(result.estimate).toBe(0.8);
        expect(result.weight).toBe(0.3);

        // Explicitly not standard DR weight (1/p_chosen = 2.0).
        expect(result.weight).not.toBeCloseTo(1 / propensityChosen, 6);
    });

    it('writeCounterfactuals retries are idempotent via upsert conflict key', async () => {
        const seenKeys = new Set<string>();
        const persistedRows: Array<Record<string, any>> = [];

        const upsert = vi.fn(async (rows: Array<Record<string, any>>, options: Record<string, any>) => {
            for (const row of rows) {
                const key = `${row.decision_id}:${row.unchosen_action_id}`;
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    persistedRows.push(row);
                }
            }
            return { data: null, error: null, options };
        });

        mockFrom.mockImplementation((table: string) => {
            if (table !== 'fact_outcome_counterfactuals') {
                throw new Error(`Unexpected table: ${table}`);
            }
            return { upsert };
        });

        const input = {
            decisionId: 'decision-1',
            realOutcomeId: 'outcome-1',
            realOutcomeScore: 0.7,
            chosenActionName: 'a',
            rankedActions: [
                { action_name: 'a', action_id: 'action-a', score: 0.9, rank: 1, propensity: 0.6 },
                { action_name: 'b', action_id: 'action-b', score: 0.7, rank: 2, propensity: 0.25 },
                { action_name: 'c', action_id: 'action-c', score: 0.4, rank: 3, propensity: 0.15 },
            ],
            contextHash: 'ctx-1',
            episodePosition: 1,
        };

        await writeCounterfactuals(input);
        await writeCounterfactuals(input);

        expect(upsert).toHaveBeenCalledTimes(2);
        for (const call of upsert.mock.calls) {
            expect(call[1]).toEqual({
                onConflict: 'decision_id,unchosen_action_id',
                ignoreDuplicates: true,
            });
        }

        // Two unchosen actions should persist once each despite retry.
        expect(seenKeys.size).toBe(2);
        expect(persistedRows).toHaveLength(2);
    });
});
