/**
 * Layer5 TypeScript SDK — core client.
 *
 * Uses native fetch — works in Node 18+, Deno, Bun,
 * Cloudflare Workers, and browsers. Zero dependencies.
 *
 * Usage:
 *   import { Layer5 } from '@layer5/sdk';
 *
 *   const l5 = new Layer5({ apiKey: 'layer5_...' });
 *
 *   const scores = await l5.getScores({
 *     agentId: 'my-agent',
 *     context: { issue_type: 'payment_failed' },
 *   });
 *
 *   await l5.logOutcome({
 *     agentId: 'my-agent',
 *     actionName: scores.ranked_actions[0].action_name,
 *     sessionId: 'sess-123',
 *     issueType: 'payment_failed',
 *     success: true,
 *     responseTimeMs: 241,
 *   });
 */

import {
  Layer5AgentSuspendedError,
  Layer5AuthError,
  Layer5Error,
  Layer5NetworkError,
  Layer5RateLimitError,
  Layer5ServerError,
  Layer5TimeoutError,
  Layer5UnknownActionError,
  Layer5ValidationError,
} from './errors.js';
import { exponentialBackoff, sleep } from './retry.js';
import type {
  GetScoresOptions,
  GetScoresResponse,
  Layer5ClientOptions,
  LogOutcomeOptions,
  LogOutcomeResponse,
  OutcomeFeedbackOptions,
  OutcomeFeedbackResponse,
  SimulateOptions,
  SimulateResponse,
} from './types.js';

declare const Deno: { env: { get(key: string): string | undefined } } | undefined;
declare const process: { env?: Record<string, string | undefined> } | undefined;

const SDK_VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://api.layer5.dev';
const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_RETRIES = 3;
const API_KEY_PATTERN = /^layer5_[a-zA-Z0-9]{20,}$/;

/**
 * Resolve an environment variable in a cross-runtime way.
 * Works in Node, Deno, Bun; returns undefined in browsers/workers without process.
 */
