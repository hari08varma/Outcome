import { describe, it, expect } from 'vitest';
import { formatAutoEnrichment } from '../../src/enrichment/format-auto.js';

describe('formatAutoEnrichment', () => {
  it('returns original description unchanged', () => {
    const desc = 'Some original tool description.';
    expect(formatAutoEnrichment(desc)).toBe(desc);
  });

  it('returns empty string unchanged', () => {
    expect(formatAutoEnrichment('')).toBe('');
  });

  it('returns multi-line description unchanged', () => {
    const desc = 'Line 1\nLine 2\nLine 3';
    expect(formatAutoEnrichment(desc)).toBe(desc);
  });
});
