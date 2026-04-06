import { describe, expect, it } from 'vitest';

import { inferSemanticActionCluster } from '../../api/lib/recommendation/semantic-action-cluster.js';

describe('semantic action clustering', () => {
    it('clusters payment refund action with high confidence', () => {
        const cluster = inferSemanticActionCluster({
            actionName: 'issue_refund',
            issueType: 'payment_failed',
            taskName: 'refund_processing',
        });

        expect(cluster.clusterKey).toContain('payments');
        expect(cluster.intent).toBe('refund');
        expect(cluster.confidence).toBeGreaterThanOrEqual(0.7);
        expect(cluster.matchedTokens.length).toBeGreaterThan(0);
    });

    it('falls back safely for unknown action names', () => {
        const cluster = inferSemanticActionCluster({
            actionName: 'do_the_thing',
            issueType: 'mystery_issue',
            taskName: 'unknown_task',
        });

        expect(cluster.clusterKey.length).toBeGreaterThan(0);
        expect(cluster.confidence).toBeGreaterThan(0);
        expect(cluster.confidence).toBeLessThanOrEqual(1);
    });
});