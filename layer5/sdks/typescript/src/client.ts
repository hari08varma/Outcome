// Layerinfinite SDK — client.ts
// Decision intelligence layer for AI agents. No LLMs. Just math.

import {
    LayerinfiniteAuthError,
    LayerinfiniteError,
    LayerinfiniteNotFoundError,
    LayerinfiniteRateLimitError,
    LayerinfiniteServerError,
    LowConfidenceError,
} from './errors.js';
import type {
    ActionEntry,
    ActionFunction,
    DelayedSignalMetadata,
    DiscrepancyDetectResponse,
    DiscrepancyDriftOptions,
    DiscrepancyDriftSnapshot,
    DiscrepancySummaryResponse,
    GetScoresResponse,
    LayerinfiniteConfig,
    LogOutcomeRequest,
    LogOutcomeResponse,
    ObservationSummary,
    OutcomeFeedbackRequest,
    OutcomeFeedbackResponse,
    PendingSignalRequest,
    PendingSignalResponse,
    RankedAction,
    Recommendation,
    ScoredAction,
    Suggestion,
    TrustStatus,
    WrappedActionFunction,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.layerinfinite.app';
const BASE_URLS_ENV = 'LAYERINFINITE_BASE_URLS';
const PENDING_OUTCOMES_FILE_ENV = 'LAYERINFINITE_PENDING_OUTCOMES_FILE';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const SDK_VERSION = '0.3.2';
const VALID_MODES = ['recommend', 'assist', 'auto'] as const;
const TRUST_STATUSES: readonly TrustStatus[] = ['trusted', 'probation', 'sandbox', 'suspended', 'new'];
const PENDING_REPLAY_INTERVAL_MS = 5_000;

// ── Pending outcome queue (Node.js only) ─────────────────────────────
// Uses dynamic import so the SDK stays importable in browser/edge envs.
// In non-Node environments the queue silently no-ops.

function getPendingOutcomesFile(): string {
    if (typeof process === 'undefined' || !process.env) return '';
    const custom = process.env[PENDING_OUTCOMES_FILE_ENV];
    if (custom) return custom;
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return `${home}/.layerinfinite/pending_outcomes.jsonl`;
}

async function enqueuePendingOutcome(payload: Record<string, unknown>): Promise<void> {
    const file = getPendingOutcomesFile();
    if (!file) return;
    try {
        const { appendFile, mkdir } = await import('node:fs/promises');
        const path = await import('node:path');
        await mkdir(path.dirname(file), { recursive: true });
        await appendFile(file, JSON.stringify(payload) + '\n', 'utf8');
    } catch {
        // Non-Node env or filesystem unavailable — silently skip
    }
}

async function flushPendingOutcomes(
    poster: (payload: Record<string, unknown>) => Promise<void>
): Promise<{ sent: number; remaining: number }> {
    const file = getPendingOutcomesFile();
    if (!file) return { sent: 0, remaining: 0 };
    try {
        const { readFile, writeFile, unlink } = await import('node:fs/promises');
        let raw: string;
        try {
            raw = await readFile(file, 'utf8');
        } catch {
            return { sent: 0, remaining: 0 }; // file doesn't exist yet
        }
        const lines = raw.split('\n').filter(l => l.trim());
        if (lines.length === 0) {
            await unlink(file).catch(() => undefined);
            return { sent: 0, remaining: 0 };
        }
        let sent = 0;
        const remaining: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            try {
                const payload = JSON.parse(lines[i]!) as Record<string, unknown>;
                await poster(payload);
                sent++;
            } catch {
                // Stop replaying on first failure — keep the rest
                remaining.push(...lines.slice(i));
                break;
            }
        }
        if (remaining.length > 0) {
            await writeFile(file, remaining.join('\n') + '\n', 'utf8');
        } else {
            await unlink(file).catch(() => undefined);
        }
        return { sent, remaining: remaining.length };
    } catch {
        return { sent: 0, remaining: 0 };
    }
}

function normalizeTrustStatus(value: unknown): TrustStatus {
    const normalized = String(value ?? '').toLowerCase();
    if (normalized === 'degraded') return 'sandbox';
    if (TRUST_STATUSES.includes(normalized as TrustStatus)) {
        return normalized as TrustStatus;
    }
    return 'probation';
}

/** Internal payload shape for POST /v1/log-outcome (not public API). */
interface InternalLogPayload {
    agent_id: string;
    action_name: string;
    issue_type: string;
    success: boolean;
    session_id: string;
    response_ms: number;
    idempotency_key: string;
    metadata?: Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

function readBaseUrlsFromEnv(): string[] {
    if (typeof process === 'undefined' || !process.env) {
        return [];
    }
    const raw = process.env[BASE_URLS_ENV];
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map(url => normalizeBaseUrl(url))
        .filter(Boolean);
}

export class Layerinfinite {
    private readonly apiKey: string;
    private readonly agentId: string;
    private readonly mode: 'recommend' | 'assist' | 'auto';
    private readonly confidenceThreshold: number;
    private readonly autoFallback: boolean;
    private readonly autoRegister: boolean;
    private readonly baseUrls: string[];
    private readonly timeout: number;
    private readonly maxRetries: number;
    private activeEndpointIndex: number;
    private lastPendingReplayAt: number = 0;

    /** task → (actionName → ActionEntry) */
    private readonly actions: Map<string, Map<string, ActionEntry>> = new Map();

