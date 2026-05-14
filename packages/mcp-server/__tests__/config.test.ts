/**
 * Tests for config.ts — Environment validation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules so loadConfig re-reads env
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    const mod = await import('../src/config.js');
    return mod.loadConfig();
  }

  // ── Required: API key ─────────────────────────────────────
  it('throws when LAYERINFINITE_API_KEY is missing', async () => {
    delete process.env.LAYERINFINITE_API_KEY;
    await expect(loadConfig()).rejects.toThrow('LAYERINFINITE_API_KEY is required');
  });

  it('throws when LAYERINFINITE_API_KEY is empty', async () => {
    process.env.LAYERINFINITE_API_KEY = '   ';
    await expect(loadConfig()).rejects.toThrow('LAYERINFINITE_API_KEY is required');
  });

  // ── Valid configuration ───────────────────────────────────
  it('returns valid config with all defaults', async () => {
    process.env.LAYERINFINITE_API_KEY = 'test-key-123';
    const config = await loadConfig();

    expect(config.apiKey).toBe('test-key-123');
    expect(config.baseUrl).toBe('https://layerinfinite.me');
    expect(config.mode).toBeNull();
    expect(config.adminKey).toBeNull();
  });

  it('respects custom base URL and strips trailing slashes', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_BASE_URL = 'https://api.example.com///';
    const config = await loadConfig();

    expect(config.baseUrl).toBe('https://api.example.com');
  });

  // ── Mode validation ───────────────────────────────────────
  it.each(['recommend', 'assist', 'auto'])('accepts valid mode: %s', async (mode) => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_MODE = mode;
    const config = await loadConfig();

    expect(config.mode).toBe(mode);
  });

  it('throws on invalid mode', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_MODE = 'turbo';
    await expect(loadConfig()).rejects.toThrow('Invalid LAYERINFINITE_MODE="turbo"');
  });

  it('mode is case-insensitive', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_MODE = 'ASSIST';
    const config = await loadConfig();

    expect(config.mode).toBe('assist');
  });

  it('empty mode defaults to bootstrap (null)', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_MODE = '';
    const config = await loadConfig();

    expect(config.mode).toBeNull();
  });

  // ── Admin key ─────────────────────────────────────────────
  it('reads admin key', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    process.env.LAYERINFINITE_ADMIN_KEY = 'admin-secret';
    const config = await loadConfig();

    expect(config.adminKey).toBe('admin-secret');
  });

  // ── Config is frozen ──────────────────────────────────────
  it('returns a frozen config object', async () => {
    process.env.LAYERINFINITE_API_KEY = 'key';
    const config = await loadConfig();

    expect(Object.isFrozen(config)).toBe(true);
  });
});
