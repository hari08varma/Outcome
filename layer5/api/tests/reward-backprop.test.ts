import { expect, test, describe, vi } from 'vitest';
import { backpropagateReward } from '../lib/reward-backprop.js';
import { supabase } from '../lib/supabase.js';

vi.mock('../lib/supabase.js', () => {
    return {
        supabase: {
            from: vi.fn(),
        }
    };
});

describe('Reward Backpropagation (Temporal Difference Decay)', () => {

    test('Test 1: 6-step failure episode: earlier steps get identical bounded penalty', async () => {
        const episode_id = 'ep-fail-1';
        const mockSteps = [
            { outcome_id: 'o0', backprop_adjusted: false },
            { outcome_id: 'o1', backprop_adjusted: false },
            { outcome_id: 'o2', backprop_adjusted: false },
            { outcome_id: 'o3', backprop_adjusted: false },
            { outcome_id: 'o4', backprop_adjusted: false },
            { outcome_id: 'o5', backprop_adjusted: false }
        ];

        let updateCalls: any[] = [];

        (supabase.from as any).mockImplementation((table: string) => {
            return {
                select: vi.fn().mockReturnThis(),
                eq: (col: string, val: string) => {
                    if (col === 'session_id' && val === episode_id) {
                        return { order: vi.fn().mockResolvedValue({ data: mockSteps, error: null }) };
                    }
                    if (col === 'outcome_id') {
                        return { select: vi.fn().mockResolvedValue({ data: [{ id: val }] }) };
                    }
                    return { select: vi.fn().mockResolvedValue({ data: [] }) };
                },
                update: (payload: any) => {
                    updateCalls.push(payload);
                    return { eq: vi.fn().mockReturnThis(), select: vi.fn().mockResolvedValue({ data: [{ updated: true }] }) };
                }
            };
        });

        const res = await backpropagateReward({ episode_id, final_outcome: 0.0, gamma: 0.85 });

        expect(res.steps_adjusted).toBe(6);
        expect(updateCalls.length).toBe(6);
        // Using formula: 0.0 * gamma^(N) evaluates absolutely to 0.0 synchronously masking earlier steps identically.
        expect(updateCalls[0].outcome_score).toBe(0.0);
        expect(updateCalls[5].outcome_score).toBe(0.0);
        expect(updateCalls[0].backprop_adjusted).toBe(true);
    });

    test('Test 2: 6-step success episode: steps get proportional decayed credit', async () => {
        const episode_id = 'ep-success-1';
        const mockSteps = [
            { outcome_id: 'o0', backprop_adjusted: false },
            { outcome_id: 'o1', backprop_adjusted: false },
            { outcome_id: 'o2', backprop_adjusted: false },
            { outcome_id: 'o3', backprop_adjusted: false },
            { outcome_id: 'o4', backprop_adjusted: false },
            { outcome_id: 'o5', backprop_adjusted: false }
        ];

        let updateCalls: any[] = [];
        (supabase.from as any).mockImplementation((table: string) => {
            return {
                select: vi.fn().mockReturnThis(),
                eq: (col: string, val: string) => {
                    if (col === 'session_id' && val === episode_id) {
                        return { order: vi.fn().mockResolvedValue({ data: mockSteps, error: null }) };
                    }
                    return { select: vi.fn().mockResolvedValue({ data: [{ id: val }] }) };
                },
                update: (payload: any) => {
                    updateCalls.push(payload);
                    return { eq: vi.fn().mockReturnThis(), select: vi.fn().mockResolvedValue({ data: [{}] }) };
                }
            };
        });

        const res = await backpropagateReward({ episode_id, final_outcome: 1.0, gamma: 0.85 });

        expect(res.steps_adjusted).toBe(6);
        // Step 0: 1.0 * 0.85^5 = 0.4437
        expect(updateCalls[0].outcome_score).toBeCloseTo(0.4437, 4);
        // Step 5: 1.0 * 0.85^0 = 1.0
        expect(updateCalls[5].outcome_score).toBe(1.0);
    });

    test('Test 3: Idempotent: already-adjusted steps are not re-adjusted', async () => {
        const episode_id = 'ep-idem-1';
        const mockSteps = [
            { outcome_id: 'o0', backprop_adjusted: true },
            { outcome_id: 'o1', backprop_adjusted: true },
            { outcome_id: 'o2', backprop_adjusted: false },
        ];

        let updateCalls = 0;
        (supabase.from as any).mockImplementation((table: string) => {
            return {
                select: vi.fn().mockReturnThis(),
                eq: (col: string, val: string) => {
                    if (col === 'session_id' && val === episode_id) {
                        return { order: vi.fn().mockResolvedValue({ data: mockSteps, error: null }) };
                    }
                    return { select: vi.fn().mockResolvedValue({ data: [{}] }) };
                },
                update: () => {
                    updateCalls++;
                    return { eq: vi.fn().mockReturnThis(), select: vi.fn().mockResolvedValue({ data: [{}] }) };
                }
            };
        });

        const res = await backpropagateReward({ episode_id, final_outcome: 1.0, gamma: 0.85 });
        expect(res.steps_adjusted).toBe(1);
        expect(updateCalls).toBe(1);
    });

});
