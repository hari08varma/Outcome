import { describe, it, expect } from 'vitest';
import { Errors } from '../src/gateway-errors.js';

describe('Errors', () => {
  describe('upstreamUnreachable', () => {
    it('returns standard MCP error format', () => {
      const err = Errors.upstreamUnreachable('github');
      expect(err.isError).toBe(true);
      expect(err.content).toHaveLength(1);
      expect(err.content[0].type).toBe('text');
      expect(err.content[0].text).toContain('github');
      expect(err.content[0].text).toContain('unreachable');
    });
  });

  describe('noRecommendations', () => {
    it('includes task name in message', () => {
      const err = Errors.noRecommendations('build_failed');
      expect(err.isError).toBe(true);
      expect(err.content[0].text).toContain('build_failed');
    });
  });

  describe('webhookInvalidSignature', () => {
    it('returns generic signature error', () => {
      const err = Errors.webhookInvalidSignature();
      expect(err.isError).toBe(true);
      expect(err.content[0].text).toContain('signature verification failed');
    });
  });

  describe('webhookDecisionNotFound', () => {
    it('includes decision ID in message', () => {
      const err = Errors.webhookDecisionNotFound('dec_abc123');
      expect(err.isError).toBe(true);
      expect(err.content[0].text).toContain('dec_abc123');
      expect(err.content[0].text).toContain('not found');
    });
  });

  it('all error types conform to GatewayError interface', () => {
    const errors = [
      Errors.upstreamUnreachable('test'),
      Errors.noRecommendations('test'),
      Errors.webhookInvalidSignature(),
      Errors.webhookDecisionNotFound('dec_x'),
    ];
    for (const err of errors) {
      expect(err.isError).toBe(true);
      expect(Array.isArray(err.content)).toBe(true);
      expect(err.content.length).toBeGreaterThan(0);
      for (const item of err.content) {
        expect(item.type).toBe('text');
        expect(typeof item.text).toBe('string');
        expect(item.text.length).toBeGreaterThan(0);
      }
    }
  });
});