    constructor(config: LayerinfiniteConfig) {
        // ── Validation ───────────────────────────────────────────
        if (!config.apiKey || !config.apiKey.startsWith('layerinfinite_')) {
            throw new LayerinfiniteError(
                "Invalid API key format. Key must start with 'layerinfinite_'. " +
                'Get your key from https://outcome-green.vercel.app/settings/api-keys'
            );
        }
        if (!config.agentId || !config.agentId.trim()) {
            throw new LayerinfiniteError('agentId must be a non-empty string.');
        }
        const mode = config.mode ?? 'recommend';
        if (!(VALID_MODES as readonly string[]).includes(mode)) {
            throw new LayerinfiniteError(
                `Invalid mode '${mode}'. Must be one of: ${VALID_MODES.join(', ')}.`
            );
        }
        const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
        if (threshold < 0.0 || threshold > 1.0) {
            throw new LayerinfiniteError(
                `confidenceThreshold must be between 0.0 and 1.0, got ${threshold}.`
            );
        }

        // ── Assign ───────────────────────────────────────────────
        this.apiKey = config.apiKey;
        this.agentId = config.agentId.trim();
        this.mode = mode;
        this.confidenceThreshold = threshold;
        this.autoFallback = config.autoFallback ?? true;
        this.autoRegister = config.autoRegister ?? true;
        const primaryBaseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
        this.baseUrls = this.resolveBaseUrls(primaryBaseUrl, config.baseUrls ?? []);
        this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.activeEndpointIndex = 0;
    }

    /**
     * Register an action function and return a wrapped version that
     * auto-logs every call's outcome to the backend.
     *
     * @example
     * // Inferred name from function.name:
     * const retryPayment = li.action('payment_failed', async function retryPayment(id: string) {
     *   return gateway.charge(id);
     * });
     *
     * // Explicit name (required for arrow functions):
     * const retryPayment = li.action('payment_failed', 'retry_payment', async (id: string) => {
     *   return gateway.charge(id);
     * });
     */
    action<TArgs extends any[], TReturn>(
        task: string,
        nameOrFn: string | ActionFunction<TArgs, TReturn>,
        maybeFn?: ActionFunction<TArgs, TReturn>,
    ): WrappedActionFunction<TArgs, TReturn> {
        // Resolve name and function from overloaded args
        let actionName: string | null;
        let fn: ActionFunction<TArgs, TReturn>;

        if (typeof nameOrFn === 'string') {
            actionName = nameOrFn;
            if (!maybeFn) {
                throw new LayerinfiniteError(
                    `li.action('${task}', '${nameOrFn}', fn) — fn is missing.`
                );
            }
            fn = maybeFn;
        } else {
            fn = nameOrFn;
            actionName = fn.name || null;
        }

        if (!actionName) {
            throw new LayerinfiniteError(
                'Action name required. Pass a named function or provide an explicit name: ' +
                `li.action('${task}', 'my_action_name', fn)`
            );
        }

        // Register in local registry
        if (!this.actions.has(task)) this.actions.set(task, new Map());
        this.actions.get(task)!.set(actionName, {
            fn: fn as ActionFunction,
            name: actionName,
            task,
            registeredVia: 'wrapper',
            createdAt: new Date().toISOString(),
        });

        // Auto-register in dashboard (fire-and-forget, no-op HTTP call — see registerActionInDashboard)
        if (this.autoRegister) {
            this.registerActionInDashboard(task, actionName).catch(err =>
                console.warn(`[layerinfinite] Dashboard registration failed: ${err}`)
            );
        }

        // Capture references for the closure (avoid 'this' binding issues)
        const self = this;
        const capturedActionName = actionName;
        const capturedTask = task;

        const wrapped = async function (...args: TArgs): Promise<TReturn> {
            const sessionId = crypto.randomUUID();
            const start = performance.now();
            let success = false;
            let errorMsg: string | undefined;

            try {
                const result = await fn(...args);
                success = true;
                return result;
            } catch (err) {
                success = false;
                errorMsg = err instanceof Error
                    ? `${err.constructor.name}: ${err.message}`
                    : String(err);
                throw err; // ALWAYS re-throw — never swallow
            } finally {
                const latencyMs = Math.round(performance.now() - start);
                // Fire-and-forget — intentionally not awaited
                self.logOutcomeInternal({
                    task: capturedTask,
                    actionName: capturedActionName,
                    success,
                    sessionId,
                    latencyMs,
                    error: errorMsg,
                }).catch(logErr =>
                    console.warn(`[layerinfinite] Failed to log outcome: ${logErr}`)
                );
            }
        };

        // Attach metadata to the wrapped function
        Object.defineProperty(wrapped, 'name', { value: capturedActionName, configurable: true });
        (wrapped as any)._liTask = capturedTask;
        (wrapped as any)._liAction = capturedActionName;

        return wrapped;
    }

    /**
     * Manually register an action without wrapping it.
     * No auto-logging on the function itself.
     * When executed via li.run(), the run() method handles logging directly.
     */
    registerAction(task: string, name: string, fn: ActionFunction): void {
        if (!task || !task.trim()) {
            throw new LayerinfiniteError('task must be a non-empty string.');
        }
        if (!name || !name.trim()) {
            throw new LayerinfiniteError('name must be a non-empty string.');
        }

        if (!this.actions.has(task)) this.actions.set(task, new Map());
        this.actions.get(task)!.set(name, {
            fn,
            name,
            task,
            registeredVia: 'manual',
            createdAt: new Date().toISOString(),
        });

        if (this.autoRegister) {
            this.registerActionInDashboard(task, name).catch(err =>
                console.warn(`[layerinfinite] Dashboard registration failed: ${err}`)
            );
        }
    }

