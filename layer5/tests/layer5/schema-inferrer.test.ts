/**
 * Tests for LLM-powered schema auto-mapping (schema-inferrer.ts).
 *
 * Tests the deterministic parts: deepGet, validateMapping, spotCheckMapping,
 * applyMapping, standardFieldsPresent. The LLM call itself is mocked.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: { from: vi.fn() },
}));

import {
    deepGet,
    validateMapping,
    spotCheckMapping,
    applyMapping,
    standardFieldsPresent,
    inferSchemaAndMap,
    clearMappingCache,
    type SchemaMapping,
    type LLMProvider,
} from '../../api/lib/schema-inferrer.js';

import { beforeEach } from 'vitest';

// Clear cache before each test to prevent cross-contamination
beforeEach(() => {
    clearMappingCache();
});

// ══════════════════════════════════════════════════════════════
// FIXTURES: Simulated agent trace data from various frameworks
// ══════════════════════════════════════════════════════════════

// CrewAI-style output
const CREWAI_RECORDS = [
    {
        agent_role: 'researcher',
        task_description: 'Find customer billing history',
        task_output: { result: 'Found 3 invoices', status: 'completed' },
        execution_time: 2400,
        tokens_used: 350,
        created_at: '2026-04-10T10:00:00Z',
    },
    {
        agent_role: 'writer',
        task_description: 'Draft refund response email',
        task_output: { result: 'Email drafted', status: 'completed' },
        execution_time: 1800,
        tokens_used: 280,
        created_at: '2026-04-10T10:00:03Z',
    },
    {
        agent_role: 'reviewer',
        task_description: 'Verify refund amount calculation',
        task_output: { result: null, status: 'failed', error: 'Calculation mismatch detected' },
        execution_time: 500,
        tokens_used: 120,
        created_at: '2026-04-10T10:00:05Z',
    },
];

// AutoGPT-style output
const AUTOGPT_RECORDS = [
    {
        thoughts: { reasoning: 'Need to search for order', plan: 'Use search command' },
        command: { name: 'search_database', args: { query: 'order 12345' } },
        result: { success: true, output: 'Found order' },
        duration_ms: 1200,
    },
    {
        thoughts: { reasoning: 'Send notification to user' },
        command: { name: 'send_notification', args: { type: 'email' } },
        result: { success: false, error: 'SMTP timeout' },
        duration_ms: 5000,
    },
    {
        thoughts: { reasoning: 'Escalate to human agent' },
        command: { name: 'escalate_ticket', args: { priority: 'high' } },
        result: { success: true, output: 'Ticket escalated' },
        duration_ms: 300,
    },
];

// Standard LI format (should NOT trigger inferrer)
const STANDARD_RECORDS = [
    { action_name: 'retry_payment', issue_type: 'billing', success: true, outcome_score: 0.9 },
    { action_name: 'escalate', issue_type: 'billing', success: false },
    { action_name: 'refund', issue_type: 'billing', success: true },
];

// ══════════════════════════════════════════════════════════════
// TESTS: deepGet
// ══════════════════════════════════════════════════════════════

describe('deepGet — dot-path value extraction', () => {
    const obj = {
        a: { b: { c: 42 } },
        items: [{ name: 'first' }, { name: 'second' }],
        command: { name: 'search' },
        'flat_key': 'value',
        result: { success: true, error: null },
    };

    it('resolves simple path', () => {
        expect(deepGet(obj, 'flat_key')).toBe('value');
    });

    it('resolves nested path', () => {
        expect(deepGet(obj, 'a.b.c')).toBe(42);
    });

    it('resolves deeply nested path', () => {
        expect(deepGet(obj, 'command.name')).toBe('search');
    });

    it('resolves array index', () => {
        expect(deepGet(obj, 'items.0.name')).toBe('first');
        expect(deepGet(obj, 'items.1.name')).toBe('second');
    });

    it('returns undefined for non-existent path', () => {
        expect(deepGet(obj, 'x.y.z')).toBeUndefined();
    });

    it('returns undefined for null/undefined input', () => {
        expect(deepGet(null, 'a')).toBeUndefined();
        expect(deepGet(undefined, 'a')).toBeUndefined();
    });

    it('returns undefined for empty path', () => {
        expect(deepGet(obj, '')).toBeUndefined();
    });

    it('handles boolean values correctly', () => {
        expect(deepGet(obj, 'result.success')).toBe(true);
        expect(deepGet(obj, 'result.error')).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════
// TESTS: validateMapping
// ══════════════════════════════════════════════════════════════

describe('validateMapping — LLM output validation', () => {
    it('accepts valid complete mapping', () => {
        const raw = {
            action_name: 'command.name',
            success: 'result.success',
            issue_type: 'category',
            error_message: 'result.error',
            error_code: null,
            response_time_ms: 'duration_ms',
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: 'created_at',
            resource_cost_units: 'tokens_used',
            retry_attempt: null,
            task_name: null,
            detected_framework: 'autogpt',
            confidence: 0.85,
        };
        const { mapping, error } = validateMapping(raw);
        expect(error).toBeNull();
        expect(mapping).not.toBeNull();
        expect(mapping!.action_name).toBe('command.name');
        expect(mapping!.confidence).toBe(0.85);
    });

    it('rejects missing action_name', () => {
        const { mapping, error } = validateMapping({
            success: 'result.ok',
            detected_framework: 'custom',
            confidence: 0.5,
        });
        expect(mapping).toBeNull();
        expect(error).toContain('action_name');
    });

    it('rejects missing success', () => {
        const { mapping, error } = validateMapping({
            action_name: 'tool_name',
            detected_framework: 'custom',
            confidence: 0.5,
        });
        expect(mapping).toBeNull();
        expect(error).toContain('success');
    });

    it('rejects non-object inputs', () => {
        expect(validateMapping('string').mapping).toBeNull();
        expect(validateMapping(null).mapping).toBeNull();
        expect(validateMapping([]).mapping).toBeNull();
        expect(validateMapping(42).mapping).toBeNull();
    });

    it('defaults confidence to 0.5 if not a valid number', () => {
        const { mapping } = validateMapping({
            action_name: 'name',
            success: 'ok',
            confidence: 'high', // not a number
        });
        expect(mapping!.confidence).toBe(0.5);
    });

    it('defaults detected_framework to "custom"', () => {
        const { mapping } = validateMapping({
            action_name: 'name',
            success: 'ok',
        });
        expect(mapping!.detected_framework).toBe('custom');
    });

    it('normalizes null optional fields', () => {
        const { mapping } = validateMapping({
            action_name: 'name',
            success: 'ok',
            error_message: 123, // not a string, should be null
            session_id: true,   // not a string, should be null
        });
        expect(mapping!.error_message).toBeNull();
        expect(mapping!.session_id).toBeNull();
    });
});

// ══════════════════════════════════════════════════════════════
// TESTS: spotCheckMapping
// ══════════════════════════════════════════════════════════════

describe('spotCheckMapping — validates mapping against real data', () => {
    it('passes when paths resolve correctly', () => {
        const mapping: SchemaMapping = {
            action_name: 'command.name',
            issue_type: null,
            success: 'result.success',
            error_message: 'result.error',
            error_code: null,
            response_time_ms: 'duration_ms',
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: null,
            resource_cost_units: null,
            retry_attempt: null,
            task_name: null,
            detected_framework: 'autogpt',
            confidence: 0.85,
        };
        const result = spotCheckMapping(mapping, AUTOGPT_RECORDS);

        expect(result.valid).toBe(true);
        expect(result.extractionRate).toBeGreaterThan(0.5);
    });

    it('fails when action_name path is wrong', () => {
        const mapping: SchemaMapping = {
            action_name: 'nonexistent.field.path',
            issue_type: null,
            success: 'result.success',
            error_message: null,
            error_code: null,
            response_time_ms: null,
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: null,
            resource_cost_units: null,
            retry_attempt: null,
            task_name: null,
            detected_framework: 'custom',
            confidence: 0.5,
        };
        const result = spotCheckMapping(mapping, AUTOGPT_RECORDS);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('action_name');
    });

    it('fails when success path is wrong', () => {
        const mapping: SchemaMapping = {
            action_name: 'command.name',
            issue_type: null,
            success: 'bogus.path.to.nothing',
            error_message: null,
            error_code: null,
            response_time_ms: null,
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: null,
            resource_cost_units: null,
            retry_attempt: null,
            task_name: null,
            detected_framework: 'custom',
            confidence: 0.5,
        };
        const result = spotCheckMapping(mapping, AUTOGPT_RECORDS);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('success');
    });
});

// ══════════════════════════════════════════════════════════════
// TESTS: applyMapping
// ══════════════════════════════════════════════════════════════

describe('applyMapping — deterministic field re-keying', () => {
    const mapping: SchemaMapping = {
        action_name: 'command.name',
        issue_type: null,
        success: 'result.success',
        error_message: 'result.error',
        error_code: null,
        response_time_ms: 'duration_ms',
        session_id: null,
        episode_id: null,
        environment: null,
        outcome_score: null,
        business_outcome: null,
        timestamp: null,
        resource_cost_units: null,
        retry_attempt: null,
        task_name: null,
        detected_framework: 'autogpt',
        confidence: 0.85,
    };

    it('maps AutoGPT records correctly', () => {
        const result = applyMapping(AUTOGPT_RECORDS, mapping);

        expect(result).toHaveLength(3);

        expect(result[0].action_name).toBe('search_database');
        expect(result[0].success).toBe(true);
        expect(result[0].response_time_ms).toBe(1200);

        expect(result[1].action_name).toBe('send_notification');
        expect(result[1].success).toBe(false);
        expect(result[1].error_message).toBe('SMTP timeout');

        expect(result[2].action_name).toBe('escalate_ticket');
        expect(result[2].success).toBe(true);
        expect(result[2].response_time_ms).toBe(300);
    });

    it('preserves original record as _original', () => {
        const result = applyMapping(AUTOGPT_RECORDS.slice(0, 1), mapping);
        expect(result[0]._original).toEqual(AUTOGPT_RECORDS[0]);
    });

    it('marks records as inferred', () => {
        const result = applyMapping(AUTOGPT_RECORDS.slice(0, 1), mapping);
        expect(result[0]._inferred_by).toBe('schema-inferrer');
        expect(result[0]._detected_framework).toBe('autogpt');
    });

    it('handles CrewAI-style mapping', () => {
        const crewMapping: SchemaMapping = {
            action_name: 'agent_role',
            issue_type: 'task_description',
            success: 'task_output.status',
            error_message: 'task_output.error',
            error_code: null,
            response_time_ms: 'execution_time',
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: 'created_at',
            resource_cost_units: 'tokens_used',
            retry_attempt: null,
            task_name: 'task_description',
            detected_framework: 'crewai',
            confidence: 0.9,
        };
        const result = applyMapping(CREWAI_RECORDS, crewMapping);

        expect(result[0].action_name).toBe('researcher');
        expect(result[0].success).toBe('completed'); // dryRunParse will normalize this
        expect(result[0].response_time_ms).toBe(2400);
        expect(result[0].resource_cost_units).toBe(350);
        expect(result[0].timestamp).toBe('2026-04-10T10:00:00Z');

        expect(result[2].error_message).toBe('Calculation mismatch detected');
        expect(result[2].success).toBe('failed');
    });
});

// ══════════════════════════════════════════════════════════════
// TESTS: standardFieldsPresent
// ══════════════════════════════════════════════════════════════

describe('standardFieldsPresent — short-circuit check', () => {
    it('returns true for standard LI format', () => {
        expect(standardFieldsPresent(STANDARD_RECORDS)).toBe(true);
    });

    it('returns false for AutoGPT format (no action_name/success at top level)', () => {
        expect(standardFieldsPresent(AUTOGPT_RECORDS)).toBe(false);
    });

    it('returns false for CrewAI format', () => {
        expect(standardFieldsPresent(CREWAI_RECORDS)).toBe(false);
    });

    it('returns true when action and status fields exist', () => {
        const records = [
            { action: 'refund', status: 'passed' },
            { action: 'retry', status: 'failed' },
            { action: 'escalate', status: 'passed' },
        ];
        expect(standardFieldsPresent(records)).toBe(true);
    });

    it('returns true for handler + result fields', () => {
        const records = [
            { handler: 'process_refund', result: true },
            { handler: 'send_email', result: false },
            { handler: 'lookup_order', result: true },
        ];
        expect(standardFieldsPresent(records)).toBe(true);
    });
});

// ══════════════════════════════════════════════════════════════
// TESTS: inferSchemaAndMap — full flow with mocked LLM
// ══════════════════════════════════════════════════════════════

describe('inferSchemaAndMap — end-to-end with mock LLM', () => {
    const mockProvider: LLMProvider = {
        modelId: 'test-mock-llm',
        complete: vi.fn(),
    };

    it('successfully infers AutoGPT schema', async () => {
        (mockProvider.complete as any).mockResolvedValueOnce(JSON.stringify({
            action_name: 'command.name',
            success: 'result.success',
            error_message: 'result.error',
            error_code: null,
            issue_type: null,
            response_time_ms: 'duration_ms',
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: null,
            resource_cost_units: null,
            retry_attempt: null,
            task_name: null,
            detected_framework: 'autogpt',
            confidence: 0.88,
        }));

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(error).toBeNull();
        expect(result).not.toBeNull();
        expect(result!.mapping.detected_framework).toBe('autogpt');
        expect(result!.mapping.confidence).toBe(0.88);
        expect(result!.mappedRecords).toHaveLength(3);
        expect(result!.mappedRecords[0].action_name).toBe('search_database');
        expect(result!.mappedRecords[1].success).toBe(false);
        expect(result!.llmModel).toBe('test-mock-llm');
    });

    it('successfully infers CrewAI schema', async () => {
        (mockProvider.complete as any).mockResolvedValueOnce(JSON.stringify({
            action_name: 'agent_role',
            success: 'task_output.status',
            error_message: 'task_output.error',
            error_code: null,
            issue_type: 'task_description',
            response_time_ms: 'execution_time',
            session_id: null,
            episode_id: null,
            environment: null,
            outcome_score: null,
            business_outcome: null,
            timestamp: 'created_at',
            resource_cost_units: 'tokens_used',
            retry_attempt: null,
            task_name: 'task_description',
            detected_framework: 'crewai',
            confidence: 0.92,
        }));

        const { result, error } = await inferSchemaAndMap(CREWAI_RECORDS, mockProvider);

        expect(error).toBeNull();
        expect(result!.mappedRecords[0].action_name).toBe('researcher');
        expect(result!.mappedRecords[0].resource_cost_units).toBe(350);
        expect(result!.mappedRecords[2].error_message).toBe('Calculation mismatch detected');
    });

    it('rejects when LLM returns invalid JSON', async () => {
        (mockProvider.complete as any).mockResolvedValueOnce('This is not JSON at all');

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(result).toBeNull();
        expect(error).toContain('invalid JSON');
    });

    it('rejects when LLM returns hallucinated paths that don\'t resolve', async () => {
        (mockProvider.complete as any).mockResolvedValueOnce(JSON.stringify({
            action_name: 'hallucinated.nonexistent.deep.path',
            success: 'also.fake.path',
            detected_framework: 'custom',
            confidence: 0.3,
        }));

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(result).toBeNull();
        expect(error).toContain('spot-check failed');
    });

    it('rejects when LLM omits required fields', async () => {
        (mockProvider.complete as any).mockResolvedValueOnce(JSON.stringify({
            issue_type: 'category',
            detected_framework: 'custom',
            confidence: 0.5,
        }));

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(result).toBeNull();
        expect(error).toContain('action_name');
    });

    it('handles LLM API failure gracefully', async () => {
        (mockProvider.complete as any).mockRejectedValueOnce(new Error('Connection refused'));

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(result).toBeNull();
        expect(error).toContain('LLM call failed');
    });

    it('returns error when no LLM provider and no env vars', async () => {
        const prevSchemaKey = process.env.SCHEMA_INFERRER_API_KEY;
        const prevOpenAiKey = process.env.OPENAI_API_KEY;
        const prevGoogleKey = process.env.GOOGLE_API_KEY;
        delete process.env.SCHEMA_INFERRER_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.GOOGLE_API_KEY;

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, null);

        expect(result).toBeNull();
        expect(error).toContain('No LLM API key');

        if (prevSchemaKey === undefined) delete process.env.SCHEMA_INFERRER_API_KEY;
        else process.env.SCHEMA_INFERRER_API_KEY = prevSchemaKey;
        if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevOpenAiKey;
        if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
        else process.env.GOOGLE_API_KEY = prevGoogleKey;
    });

    it('handles empty records array', async () => {
        const { result, error } = await inferSchemaAndMap([], mockProvider);

        expect(result).toBeNull();
        expect(error).toContain('No records');
    });

    it('handles LLM returning markdown-wrapped JSON', async () => {
        const wrappedResponse = '```json\n' + JSON.stringify({
            action_name: 'command.name',
            success: 'result.success',
            detected_framework: 'autogpt',
            confidence: 0.8,
        }) + '\n```';

        (mockProvider.complete as any).mockResolvedValueOnce(wrappedResponse);

        const { result, error } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);

        expect(error).toBeNull();
        expect(result).not.toBeNull();
        expect(result!.mappedRecords[0].action_name).toBe('search_database');
    });

    it('returns cached mapping on second call — no second LLM call', async () => {
        vi.mocked(mockProvider.complete).mockClear();
        (mockProvider.complete as any).mockResolvedValueOnce(JSON.stringify({
            action_name: 'command.name',
            success: 'result.success',
            detected_framework: 'autogpt',
            confidence: 0.88,
        }));

        // First call: LLM is invoked
        const { result: first } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);
        expect(first).not.toBeNull();
        expect(first!.llmModel).toBe('test-mock-llm');

        // Second call with identical schema shape: must hit cache, not LLM
        const { result: second } = await inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider);
        expect(second).not.toBeNull();
        expect(second!.llmModel).toBe('cache');
        expect(second!.sampleCount).toBe(0);
        expect(second!.mappedRecords[0].action_name).toBe('search_database');

        // LLM complete() should have been called exactly once
        expect(mockProvider.complete).toHaveBeenCalledTimes(1);
    });

    it('concurrent requests with the same fingerprint fire only one LLM call (in-flight dedup)', async () => {
        vi.mocked(mockProvider.complete).mockClear();

        // Delay the LLM response so all concurrent calls are genuinely in-flight
        (mockProvider.complete as any).mockImplementationOnce(
            () => new Promise((resolve) =>
                setTimeout(() => resolve(JSON.stringify({
                    action_name: 'command.name',
                    success: 'result.success',
                    detected_framework: 'autogpt',
                    confidence: 0.88,
                })), 20),
            ),
        );

        // Fire 5 identical concurrent requests
        const results = await Promise.all(
            Array.from({ length: 5 }, () => inferSchemaAndMap(AUTOGPT_RECORDS, mockProvider)),
        );

        // LLM should only have been called once
        expect(mockProvider.complete).toHaveBeenCalledTimes(1);

        // All 5 results must be valid and map correctly
        for (const { result, error } of results) {
            expect(error).toBeNull();
            expect(result).not.toBeNull();
            expect(result!.mappedRecords[0].action_name).toBe('search_database');
        }

        // First result is the real call; the rest are in-flight-dedup or cache
        const models = results.map((r) => r.result!.llmModel);
        expect(models[0]).toBe('test-mock-llm');
        expect(models.slice(1).every((m) => m === 'inflight-dedup' || m === 'cache')).toBe(true);
    });

    it('does NOT share cache between schemas with identical top-level keys but different nested keys', async () => {
        vi.mocked(mockProvider.complete).mockClear();

        // Same top-level keys, but payload subkeys differ — must produce different fingerprints
        const schemaA = [
            { id: '1', payload: { tool: 'search', result: true } },
            { id: '2', payload: { tool: 'email', result: false } },
            { id: '3', payload: { tool: 'lookup', result: true } },
        ];
        const schemaB = [
            { id: '1', payload: { url: '/api/search', ok: true } },
            { id: '2', payload: { url: '/api/email', ok: false } },
            { id: '3', payload: { url: '/api/lookup', ok: true } },
        ];

        (mockProvider.complete as any)
            .mockResolvedValueOnce(JSON.stringify({
                action_name: 'payload.tool',
                success: 'payload.result',
                detected_framework: 'custom',
                confidence: 0.8,
            }))
            .mockResolvedValueOnce(JSON.stringify({
                action_name: 'id',
                success: 'payload.ok',
                detected_framework: 'custom',
                confidence: 0.7,
            }));

        const { result: resA } = await inferSchemaAndMap(schemaA, mockProvider);
        const { result: resB } = await inferSchemaAndMap(schemaB, mockProvider);

        // Both calls should hit the LLM — fingerprints are different
        expect(mockProvider.complete).toHaveBeenCalledTimes(2);
        expect(resA!.mapping.action_name).toBe('payload.tool');
        expect(resB!.mapping.action_name).toBe('id');
    });
});
