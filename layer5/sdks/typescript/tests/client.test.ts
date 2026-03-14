// Layerinfinite TypeScript SDK — tests/client.test.ts
// Run with: npm test (vitest)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LayerinfiniteAuthError,
    LayerinfiniteClient,
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

const MOCK_LOG_OUTCOME_BODY = {
    logged: true,
    outcome_id: 'out-uuid-1',
    agent_trust_score: 0.74,
    trust_status: 'trusted',
    policy: 'exploit',
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

        const client = new LayerinfiniteClient({ apiKey: API_KEY, baseUrl: BASE_URL });
        const result = await client.getScores({
            agentId: 'my-agent',
            issueType: 'billing_dispute',
        });

        expect(result.top_action).toBeDefined();
        expect(result.top_action?.action_name).toBe('escalate_to_senior');
        expect(result.top_action?.composite_score).toBeCloseTo(0.87);
        expect(['exploit', 'explore', 'escalate']).toContain(result.policy);
        expect(result.ranked_actions).toHaveLength(1);
    });

    // ── Test 2 ─────────────────────────────────────────────────
    it('Test 2: 401 throws LayerinfiniteAuthError', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse({ error: 'Unauthorized' }, 401),
        );

        const client = new LayerinfiniteClient({ apiKey: 'bad_key', baseUrl: BASE_URL, maxRetries: 0 });

        await expect(
            client.getScores({ agentId: 'agent-1', issueType: 'test' }),
        ).rejects.toBeInstanceOf(LayerinfiniteAuthError);
    });

    // ── Test 3 ─────────────────────────────────────────────────
    it('Test 3: 429 throws LayerinfiniteRateLimitError with retryAfter', async () => {
        fetchSpy.mockResolvedValue(
            mockResponse({ error: 'Too Many Requests' }, 429, { 'Retry-After': '30' }),
        );

        const client = new LayerinfiniteClient({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 0 });

        let error: unknown;
        try {
            await client.getScores({ agentId: 'agent-1', issueType: 'test' });
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

        const client = new LayerinfiniteClient({ apiKey: API_KEY, baseUrl: BASE_URL });
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
    });

    // ── Test 5 ─────────────────────────────────────────────────
    it('Test 5: health check sends no X-API-Key header', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse({ status: 'ok', version: '1.0.0' }),
        );

        const client = new LayerinfiniteClient({ apiKey: API_KEY, baseUrl: BASE_URL });
        const result = await client.health();

        expect(result.status).toBe('ok');
        expect(result.version).toBe('1.0.0');

        const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['X-API-Key']).toBeUndefined();
    });
});