    /**
     * List all registered actions, optionally filtered by task.
     * Returns { "payment_failed": ["retry_payment", "switch_provider"] }
     */
    listActions(task?: string): Record<string, string[]> {
        if (task !== undefined) {
            return { [task]: Array.from(this.actions.get(task)?.keys() ?? []) };
        }
        const result: Record<string, string[]> = {};
        for (const [t, actionMap] of this.actions) {
            result[t] = Array.from(actionMap.keys());
        }
        return result;
    }

    /**
     * Pick the best action for task, execute it, log outcome, return result.
     * Only available in mode='auto'.
     *
     * @throws {LayerinfiniteError} if mode !== 'auto', no actions registered, or all fail
     * @throws {LowConfidenceError} if confidence < confidenceThreshold
     */
    async run<TReturn = any>(task: string, ...args: any[]): Promise<TReturn> {
        if (this.mode !== 'auto') {
            throw new LayerinfiniteError(
                `run() is only available in 'auto' mode. ` +
                `Current mode: '${this.mode}'. ` +
                `Use mode: 'auto' when initializing Layerinfinite.`
            );
        }

        const taskActions = this.actions.get(task);
        if (!taskActions || taskActions.size === 0) {
            throw new LayerinfiniteError(
                `No actions registered for task '${task}'. ` +
                `Use li.action('${task}', fn) to register action functions.`
            );
        }

        // Build execution order from backend scores (fallback: registration order)
        const executionOrder = await this.buildExecutionOrder(task);

        // Confidence check on top action
        let topConfidence = 0.0;
        let topReason = 'No outcome data yet.';
        let scoresResp: GetScoresResponse | null = null;

        try {
            scoresResp = await this.fetchScores(task);
            if (scoresResp?.top_action) {
                topConfidence = scoresResp.top_action.confidence;
                topReason = scoresResp.top_action.policy_reason ?? 'Ranked by outcome history.';
            }

            if (scoresResp?.policy === 'abstain') {
                const ranked = this.buildRankedFromScores(scoresResp);
                const topName = scoresResp.top_action?.action_name
                    ?? executionOrder[0]
                    ?? 'unknown';
                const abstainReason = scoresResp.policy_abstain_message
                    ?? topReason
                    ?? 'Top actions are statistically indistinguishable. Gather more outcomes or escalate.';
                const suggestion: Suggestion = {
                    actionName: topName,
                    confidence: topConfidence,
                    reason: abstainReason,
                    ranked,
                };

                throw new LowConfidenceError(
                    `Policy abstain for task '${task}'. ${abstainReason}`,
                    suggestion,
                    topConfidence,
                    this.confidenceThreshold,
                );
            }
        } catch (err) {
            if (err instanceof LowConfidenceError) {
                throw err;
            }
            // fetchScores already logs a warning — continue with registration order
        }

        if (topConfidence > 0 && topConfidence < this.confidenceThreshold) {
            const ranked = this.buildRankedFromScores(scoresResp);
            const topName = executionOrder[0] ?? 'unknown';
            const suggestion: Suggestion = {
                actionName: topName,
                confidence: topConfidence,
                reason: topReason,
                ranked,
            };
            throw new LowConfidenceError(
                `Confidence ${(topConfidence * 100).toFixed(0)}% is below threshold ` +
                `${(this.confidenceThreshold * 100).toFixed(0)}% for task '${task}'. ` +
                `Best action: '${topName}'. ` +
                `Lower confidenceThreshold or wait for more outcome data.`,
                suggestion,
                topConfidence,
                this.confidenceThreshold,
            );
        }

        // Execute with fallback loop
        let lastError: unknown;

        for (let idx = 0; idx < executionOrder.length; idx++) {
            const actionName = executionOrder[idx]!;
            const entry = taskActions.get(actionName);
            if (!entry) continue;

            const sessionId = crypto.randomUUID();
            const start = performance.now();

            try {
                const result = await entry.fn(...args) as TReturn;
                const latencyMs = Math.round(performance.now() - start);
                console.log(
                    `[layerinfinite] ✓ task=${task} action=${actionName} succeeded (${latencyMs}ms)`
                );
                // Only log if manually registered (wrapper actions log themselves)
                if (entry.registeredVia === 'manual') {
                    this.logOutcomeInternal({
                        task, actionName, success: true,
                        sessionId, latencyMs,
                    }).catch(err =>
                        console.warn(`[layerinfinite] Failed to log outcome: ${err}`)
                    );
                }
                return result;
            } catch (err) {
                lastError = err;
                const latencyMs = Math.round(performance.now() - start);
                const errorMsg = err instanceof Error
                    ? `${err.constructor.name}: ${err.message}`
                    : String(err);

                console.warn(
                    `[layerinfinite] ✗ task=${task} action=${actionName} failed: ${errorMsg} (${latencyMs}ms)`
                );

                if (entry.registeredVia === 'manual') {
                    this.logOutcomeInternal({
                        task, actionName, success: false,
                        sessionId, latencyMs, error: errorMsg,
                    }).catch(logErr =>
                        console.warn(`[layerinfinite] Failed to log outcome: ${logErr}`)
                    );
                }

                if (!this.autoFallback) {
                    throw new LayerinfiniteError(
                        `Action '${actionName}' failed for task '${task}': ${errorMsg}`
                    );
                }

                if (idx + 1 < executionOrder.length) {
                    console.warn(
                        `[layerinfinite] ↻ task=${task} falling back to ${executionOrder[idx + 1]}`
                    );
                }
            }
        }

        throw new LayerinfiniteError(
            `All actions failed for task '${task}'. Last error: ${lastError}`
        );
    }

