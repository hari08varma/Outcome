import { describe, it, expect } from 'vitest';
import { CacheKeys } from '../src/cache-keys.js';

describe('CacheKeys', () => {
  const cust = 'cust_abc';
  const task = 'build_failed';
  const tool = 'github_push';
  const agent = 'agent_1';
  const upstream = 'github';

  it('score key is customer-namespaced', () => {
    const key = CacheKeys.score(cust, task);
    expect(key).toContain('cust_abc');
    expect(key).toContain('build_failed');
    expect(key).toMatch(/^li:score:/);
  });

  it('enrich key is customer + task + tool namespaced', () => {
    const key = CacheKeys.enrich(cust, task, tool);
    expect(key).toContain('cust_abc');
    expect(key).toContain('build_failed');
    expect(key).toContain('github_push');
    expect(key).toMatch(/^li:enrich:/);
  });

  it('upstreamTools key contains upstream name', () => {
    const key = CacheKeys.upstreamTools(upstream);
    expect(key).toContain('github');
    expect(key).toMatch(/^li:upstream:tools:/);
  });

  it('mode key is customer + task namespaced', () => {
    const key = CacheKeys.mode(cust, task);
    expect(key).toContain('cust_abc');
    expect(key).toContain('build_failed');
    expect(key).toMatch(/^li:mode:/);
  });

  it('trust key is customer + agent namespaced', () => {
    const key = CacheKeys.trust(cust, agent);
    expect(key).toContain('cust_abc');
    expect(key).toContain('agent_1');
    expect(key).toMatch(/^li:trust:/);
  });

  it('episode key is customer + agent namespaced', () => {
    const key = CacheKeys.episode(cust, agent);
    expect(key).toContain('cust_abc');
    expect(key).toContain('agent_1');
    expect(key).toMatch(/^li:episode:/);
  });

  it('shadow key is customer + task namespaced', () => {
    const key = CacheKeys.shadow(cust, task);
    expect(key).toContain('cust_abc');
    expect(key).toContain('build_failed');
    expect(key).toMatch(/^li:shadow:/);
  });

  it('globalPriors key contains task only', () => {
    const key = CacheKeys.globalPriors(task);
    expect(key).toContain('build_failed');
    expect(key).toMatch(/^li:global:priors:/);
  });

  it('rateLimit key is customer-namespaced', () => {
    const key = CacheKeys.rateLimit(cust);
    expect(key).toContain('cust_abc');
    expect(key).toMatch(/^li:ratelimit:/);
  });

  it('all keys use li: prefix', () => {
    const keys = [
      CacheKeys.score('c', 't'),
      CacheKeys.enrich('c', 't', 'to'),
      CacheKeys.upstreamTools('u'),
      CacheKeys.mode('c', 't'),
      CacheKeys.trust('c', 'a'),
      CacheKeys.episode('c', 'a'),
      CacheKeys.shadow('c', 't'),
      CacheKeys.globalPriors('t'),
      CacheKeys.rateLimit('c'),
    ];
    for (const key of keys) {
      expect(key.startsWith('li:')).toBe(true);
    }
  });

  it('different customers produce different keys', () => {
    const key1 = CacheKeys.score('cust_a', 'task');
    const key2 = CacheKeys.score('cust_b', 'task');
    expect(key1).not.toBe(key2);
  });
});
