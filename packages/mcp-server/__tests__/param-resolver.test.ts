/**
 * Tests for param-resolver.ts — Three-Layer Parameter Resolution
 */
import { describe, it, expect } from 'vitest';
import { resolveParams, type ActionParamSchema } from '../src/param-resolver.js';

describe('resolveParams', () => {
  // ── Null / empty schema ───────────────────────────────────
  it('returns all original params when schema is null', () => {
    const result = resolveParams({ a: 1, b: 'two' }, null);
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toEqual({ a: 1, b: 'two' });
    expect(Object.keys(result.needed)).toHaveLength(0);
  });

  it('returns all original params when schema is empty', () => {
    const result = resolveParams({ x: 'val' }, {});
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toEqual({ x: 'val' });
  });

  // ── Layer 1: Shared params carry over ─────────────────────
  it('Layer 1: carries over matching param names', () => {
    const schema: ActionParamSchema = {
      transaction_id: { type: 'string', required: true },
      amount: { type: 'number', required: true },
    };
    const result = resolveParams({ transaction_id: 'tx-123', amount: 50 }, schema);
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toEqual({ transaction_id: 'tx-123', amount: 50 });
  });

  // ── Layer 2: Defaults fill gaps ───────────────────────────
  it('Layer 2: fills from defaults when original param missing', () => {
    const schema: ActionParamSchema = {
      transaction_id: { type: 'string', required: true },
      provider_name: { type: 'string', required: true, default: 'stripe' },
    };
    const result = resolveParams({ transaction_id: 'tx-123' }, schema);
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toEqual({ transaction_id: 'tx-123', provider_name: 'stripe' });
  });

  // ── Layer 3: Missing required params → agent must fill ────
  it('Layer 3: marks unresolvable required params as needed', () => {
    const schema: ActionParamSchema = {
      transaction_id: { type: 'string', required: true },
      fallback_config: { type: 'object', required: true },
    };
    const result = resolveParams({ transaction_id: 'tx-123' }, schema);
    expect(result.fullyResolved).toBe(false);
    expect(result.resolved).toEqual({ transaction_id: 'tx-123' });
    expect(result.needed).toHaveProperty('fallback_config');
  });

  // ── Optional params don't block resolution ────────────────
  it('optional params with no match are not marked as needed', () => {
    const schema: ActionParamSchema = {
      transaction_id: { type: 'string', required: true },
      metadata: { type: 'object', required: false },
    };
    const result = resolveParams({ transaction_id: 'tx-123' }, schema);
    expect(result.fullyResolved).toBe(true);
    expect(result.resolved).toEqual({ transaction_id: 'tx-123' });
    expect(Object.keys(result.needed)).toHaveLength(0);
  });

  // ── Full 3-layer scenario ─────────────────────────────────
  it('all three layers in one redirect scenario', () => {
    // retry_payment → switch_provider
    const originalParams = {
      transaction_id: 'tx-999',
      amount: 100,
      retry_count: 3, // not needed by target
    };

    const targetSchema: ActionParamSchema = {
      transaction_id: { type: 'string', required: true },  // Layer 1: match
      amount: { type: 'number', required: true },           // Layer 1: match
      provider_name: { type: 'string', required: true, default: 'stripe_backup' }, // Layer 2: default
      fallback_config: { type: 'object', required: true },  // Layer 3: agent must fill
    };

    const result = resolveParams(originalParams, targetSchema);
    expect(result.fullyResolved).toBe(false);
    expect(result.resolved).toEqual({
      transaction_id: 'tx-999',
      amount: 100,
      provider_name: 'stripe_backup',
    });
    expect(result.needed).toHaveProperty('fallback_config');
    expect(Object.keys(result.needed)).toHaveLength(1);
  });
});
