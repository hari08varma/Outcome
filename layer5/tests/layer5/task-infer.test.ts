import { describe, expect, it } from 'vitest';
import {
    inferTask,
    isGenericTaskName,
    TASK_MAPPING_CONFIDENCE,
    validateTaskName,
} from '../../api/lib/recommendation/task-infer.js';

describe('Task inference', () => {
    it('maps exact known issue_type with exact_match confidence', () => {
        const result = inferTask('billing_dispute');

        expect(result.task).toBe('payment_failed');
        expect(result.tier).toBe('exact_match');
        expect(result.confidence).toBe(TASK_MAPPING_CONFIDENCE.exact_match);
    });

    it('normalizes numeric-leading labels to valid task names', () => {
        const task = validateTaskName('500 Timeout');
        expect(task).toBe('task_500_timeout');
    });

    it('converts generic placeholder issue types to unspecified_issue', () => {
        const result = inferTask('unknown_task');

        expect(result.task).toBe('unspecified_issue');
        expect(result.tier).toBe('slugified_fallback');
        expect(result.confidence).toBe(TASK_MAPPING_CONFIDENCE.slugified_fallback);
    });

    it('uses deterministic fallback task names for non-empty unparseable labels', () => {
        const result = inferTask('🚨🚨🚨');

        expect(result.task).toMatch(/^task_[a-z0-9]+$/);
        expect(result.task).not.toBe('unknown_task');
        expect(result.tier).toBe('slugified_fallback');
    });

    it('keeps unknown tier only for truly blank issue_type', () => {
        const result = inferTask('   ');

        expect(result.task).toBe('unknown_task');
        expect(result.tier).toBe('unknown');
        expect(result.confidence).toBe(TASK_MAPPING_CONFIDENCE.unknown);
    });

    it('identifies generic task names', () => {
        expect(isGenericTaskName('unknown_task')).toBe(true);
        expect(isGenericTaskName('unspecified_issue')).toBe(true);
        expect(isGenericTaskName('payment_failed')).toBe(false);
    });
});