    /**
     * Return the best action recommendation without executing.
     * Only available in mode='assist'.
     */
    async suggest(task: string): Promise<Suggestion> {
        if (this.mode !== 'assist') {
            throw new LayerinfiniteError(
                `suggest() is only available in 'assist' mode. ` +
                `Current mode: '${this.mode}'. ` +
                `Use mode: 'assist' when initializing Layerinfinite.`
            );
        }

        const taskActions = this.actions.get(task);
        if (!taskActions || taskActions.size === 0) {
            throw new LayerinfiniteError(
                `No actions registered for task '${task}'. ` +
                `Use li.action('${task}', fn) to register action functions.`
            );
        }

        let scoresResp: GetScoresResponse | null = null;
        try {
            scoresResp = await this.fetchScores(task);
        } catch (err) {
            throw new LayerinfiniteError(
                `Cannot reach scoring engine: ${err}. ` +
                'Check your network connection and API key.'
            );
        }

        let suggestion: Suggestion;

        if (!scoresResp?.top_action) {
            // Cold start
            const firstAction = taskActions.keys().next().value as string;
            suggestion = {
                actionName: firstAction,
                confidence: 0,
                reason: 'No outcome data yet. This is the first registered action.',
                ranked: Array.from(taskActions.keys()).map(name => ({
                    actionName: name,
                    score: 0,
                    confidence: 0,
                })),
            };
        } else {
            suggestion = {
                actionName: scoresResp.top_action.action_name,
                confidence: scoresResp.top_action.confidence,
                reason: scoresResp.top_action.policy_reason
                    ?? `${scoresResp.top_action.action_name} has the highest outcome score.`,
                ranked: this.buildRankedFromScores(scoresResp),
            };
        }

        // Pretty-print
        console.log(`\n[layerinfinite] Suggestion for "${task}":`);
        console.log(`  Best action:  ${suggestion.actionName} (confidence: ${(suggestion.confidence * 100).toFixed(0)}%)`);
        console.log(`  Reason:       ${suggestion.reason}`);
        if (suggestion.ranked.length > 0) {
            console.log('  Ranked:');
            suggestion.ranked.forEach((r, i) => {
                console.log(`    ${i + 1}. ${r.actionName.padEnd(20)} (score: ${r.score.toFixed(2)})`);
            });
        }
        console.log('');

        return suggestion;
    }

    /**
     * Get a plain-English recommendation based on accumulated outcome data.
     * Available in ALL modes — no mode check.
     */
    async recommend(task: string): Promise<Recommendation> {
        const path = `/v1/recommendations?task=${encodeURIComponent(task)}`;
        const response = await this.fetchWithRetry(
            path,
            {
                method: 'GET',
                headers: this.authHeaders(),
            },
            code => code >= 500,
        );

        // Backend returns snake_case — map to camelCase
        const raw = await response.json() as {
            task: string;
            state: string;
            problem?: string | null;
            recommendation?: string | null;
            expected_improvement?: { baseline: string; improved: string; delta: string } | null;
            data_freshness?: {
                source?: 'mv' | 'fact_fallback' | 'unknown';
                last_seen_at?: string | null;
                age_hours?: number | null;
                is_stale?: boolean;
                stale_threshold_hours?: number;
            } | null;
            reason?: string | null;
            confidence?: number | null;
        };

        const rec: Recommendation = {
            task: raw.task ?? task,
            state: (raw.state as Recommendation['state']) ?? 'no_data',
            problem: raw.problem ?? null,
            recommendation: raw.recommendation ?? null,
            expectedImprovement: raw.expected_improvement ?? null,
            dataFreshness: raw.data_freshness
                ? {
                    source: raw.data_freshness.source ?? 'unknown',
                    lastSeenAt: raw.data_freshness.last_seen_at ?? null,
                    ageHours: raw.data_freshness.age_hours ?? null,
                    isStale: Boolean(raw.data_freshness.is_stale),
                    staleThresholdHours: raw.data_freshness.stale_threshold_hours ?? 72,
                }
                : null,
            reason: raw.reason ?? null,
            confidence: raw.confidence ?? null,
        };

        // Pretty-print
        console.log(`\n[layerinfinite] Recommendation for "${task}":`);
        console.log(`  State:      ${rec.state}`);
        if (rec.problem) console.log(`  Problem:    ${rec.problem}`);
        if (rec.recommendation) console.log(`  Action:     ${rec.recommendation}`);
        if (rec.expectedImprovement) {
            const i = rec.expectedImprovement;
            console.log(`  Impact:     ${i.baseline} → ${i.improved} (${i.delta})`);
        }
        if (rec.reason) console.log(`  Reason:     ${rec.reason}`);
        if (rec.confidence !== null && rec.confidence !== undefined) {
            console.log(`  Confidence: ${Math.round(rec.confidence * 100)}%`);
        }
        if (rec.dataFreshness?.isStale) {
            const age = rec.dataFreshness.ageHours;
            console.log(
                `  Freshness:  stale (${age !== null ? `${age.toFixed(1)}h` : 'unknown age'}) from ${rec.dataFreshness.source}`,
            );
        }
        console.log('');

        return rec;
    }

