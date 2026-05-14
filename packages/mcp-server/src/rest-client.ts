/**
 * LayerInfinite MCP Server — rest-client.ts
 * ══════════════════════════════════════════════════════════════
 * Thin HTTP client that proxies calls to the LayerInfinite REST API.
 * Handles auth headers, timeouts, retries, and structured error responses.
 *
 * Production hardening:
 *   - Exponential backoff retry for transient failures (503, 429, timeouts)
 *   - Structured request/response logging
 *   - Native fetch() — zero external dependencies
 * ══════════════════════════════════════════════════════════════
 */

import type { LIConfig } from './config.js';
import { logger } from './logger.js';

/** Standard error shape returned by the LI REST API. */
export interface LIApiError {
  error: string;
  code: string;
  message?: string;
  details?: unknown;
}

/** Successful response wrapper. */
export interface LIApiResponse<T> {
  ok: true;
  status: number;
  data: T;
}

/** Failed response wrapper. */
export interface LIApiErrorResponse {
  ok: false;
  status: number;
  error: LIApiError;
}

export type LIResult<T> = LIApiResponse<T> | LIApiErrorResponse;

const DEFAULT_TIMEOUT_MS = 15_000;

/** HTTP status codes that are safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Max retries for transient failures. */
const MAX_RETRIES = 2;

/** Base delay for exponential backoff (ms). */
const BASE_RETRY_DELAY_MS = 500;

export class RestClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly log = logger.forTool('rest-client');

  constructor(config: LIConfig) {
    this.baseUrl = config.baseUrl;
    this.headers = {
      'X-API-Key': config.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': '@layerinfinite/mcp-server/1.0.0',
    };
  }

  /** GET request to the LI REST API. */
  async get<T>(path: string, params?: Record<string, string>): Promise<LIResult<T>> {
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

  /** POST request to the LI REST API. */
  async post<T>(path: string, body: Record<string, unknown>): Promise<LIResult<T>> {
    const url = `${this.baseUrl}${path}`;
    return this.requestWithRetry<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** PUT request to the LI REST API. */
  async put<T>(path: string, body: Record<string, unknown>): Promise<LIResult<T>> {
    const url = `${this.baseUrl}${path}`;
    return this.requestWithRetry<T>(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /**
   * Request with exponential backoff retry for transient failures.
   * Retries on: 429, 502, 503, 504, TIMEOUT, NETWORK_ERROR
   * Does NOT retry on: 400, 401, 403, 404, 409 (client errors are permanent)
   */
  private async requestWithRetry<T>(url: string, init: RequestInit): Promise<LIResult<T>> {
    let lastResult: LIResult<T> | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        this.log.warn('Retrying request', {
          url,
          method: init.method,
          attempt: attempt + 1,
          delay_ms: delay,
        });
        await this.sleep(delay);
      }

      const result = await this.request<T>(url, init);

      // Success — return immediately
      if (result.ok) return result;

      lastResult = result;

      // Check if the error is retryable
      const isRetryableStatus = RETRYABLE_STATUS_CODES.has(result.status);
      const isRetryableError = result.error.code === 'TIMEOUT' || result.error.code === 'NETWORK_ERROR';

      if (!isRetryableStatus && !isRetryableError) {
        // Client error (400, 401, 403, 404) — don't retry
        break;
      }
    }

    // All retries exhausted — return the last error
    return lastResult!;
  }

  private async request<T>(url: string, init: RequestInit): Promise<LIResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const startMs = Date.now();

    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string> ?? {}) },
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startMs;
      const contentType = response.headers.get('content-type') ?? '';
      const isJson = contentType.includes('application/json');

      if (response.ok) {
        const data = isJson ? (await response.json()) as T : ({} as T);
        this.log.debug('API response', {
          method: init.method,
          url,
          status: response.status,
          latency_ms: latencyMs,
        });
        return { ok: true, status: response.status, data };
      }

      const errorBody = isJson
        ? (await response.json()) as LIApiError
        : { error: 'API Error', code: 'UNKNOWN', message: await response.text() };

      this.log.warn('API error', {
        method: init.method,
        url,
        status: response.status,
        latency_ms: latencyMs,
        error_code: errorBody.code,
      });

      return { ok: false, status: response.status, error: errorBody };
    } catch (err) {
      const latencyMs = Date.now() - startMs;

      if (err instanceof DOMException && err.name === 'AbortError') {
        this.log.error('Request timeout', {
          method: init.method,
          url,
          timeout_ms: DEFAULT_TIMEOUT_MS,
          latency_ms: latencyMs,
        });
        return {
          ok: false,
          status: 0,
          error: { error: 'Request timed out', code: 'TIMEOUT', message: `Request to ${url} timed out after ${DEFAULT_TIMEOUT_MS}ms` },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      this.log.error('Network error', {
        method: init.method,
        url,
        latency_ms: latencyMs,
        error: message,
      });
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
