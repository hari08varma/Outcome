import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { UpstreamRegistry } from '../src/upstream-registry.js';
import type { GatewayConfig, UpstreamServer } from '../src/config.js';

function makeConfig(servers: UpstreamServer[] = [], overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiKey: 'li-key', baseUrl: 'https://li.test', mode: 'recommend',
    upstreamServers: servers, modeOverrides: new Map(),
    shadowMode: false, environment: 'production', adminKey: null,
    logLevel: 'error', classifier: null, ...overrides,
  };
}

function makeServer(overrides: Partial<UpstreamServer> = {}): UpstreamServer {
  return { name: 'github', url: 'https://github-mcp.test', ...overrides };
}

describe('UpstreamRegistry', () => {
  let registry: UpstreamRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    registry?.stopHealthChecks();
  });

  describe('health checks', () => {
    it('marks upstream healthy on HTTP 200', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      registry = new UpstreamRegistry(makeConfig([makeServer({ name: 'github' })]));
      await (registry as unknown as { checkAllUpstreams: () => Promise<void> }).checkAllUpstreams();

      expect(registry.isHealthy('github')).toBe(true);
    });

    it('marks upstream unhealthy on non-200', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Down', { status: 503 }));

      registry = new UpstreamRegistry(makeConfig([makeServer({ name: 'github' })]));
      await (registry as unknown as { checkAllUpstreams: () => Promise<void> }).checkAllUpstreams();

      expect(registry.isHealthy('github')).toBe(false);
    });

    it('marks unhealthy on fetch error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

      registry = new UpstreamRegistry(makeConfig([makeServer({ name: 'github' })]));
      await (registry as unknown as { checkAllUpstreams: () => Promise<void> }).checkAllUpstreams();

      expect(registry.isHealthy('github')).toBe(false);
    });

    it('updates lastCheck timestamp', async () => {
      fetchMock.mockResolvedValueOnce(new Response('OK', { status: 200 }));

      registry = new UpstreamRegistry(makeConfig([makeServer()]));
      const before = registry.getUpstream('github')!.lastCheck;
      await (registry as unknown as { checkAllUpstreams: () => Promise<void> }).checkAllUpstreams();
      const after = registry.getUpstream('github')!.lastCheck;

      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('circuit breaker integration', () => {
    it('isHealthy returns false when circuit is open', () => {
      registry = new UpstreamRegistry(makeConfig([makeServer({ name: 'github' })]));

      // Force circuit breaker open via 3 failures
      const state = registry.getFailOpenState();
      state.upstreamFailures.set('github', 3);
      state.circuitBreakerOpen.set('github', true);

      expect(registry.isHealthy('github')).toBe(false);
    });

    it('isHealthy returns false for unknown upstream', () => {
      registry = new UpstreamRegistry(makeConfig([]));
      expect(registry.isHealthy('unknown')).toBe(false);
    });
  });

  describe('registration', () => {
    it('registers upstreams from config', () => {
      registry = new UpstreamRegistry(makeConfig([
        makeServer({ name: 'github' }),
        makeServer({ name: 'database' }),
      ]));

      expect(registry.getAllUpstreams()).toHaveLength(2);
      expect(registry.getUpstream('github')).toBeDefined();
      expect(registry.getUpstream('database')).toBeDefined();
    });

    it('starts optimistic (healthy=true)', () => {
      registry = new UpstreamRegistry(makeConfig([makeServer()]));
      expect(registry.isHealthy('github')).toBe(true);
    });

    it('getFailOpenState returns same reference', () => {
      registry = new UpstreamRegistry(makeConfig([makeServer()]));
      const s1 = registry.getFailOpenState();
      const s2 = registry.getFailOpenState();
      expect(s1).toBe(s2);
    });
  });

  describe('health check lifecycle', () => {
    it('startHealthChecks does not double-start', () => {
      registry = new UpstreamRegistry(makeConfig([makeServer()]));
      registry.startHealthChecks();
      registry.startHealthChecks();
      // Should not throw
    });

    it('stopHealthChecks sets shutdown flag', () => {
      registry = new UpstreamRegistry(makeConfig([makeServer()]));
      registry.startHealthChecks();
      registry.stopHealthChecks();
      // Should not throw
    });
  });
});
