import { describe, it, expect } from 'vitest';
import { classifyWithRules } from '../src/outcome-classifier.js';

function makeResult(text: string, isError = false) {
  return {
    content: [{ type: 'text', text }] as Array<{ type: string; [key: string]: unknown }>,
    isError,
  };
}

describe('classifyWithRules', () => {
  const toolName = 'github_push_fix';

  it('classifies error result as failed', () => {
    const result = makeResult('Push failed: permission denied');
    const classification = classifyWithRules(toolName, {}, result, true, 'build_failed');
    expect(classification.success).toBe(false);
    expect(classification.business_outcome).toBe('failed');
    expect(classification.confidence).toBe(0.5);
  });

  it('classifies isError flag as failed', () => {
    const result = makeResult('Something went wrong', true);
    const classification = classifyWithRules(toolName, {}, result, false, 'build_failed');
    expect(classification.success).toBe(false);
    expect(classification.business_outcome).toBe('failed');
  });

  it('detects error keywords in result text', () => {
    const result = makeResult('Operation failed with timeout error');
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.success).toBe(false);
    expect(classification.business_outcome).toBe('failed');
  });

  it('detects "not found" as error keyword', () => {
    const result = makeResult('Resource not found');
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.success).toBe(false);
  });

  it('classifies empty result as unknown', () => {
    const result = makeResult('');
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.success).toBe(true);
    expect(classification.business_outcome).toBe('unknown');
  });

  it('classifies whitespace-only result as unknown', () => {
    const result = makeResult('   \n  ');
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.business_outcome).toBe('unknown');
  });

  it('classifies successful result as resolved', () => {
    const result = makeResult('Successfully pushed commit abc123 to main branch');
    const classification = classifyWithRules(toolName, {}, result, false, 'build_failed');
    expect(classification.success).toBe(true);
    expect(classification.business_outcome).toBe('resolved');
  });

  it('uses agent task type when valid', () => {
    const result = makeResult('Success');
    const classification = classifyWithRules(toolName, {}, result, false, 'payment_failed');
    expect(classification.task_type).toBe('payment_failed');
  });

  it('falls back to unspecified_issue when agent task type is unknown', () => {
    const result = makeResult('Success');
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.task_type).toBe('unspecified_issue');
  });

  it('falls back to unspecified_issue for empty task type', () => {
    const result = makeResult('Success');
    const classification = classifyWithRules(toolName, {}, result, false, '');
    expect(classification.task_type).toBe('unspecified_issue');
  });

  it('truncates error message to 500 chars', () => {
    const longText = 'x'.repeat(600);
    const result = makeResult(longText);
    const classification = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(classification.result_summary.length).toBeLessThanOrEqual(500);
  });

  it('confidence is always 0.5 for rule-based classification', () => {
    const result = makeResult('Success');
    const c = classifyWithRules(toolName, {}, result, false, 'build_failed');
    expect(c.confidence).toBe(0.5);

    const errResult = makeResult('Error', true);
    const c2 = classifyWithRules(toolName, {}, errResult, false, 'build_failed');
    expect(c2.confidence).toBe(0.5);
  });

  it('detects "unauthorized" as error', () => {
    const result = makeResult('Request unauthorized');
    const c = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(c.success).toBe(false);
  });

  it('detects "forbidden" as error', () => {
    const result = makeResult('Access forbidden');
    const c = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(c.success).toBe(false);
  });

  it('detects "panic" as error', () => {
    const result = makeResult('Kernel panic');
    const c = classifyWithRules(toolName, {}, result, false, 'unknown');
    expect(c.success).toBe(false);
  });
});
