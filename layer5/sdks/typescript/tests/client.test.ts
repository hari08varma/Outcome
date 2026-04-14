// Layerinfinite TypeScript SDK — tests/client.test.ts
// Run with: npm test (vitest)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LayerinfiniteAuthError,
    LayerinfiniteClient,
    LowConfidenceError,
    LayerinfiniteRateLimitError,
} from '../src/index.js';

const BASE_URL = 'https://test.layerinfinite.ai';
const API_KEY = 'layerinfinite_testkey123456789';

const MOCK_SCORED_ACTION = {
    action_id: 'act-uuid-1',
    action_name: 'escalate_to_senior',
    action_category: 'escalation',
    composite_score: 0.87,
    confidence: 0.72,
    total_attempts: 42,
    policy_reason: 'top_performer',
    is_cold_start: false,
};

const MOCK_GET_SCORES_BODY = {
    ranked_actions: [MOCK_SCORED_ACTION],
    top_action: MOCK_SCORED_ACTION,
    policy: 'exploit',
    cold_start: false,
    context_id: 'ctx-uuid-1',
    agent_id: 'my-agent',
    served_from_cache: false,
};

const MOCK_GET_SCORES_BODY_WITH_EXPLORE_TARGET = {
    ranked_actions: [
        {
            action_id: 'act-uuid-1',
            action_name: 'escalate_to_senior',
            action_category: 'escalation',
            composite_score: 0.87,
            confidence: 0.72,
            total_attempts: 42,
            policy_reason: 'top_performer',
            is_cold_start: false,
        },
        {
            action_id: 'act-uuid-2',
            action_name: 'retry_with_backoff',
            action_category: 'remediation',
            composite_score: 0.79,
            confidence: 0.68,
            total_attempts: 31,
            policy_reason: 'runner_up',
            is_cold_start: false,
        },
        {
            action_id: 'act-uuid-3',
            action_name: 'pin_previous_image',
            action_category: 'rollback',
            composite_score: 0.74,
            confidence: 0.64,
            total_attempts: 19,
            policy_reason: 'exploration_candidate',
            is_cold_start: false,
        },
    ],
    top_action: {
        action_id: 'act-uuid-1',
        action_name: 'escalate_to_senior',
        action_category: 'escalation',
        composite_score: 0.87,
        confidence: 0.72,
        total_attempts: 42,
        policy_reason: 'top_performer',
        is_cold_start: false,
    },
    policy: 'explore',
    policy_exploration_target: 'act-uuid-3',
    cold_start: false,
    context_id: 'ctx-uuid-2',
    agent_id: 'my-agent',
    served_from_cache: false,
};

const MOCK_GET_SCORES_BODY_ABSTAIN = {
    ranked_actions: [
        {
            action_id: 'act-uuid-1',
            action_name: 'candidate_action',
            action_category: 'remediation',
            composite_score: 0.59,
            confidence: 0.58,
            total_attempts: 12,
            policy_reason: 'near_tie',
            is_cold_start: false,
        },
        {
            action_id: 'act-uuid-2',
            action_name: 'alternate_action',
            action_category: 'escalation',
            composite_score: 0.58,
            confidence: 0.57,
            total_attempts: 11,
            policy_reason: 'near_tie',
            is_cold_start: false,
        },
    ],
    top_action: {
        action_id: 'act-uuid-1',
        action_name: 'candidate_action',
        action_category: 'remediation',
        composite_score: 0.59,
        confidence: 0.58,
        total_attempts: 12,
        policy_reason: 'near_tie',
        is_cold_start: false,
    },
    policy: 'abstain',
    policy_abstain_message: 'Top actions are statistically indistinguishable.',
    cold_start: false,
    context_id: 'ctx-uuid-abstain',
    agent_id: 'my-agent',
    served_from_cache: false,
};

