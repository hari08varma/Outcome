import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        rpc: vi.fn(),
    },
}));

import { supabase } from '../../api/lib/supabase.js';

import {
    COHORT_CYCLE_MAX_DAYS,
    COHORT_CYCLE_MAX_OUTCOMES,
    COHORT_EARLY_CLOSE_CONFIDENCE_DROP,
    COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP,
    resetRecommendationCohortCycleStore,
    upsertRecommendationCohortCycle,
} from '../../api/lib/recommendation/cohort-cycle.js';

function observation(overrides: Partial<Parameters<typeof upsertRecommendationCohortCycle>[0]> = {}) {
    return {
        customer_id: 'cust-1',
        task_name: 'incident_resolution',
        observed_at: '2026-04-01T00:00:00.000Z',
        total_outcomes: 0,
        median_confidence: 0.8,
        median_success_rate: 0.85,
        ...overrides,
    };
}

describe('recommendation cohort cycle rotation', () => {
    beforeEach(() => {
        resetRecommendationCohortCycleStore();
        vi.clearAllMocks();
        vi.mocked((supabase as any).rpc).mockResolvedValue({
            data: null,
            error: {
                code: '42883',
                message: 'function upsert_recommendation_cohort_cycle does not exist',
            },
        });
    });

    it('rotates on time boundary (>= 7 days)', async () => {
        const first = await upsertRecommendationCohortCycle(observation());

        const second = await upsertRecommendationCohortCycle(observation({
            observed_at: '2026-04-09T00:00:00.000Z',
            total_outcomes: 5,
        }));

        expect(first.rotation_triggered).toBe(false);
        expect(second.rotation_triggered).toBe(true);
        expect(second.rotation_reason).toBe('time_elapsed');
        expect(second.previous_cycle?.elapsed_days).toBeGreaterThanOrEqual(COHORT_CYCLE_MAX_DAYS);
    });

    it('rotates on outcome-count boundary (>= 100)', async () => {
        await upsertRecommendationCohortCycle(observation());

        const rotated = await upsertRecommendationCohortCycle(observation({
            observed_at: '2026-04-02T00:00:00.000Z',
            total_outcomes: COHORT_CYCLE_MAX_OUTCOMES,
        }));

        expect(rotated.rotation_triggered).toBe(true);
        expect(rotated.rotation_reason).toBe('outcome_count');
        expect(rotated.previous_cycle?.outcomes_in_cycle).toBe(COHORT_CYCLE_MAX_OUTCOMES);
    });

    it('rotates early on confidence drop >= 0.10', async () => {
        await upsertRecommendationCohortCycle(observation({ median_confidence: 0.8 }));

        const rotated = await upsertRecommendationCohortCycle(observation({
            observed_at: '2026-04-01T06:00:00.000Z',
            median_confidence: 0.8 - COHORT_EARLY_CLOSE_CONFIDENCE_DROP,
            total_outcomes: 2,
        }));

        expect(rotated.rotation_triggered).toBe(true);
        expect(rotated.rotation_reason).toBe('confidence_drop');
    });

    it('rotates early on success-rate drop >= 0.15', async () => {
        await upsertRecommendationCohortCycle(observation({ median_success_rate: 0.9 }));

        const rotated = await upsertRecommendationCohortCycle(observation({
            observed_at: '2026-04-01T03:00:00.000Z',
            median_success_rate: 0.9 - COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP,
            total_outcomes: 3,
        }));

        expect(rotated.rotation_triggered).toBe(true);
        expect(rotated.rotation_reason).toBe('success_rate_drop');
    });

    it('keeps active cycle when no boundary is crossed', async () => {
        const first = await upsertRecommendationCohortCycle(observation());

        const second = await upsertRecommendationCohortCycle(observation({
            observed_at: '2026-04-03T00:00:00.000Z',
            total_outcomes: 20,
            median_confidence: 0.75,
            median_success_rate: 0.8,
        }));

        expect(second.rotation_triggered).toBe(false);
        expect(second.rotation_reason).toBeNull();
        expect(second.active_cycle.cycle_id).toBe(first.active_cycle.cycle_id);
        expect(second.active_cycle.closed_at).toBeNull();
        expect(second.active_cycle.close_reason).toBeNull();
    });

    it('uses Postgres RPC result when available', async () => {
        const rpcPayload = {
            active_cycle: {
                cycle_id: 'rpc-cycle',
                opened_at: '2026-04-01T00:00:00.000Z',
                closed_at: null,
                close_reason: null,
                elapsed_days: 0,
                outcomes_in_cycle: 0,
            },
            previous_cycle: null,
            rotation_triggered: false,
            rotation_reason: null,
            thresholds: {
                max_days: 7,
                max_outcomes: 100,
                confidence_drop: 0.1,
                success_rate_drop: 0.15,
            },
        };

        vi.mocked((supabase as any).rpc).mockResolvedValueOnce({
            data: rpcPayload,
            error: null,
        });

        const result = await upsertRecommendationCohortCycle(observation());

        expect(result.active_cycle.cycle_id).toBe('rpc-cycle');
        expect(result.thresholds.max_days).toBe(7);
        expect((supabase as any).rpc).toHaveBeenCalledWith(
            'upsert_recommendation_cohort_cycle',
            expect.objectContaining({
                p_customer_id: 'cust-1',
                p_task_name: 'incident_resolution',
            }),
        );
    });
});