    /**
     * Fetch raw ranked action scores for a task.
     * Available in ALL modes.
     */
    async scores(task: string): Promise<GetScoresResponse> {
        const result = await this.fetchScores(task);
        return result ?? { ranked_actions: [], top_action: null, policy: 'explore', cold_start: true, outcomes_needed: 50, context_id: '', agent_id: this.agentId, served_from_cache: false };
    }

    /**
     * Get quick outcome stats for a task. Pretty-prints to console.
     * Available in ALL modes.
     */
    async observe(task: string): Promise<ObservationSummary> {
        const path = `/v1/observe?task=${encodeURIComponent(task)}`;
        const response = await this.fetchWithRetry(
            path,
            {
                method: 'GET',
                headers: this.authHeaders(),
            },
            code => code >= 500,
        );

        // Backend returns snake_case — map to camelCase
        const raw = await response.json() as {
            task: string;
            total_runs: number;
            success_rate: number;
            actions_seen: string[];
            best_performing?: string | null;
            worst_performing?: string | null;
            last_run?: string | null;
        };

        const obs: ObservationSummary = {
            task: raw.task,
            totalRuns: raw.total_runs,
            successRate: raw.success_rate,
            actionsSeen: raw.actions_seen ?? [],
            bestPerforming: raw.best_performing ?? null,
            worstPerforming: raw.worst_performing ?? null,
            lastRun: raw.last_run ?? null,
        };

        // Pretty-print
        console.log(`\n[layerinfinite] Stats for "${task}":`);
        console.log(`  Total runs:      ${obs.totalRuns}`);
        console.log(`  Success rate:    ${(obs.successRate * 100).toFixed(0)}%`);
        if (obs.totalRuns === 0) console.log('  No outcome data yet for this task.');
        if (obs.actionsSeen.length > 0) console.log(`  Actions seen:    ${obs.actionsSeen.join(', ')}`);
        if (obs.bestPerforming) console.log(`  Best performing: ${obs.bestPerforming}`);
        if (obs.worstPerforming) console.log(`  Worst performing: ${obs.worstPerforming}`);
        if (obs.lastRun) console.log(`  Last run:        ${obs.lastRun}`);
        console.log('');

        return obs;
    }

    /** Check API health. No auth required. */
    async health(): Promise<{ status: string; version: string }> {
        const response = await this.fetchWithRetry(
            '/health',
            {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            },
            code => code >= 500,
            5_000,
        );
        return response.json() as Promise<{ status: string; version: string }>;
    }

    /**
     * @deprecated Use li.scores(task) instead. Will be removed in v0.5.0.
     */
    async getScores(params: {
        agentId: string;
        issueType: string;
        environment?: string;
    }): Promise<GetScoresResponse> {
        return this.scores(params.issueType);
    }

    /**
     * @deprecated Use li.recommend(task) instead. Will be removed in v0.5.0.
     * Note: returns Recommendation (camelCase) not old RecommendationResponse (snake_case).
     */
    async getRecommendations(task: string): Promise<Recommendation> {
        return this.recommend(task);
    }

    /**
     * Power-user method: manually log an outcome.
     * Compatible with old LogOutcomeRequest shape (backward compat).
     */
    async logOutcome(request: LogOutcomeRequest): Promise<LogOutcomeResponse> {
        const payloadToSend: LogOutcomeRequest = {
            ...request,
            idempotency_key: request.idempotency_key ?? crypto.randomUUID(),
        };

        const response = await this.fetchWithRetry(
            '/v1/log-outcome',
            {
                method: 'POST',
                headers: this.authHeaders(true),
                body: JSON.stringify(payloadToSend),
            },
            code => code >= 500,
        );
        const payload = await response.json() as Partial<LogOutcomeResponse>;
        return {
            logged: Boolean(payload.logged),
            outcome_id: String(payload.outcome_id ?? ''),
            agent_trust_score: Number(payload.agent_trust_score ?? 0),
            trust_status: normalizeTrustStatus(payload.trust_status),
            policy: String(payload.policy ?? ''),
        };
    }

    /**
     * Register a delayed outcome signal so provider webhooks can reconcile later.
     */
    async registerPendingSignal(request: PendingSignalRequest): Promise<PendingSignalResponse> {
        const payloadToSend = {
            ...request,
            feedback_signal: 'delayed' as const,
        };

        const response = await this.fetchWithRetry(
            '/v1/pending-signals',
            {
                method: 'POST',
                headers: this.authHeaders(true),
                body: JSON.stringify(payloadToSend),
            },
            code => code >= 500,
        );

        const payload = await response.json() as Partial<PendingSignalResponse>;
        return {
            registration_id: String(payload.registration_id ?? ''),
            outcome_id: String(payload.outcome_id ?? ''),
            created_at: String(payload.created_at ?? ''),
            idempotent_replay: Boolean(payload.idempotent_replay),
            pending_state: payload.pending_state,
        };
    }