const MOCK_LOG_OUTCOME_BODY = {
    logged: true,
    outcome_id: 'out-uuid-1',
    agent_trust_score: 0.74,
    trust_status: 'trusted',
    policy: 'exploit',
    ingestion_quality: {
        data_quality: 0.92,
        score_origin: 'inferred',
        is_inconsistent: false,
        mapping_tier: 'exact_match',
        mapping_confidence: 1.0,
        execution_status: 'COMPLETED',
        status_origin: 'inferred_from_success',
    },
};

const MOCK_LOG_OUTCOME_BODY_LEGACY_DEGRADED = {
    logged: true,
    outcome_id: 'out-uuid-legacy',
    agent_trust_score: 0.21,
    trust_status: 'degraded',
    policy: 'SANDBOX',
};

const MOCK_PENDING_SIGNAL_RESPONSE = {
    registration_id: 'reg-uuid-1',
    outcome_id: 'out-uuid-1',
    created_at: '2026-04-07T10:00:00.000Z',
    idempotent_replay: false,
    pending_state: {
        signal_pending: true,
        cross_event_status: 'pending_signal',
    },
};

const MOCK_OUTCOME_FEEDBACK_RESPONSE = {
    updated: true,
    outcome_id: 'out-uuid-1',
    final_score: 0.25,
    business_outcome: 'failed',
    cross_event_status: 'conflict',
    cross_event_conflict: true,
};

const MOCK_DISCREPANCY_DETECT_RESPONSE = {
    detected: 8,
    cases: {
        expired: 2,
        mismatch: 3,
        low_confidence: 1,
    },
    advanced_cases: {
        cross_event_conflict: 2,
        pending_state_mismatch: 0,
        ingestion_inconsistency: 0,
    },
};

const MOCK_DISCREPANCY_SUMMARY_RESPONSE = {
    total: 20,
    by_type: {
        cross_event_conflict: 5,
        outcome_mismatch: 9,
        ingestion_inconsistency: 6,
    },
};

const MOCK_RECOMMENDATION_BODY = {
    task: 'billing_dispute',
    state: 'stable',
    problem: 'retry_with_backoff underperforms',
    recommendation: 'escalate_to_senior',
    expected_improvement: {
        baseline: '62.0%',
        improved: '79.0%',
        delta: '+17.0%',
    },
    data_freshness: {
        source: 'mv',
        last_seen_at: '2026-04-05T10:00:00.000Z',
        age_hours: 4,
        is_stale: false,
        stale_threshold_hours: 72,
    },
    reason: 'historically strongest action',
    confidence: 0.91,
    confidence_source: 'empirical_stable',
    traceability: {
        reason_code: 'stable_recommendation',
        stage: 'decision',
        gate: null,
        detail: 'Recommendation is stable under current reliability gates.',
    },
};

function mockResponse(
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    });
}