function getEnv(key: string): string | undefined {
  // Node / Bun
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  // Deno
  if (typeof Deno !== 'undefined') {
    try {
      return Deno!.env.get(key);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export class Layer5 {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  readonly agentId?: string;

  constructor(options: Layer5ClientOptions = {}) {
    const apiKey = options.apiKey ?? getEnv('LAYER5_API_KEY');

    if (!apiKey) {
      throw new Layer5AuthError(
        "No API key provided. " +
          "Pass apiKey option or set LAYER5_API_KEY environment variable. " +
          "Get your key at https://app.layer5.dev/settings/api-keys"
      );
    }

    if (!API_KEY_PATTERN.test(apiKey)) {
      throw new Layer5AuthError(
        `Invalid API key format: '${apiKey.slice(0, 12)}...'. ` +
          "Keys must start with 'layer5_' followed by " +
          "at least 20 alphanumeric characters. " +
          "Check for extra spaces or truncation."
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (
      options.baseUrl ?? getEnv('LAYER5_BASE_URL') ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
    this.agentId = options.agentId;
  }

  // ── Response handler ──────────────────────────────────────

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return (await response.json()) as T;
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // body stays empty
    }

    const code = (body.code as string) ?? '';
    const message =
      (body.error as string) ??
      (body.message as string) ??
      response.statusText;
    const requestId = response.headers.get('x-request-id') ?? undefined;

    switch (response.status) {
      case 400: {
        const field = body.field as string | undefined;
        throw new Layer5ValidationError(message, field);
      }
      case 401:
        throw new Layer5AuthError();
      case 422:
        throw new Layer5ValidationError(message);
      case 429: {
        const retryAfter = parseInt(
          response.headers.get('retry-after') ?? '60',
          10
        );
        throw new Layer5RateLimitError(retryAfter);
      }
      case 403:
        if (code === 'AGENT_SUSPENDED') {
          throw new Layer5AgentSuspendedError(
            (body.agent_id as string) ?? 'unknown'
          );
        }
        throw new Layer5AuthError(`Access denied: ${message}`);
      case 404:
        if (code === 'UNKNOWN_ACTION') {
          throw new Layer5UnknownActionError(
            (body.action_name as string) ?? 'unknown'
          );
        }
        throw new Layer5Error(`Resource not found: ${message}`);
      default:
        if (response.status >= 500) {
          throw new Layer5ServerError(response.status, requestId);
        }
        throw new Layer5Error(
          `Unexpected status ${response.status}: ${message}`
        );
    }
  }

  // ── Request with retries ──────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    options: {
      params?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (options.params) {
      const searchParams = new URLSearchParams(options.params);
      url += '?' + searchParams.toString();
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.timeout
        );

        let response: Response;
        try {
          response = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'User-Agent': `layer5-js/${SDK_VERSION}`,
              'X-SDK-Version': SDK_VERSION,
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        return await this.handleResponse<T>(response);
      } catch (error) {
        // Rate limit — respect retry_after
        if (error instanceof Layer5RateLimitError) {
          lastError = error;
          if (attempt < this.maxRetries - 1) {
            await sleep(Math.min(error.retryAfter * 1000, 1000));
            continue;
          }
          throw error;
        }

        // Server error — exponential backoff
        if (error instanceof Layer5ServerError) {
          lastError = error;
          if (attempt < this.maxRetries - 1) {
            await sleep(exponentialBackoff(attempt));
            continue;
          }
          throw error;
        }

        // AbortError = timeout
        if (
          error instanceof DOMException &&
          error.name === 'AbortError'
        ) {
          lastError = new Layer5TimeoutError(
            `Request timed out after ${this.timeout}ms`
          );
          if (attempt < this.maxRetries - 1) {
            await sleep(exponentialBackoff(attempt));
            continue;
          }
          throw lastError;
        }

        // TypeError = network failure (fetch spec)
        if (error instanceof TypeError) {
          lastError = new Layer5NetworkError(error.message, error);
          if (attempt < this.maxRetries - 1) {
            await sleep(exponentialBackoff(attempt));
            continue;
          }
          throw lastError;
        }

        // Non-retryable Layer5 errors — raise immediately
        if (
          error instanceof Layer5AuthError ||
          error instanceof Layer5ValidationError ||
          error instanceof Layer5UnknownActionError ||
          error instanceof Layer5AgentSuspendedError
        ) {
          throw error;
        }

        // Unknown error — wrap and throw
        if (error instanceof Error) {
          throw new Layer5NetworkError(error.message, error);
        }
        throw new Layer5Error(String(error));
      }
    }

    throw lastError!;
  }

  // ── Public API methods ────────────────────────────────────

  /**
   * Get ranked actions for your agent to choose from.
   * Call this BEFORE your agent takes any action.
   */
  async getScores(options: GetScoresOptions = {}): Promise<GetScoresResponse> {
    const agentId = options.agentId ?? this.agentId;
    if (!agentId) {
      throw new Layer5ValidationError(
        "agentId is required. " +
          "Pass it here or set it on the client: " +
          "new Layer5({ apiKey: '...', agentId: 'my-agent' })",
        'agentId'
      );
    }

    const start = Date.now();
    const params: Record<string, string> = { agent_id: agentId };
    const context = options.context ?? {};

    // Map SDK context dict to API query params
    if ('issue_type' in context) {
      params.issue_type = String(context.issue_type);
    }
    if ('context_id' in context) {
      params.context_id = String(context.context_id);
    }
    if (options.topN !== undefined && options.topN !== 10) {
      params.top_n = String(options.topN);
    }
    if (options.refresh) {
      params.refresh = 'true';
    }
    if (options.episodeId !== undefined) {
      params.episode_id = options.episodeId;
    }
    if (options.episodeHistory !== undefined) {
      params.episode_history = JSON.stringify(options.episodeHistory);
    }

    // Fallback: if neither issue_type nor context_id, serialize context
    if (!params.issue_type && !params.context_id) {
      params.issue_type = JSON.stringify(context);
    }

    const data = await this.request<GetScoresResponse>(
      'GET',
      '/v1/get-scores',
      { params }
    );

    data.latencyMs = Date.now() - start;
    return data;
  }

  /**
   * Log what happened after your agent took an action.
   * Call this AFTER every action — success or failure.
   * This is how Layer5 learns.
   */
  async logOutcome(
    options: LogOutcomeOptions
  ): Promise<LogOutcomeResponse> {
    const agentId = options.agentId ?? this.agentId;
    if (!agentId) {
      throw new Layer5ValidationError(
        'agentId is required.',
        'agentId'
      );
    }

    // Client-side validation for fast feedback
    if (
      options.outcomeScore !== undefined &&
      (options.outcomeScore < 0 || options.outcomeScore > 1)
    ) {
      throw new Layer5ValidationError(
        `outcomeScore must be between 0.0 and 1.0, got ${options.outcomeScore}. ` +
          'Use 0.0 for complete failure, 1.0 for perfect success.',
        'outcomeScore'
      );
    }

    // Derive issueType and sessionId with sensible defaults
    const issueType =
      options.issueType ??
      (options.context?.issue_type as string | undefined) ??
      options.actionName;
    const sessionId = options.sessionId ?? 'sdk-auto';

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      action_name: options.actionName,
      issue_type: issueType,
      success: options.success,
    };

    if (options.actionParams !== undefined) payload.action_params = options.actionParams;
    // responseMs is an alias for responseTimeMs
    const responseTime = options.responseTimeMs ?? options.responseMs;
    if (responseTime !== undefined) payload.response_time_ms = responseTime;
    if (options.errorCode !== undefined) payload.error_code = options.errorCode;
    if (options.errorMessage !== undefined) payload.error_message = options.errorMessage;
    // context maps to raw_context (rawContext takes precedence if both set)
    const rawContext = options.rawContext ?? options.context;
    if (rawContext !== undefined) payload.raw_context = rawContext;
    if (options.environment !== undefined) payload.environment = options.environment;
    if (options.customerTier !== undefined) payload.customer_tier = options.customerTier;
    if (options.outcomeScore !== undefined) payload.outcome_score = options.outcomeScore;
    if (options.businessOutcome !== undefined) payload.business_outcome = options.businessOutcome;
    if (options.feedbackSignal !== undefined) payload.feedback_signal = options.feedbackSignal;
    if (options.decisionId !== undefined) payload.decision_id = options.decisionId;
    if (options.episodeHistory !== undefined) payload.episode_history = options.episodeHistory;

    return this.request<LogOutcomeResponse>(
      'POST',
      '/v1/log-outcome',
      { body: payload }
    );
  }

  /**
   * Predict outcomes for a proposed action sequence
   * before executing it in the real environment.
   *
   * Uses the 3-tier simulation engine:
   *   Tier 1: Historical Wilson CI (always available)
   *   Tier 2: LightGBM model (after ~200 episodes)
   *   Tier 3: MCTS planning (after ~1000 episodes)
   *
   * The system selects the appropriate tier automatically.
   *
   * @example
   * ```ts
   * const result = await l5.simulate({
   *   proposedSequence: ['clear_cache', 'update_app'],
   *   context: { issue_type: 'payment_failed' },
   *   agentId: 'payment-bot',
   *   episodeHistory: ['update_app'],
   *   simulateAlternatives: 2,
   * });
   *
   * console.log(result.primary.predicted_outcome); // 0.83
   * console.log(result.simulation_tier);           // 2 or 3
   *
   * if (result.alternatives.length > 0) {
   *   const best = result.alternatives[0];
   *   if (best.better_than_proposed) {
   *     console.log(`Better path: ${best.actions}`);
   *   }
   * }
   * ```
   */
  async simulate(
    options: SimulateOptions
  ): Promise<SimulateResponse> {
    if (!options.proposedSequence || options.proposedSequence.length === 0) {
      throw new Layer5ValidationError(
        'proposedSequence cannot be empty. ' +
          'Provide at least one action name.',
        'proposedSequence'
      );
    }

    if (options.proposedSequence.length > 5) {
      throw new Layer5ValidationError(
        `proposedSequence max length is 5, got ${options.proposedSequence.length}. ` +
          'Layer5 plans sequences up to 5 steps.',
        'proposedSequence'
      );
    }

    const agentId = options.agentId ?? this.agentId;
    if (!agentId) {
      throw new Layer5ValidationError(
        'agentId is required.',
        'agentId'
      );
    }

    const payload: Record<string, unknown> = {
      agent_id: agentId,
      context: options.context,
      proposed_sequence: options.proposedSequence,
    };

    if (options.episodeHistory !== undefined) {
      payload.episode_history = options.episodeHistory;
    }
    if (options.simulateAlternatives !== undefined && options.simulateAlternatives !== 2) {
      payload.simulate_alternatives = options.simulateAlternatives;
    }
    if (options.maxSequenceDepth !== undefined && options.maxSequenceDepth !== 5) {
      payload.max_sequence_depth = options.maxSequenceDepth;
    }

    return this.request<SimulateResponse>(
      'POST',
      '/v1/simulate',
      { body: payload }
    );
  }

  /**
   * Submit delayed feedback for a previously logged outcome.
   * Use when you only know the true result hours later.
   */
  async logOutcomeFeedback(
    options: OutcomeFeedbackOptions
  ): Promise<OutcomeFeedbackResponse> {
    const payload: Record<string, unknown> = {
      outcome_id: options.outcomeId,
      final_score: options.finalScore,
      business_outcome: options.businessOutcome,
    };

    if (options.feedbackNotes !== undefined) {
      payload.feedback_notes = options.feedbackNotes;
    }

    return this.request<OutcomeFeedbackResponse>(
      'POST',
      '/v1/outcome-feedback',
      { body: payload }
    );
  }
}
