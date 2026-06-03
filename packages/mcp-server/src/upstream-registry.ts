/**
 * LayerInfinite MCP Server — upstream-registry.ts
 * ══════════════════════════════════════════════════════════════
 * Manages upstream MCP server connections: registration, health
 * checks, circuit breaker integration, and tool discovery.
 * ══════════════════════════════════════════════════════════════
 */

import type { UpstreamServer, GatewayConfig } from './config.js';
import {
  createFailOpenState,
  recordUpstreamFailure,
  recordUpstreamSuccess,
  probeCircuitBreaker,
  updateHealthCheck,
  isCircuitOpen,
} from './fail-open.js';
import type { FailOpenState } from './types.js';
import { logger } from './logger.js';

const log = logger.forTool('upstream-registry');

const DEFAULT_HEALTH_CHECK_MS = 30_000;
const HEALTH_PING_TIMEOUT_MS = 5_000;

export interface UpstreamEntry {
  server: UpstreamServer;
  healthy: boolean;
  lastCheck: number;
  lastError?: string;
}

export class UpstreamRegistry {
  private readonly servers: Map<string, UpstreamEntry> = new Map();
  private readonly state: FailOpenState;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownFlag = false;

  constructor(config: GatewayConfig) {
    this.state = createFailOpenState();
    for (const server of config.upstreamServers) {
      this.servers.set(server.name, {
        server,
        healthy: true, // Start optimistic — first health check will correct
        lastCheck: 0,
      });
      log.info('Registered upstream', { name: server.name, url: server.url });
    }
  }

  /** Get a single upstream by name. */
  getUpstream(name: string): UpstreamEntry | undefined {
    return this.servers.get(name);
  }

  /** Get all upstream server configs. */
  getAllUpstreams(): UpstreamEntry[] {
    return Array.from(this.servers.values());
  }

  /** Check if an upstream is healthy (circuit closed + recent health check OK). */
  isHealthy(name: string): boolean {
    const entry = this.servers.get(name);
    if (!entry) return false;
    if (isCircuitOpen(this.state, name)) return false;
    return entry.healthy;
  }

  /** Get the FailOpenState for external circuit breaker queries. */
  getFailOpenState(): FailOpenState {
    return this.state;
  }

  /**
   * Start periodic health checks for all upstream servers.
   * Each upstream gets its own check interval (default 30s).
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    // Run initial checks immediately
    void this.checkAllUpstreams();

    this.healthCheckTimer = setInterval(() => {
      if (this.shutdownFlag) return;
      void this.checkAllUpstreams();
    }, DEFAULT_HEALTH_CHECK_MS);

    log.info('Health checks started', { upstreams: this.servers.size });
  }

  /** Stop the health check loop. */
  stopHealthChecks(): void {
    this.shutdownFlag = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      log.info('Health checks stopped');
    }
  }

  private async checkAllUpstreams(): Promise<void> {
    const checks = Array.from(this.servers.values()).map((entry) =>
      this.checkUpstream(entry),
    );
    await Promise.allSettled(checks);
  }

  private async checkUpstream(entry: UpstreamEntry): Promise<void> {
    const { server } = entry;
    const interval = server.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_MS;

    // Skip if checked recently
    if (Date.now() - entry.lastCheck < interval) return;

    // Check if circuit breaker allows probing
    probeCircuitBreaker(this.state, server.name);
    updateHealthCheck(this.state, server.name);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_PING_TIMEOUT_MS);

      const response = await fetch(`${server.url}/health`, {
        method: 'GET',
        headers: server.apiKey
          ? { Authorization: `Bearer ${server.apiKey}` }
          : {},
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        entry.healthy = true;
        entry.lastCheck = Date.now();
        entry.lastError = undefined;
        recordUpstreamSuccess(this.state, server.name);
        log.debug('Upstream healthy', { name: server.name });
      } else {
        entry.healthy = false;
        entry.lastCheck = Date.now();
        entry.lastError = `HTTP ${response.status}`;
        recordUpstreamFailure(this.state, server.name);
        log.warn('Upstream unhealthy', {
          name: server.name,
          status: response.status,
        });
      }
    } catch (err) {
      entry.healthy = false;
      entry.lastCheck = Date.now();
      entry.lastError = err instanceof Error ? err.message : String(err);
      recordUpstreamFailure(this.state, server.name);
      log.warn('Upstream health check failed', {
        name: server.name,
        error: entry.lastError,
      });
    }
  }
}
