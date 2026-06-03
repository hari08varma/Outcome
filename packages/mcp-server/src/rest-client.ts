/**
 * LayerInfinite MCP Server — rest-client.ts
 * ══════════════════════════════════════════════════════════════
 * V2: LiApiClient (LI REST API) + UpstreamMCPClient (MCP JSON-RPC proxy).
 *
 * LiApiClient replaces V1 RestClient — fetches scores, policy decisions,
 * and logs outcomes to the LayerInfinite REST API.
 *
 * UpstreamMCPClient implements MCP JSON-RPC over HTTP for proxying
 * tools/list and tools/call to upstream MCP servers, with circuit
 * breaker integration and session caching.
 * ══════════════════════════════════════════════════════════════
 */

import type { GatewayConfig, UpstreamServer } from './config.js';
import type { ScoredAction, PolicyDecision, OutcomePayload } from './types.js';
import { UpstreamRegistry } from './upstream-registry.js';
import type { FailOpenState } from './types.js';
import {
  recordUpstreamSuccess,
  recordUpstreamFailure,
} from './fail-open.js';
import { logger } from './logger.js';

const log = logger.forTool('rest-client');

// ── V1-compatible types (preserved) ──────────────────────────

export interface LIApiError {
  error: string;
  code: string;
  message?: string;
  details?: unknown;
}

export interface LIApiResponse<T> {
  ok: true;
  status: number;
  data: T;
}

export interface LIApiErrorResponse {
  ok: false;
  status: number;
  error: LIApiError;
}

export type LIResult<T> = LIApiResponse<T> | LIApiErrorResponse;

// ── V2 new types ─────────────────────────────────────────────

export interface RawUpstreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  upstreamName: string;
}

export interface UpstreamCallResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
}

// ── Constants ────────────────────────────────────────────────

const LI_API_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;

// Per-upstream connection concurrency
const DEFAULT_MAX_CONCURRENT_UPSTREAM = 100;

