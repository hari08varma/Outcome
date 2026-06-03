import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GatewayProxy } from '../src/gateway-proxy.js';
import type { GatewayConfig, LIMode } from '../src/config.js';
import type { LiApiClient, UpstreamMCPClient, UpstreamCallResult, RawUpstreamTool } from '../src/rest-client.js';
import type { UpstreamRegistry } from '../src/upstream-registry.js';
import type { DecisionTracker } from '../src/decision-tracker.js';
import type { OutcomeClassifier } from '../src/outcome-classifier.js';

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    apiKey: 'test-key', baseUrl: 'https://test.example.com',
    mode: 'recommend' as LIMode | null, upstreamServers: [],
    modeOverrides: new Map(), shadowMode: false,
    environment: 'production', adminKey: null,
    logLevel: 'error', classifier: null,
    ...overrides,
  };
}

function mockLiApi(): LiApiClient {
  return {
    getScores: vi.fn().mockResolvedValue([]),
    getPolicyDecision: vi.fn().mockResolvedValue(null),
    logOutcome: vi.fn().mockResolvedValue(true),
    getRecommendations: vi.fn().mockResolvedValue([]),
  } as unknown as LiApiClient;
}

function mockUpstreamClient(tools: RawUpstreamTool[] = [], callResult?: UpstreamCallResult): UpstreamMCPClient {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockResolvedValue(callResult ?? { content: [{ type: 'text', text: 'ok' }] }),
    getHealthyUpstreams: vi.fn().mockReturnValue([]),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
  } as unknown as UpstreamMCPClient;
}

function mockRegistry(upstreams: Array<{ name: string; healthy?: boolean }> = []): UpstreamRegistry {
  const entries = upstreams.map((u) => ({
    server: { name: u.name, url: `https://${u.name}.test` },
    healthy: u.healthy ?? true,
    lastCheck: Date.now(),
  }));
  return {
    getAllUpstreams: () => entries,
    isHealthy: (name: string) => entries.find((e) => e.server.name === name)?.healthy ?? false,
    getUpstream: (name: string) => entries.find((e) => e.server.name === name),
    startHealthChecks: vi.fn(),
    stopHealthChecks: vi.fn(),
    getFailOpenState: () => createFailOpenState(),
  } as unknown as UpstreamRegistry;
}

function createFailOpenState() {
  return {
    upstreamFailures: new Map(),
    circuitBreakerOpen: new Map(),
    lastHealthCheck: new Map(),
    totalRequests: 0,
    passthroughRequests: 0,
  };
}

function makeTool(): RawUpstreamTool {
  return { name: 'github_push', description: 'Push commits', inputSchema: { type: 'object' }, upstreamName: 'github' };
}

describe('GatewayProxy', () => {
  let proxy: GatewayProxy;
  let liApi: LiApiClient;
  let upstreamClient: UpstreamMCPClient;
  let registry: UpstreamRegistry;
  let config: GatewayConfig;

  beforeEach(() => {
    liApi = mockLiApi();
    upstreamClient = mockUpstreamClient([makeTool()]);
    registry = mockRegistry([{ name: 'github' }]);
    config = makeConfig();
    proxy = new GatewayProxy(liApi, upstreamClient, registry, config, null, null);
  });

  describe('handleListTools', () => {
    it('returns enriched tools', async () => {
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].name).toBe('li_recommend'); // rank 0 sorts first
      expect(tools[1].name).toBe('github_push');
    });

    it('injects li_recommend in non-bootstrap mode', async () => {
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      expect(tools.some((t) => t.name === 'li_recommend')).toBe(true);
    });

    it('does not inject li_recommend in bootstrap mode', async () => {
      config = makeConfig({ mode: null });
      proxy = new GatewayProxy(liApi, upstreamClient, registry, config, null, null);
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      expect(tools.some((t) => t.name === 'li_recommend')).toBe(false);
    });

    it('sorts by ranking first, then alphabetically', async () => {
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      // li_recommend (rank 0) should be first
      expect(tools[0].name).toBe('li_recommend');
    });

    it('degrades gracefully when enrichment fails', async () => {
      const badUpstream = mockUpstreamClient();
      (badUpstream.listTools as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Upstream down'))
        .mockResolvedValueOnce([makeTool()]);
      proxy = new GatewayProxy(liApi, badUpstream, registry, config, null, null);
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      expect(tools).toHaveLength(1);
    });

    it('returns empty array when everything fails', async () => {
      const badUpstream = mockUpstreamClient();
      (badUpstream.listTools as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Down'));
      proxy = new GatewayProxy(liApi, badUpstream, registry, config, null, null);
      const tools = await proxy.handleListTools({
        taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1',
      });
      expect(tools).toEqual([]);
    });
  });

  describe('handleCallTool', () => {
    it('proxies tool call to upstream', async () => {
      const result = await proxy.handleCallTool(
        'github_push', { branch: 'main' },
        { taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1' },
      );
      expect(upstreamClient.callTool).toHaveBeenCalledWith(
        'github', 'github_push', { branch: 'main' },
      );
      expect(result.content[0].text).toBe('ok');
    });

    it('handles li_recommend virtual tool', async () => {
      (liApi.getScores as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await proxy.handleCallTool(
        'li_recommend', { task: 'build_failed' },
        { taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1' },
      );
      expect(upstreamClient.callTool).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('No recommendations available');
    });

    it('logs outcomes as fire-and-forget', async () => {
      await proxy.handleCallTool(
        'github_push', {},
        { taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1' },
      );
      // Fire-and-forget is async — wait briefly
      await new Promise((r) => setTimeout(r, 50));
      expect(liApi.logOutcome).toHaveBeenCalled();
    });

    it('reports upstream errors', async () => {
      const errorClient = mockUpstreamClient([], {
        content: [{ type: 'text', text: 'Error: permission denied' }],
        isError: true,
      });
      registry = mockRegistry([{ name: 'github' }]);
      proxy = new GatewayProxy(liApi, errorClient, registry, config, null, null);
      const result = await proxy.handleCallTool(
        'github_push', {},
        { taskType: 'build_failed', customerId: 'cust-1', agentId: 'agent-1' },
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('stops health checks', async () => {
      await proxy.shutdown();
      expect(registry.stopHealthChecks).toHaveBeenCalled();
    });
  });
});
