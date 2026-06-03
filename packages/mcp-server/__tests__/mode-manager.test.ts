import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ModeManager } from '../src/mode-manager.js';
import type { GatewayConfig, LIMode } from '../src/config.js';

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiKey: 'test-key', baseUrl: 'https://test.example.com',
    mode: 'recommend' as LIMode | null, upstreamServers: [],
    modeOverrides: new Map(), shadowMode: false,
    environment: 'production', adminKey: null,
    logLevel: 'info', classifier: null, ...overrides,
  };
}

describe('ModeManager', () => {
  let manager: ModeManager;

  describe('resolveMode', () => {
    it('returns bootstrap when global mode is null', () => {
      manager = new ModeManager(makeConfig({ mode: null }));
      expect(manager.resolveMode('build_failed')).toBe('bootstrap');
    });

    it('returns global mode when no override exists', () => {
      manager = new ModeManager(makeConfig({ mode: 'recommend' }));
      expect(manager.resolveMode('build_failed')).toBe('recommend');
    });

    it('returns override for per-task-type override', () => {
      const overrides = new Map<string, LIMode>([['build_failed', 'auto']]);
      manager = new ModeManager(makeConfig({ mode: 'recommend', modeOverrides: overrides }));
      expect(manager.resolveMode('build_failed')).toBe('auto');
    });

    it('falls back to global mode for non-overridden task', () => {
      const overrides = new Map<string, LIMode>([['build_failed', 'auto']]);
      manager = new ModeManager(makeConfig({ mode: 'assist', modeOverrides: overrides }));
      expect(manager.resolveMode('ci_timeout')).toBe('assist');
    });

    it('caches resolved modes', () => {
      manager = new ModeManager(makeConfig({ mode: 'recommend' }));
      expect(manager.resolveMode('build_failed')).toBe('recommend');
      expect(manager.resolveMode('build_failed')).toBe('recommend');
    });

    it('caches different tasks independently', () => {
      const overrides = new Map([['build_failed', 'auto' as LIMode]]);
      manager = new ModeManager(makeConfig({ mode: 'recommend', modeOverrides: overrides }));
      expect(manager.resolveMode('build_failed')).toBe('auto');
      expect(manager.resolveMode('ci_timeout')).toBe('recommend');
    });
  });

  describe('getGlobalMode', () => {
    it('returns bootstrap when mode is null', () => {
      manager = new ModeManager(makeConfig({ mode: null }));
      expect(manager.getGlobalMode()).toBe('bootstrap');
    });

    it('returns the set mode', () => {
      manager = new ModeManager(makeConfig({ mode: 'auto' }));
      expect(manager.getGlobalMode()).toBe('auto');
    });
  });

  describe('clearCache', () => {
    it('clears the cache', () => {
      manager = new ModeManager(makeConfig({ mode: 'recommend' }));
      manager.resolveMode('build_failed');
      manager.clearCache();
      // Should not throw; re-resolution works
      expect(manager.resolveMode('build_failed')).toBe('recommend');
    });
  });

  describe('cache expiry', () => {
    it('re-resolves after TTL expires', () => {
      vi.useFakeTimers();
      manager = new ModeManager(makeConfig({ mode: 'recommend' }));
      manager.resolveMode('build_failed');
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(manager.resolveMode('build_failed')).toBe('recommend');
      vi.useRealTimers();
    });
  });
});