function getMaxConcurrentUpstream(): number {
  const v = Number.parseInt(process.env.LAYERINFINITE_MAX_UPSTREAM_CONCURRENT ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CONCURRENT_UPSTREAM;
}

// ══════════════════════════════════════════════════════════════
// LiApiClient — LI REST API communication
// ══════════════════════════════════════════════════════════════

export class LiApiClient {
  private readonly baseUrl: string;
  private readonly primaryKey: string;
  private readonly secondaryKey: string | undefined;

  constructor(config: GatewayConfig) {
    this.baseUrl = config.baseUrl;
    this.primaryKey = config.apiKey;
    this.secondaryKey = config.apiKeySecondary;
  }

  private buildHeaders(apiKey?: string): Record<string, string> {
    return {
      'X-API-Key': apiKey ?? this.primaryKey,
      'Content-Type': 'application/json',
      'User-Agent': '@layerinfinite/mcp-server/2.0.0',
    };
  }

  /** Fetch scored actions for a task type. */
  async getScores(
    taskType: string,
    customerId: string,
    agentId: string,
  ): Promise<ScoredAction[]> {
    const result = await this.get<{ scores: ScoredAction[] }>(
      '/v1/get-scores',
      { task_type: taskType, customer_id: customerId, agent_id: agentId },
    );
    if (!result.ok) {
      log.warn('getScores failed', { code: result.error.code });
      return [];
    }
    return result.data.scores ?? [];
  }

  /** Fetch policy decision for a task type. */
  async getPolicyDecision(
    taskType: string,
    customerId: string,
    agentId: string,
  ): Promise<PolicyDecision | null> {
    const result = await this.get<{ decision: PolicyDecision | null }>(
      '/v1/recommendations',
      { task_type: taskType, customer_id: customerId, agent_id: agentId },
    );
    if (!result.ok) {
      log.warn('getPolicyDecision failed', { code: result.error.code });
      return null;
    }
    return result.data.decision ?? null;
  }

  /** Fire-and-forget outcome logging. Returns true if successful. */
  async logOutcome(payload: OutcomePayload): Promise<boolean> {
    const result = await this.post<{ accepted: boolean }>(
      '/v1/log-outcome',
      payload as unknown as Record<string, unknown>,
    );
    return result.ok;
  }

  /** Get recommendations for a task type (legacy / li_recommend support). */
  async getRecommendations(
    taskType: string,
    customerId: string,
    agentId: string,
  ): Promise<ScoredAction[]> {
    return this.getScores(taskType, customerId, agentId);
  }

  // ── HTTP helpers (preserved from V1) ─────────────────────

  private async get<T>(
    path: string,
    params?: Record<string, string>,
  ): Promise<LIResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, value);
        }
      }
    }
    return this.requestWithRetry<T>(url.toString(), { method: 'GET' });
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<LIResult<T>> {
    return this.requestWithRetry<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async requestWithRetry<T>(
    url: string,
    init: RequestInit,
  ): Promise<LIResult<T>> {
    let lastResult: LIResult<T> | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        log.warn('Retrying LI API request', { url, attempt: attempt + 1, delay_ms: delay });
        await this.sleep(delay);
      }

      const result = await this.request<T>(url, init);
      if (result.ok) return result;

      lastResult = result;
      const isRetryable = RETRYABLE_STATUS_CODES.has(result.status)
        || result.error.code === 'TIMEOUT'
        || result.error.code === 'NETWORK_ERROR';
      if (!isRetryable) break;
    }

    return lastResult!;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    usedSecondary = false,
  ): Promise<LIResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LI_API_TIMEOUT_MS);
    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...this.buildHeaders(), ...(init.headers as Record<string, string> ?? {}) },
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startMs;
      const isJson = response.headers.get('content-type')?.includes('application/json');

      if (response.ok) {
        const data = isJson ? (await response.json()) as T : ({} as T);
        log.debug('LI API response', { method: init.method, url, status: response.status, latency_ms: latencyMs });
        return { ok: true, status: response.status, data };
      }

      // Zero-downtime key rotation: retry with secondary key on auth failure
      if ((response.status === 401 || response.status === 403) && this.secondaryKey && !usedSecondary) {
        clearTimeout(timeout);
        log.info('Primary key rejected — retrying with secondary key');
        return this.request<T>(url, {
          ...init,
          headers: { ...this.buildHeaders(this.secondaryKey), ...(init.headers as Record<string, string> ?? {}) },
        }, true);
      }

      const errorBody: LIApiError = isJson
        ? (await response.json()) as LIApiError
        : { error: 'API Error', code: 'UNKNOWN', message: await response.text() };

      log.warn('LI API error', { method: init.method, url, status: response.status, error_code: errorBody.code });
      return { ok: false, status: response.status, error: errorBody };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.error('LI API timeout', { method: init.method, url, timeout_ms: LI_API_TIMEOUT_MS });
        return {
          ok: false,
          status: 0,
          error: { error: 'Request timed out', code: 'TIMEOUT', message: `Request timed out after ${LI_API_TIMEOUT_MS}ms` },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      log.error('LI API network error', { method: init.method, url, error: message });
      return {
        ok: false,
        status: 0,
        error: { error: 'Network error', code: 'NETWORK_ERROR', message },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ══════════════════════════════════════════════════════════════
// UpstreamMCPClient — MCP JSON-RPC proxy to upstream servers
// ══════════════════════════════════════════════════════════════

export class UpstreamMCPClient {
  private readonly registry: UpstreamRegistry;
  private readonly failOpenState: FailOpenState;
  private readonly sessions = new Map<string, string>();
  private requestCounter = 0;
  private readonly activeConnections = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly initialized = new Map<string, boolean>();
  private readonly initPromises = new Map<string, Promise<void>>();

  constructor(registry: UpstreamRegistry) {
    this.registry = registry;
    this.failOpenState = registry.getFailOpenState();
    this.maxConcurrent = getMaxConcurrentUpstream();
  }

  /** Fetch all tools from all healthy upstreams. */
  async listTools(): Promise<RawUpstreamTool[]> {
    const tools: RawUpstreamTool[] = [];
    const healthy = this.getHealthyUpstreams();
    const entries = this.registry.getAllUpstreams().filter((e) => healthy.includes(e.server.name));

    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const rawTools = await this.fetchUpstreamTools(entry.server);
        return rawTools.map((t) => ({
          ...t,
          upstreamName: entry.server.name,
        }));
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        tools.push(...result.value);
      }
    }

    return tools;
  }

  /** Call a tool on a specific upstream server. */
  async callTool(
    upstreamName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<UpstreamCallResult> {
    const entry = this.registry.getUpstream(upstreamName);
    if (!entry) {
      throw new Error(`Upstream "${upstreamName}" not found`);
    }

    await this.ensureInitialized(entry.server);

    try {
      const result = await this.mcpRequest<UpstreamCallResult>(
        entry.server,
        'tools/call',
        { name: toolName, arguments: args },
      );
      recordUpstreamSuccess(this.failOpenState, upstreamName);
      return result;
    } catch (err) {
      recordUpstreamFailure(this.failOpenState, upstreamName);
      throw err;
    }
  }

  /** Get list of healthy upstream names (circuit closed + last health check OK). */
  getHealthyUpstreams(): string[] {
    return this.registry.getAllUpstreams()
      .filter((e) => this.registry.isHealthy(e.server.name))
      .map((e) => e.server.name);
  }

  /** Start periodic health checks on all upstreams. */
  startHealthChecks(): void {
    this.registry.startHealthChecks();
  }

  /** Stop periodic health checks. */
  stopHealthChecks(): void {
    this.registry.stopHealthChecks();
  }

  // ── Private: MCP JSON-RPC ────────────────────────────────

  private async ensureInitialized(server: UpstreamServer): Promise<void> {
    if (this.initialized.get(server.name)) return;

    const existing = this.initPromises.get(server.name);
    if (existing) return existing;

    const promise = this.doInitialize(server);
    this.initPromises.set(server.name, promise);

    try {
      await promise;
    } finally {
      this.initPromises.delete(server.name);
    }
  }

  private async doInitialize(server: UpstreamServer): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'layerinfinite-gateway', version: '2.0.0' },
      },
      id: 0,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Initialize failed for ${server.name}: HTTP ${response.status}`);
    }

    const sessionId = response.headers.get('Mcp-Session-Id');
    if (sessionId) {
      this.sessions.set(server.name, sessionId);
    }

    // Send initialized notification (no id = notification per MCP spec)
    const notifBody = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });

    const notifHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sessionId) notifHeaders['Mcp-Session-Id'] = sessionId;
    if (server.apiKey) notifHeaders['Authorization'] = `Bearer ${server.apiKey}`;

    await fetch(server.url, {
      method: 'POST',
      headers: notifHeaders,
      body: notifBody,
      signal: AbortSignal.timeout(5_000),
    });

    this.initialized.set(server.name, true);
    log.info('Upstream initialized', { name: server.name });
  }

  private async fetchUpstreamTools(server: UpstreamServer): Promise<Omit<RawUpstreamTool, 'upstreamName'>[]> {
    await this.ensureInitialized(server);
    const result = await this.mcpRequest<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>(
      server,
      'tools/list',
    );
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  private async mcpRequest<T>(
    server: UpstreamServer,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    // ── Concurrency gate ────────────────────────────────────
    const active = this.activeConnections.get(server.name) ?? 0;
    if (active >= this.maxConcurrent) {
      throw new Error(
        `Upstream "${server.name}" concurrency limit reached (${active}/${this.maxConcurrent})`,
      );
    }
    this.activeConnections.set(server.name, active + 1);

    const id = ++this.requestCounter;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: params ?? {},
      id,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (server.apiKey) {
      headers['Authorization'] = `Bearer ${server.apiKey}`;
    }

    const sessionId = this.sessions.get(server.name);
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_CALL_TIMEOUT_MS);

    try {
      const response = await fetch(server.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      // Cache session ID from response
      const newSessionId = response.headers.get('Mcp-Session-Id');
      if (newSessionId) {
        this.sessions.set(server.name, newSessionId);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Upstream ${server.name} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      // Handle non-JSON responses gracefully
      if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
        const text = await response.text();
        log.warn('Non-JSON upstream response', { server: server.name, method, contentType });
        // Try to parse as JSON anyway
        try {
          const data = JSON.parse(text);
          if (data.error) {
            throw new Error(`MCP error from ${server.name}: ${data.error.message ?? JSON.stringify(data.error)}`);
          }
          return data.result as T;
        } catch {
          // If it's not JSON at all, return as text content
          return { content: [{ type: 'text', text }] } as unknown as T;
        }
      }

      const data = (await response.json()) as { error?: { message?: string }; result?: T };

      if (data.error) {
        throw new Error(`MCP error from ${server.name}: ${data.error.message ?? JSON.stringify(data.error)}`);
      }

      return data.result as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Upstream ${server.name} timed out after ${MCP_CALL_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      // Release concurrency slot
      const cur = this.activeConnections.get(server.name) ?? 1;
      if (cur <= 1) {
        this.activeConnections.delete(server.name);
      } else {
        this.activeConnections.set(server.name, cur - 1);
      }
    }
  }
}