    /**
     * Submit delayed feedback to finalize an outcome after external signals arrive.
     */
    async submitOutcomeFeedback(request: OutcomeFeedbackRequest): Promise<OutcomeFeedbackResponse> {
        const response = await this.fetchWithRetry(
            '/v1/outcome-feedback',
            {
                method: 'POST',
                headers: this.authHeaders(true),
                body: JSON.stringify(request),
            },
            code => code >= 500,
        );

        const payload = await response.json() as Partial<OutcomeFeedbackResponse>;
        return {
            updated: Boolean(payload.updated),
            outcome_id: String(payload.outcome_id ?? ''),
            final_score: Number(payload.final_score ?? 0),
            business_outcome: String(payload.business_outcome ?? ''),
            cross_event_status: String(payload.cross_event_status ?? ''),
            cross_event_conflict: Boolean(payload.cross_event_conflict),
        };
    }

    /**
     * Build provider metadata from outcome_id for delayed signal callback correlation.
     */
    buildDelayedSignalMetadata(outcomeId: string): DelayedSignalMetadata {
        const normalizedOutcomeId = String(outcomeId ?? '').trim();
        if (!normalizedOutcomeId) {
            throw new LayerinfiniteError('outcomeId must be a non-empty string.');
        }

        return {
            outcome_id: normalizedOutcomeId,
            stripe: {
                metadata: {
                    layerinfinite_outcome_id: normalizedOutcomeId,
                },
            },
            sendgrid: {
                unique_args: {
                    outcome_id: normalizedOutcomeId,
                },
            },
            generic: {
                outcome_id: normalizedOutcomeId,
            },
        };
    }

    /**
     * Trigger discrepancy detection and return the detector summary.
     */
    async detectDiscrepancies(): Promise<DiscrepancyDetectResponse> {
        const response = await this.fetchWithRetry(
            '/v1/discrepancies/detect',
            {
                method: 'POST',
                headers: this.authHeaders(true),
                body: JSON.stringify({}),
            },
            code => code >= 500,
        );

        const payload = await response.json() as Partial<DiscrepancyDetectResponse>;
        return {
            detected: Number(payload.detected ?? 0),
            cases: {
                expired: Number(payload.cases?.expired ?? 0),
                mismatch: Number(payload.cases?.mismatch ?? 0),
                low_confidence: Number(payload.cases?.low_confidence ?? 0),
            },
            advanced_cases: {
                cross_event_conflict: Number(payload.advanced_cases?.cross_event_conflict ?? 0),
                pending_state_mismatch: Number(payload.advanced_cases?.pending_state_mismatch ?? 0),
                ingestion_inconsistency: Number(payload.advanced_cases?.ingestion_inconsistency ?? 0),
            },
        };
    }

    /**
     * Read unresolved discrepancy counts grouped by discrepancy_type.
     */
    async discrepancySummary(): Promise<DiscrepancySummaryResponse> {
        const response = await this.fetchWithRetry(
            '/v1/discrepancies/summary',
            {
                method: 'GET',
                headers: this.authHeaders(),
            },
            code => code >= 500,
        );

        const payload = await response.json() as Partial<DiscrepancySummaryResponse>;
        return {
            total: Number(payload.total ?? 0),
            by_type: payload.by_type ?? {},
        };
    }

    /**
     * Compute discrepancy and conflict drift rates for production monitoring.
     */
    async monitorDiscrepancyDrift(options: DiscrepancyDriftOptions = {}): Promise<DiscrepancyDriftSnapshot> {
        const runDetection = options.runDetection ?? true;
        const observedOutcomes = options.observedOutcomes;

        const detected = runDetection
            ? await this.detectDiscrepancies()
            : null;

        const summary = await this.discrepancySummary();

        const openTotalDiscrepancies = Number(summary.total ?? 0);
        const openConflictDiscrepancies = Number(summary.by_type.cross_event_conflict ?? 0);
        const openConflictShare = openTotalDiscrepancies > 0
            ? openConflictDiscrepancies / openTotalDiscrepancies
            : 0;

        const denominator = typeof observedOutcomes === 'number' && observedOutcomes > 0
            ? observedOutcomes
            : null;

        const discrepancyRate = denominator === null
            ? null
            : openTotalDiscrepancies / denominator;
        const conflictRate = denominator === null
            ? null
            : openConflictDiscrepancies / denominator;

        return {
            open_total_discrepancies: openTotalDiscrepancies,
            open_conflict_discrepancies: openConflictDiscrepancies,
            open_conflict_share: openConflictShare,
            discrepancy_rate: discrepancyRate,
            conflict_rate: conflictRate,
            detected_now: detected ? detected.detected : null,
            detected_conflicts_now: detected ? detected.advanced_cases.cross_event_conflict : null,
            by_type: summary.by_type,
        };
    }

    // ── Private: endpoint management ─────────────────────────────

    private resolveBaseUrls(primaryBaseUrl: string, configuredBaseUrls: string[]): string[] {
        const candidates = [
            primaryBaseUrl,
            ...configuredBaseUrls,
            ...readBaseUrlsFromEnv(),
        ];

        const deduped: string[] = [];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') {
                continue;
            }
            const normalized = normalizeBaseUrl(candidate);
            if (!normalized || deduped.includes(normalized)) {
                continue;
            }
            deduped.push(normalized);
        }

