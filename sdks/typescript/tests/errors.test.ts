import { describe, expect, it } from 'vitest';
import {
  Layer5Error,
  Layer5AuthError,
  Layer5RateLimitError,
  Layer5ValidationError,
  Layer5NetworkError,
  Layer5TimeoutError,
  Layer5ServerError,
  Layer5UnknownActionError,
  Layer5AgentSuspendedError,
} from '../src/errors.js';

describe('Layer5Error hierarchy', () => {
  it('Layer5Error is instanceof Error', () => {
    const err = new Layer5Error('base');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err.name).toBe('Layer5Error');
    expect(err.message).toBe('base');
  });

  it('Layer5AuthError defaults message', () => {
    const err = new Layer5AuthError();
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5AuthError);
    expect(err.name).toBe('Layer5AuthError');
    expect(err.message).toContain('API key');
  });

  it('Layer5AuthError accepts custom message', () => {
    const err = new Layer5AuthError('custom');
    expect(err.message).toBe('custom');
  });

  it('Layer5RateLimitError stores retryAfter', () => {
    const err = new Layer5RateLimitError(30);
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5RateLimitError);
    expect(err.retryAfter).toBe(30);
    expect(err.message).toContain('30');
    expect(err.name).toBe('Layer5RateLimitError');
  });

  it('Layer5RateLimitError defaults retryAfter to 60', () => {
    const err = new Layer5RateLimitError();
    expect(err.retryAfter).toBe(60);
  });

  it('Layer5ValidationError stores field', () => {
    const err = new Layer5ValidationError('bad value', 'agent_id');
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5ValidationError);
    expect(err.field).toBe('agent_id');
    expect(err.message).toContain('[agent_id]');
    expect(err.name).toBe('Layer5ValidationError');
  });

  it('Layer5ValidationError without field', () => {
    const err = new Layer5ValidationError('bad');
    expect(err.field).toBeUndefined();
    expect(err.message).toContain('bad');
  });

  it('Layer5NetworkError stores original', () => {
    const original = new Error('DNS failed');
    const err = new Layer5NetworkError('DNS failed', original);
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5NetworkError);
    expect(err.original).toBe(original);
    expect(err.name).toBe('Layer5NetworkError');
  });

  it('Layer5TimeoutError extends Layer5NetworkError', () => {
    const err = new Layer5TimeoutError('timed out');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5NetworkError);
    expect(err).toBeInstanceOf(Layer5TimeoutError);
    expect(err.name).toBe('Layer5TimeoutError');
  });

  it('Layer5ServerError stores statusCode and requestId', () => {
    const err = new Layer5ServerError(503, 'req-42');
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5ServerError);
    expect(err.statusCode).toBe(503);
    expect(err.requestId).toBe('req-42');
    expect(err.name).toBe('Layer5ServerError');
  });

  it('Layer5UnknownActionError stores actionName', () => {
    const err = new Layer5UnknownActionError('bad_action');
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5UnknownActionError);
    expect(err.actionName).toBe('bad_action');
    expect(err.message).toContain('bad_action');
  });

  it('Layer5AgentSuspendedError stores agentId', () => {
    const err = new Layer5AgentSuspendedError('agent-99');
    expect(err).toBeInstanceOf(Layer5Error);
    expect(err).toBeInstanceOf(Layer5AgentSuspendedError);
    expect(err.agentId).toBe('agent-99');
    expect(err.message).toContain('agent-99');
  });

  it('instanceof works correctly across all classes (Object.setPrototypeOf)', () => {
    // This is the key test — without Object.setPrototypeOf,
    // instanceof can fail in transpiled code
    const errors = [
      new Layer5Error('e'),
      new Layer5AuthError(),
      new Layer5RateLimitError(),
      new Layer5ValidationError('v'),
      new Layer5NetworkError('n'),
      new Layer5TimeoutError('t'),
      new Layer5ServerError(500),
      new Layer5UnknownActionError('a'),
      new Layer5AgentSuspendedError('x'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(Layer5Error);
    }
  });
});
