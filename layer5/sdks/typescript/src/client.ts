// Layerinfinite SDK — client.ts
// Production-ready Layerinfinite client using native fetch with retry logic.

import {
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
} from './errors.js';
import type {
    LayerinfiniteConfig,
    GetScoresResponse,
    LogOutcomeRequest,
    LogOutcomeResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://outcome-production.up.railway.app';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class LayerinfiniteClient {
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly maxRetries: number;

    constructor(config: LayerinfiniteConfig) {
        if (!config.apiKey) throw new LayerinfiniteError('apiKey is required');
        if (!config.apiKey.startsWith('layerinfinite_')) {
            throw new LayerinfiniteError(
                "Invalid API key format. Key must start with 'layerinfinite_'. " +
                'Get your key from https://outcome-green.vercel.app/settings/api-keys'
            );
        }
        this.apiKey = config.apiKey;
        this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
        this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    }

    getBaseUrl(): string {
        return this.baseUrl;
    }

    getApiKey(): string {
        return this.apiKey;
    }

    // ── Internal: parse and raise typed errors ─────────────────
    private async raiseForStatus(response: Response): Promise<never> {
        let body: unknown;
        try { body = await response.json(); } catch { body = {}; }

        const code = response.status;

        if (code === 401) throw new LayerinfiniteAuthError(
            'Invalid or missing API key. Verify your X-API-Key.',
            body,
        );
        if (code === 404) throw new LayerinfiniteNotFoundError('Resource not found.', body);
        if (code === 429) {
            const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
            throw new LayerinfiniteRateLimitError(
                `Rate limit exceeded. Retry after ${retryAfter}s.`,
                retryAfter,
            );
        }
        if (code >= 500) {
            const msg = (body as Record<string, unknown>)?.error ?? 'unknown server error';
            throw new LayerinfiniteServerError(`Layerinfinite server error [${code}]: ${msg}`, code, body);
        }
        throw new LayerinfiniteError(`Request error [${code}]`, code, body);
    }

    // ── Internal: fetch with timeout + retry ───────────────────
    private async fetchWithRetry(
        url: string,
        init: RequestInit,
        isRetryableStatus: (code: number) => boolean,
    ): Promise<Response> {
        let lastErr: unknown;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });

                // 429 — wait, then retry
                if (response.status === 429 && attempt < this.maxRetries) {
                    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                // Retryable status (caller-defined) — exponential backoff
                if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
                    await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
                    continue;
                }

                // Non-2xx on final attempt — raise typed error
                if (!response.ok) await this.raiseForStatus(response);

                return response;

            } catch (err: unknown) {
                if (err instanceof LayerinfiniteError) throw err;
                if (err instanceof Error && err.name === 'AbortError') {
                    lastErr = new LayerinfiniteError(`Request timed out after ${this.timeout}ms`);
                } else {
                    lastErr = new LayerinfiniteError(`Network error: ${String(err)}`);
                }
                if (attempt >= this.maxRetries) throw lastErr;
            } finally {
                clearTimeout(timer);
            }
        }

        throw lastErr ?? new LayerinfiniteError('Max retries exceeded');
    }

    // ── Public API ──────────────────────────────────────────────

    /**
     * Fetch ranked action scores for the given agent and context.
     *
     * @throws {LayerinfiniteAuthError} on 401
     * @throws {LayerinfiniteRateLimitError} on 429
     * @throws {LayerinfiniteServerError} on 5xx
     */
    async getScores(params: {
        agentId: string;
        issueType: string;
        environment?: string;
    }): Promise<GetScoresResponse> {
        const qs = new URLSearchParams({
            agent_id: params.agentId,
            issue_type: params.issueType,
            environment: params.environment ?? 'production',
        });
        const url = `${this.baseUrl}/v1/get-scores?${qs.toString()}`;
        const response = await this.fetchWithRetry(
            url,
            {
                method: 'GET',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Accept': 'application/json',
                },
            },
            code => code === 429 || code >= 500,
        );
        const data = await response.json() as GetScoresResponse;
        if (!data.agent_id) data.agent_id = params.agentId;
        return data;
    }

    /**
     * Log the outcome of an action taken by the agent.
     *
     * @throws {LayerinfiniteAuthError} on 401
     * @throws {LayerinfiniteRateLimitError} on 429
     * @throws {LayerinfiniteServerError} on 5xx
     */
    async logOutcome(request: LogOutcomeRequest): Promise<LogOutcomeResponse> {
        const url = `${this.baseUrl}/v1/log-outcome`;
        const response = await this.fetchWithRetry(
            url,
            {
                method: 'POST',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify(request),
            },
            code => code === 429 || code >= 500,
        );
        return response.json() as Promise<LogOutcomeResponse>;
    }

    /**
     * Check API health (no auth required).
     */
    async health(): Promise<{ status: string; version: string }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
            const response = await fetch(`${this.baseUrl}/health`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new LayerinfiniteError(`Health check failed [${response.status}]`);
            }
            return response.json() as Promise<{ status: string; version: string }>;
        } finally {
            clearTimeout(timer);
        }
    }
}
