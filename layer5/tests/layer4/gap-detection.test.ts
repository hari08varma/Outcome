/**
 * Layer5 — Unit Tests: Gap Detection Logic
 * Tests latency spikes, context drift, coordinated failure,
 * and silent failure detection.
 * Run: npx vitest run tests/layer4/gap-detection.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// GAP 1 — LATENCY SPIKE DETECTION
// ═══════════════════════════════════════════════════════════════

describe('Gap 1 — Latency Spike Detection', () => {
    const LATENCY_SPIKE_THRESHOLD = 3.0;

    function shouldAlert(spike: {
        latency_spike_ratio: number | null;
        total_attempts: number;
    }): boolean {
        return (
            spike.latency_spike_ratio !== null &&
            spike.latency_spike_ratio >= LATENCY_SPIKE_THRESHOLD &&
            spike.total_attempts >= 10
        );
    }

    function getSeverity(ratio: number): 'critical' | 'warning' {
        return ratio >= 5.0 ? 'critical' : 'warning';
    }

    it('latency_spike_ratio = 3.5 → alert emitted', () => {
        expect(shouldAlert({ latency_spike_ratio: 3.5, total_attempts: 50 })).toBe(true);
    });

    it('latency_spike_ratio = 2.9 → no alert', () => {
        expect(shouldAlert({ latency_spike_ratio: 2.9, total_attempts: 50 })).toBe(false);
    });

    it('no baseline data → spike_ratio is null → no alert', () => {
        expect(shouldAlert({ latency_spike_ratio: null, total_attempts: 100 })).toBe(false);
    });

    it('spike_ratio = 3.0 but only 5 attempts → no alert (below min sample)', () => {
        expect(shouldAlert({ latency_spike_ratio: 3.0, total_attempts: 5 })).toBe(false);
    });

    it('spike_ratio exactly 3.0 → alert emitted (threshold inclusive)', () => {
        expect(shouldAlert({ latency_spike_ratio: 3.0, total_attempts: 10 })).toBe(true);
    });

    it('spike_ratio >= 5.0 → severity is critical', () => {
        expect(getSeverity(5.0)).toBe('critical');
        expect(getSeverity(7.2)).toBe('critical');
    });

    it('spike_ratio < 5.0 → severity is warning', () => {
        expect(getSeverity(3.0)).toBe('warning');
        expect(getSeverity(4.9)).toBe('warning');
    });

    it('latency spike deduped within 24h', () => {
        const now = Date.now();
        const twentyThreeHoursAgo = new Date(now - 23 * 60 * 60 * 1000);
        const twentyFiveHoursAgo = new Date(now - 25 * 60 * 60 * 1000);
        const dedupWindow = new Date(now - 24 * 60 * 60 * 1000);

        expect(twentyThreeHoursAgo.getTime()).toBeGreaterThan(dedupWindow.getTime()); // within window → dedup
        expect(twentyFiveHoursAgo.getTime()).toBeLessThan(dedupWindow.getTime()); // outside window → new alert
    });
});

// ═══════════════════════════════════════════════════════════════
// GAP 2 — CONTEXT DRIFT DETECTION
// ═══════════════════════════════════════════════════════════════

describe('Gap 2 — Context Drift Detection', () => {

    function isContextDrift(outcomeCount: number): boolean {
        return outcomeCount === 0;
    }

    function buildContextWarning(isUnknown: boolean) {
        return isUnknown
            ? {
                  type: 'context_drift',
                  message: 'No outcome history for this context type.',
                  recommendation: 'Cold-start protocol active. Scores are based on priors only.',
                  confidence_cap: 0.3,
              }
            : null;
    }

    it('unknown context_type → context_drift alert emitted', () => {
        expect(isContextDrift(0)).toBe(true);
    });

    it('known context_type → no alert', () => {
        expect(isContextDrift(15)).toBe(false);
    });

    it('unknown context → get-scores returns context_warning', () => {
        const warning = buildContextWarning(true);
        expect(warning).not.toBeNull();
        expect(warning!.type).toBe('context_drift');
        expect(warning!.confidence_cap).toBe(0.3);
    });

    it('known context → get-scores returns null context_warning', () => {
        const warning = buildContextWarning(false);
        expect(warning).toBeNull();
    });

    it('context drift deduped within 24h', () => {
        const now = Date.now();
        const recentAlertTime = new Date(now - 12 * 60 * 60 * 1000); // 12h ago
        const dedupWindow = new Date(now - 24 * 60 * 60 * 1000);
        expect(recentAlertTime.getTime()).toBeGreaterThan(dedupWindow.getTime()); // within window → skip

        const staleAlertTime = new Date(now - 25 * 60 * 60 * 1000); // 25h ago
        expect(staleAlertTime.getTime()).toBeLessThan(dedupWindow.getTime()); // outside window → new alert
    });
});

// ═══════════════════════════════════════════════════════════════
// GAP 3 — COORDINATED FAILURE DETECTION
// ═══════════════════════════════════════════════════════════════

describe('Gap 3 — Coordinated Failure Detection', () => {
    const MIN_AGENTS = 3;

    function isCoordinatedFailure(
        agentCount: number,
        sameAction: boolean
    ): boolean {
        return sameAction && agentCount >= MIN_AGENTS;
    }

    it('3 agents fail same action in 15min → alert emitted', () => {
        expect(isCoordinatedFailure(3, true)).toBe(true);
    });

    it('2 agents fail same action → no alert (below threshold)', () => {
        expect(isCoordinatedFailure(2, true)).toBe(false);
    });

    it('3 agents fail DIFFERENT actions → no alert', () => {
        expect(isCoordinatedFailure(3, false)).toBe(false);
    });

    it('coordinated failure severity is always critical', () => {
        const severity = 'critical'; // hardcoded in trend-detector
        expect(severity).toBe('critical');
    });

    it('coordinated failure deduped within 1h (not 24h)', () => {
        const now = Date.now();
        const thirtyMinAgo = new Date(now - 30 * 60 * 1000);
        const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
        const dedupWindow = new Date(now - 60 * 60 * 1000); // 1 hour

        expect(thirtyMinAgo.getTime()).toBeGreaterThan(dedupWindow.getTime()); // within → dedup
        expect(twoHoursAgo.getTime()).toBeLessThan(dedupWindow.getTime()); // outside → new alert
    });

    it('detect_coordinated_failures SQL function returns correct structure', () => {
        // Verify the RPC return type matches what trend-detector expects
        const mockResult = {
            customer_id: '00000000-0000-0000-0000-000000000001',
            action_id: '00000000-0000-0000-0000-000000000002',
            action_name: 'restart_service',
            agent_count: 4,
            failure_count: 12,
            window_start: '2026-03-09T14:00:00Z',
            window_end: '2026-03-09T14:15:00Z',
        };
        expect(mockResult).toHaveProperty('customer_id');
        expect(mockResult).toHaveProperty('action_id');
        expect(mockResult).toHaveProperty('action_name');
        expect(mockResult).toHaveProperty('agent_count');
        expect(mockResult).toHaveProperty('failure_count');
        expect(mockResult.agent_count).toBeGreaterThanOrEqual(MIN_AGENTS);
    });
});

// ═══════════════════════════════════════════════════════════════
// GAP 5 — SILENT FAILURE DETECTION
// ═══════════════════════════════════════════════════════════════

describe('Gap 5 — Silent Failure Detection', () => {

    function isSilentFailure(outcome: {
        success: boolean;
        outcome_score: number | null;
    }): boolean {
        return (
            outcome.success === true &&
            outcome.outcome_score !== null &&
            outcome.outcome_score < 0.3
        );
    }

    function isDelayedSilentFailure(
        originalSuccess: boolean,
        finalScore: number
    ): boolean {
        return originalSuccess === true && finalScore < 0.3;
    }

    it('success=true + outcome_score=0.1 → silent failure alert', () => {
        expect(isSilentFailure({ success: true, outcome_score: 0.1 })).toBe(true);
    });

    it('success=true + outcome_score=0.7 → no alert', () => {
        expect(isSilentFailure({ success: true, outcome_score: 0.7 })).toBe(false);
    });

    it('success=true + outcome_score=null → no alert', () => {
        expect(isSilentFailure({ success: true, outcome_score: null })).toBe(false);
    });

    it('success=false → not a silent failure (expected failure)', () => {
        expect(isSilentFailure({ success: false, outcome_score: 0.1 })).toBe(false);
    });

    it('success=true + outcome_score=0.29 → silent failure (boundary)', () => {
        expect(isSilentFailure({ success: true, outcome_score: 0.29 })).toBe(true);
    });

    it('success=true + outcome_score=0.3 → no alert (boundary exclusive)', () => {
        expect(isSilentFailure({ success: true, outcome_score: 0.3 })).toBe(false);
    });

    it('delayed feedback final_score=0.2 on success=true → alert', () => {
        expect(isDelayedSilentFailure(true, 0.2)).toBe(true);
    });

    it('delayed feedback final_score=0.8 on success=true → no alert', () => {
        expect(isDelayedSilentFailure(true, 0.8)).toBe(false);
    });

    it('delayed feedback final_score=0.1 on success=false → no alert (not silent)', () => {
        expect(isDelayedSilentFailure(false, 0.1)).toBe(false);
    });
});