        return deduped.length ? deduped : [primaryBaseUrl];
    }

    private currentEndpoint(): { index: number; baseUrl: string } {
        const index = this.activeEndpointIndex;
        const baseUrl = this.baseUrls[index] ?? this.baseUrls[0] ?? DEFAULT_BASE_URL;
        return { index, baseUrl };
    }

    private rotateEndpoint(reason: string): void {
        if (this.baseUrls.length <= 1) {
            return;
        }
        const previousIndex = this.activeEndpointIndex;
        const nextIndex = (previousIndex + 1) % this.baseUrls.length;
        if (nextIndex === previousIndex) {
            return;
        }
        this.activeEndpointIndex = nextIndex;
        console.warn(
            `[layerinfinite] Endpoint failover: ${this.baseUrls[previousIndex]} -> ${this.baseUrls[nextIndex]} (${reason})`,
        );
    }

    private buildEndpointUrl(baseUrl: string, path: string): string {
        if (/^https?:\/\//i.test(path)) {
            return path;
        }
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        return `${baseUrl}${normalizedPath}`;
    }

    // ── Private: headers ─────────────────────────────────────────

    private authHeaders(withContentType = false): Record<string, string> {
        const headers: Record<string, string> = {
            'X-API-Key': this.apiKey,
            'User-Agent': `layerinfinite-ts-sdk/${SDK_VERSION}`,
            'Accept': 'application/json',
        };
        if (withContentType) headers['Content-Type'] = 'application/json';
        return headers;
    }

    // ── Private: internal outcome logging ────────────────────────

    /**
     * POST /v1/log-outcome with the internal simplified payload.
     * Fire-and-forget from wrappers (called with .catch()).
     * NEVER throws to caller — catches everything and console.warns.
     */
    private async logOutcomeInternal(params: {
        task: string;
        actionName: string;
        success: boolean;
        sessionId: string;
        latencyMs: number;
        error?: string;
    }): Promise<void> {
        const payload: InternalLogPayload = {
            agent_id: this.agentId,
            action_name: params.actionName,
            issue_type: params.task,
            success: params.success,
            session_id: params.sessionId,
            response_ms: params.latencyMs,
            idempotency_key: crypto.randomUUID(),
        };
        if (params.error) {
            payload.metadata = { error: params.error };
        }

        // Replay pending outcomes from previous failed calls (throttled to once per 5s)
        const now = Date.now();
        if (now - this.lastPendingReplayAt >= PENDING_REPLAY_INTERVAL_MS) {
            this.lastPendingReplayAt = now;
            flushPendingOutcomes(async (queued) => {
                await this.fetchWithRetry(
                    '/v1/log-outcome',
                    { method: 'POST', headers: this.authHeaders(true), body: JSON.stringify(queued) },
                    code => code >= 500,
                );
            }).then(({ sent, remaining }) => {
                if (sent > 0) {
                    console.info(`[layerinfinite] Replayed ${sent} pending outcome(s) (${remaining} remaining).`);
                }
            }).catch(() => undefined); // never throws to caller
        }

        try {
            await this.fetchWithRetry(
                '/v1/log-outcome',
                {
                    method: 'POST',
                    headers: this.authHeaders(true),
                    body: JSON.stringify(payload),
                },
                code => code >= 500,
            );
        } catch (err) {
            if (err instanceof LayerinfiniteAuthError) {
                // Auth errors are permanent — do not queue (retrying won't help)
                console.warn(
                    `[layerinfinite] Failed to log outcome for ${params.task}/${params.actionName} — auth error, not queued: ${err}`
                );
            } else {
                // Network/server errors — queue for replay on next call
                enqueuePendingOutcome(payload as unknown as Record<string, unknown>).catch(() => undefined);
                console.warn(
                    `[layerinfinite] Failed to log outcome for ${params.task}/${params.actionName} — queued for replay: ${err}`
                );
            }
        }
    }

    // ── Private: dashboard registration (NO-OP) ──────────────────

    /**
     * NO-OP. Action registration is handled automatically by the backend.
     *
     * When the wrapped action is called for the first time, logOutcomeInternal()
     * fires POST /v1/log-outcome. The server's validateActionMiddleware intercepts
     * that request and upserts the action into dim_actions scoped to this customer.
     * It also seeds dim_institutional_knowledge with a baseline prior so scoring
     * starts immediately.
     *
     * The /v1/actions/register endpoint requires customer_admin session auth —
     * not an agent API key. Calling it from the SDK produces a 401 on every
     * li.action() invocation. DO NOT add an HTTP call here.
     *
     * autoRegister=true is preserved for forward compatibility when a dedicated
     * SDK-accessible registration endpoint is added.
     */
    private async registerActionInDashboard(task: string, actionName: string): Promise<void> {
        if (this.autoRegister) {
            console.debug(
                `[layerinfinite] '${task}/${actionName}' will be auto-registered in dashboard ` +
                `on first outcome log via validateActionMiddleware.`
            );
        }
    }

    // ── Private: scores fetcher ───────────────────────────────────

    /**
     * GET /v1/get-scores?issue_type={task}&environment=production
     * Returns null if cold start (no scores available yet).
     * NOTE: Do NOT send agent_id as query param — backend resolves via X-API-Key.
     */
    private async fetchScores(task: string): Promise<GetScoresResponse | null> {
        try {
            const qs = new URLSearchParams({
                issue_type: task,
                environment: 'production',
            });
            const response = await this.fetchWithRetry(
                `/v1/get-scores?${qs.toString()}`,
                {
                    method: 'GET',
                    headers: this.authHeaders(),
                },
                code => code >= 500,
            );
            const data = await response.json() as GetScoresResponse;
            if (!data.ranked_actions?.length && !data.top_action) return null;
            return data;
        } catch (err) {
            if (err instanceof LayerinfiniteAuthError || err instanceof LayerinfiniteNotFoundError) {
                throw err;
            }
            console.warn(`[layerinfinite] fetchScores failed: ${err}`);
            return null;
        }
    }

    // ── Private: execution order builder ─────────────────────────

    /**
     * Returns action names in execution priority order:
     *   1. Actions ranked by backend score (highest first)
     *   2. Registered actions NOT in backend scores (appended — cold start)
     * Fallback on error: Map insertion order (guaranteed in JS).
     */
    private async buildExecutionOrder(task: string): Promise<string[]> {
        const taskActions = this.actions.get(task);
        const registeredNames = taskActions ? Array.from(taskActions.keys()) : [];
        const registeredSet = new Set(registeredNames);

        try {
            const scoresResp = await this.fetchScores(task);
            if (!scoresResp?.ranked_actions?.length) return registeredNames;

            const scoredActions = scoresResp.ranked_actions
                .filter(a => registeredSet.has(a.action_name));
            let scoredNames = scoredActions.map(a => a.action_name);

            const actionIdToName = new Map<string, string>(
                scoredActions.map((a) => [a.action_id, a.action_name])
            );

            if (scoresResp.policy === 'explore') {
                const targetName = scoresResp.policy_exploration_target
                    ? actionIdToName.get(scoresResp.policy_exploration_target)
                    : null;

                if (targetName && scoredNames.includes(targetName)) {
                    scoredNames = [
                        targetName,
                        ...scoredNames.filter((name) => name !== targetName),
                    ];
                } else if (scoredNames.length > 1) {
                    const fallback = scoredNames[1]!;
                    scoredNames = [
                        fallback,
                        ...scoredNames.filter((name) => name !== fallback),
                    ];
                }
            }

            if (scoresResp.policy === 'exploit') {
                const selectedName = scoresResp.policy_selected_action
                    ? actionIdToName.get(scoresResp.policy_selected_action)
                    : scoredNames[0] ?? null;

                if (selectedName && scoredNames.includes(selectedName)) {
                    scoredNames = [
                        selectedName,
                        ...scoredNames.filter((name) => name !== selectedName),
                    ];
                }
            }

            const unscored = registeredNames.filter(name => !scoredNames.includes(name));
            return [...scoredNames, ...unscored];
        } catch {
            console.warn(
                `[layerinfinite] Cannot reach scoring engine, using registration order.`
            );
            return registeredNames;
        }
    }

    // ── Private: score mapper ─────────────────────────────────────

    private buildRankedFromScores(scoresResp: GetScoresResponse | null): RankedAction[] {
        if (!scoresResp?.ranked_actions?.length) return [];
        return scoresResp.ranked_actions.map(a => ({
            actionName: a.action_name,
            score: a.composite_score,
            confidence: a.confidence,
        }));
    }

    // ── Private: fetchWithRetry ───────────────────────────────────

    /**
     * Native fetch with AbortController timeout + retry logic.
     *   - 429: wait Retry-After seconds, retry up to maxRetries
     *   - isRetryable(status): rotate endpoint and exponential backoff 1s→2s→4s
     *   - Timeout / network error: rotate endpoint and retry up to maxRetries
     *   - 401, 404: throw immediately (no retry)
     */
    private async fetchWithRetry(
        path: string,
        init: RequestInit,
        isRetryableStatus: (code: number) => boolean,
        timeoutMs = this.timeout,
    ): Promise<Response> {
        let lastErr: unknown;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const { baseUrl } = this.currentEndpoint();
            const url = this.buildEndpointUrl(baseUrl, path);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(url, { ...init, signal: controller.signal });

                // 429 — wait Retry-After then retry
                if (response.status === 429 && attempt < this.maxRetries) {
                    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
                    await sleep(retryAfter * 1000);
                    continue;
                }

                // Retryable 5xx — exponential backoff
                if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
                    this.rotateEndpoint(`server error ${response.status}`);
                    await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
                    continue;
                }

                // Non-2xx — raise typed error
                if (!response.ok) await this.raiseForStatus(response);

                return response;

            } catch (err) {
                if (err instanceof LayerinfiniteError) throw err;
                if (err instanceof Error && err.name === 'AbortError') {
                    this.rotateEndpoint('timeout');
                    lastErr = new LayerinfiniteError(`Request timed out after ${timeoutMs}ms`);
                } else {
                    this.rotateEndpoint('network request error');
                    lastErr = new LayerinfiniteError(`Network error: ${String(err)}`);
                }
                if (attempt >= this.maxRetries) throw lastErr;
                await sleep(Math.min(1000 * Math.pow(2, attempt), 8_000));
            } finally {
                clearTimeout(timer);
            }
        }

        throw lastErr ?? new LayerinfiniteError('Max retries exceeded.');
    }

    // ── Private: raiseForStatus ───────────────────────────────────

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
            const payload = body as Record<string, unknown>;
            const base = payload?.error ?? 'unknown server error';
            const details = payload?.details;
            const msg = details
                ? `${base} | details: ${String(details)}`
                : base;
            throw new LayerinfiniteServerError(
                `Layerinfinite server error [${code}]: ${msg}`, code, body
            );
        }
        throw new LayerinfiniteError(`Request error [${code}]`, code, body);
    }
}

// ── Backward compatibility alias ─────────────────────────────────
export { Layerinfinite as LayerinfiniteClient };