describe('LayerinfiniteClient', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // ── Test 1 ─────────────────────────────────────────────────
    it('Test 1: getScores returns typed GetScoresResponse', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_GET_SCORES_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const result = await client.getScores({
            agentId: 'my-agent',
            issueType: 'billing_dispute',
        });

        expect(result.top_action).toBeDefined();
        expect(result.top_action?.action_name).toBe('escalate_to_senior');
        expect(result.top_action?.composite_score).toBeCloseTo(0.87);
        expect(['exploit', 'explore', 'escalate', 'SANDBOX', 'abstain']).toContain(result.policy);
        expect(result.ranked_actions).toHaveLength(1);
    });

    it('Test 1b: auto mode prioritizes policy exploration target in execution order', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse(MOCK_GET_SCORES_BODY_WITH_EXPLORE_TARGET),
        );

        const client = new LayerinfiniteClient({
            apiKey: API_KEY,
            agentId: 'my-agent',
            baseUrl: BASE_URL,
            mode: 'auto',
        });

        client.registerAction('billing_dispute', 'escalate_to_senior', async () => true);
        client.registerAction('billing_dispute', 'retry_with_backoff', async () => true);
        client.registerAction('billing_dispute', 'pin_previous_image', async () => true);

        const { order: executionOrder } = await (client as any).buildExecutionOrder('billing_dispute');

        expect(executionOrder.slice(0, 3)).toEqual([
            'pin_previous_image',
            'escalate_to_senior',
            'retry_with_backoff',
        ]);
    });

    it('Test 1c: auto mode raises LowConfidenceError on policy abstain and skips execution', async () => {
        const client = new LayerinfiniteClient({
            apiKey: API_KEY,
            agentId: 'my-agent',
            baseUrl: BASE_URL,
            mode: 'auto',
        });

        const executed: string[] = [];
        client.registerAction('billing_dispute', 'candidate_action', async () => {
            executed.push('candidate_action');
            return true;
        });

        vi.spyOn(client as any, 'buildExecutionOrder').mockResolvedValue(['candidate_action']);
        vi.spyOn(client as any, 'fetchScores').mockResolvedValue(MOCK_GET_SCORES_BODY_ABSTAIN);

        await expect(client.run('billing_dispute')).rejects.toBeInstanceOf(LowConfidenceError);

        expect(executed).toHaveLength(0);
    });

    // ── Test 2 ─────────────────────────────────────────────────
    it('Test 2: 401 throws LayerinfiniteAuthError', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse({ error: 'Unauthorized' }, 401),
        );

        const client = new LayerinfiniteClient({ apiKey: 'layerinfinite_bad_key', agentId: 'my-agent', baseUrl: BASE_URL, maxRetries: 0 });

        await expect(
            client.getScores({ agentId: 'agent-1', issueType: 'test' }),
        ).rejects.toBeInstanceOf(LayerinfiniteAuthError);
    });

    // ── Test 3 ─────────────────────────────────────────────────
    it('Test 3: 429 throws LayerinfiniteRateLimitError with retryAfter', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '30' }),
        );

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL, maxRetries: 0 });

        let error: unknown;
        try {
            await client.logOutcome({
                agent_id: 'my-agent',
                action_id: 'act-uuid-1',
                context_id: 'ctx-uuid-1',
                issue_type: 'test',
                success: true,
            });
        } catch (err) {
            error = err;
        }

        expect(error).toBeInstanceOf(LayerinfiniteRateLimitError);
        expect((error as LayerinfiniteRateLimitError).retryAfter).toBe(30);
        expect((error as LayerinfiniteRateLimitError).statusCode).toBe(429);
    });

    // ── Test 4 ─────────────────────────────────────────────────
    it('Test 4: logOutcome returns LogOutcomeResponse', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_LOG_OUTCOME_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const response = await client.logOutcome({
            agent_id: 'my-agent',
            action_id: 'act-uuid-1',
            context_id: 'ctx-uuid-1',
            issue_type: 'billing_dispute',
            success: true,
            outcome_score: 0.9,
            business_outcome: 'resolved',
        });

        expect(response.logged).toBe(true);
        expect(typeof response.agent_trust_score).toBe('number');
        expect(response.outcome_id).toBe('out-uuid-1');
        expect(response.trust_status).toBe('trusted');
        expect(response.ingestion_quality?.score_origin).toBe('inferred');
        expect(response.ingestion_quality?.execution_status).toBe('COMPLETED');
    });

    it('Test 4b: logOutcome normalizes legacy degraded trust_status to sandbox', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_LOG_OUTCOME_BODY_LEGACY_DEGRADED));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const response = await client.logOutcome({
            agent_id: 'my-agent',
            action_id: 'act-uuid-legacy',
            context_id: 'ctx-uuid-legacy',
            issue_type: 'billing_dispute',
            success: false,
            outcome_score: 0.2,
            business_outcome: 'failed',
        });

        expect(response.outcome_id).toBe('out-uuid-legacy');
        expect(response.trust_status).toBe('sandbox');
    });

    it('Test 4c: logOutcome auto-populates idempotency_key when omitted', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_LOG_OUTCOME_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        await client.logOutcome({
            agent_id: 'my-agent',
            action_id: 'act-uuid-1',
            context_id: 'ctx-uuid-1',
            issue_type: 'billing_dispute',
            success: true,
            outcome_score: 0.92,
        });

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as { idempotency_key?: string };
        expect(typeof body.idempotency_key).toBe('string');
        expect((body.idempotency_key ?? '').length).toBeGreaterThan(0);
    });

    it('Test 4d: logOutcome accepts missing outcome_score and maps action_id to action_id_input', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_LOG_OUTCOME_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        await client.logOutcome({
            agent_id: 'my-agent',
            action_id: 'act-uuid-no-score',
            issue_type: 'billing_dispute',
            success: true,
        });

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as {
            outcome_score?: number;
            action_id?: string;
            action_id_input?: string;
        };

        expect(body.outcome_score).toBeUndefined();
        expect(body.action_id).toBe('act-uuid-no-score');
        expect(body.action_id_input).toBe('act-uuid-no-score');
    });

    it('Test 4e: internal logging omits response_ms when latency is zero', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_LOG_OUTCOME_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        await (client as any).logOutcomeInternal({
            task: 'billing_dispute',
            actionName: 'escalate_to_senior',
            success: true,
            sessionId: 'session-zero',
            latencyMs: 0,
        });

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as { response_ms?: number };
        expect(body.response_ms).toBeUndefined();
    });

    it('Test 4f: internal logging does not queue non-retryable 4xx errors', async () => {
        const fs = await import('node:fs/promises');
        const os = await import('node:os');
        const path = await import('node:path');

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-ts-queue-'));
        const pendingFile = path.join(tempDir, 'pending_outcomes.jsonl');
        process.env.LAYERINFINITE_PENDING_OUTCOMES_FILE = pendingFile;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        fetchSpy.mockResolvedValueOnce(
            mockResponse({ error: 'Invalid request body', details: 'response_ms must be positive' }, 400),
        );

        try {
            const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL, maxRetries: 0 });
            await (client as any).logOutcomeInternal({
                task: 'billing_dispute',
                actionName: 'escalate_to_senior',
                success: true,
                sessionId: 'session-bad-request',
                latencyMs: 0,
            });

            const warnedNotQueued = warnSpy.mock.calls.some((call) =>
                String(call[0] ?? '').includes('not queued')
            );
            expect(warnedNotQueued).toBe(true);

            const exists = await fs.access(pendingFile).then(() => true).catch(() => false);
            expect(exists).toBe(false);
        } finally {
            warnSpy.mockRestore();
            delete process.env.LAYERINFINITE_PENDING_OUTCOMES_FILE;
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });

    // ── Test 5 ─────────────────────────────────────────────────
    it('Test 5: health check sends no X-API-Key header', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse({ status: 'ok', version: '1.0.0' }),
        );

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const result = await client.health();

        expect(result.status).toBe('ok');
        expect(result.version).toBe('1.0.0');

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['X-API-Key']).toBeUndefined();
    });

    it('Test 6: getScores fails over to secondary endpoint on DNS/network error', async () => {
        const primaryBaseUrl = 'https://primary.layerinfinite.ai';
        const secondaryBaseUrl = 'https://secondary.layerinfinite.ai';

        fetchSpy
            .mockRejectedValueOnce(new TypeError('fetch failed: getaddrinfo ENOTFOUND primary.layerinfinite.ai'))
            .mockResolvedValueOnce(mockResponse(MOCK_GET_SCORES_BODY));

        const client = new LayerinfiniteClient({
            apiKey: API_KEY,
            agentId: 'my-agent',
            baseUrl: primaryBaseUrl,
            baseUrls: [secondaryBaseUrl],
            maxRetries: 1,
        });

        const result = await client.getScores({
            agentId: 'my-agent',
            issueType: 'billing_dispute',
        });

        expect(result.top_action?.action_name).toBe('escalate_to_senior');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        const [firstUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const [secondUrl] = fetchSpy.mock.calls[1] as [string, RequestInit];

        expect(new URL(firstUrl).origin).toBe(primaryBaseUrl);
        expect(new URL(secondUrl).origin).toBe(secondaryBaseUrl);
        expect(new URL(secondUrl).pathname).toBe('/v1/get-scores');
        expect(new URL(secondUrl).searchParams.get('issue_type')).toBe('billing_dispute');
    });

    it('Test 7: recommend maps data_freshness to typed dataFreshness', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_RECOMMENDATION_BODY));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const rec = await client.recommend('billing_dispute');

        expect(rec.task).toBe('billing_dispute');
        expect(rec.recommendation).toBe('escalate_to_senior');
        expect(rec.dataFreshness).not.toBeNull();
        expect(rec.dataFreshness?.source).toBe('mv');
        expect(rec.dataFreshness?.ageHours).toBe(4);
        expect(rec.dataFreshness?.isStale).toBe(false);
        expect(rec.dataFreshness?.staleThresholdHours).toBe(72);
        expect(rec.confidenceSource).toBe('empirical_stable');
        expect((rec.traceability as { reason_code?: string } | null)?.reason_code).toBe('stable_recommendation');
    });

    it('Test 8: registerPendingSignal enforces delayed feedback signal', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_PENDING_SIGNAL_RESPONSE, 201));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const result = await client.registerPendingSignal({
            outcome_id: '8fc5b70f-3d48-4dc8-a937-5464248f22f8',
            action_name: 'retry_payment',
            provider_hint: 'stripe',
        });

        expect(result.registration_id).toBe('reg-uuid-1');
        expect(result.pending_state?.cross_event_status).toBe('pending_signal');

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(String(init.body)) as { feedback_signal?: string };
        expect(body.feedback_signal).toBe('delayed');
    });

    it('Test 9: submitOutcomeFeedback maps cross-event response fields', async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(MOCK_OUTCOME_FEEDBACK_RESPONSE));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const result = await client.submitOutcomeFeedback({
            outcome_id: 'out-uuid-1',
            final_score: 0.25,
            business_outcome: 'failed',
            feedback_notes: 'webhook status=failed',
        });

        expect(result.updated).toBe(true);
        expect(result.cross_event_conflict).toBe(true);
        expect(result.cross_event_status).toBe('conflict');
    });

    it('Test 10: monitorDiscrepancyDrift computes discrepancy and conflict rates', async () => {
        fetchSpy
            .mockResolvedValueOnce(mockResponse(MOCK_DISCREPANCY_DETECT_RESPONSE))
            .mockResolvedValueOnce(mockResponse(MOCK_DISCREPANCY_SUMMARY_RESPONSE));

        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const drift = await client.monitorDiscrepancyDrift({ observedOutcomes: 200 });

        expect(drift.open_total_discrepancies).toBe(20);
        expect(drift.open_conflict_discrepancies).toBe(5);
        expect(drift.discrepancy_rate).toBeCloseTo(0.1);
        expect(drift.conflict_rate).toBeCloseTo(0.025);
        expect(drift.detected_now).toBe(8);
        expect(drift.detected_conflicts_now).toBe(2);
    });

    it('Test 11: buildDelayedSignalMetadata maps provider-specific payload fields', () => {
        const client = new LayerinfiniteClient({ apiKey: API_KEY, agentId: 'my-agent', baseUrl: BASE_URL });
        const metadata = client.buildDelayedSignalMetadata('out-123');

        expect(metadata.stripe.metadata.layerinfinite_outcome_id).toBe('out-123');
        expect(metadata.sendgrid.unique_args.outcome_id).toBe('out-123');
        expect(metadata.generic.outcome_id).toBe('out-123');
    });
});
