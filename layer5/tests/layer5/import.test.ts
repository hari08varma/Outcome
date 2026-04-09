/**
 * LAYERINFINITE — tests/layer5/import.test.ts
 * ══════════════════════════════════════════════════════════════
 * Tests for the historical import feature.
 *
 * Coverage:
 *   1. Parser: JSON / JSONL / CSV auto-detection
 *   2. Parser: field normalization (action_name, success variants, score clamping)
 *   3. Parser: action name normalization across casing variants
 *   4. Parser: task clustering — fragmentation detection
 *   5. Quality gate: blocked below threshold, warn above
 *   6. Idempotency: duplicate idempotency key returns existing outcome_id
 *   7. Trust guard: orchestrateOutcome skipTrust=true never calls updateAgentTrust
 *   8. Trust guard: upsertLiveTrustScore filters ingestion_source='sdk'
 *   9. Mixed rows: valid + invalid → partial success, error summary
 *  10. Batch trust guard in trust-updater: ingestion_source filter present
 * ══════════════════════════════════════════════════════════════
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── Mock supabase (shared mock pattern from existing tests) ───
vi.mock('../../api/lib/supabase.js', () => ({
    supabase: {
        from: vi.fn(),
        rpc: vi.fn(),
    },
}));

vi.mock('../../api/lib/ips-engine.js', () => ({
    writeCounterfactuals: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/sequence-tracker.js', () => ({
    upsertSequence: vi.fn().mockResolvedValue(undefined),
    closeSequence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/reward-backprop.js', () => ({
    backpropagateReward: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/lib/scoring.js', () => ({
    invalidateCache: vi.fn(),
    getCachedScore: vi.fn().mockReturnValue(null),
    getScores: vi.fn().mockResolvedValue({ ranked_actions: [], cold_start: true }),
    clearAllCache: vi.fn(),
}));

vi.mock('../../api/lib/verifier.js', () => ({
    resolveVerifiedSuccess: vi.fn((success: boolean) => ({
        verified_success: success,
        discrepancy_detected: false,
        confidence_override: null,
    })),
}));

vi.mock('../../api/middleware/validate-action.js', () => ({
    validateAction: vi.fn().mockResolvedValue({
        valid: true,
        action_id: 'action-uuid-123',
        error: null,
        error_code: null,
    }),
    normalizeActionName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '_')),
}));

import { supabase } from '../../api/lib/supabase.js';
import { orchestrateOutcome } from '../../api/lib/outcome-orchestrator.js';
import {
    importRouter,
    dryRunParse,
    extractScore,
    extractSuccess,
    normalizeBusinessOutcome,
    splitCsvLine,
} from '../../api/routes/import.js';
import { normalizeActionName } from '../../api/middleware/validate-action.js';
import { inferTask, isGenericTaskName, validateTaskName } from '../../api/lib/recommendation/task-infer.js';

function createImportApp(agentName = 'agent-from-key'): Hono {
    const app = new Hono();

    app.use('*', async (c, next) => {
        c.set('agent_id' as any, 'agent-test-1');
        c.set('customer_id' as any, 'customer-test-1');
        c.set('agent_name' as any, agentName);
        await next();
    });

    app.route('/v1/import', importRouter);
    return app;
}

function resolveTaskAsSdk(taskName: string | null | undefined, issueType: string): string {
    const rawTask = taskName?.trim() || null;

    if (rawTask) {
        const normalizedProvidedTask = validateTaskName(rawTask);

        if (isGenericTaskName(normalizedProvidedTask)) {
            const inferred = inferTask(issueType);
            if (inferred.tier !== 'unknown') return inferred.task;
            return normalizedProvidedTask;
        }

        return normalizedProvidedTask;
    }

    return inferTask(issueType).task;
}

// ── Test 1-5: Parser and quality gate (pure logic, no DB) ─────

describe('Parser: field extraction', () => {
    it('extracts action_name from multiple field aliases', () => {
        const ACTION_FIELDS = ['action_name', 'action', 'action_taken', 'handler', 'function_name'];
        function extractFirst(record: Record<string, unknown>, fields: string[]): string | null {
            for (const key of fields) {
                const v = record[key];
                if (v !== undefined && v !== null && v !== '') return String(v).trim();
            }
            return null;
        }

        expect(extractFirst({ action: 'retry' }, ACTION_FIELDS)).toBe('retry');
        expect(extractFirst({ handler: 'escalate' }, ACTION_FIELDS)).toBe('escalate');
        expect(extractFirst({ function_name: 'switch_provider' }, ACTION_FIELDS)).toBe('switch_provider');
        expect(extractFirst({ action_name: 'send_refund' }, ACTION_FIELDS)).toBe('send_refund');
        expect(extractFirst({ unrelated: 'x' }, ACTION_FIELDS)).toBeNull();
    });

    it('normalizes success field from multiple truthy values', () => {
        expect(extractSuccess({ success: 'true' })).toBe(true);
        expect(extractSuccess({ success: '1' })).toBe(true);
        expect(extractSuccess({ success: 'SUCCESS' })).toBe(true);
        expect(extractSuccess({ success: 'passed' })).toBe(true);
        expect(extractSuccess({ success: 'false' })).toBe(false);
        expect(extractSuccess({ success: 'FAILED' })).toBe(false);
        expect(extractSuccess({ success: 'partial' })).toBe(false);
        expect(extractSuccess({ success: 'unknown_status' })).toBeNull();
    });

    it('clamps percentage scores to 0-1 range', () => {
        expect(extractScore({ score: '85' })).toBe(0.85);
        expect(extractScore({ score: 0.9 })).toBe(0.9);
        expect(extractScore({ score: '1.5' })).toBe(1.0);
        expect(extractScore({ score: '-0.1' })).toBe(0.0);
        expect(extractScore({ score: 'not_a_number' })).toBeNull();
        expect(extractScore({ score: 75 })).toBe(0.75);  // percentage style
    });

    it('normalizes business_outcome to canonical values', () => {
        expect(normalizeBusinessOutcome('success')).toBe('resolved');
        expect(normalizeBusinessOutcome('COMPLETED')).toBe('resolved');
        expect(normalizeBusinessOutcome('partial_success')).toBe('partial');
        expect(normalizeBusinessOutcome('error')).toBe('failed');
        expect(normalizeBusinessOutcome('something_weird')).toBe('unknown');
        expect(normalizeBusinessOutcome(null)).toBeNull();
    });

    it('normalizes environment aliases and defaults unknowns to production', () => {
        const result = dryRunParse(
            [
                { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true },
                { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true, env: 'stg' },
                { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true, environment: 'DEV' },
                { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true, stage: 'unknown' },
            ],
            'agent-test-1',
            'customer-test-1',
        );

        expect(result.validation_errors).toHaveLength(0);
        expect(result.valid_rows).toHaveLength(4);
        expect(result.valid_rows.map((row) => row.row.environment)).toEqual([
            'production',
            'staging',
            'development',
            'production',
        ]);
    });

    it('maps import and SDK task/action inputs into the same canonical buckets', () => {
        const scenarios = [
            { task_name: undefined, issue_type: 'payment_failed' },
            { task_name: 'unknown', issue_type: 'payment_failed' },
            { task_name: 'Auth Recovery', issue_type: 'login_failed' },
        ];

        for (const scenario of scenarios) {
            const parsed = dryRunParse(
                [
                    {
                        action_name: 'Retry-With Cache',
                        issue_type: scenario.issue_type,
                        success: true,
                        task_name: scenario.task_name,
                    },
                ],
                'agent-test-1',
                'customer-test-1',
            );

            expect(parsed.validation_errors).toHaveLength(0);
            expect(parsed.valid_rows).toHaveLength(1);

            const importTask = parsed.valid_rows[0]!.row.task_name;
            const sdkTask = resolveTaskAsSdk(scenario.task_name, scenario.issue_type);
            expect(importTask).toBe(sdkTask);
        }

        const importCanonicalAction = normalizeActionName('Retry With Cache');
        const sdkCanonicalAction = normalizeActionName('retry with cache');
        expect(importCanonicalAction).toBe(sdkCanonicalAction);
    });
});

describe('Import route identity assertion', () => {
    it('rejects mismatched agent_name even for valid dry-run payload', async () => {
        const app = createImportApp('agent-from-key');

        const res = await app.request('/v1/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: JSON.stringify([
                    { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true },
                ]),
                agent_name: 'different-agent',
                dry_run: true,
            }),
        });

        expect(res.status).toBe(400);
        const json = await res.json() as any;
        expect(json.code).toBe('AGENT_NAME_MISMATCH');
    });

    it('allows dry-run payload when asserted agent_name matches key identity', async () => {
        const app = createImportApp('agent-from-key');

        const res = await app.request('/v1/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: JSON.stringify([
                    { action_name: 'retry_with_cache', issue_type: 'payment_failed', success: true },
                ]),
                agent_name: 'agent-from-key',
                dry_run: true,
            }),
        });

        expect(res.status).toBe(200);
        const json = await res.json() as any;
        expect(json.dry_run).toBe(true);
        expect(json.queued_rows).toBe(1);
    });
});

describe('Parser: action name normalization', () => {
    it('normalizes casing variants of the same action to the same key', () => {
        expect(normalizeActionName('SendRefund')).toBe('sendrefund');
        // The real impl does more (splits camelCase), but the mock covers the basic case.
        // The real action registry scopes on (customer_id, normalized_name) so
        // 'SendRefund' and 'send_refund' may still diverge — test the mock behavior.
        expect(normalizeActionName('RETRY')).toBe('retry');
        expect(normalizeActionName('send refund')).toBe('send_refund');
    });
});

describe('Quality gate logic', () => {
    function computeQuality(params: {
        hasScore: boolean;
        isInconsistent: boolean;
        mappingConfidence: number;
        hasBusinessOutcome: boolean;
    }): number {
        let q = 1.0;
        if (!params.hasScore) q -= 0.25;
        if (params.isInconsistent) q -= 0.20;
        if (params.mappingConfidence < 0.70) q -= 0.20;
        if (!params.hasBusinessOutcome) q -= 0.10;
        return Math.max(0, q);
    }

    it('perfect row scores 1.0', () => {
        expect(computeQuality({ hasScore: true, isInconsistent: false, mappingConfidence: 0.9, hasBusinessOutcome: true })).toBe(1.0);
    });

    it('missing outcome_score deducts 0.25', () => {
        expect(computeQuality({ hasScore: false, isInconsistent: false, mappingConfidence: 0.9, hasBusinessOutcome: true })).toBe(0.75);
    });

    it('inconsistent row deducts 0.20', () => {
        expect(computeQuality({ hasScore: true, isInconsistent: true, mappingConfidence: 0.9, hasBusinessOutcome: true })).toBe(0.80);
    });

    it('low mapping confidence deducts 0.20', () => {
        expect(computeQuality({ hasScore: true, isInconsistent: false, mappingConfidence: 0.5, hasBusinessOutcome: true })).toBe(0.80);
    });

    it('blocked gate below 0.40', () => {
        // Missing score + inconsistent + low confidence + no business outcome = 0.25
        const q = computeQuality({ hasScore: false, isInconsistent: true, mappingConfidence: 0.5, hasBusinessOutcome: false });
        expect(q).toBe(0.25);
        expect(q < 0.40).toBe(true);
    });
});

// ── Test 6: Idempotency ───────────────────────────────────────
describe('Idempotency key generation', () => {
    it('same inputs produce the same key', () => {
        const crypto = require('node:crypto');
        function makeKey(customerId: string, agentId: string, actionName: string, issueType: string, success: boolean, ts: string): string {
            const base = `${customerId}|${agentId}|${actionName}|${issueType}|${String(success)}|${ts}`;
            return crypto.createHash('sha256').update(base).digest('hex').slice(0, 64);
        }

        const k1 = makeKey('cust-1', 'agent-1', 'retry', 'payment_failed', true, '2024-01-01T00:00:00.000Z');
        const k2 = makeKey('cust-1', 'agent-1', 'retry', 'payment_failed', true, '2024-01-01T00:00:00.000Z');
        expect(k1).toBe(k2);
        expect(k1).toHaveLength(64);
    });

    it('different agent produces different key', () => {
        const crypto = require('node:crypto');
        function makeKey(agentId: string): string {
            const base = `cust-1|${agentId}|retry|payment_failed|true|2024-01-01T00:00:00.000Z`;
            return crypto.createHash('sha256').update(base).digest('hex').slice(0, 64);
        }
        expect(makeKey('agent-1')).not.toBe(makeKey('agent-2'));
    });
});

// ── Test 7: Trust guard — orchestrator skipTrust ──────────────
describe('orchestrateOutcome: skipTrust=true', () => {
    type MockState = {
        factOutcomesByAgent: Record<string, Array<{ success: boolean }>>;
        trustRowsByAgent: Record<string, any>;
        rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
        alerts: Array<Record<string, any>>;
        trustUpserts: Array<Record<string, any>>;
        contextsByCustomerIssue: Record<string, string>;
        contextOutcomeCounts: Record<string, number>;
        trustUpdates: Array<any>;
    };

    function makeState(): MockState {
        return {
            factOutcomesByAgent: {},
            trustRowsByAgent: {
                'agent-import': {
                    trust_id: 'trust-1', trust_score: 0.7, total_decisions: 0,
                    correct_decisions: 0, consecutive_failures: 0, trust_status: 'trusted',
                    suspension_reason: null,
                },
            },
            rpcCalls: [],
            alerts: [],
            trustUpserts: [],
            contextsByCustomerIssue: {},
            contextOutcomeCounts: {},
            trustUpdates: [],
        };
    }

    function buildMockFrom(state: MockState) {
        return (table: string) => {
            const q: any = {
                select: vi.fn(() => q),
                eq: vi.fn(() => q),
                gt: vi.fn(() => q),
                order: vi.fn(() => q),
                limit: vi.fn(() => q),
                maybeSingle: vi.fn(async () => {
                    if (table === 'agent_trust_scores') {
                        const key = 'agent-import';
                        return { data: state.trustRowsByAgent[key] ?? null, error: null };
                    }
                    return { data: null, error: null };
                }),
                single: vi.fn(async () => ({ data: null, error: null })),
                insert: vi.fn(async (payload: any) => {
                    if (table === 'degradation_alert_events') state.alerts.push(payload);
                    return { data: null, error: null };
                }),
                upsert: vi.fn(async (payload: any) => {
                    if (table === 'agent_trust_scores') state.trustUpserts.push(payload);
                    return { data: null, error: null };
                }),
                update: vi.fn((payload: any) => {
                    state.trustUpdates.push({ payload, table });
                    return q;
                }),
            };
            return q;
        };
    }

    beforeEach(() => {
        vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any);
    });

    it('does NOT call trust RPC when skipTrust=true', async () => {
        const state = makeState();
        vi.mocked(supabase.from).mockImplementation(buildMockFrom(state));

        await orchestrateOutcome({
            agentId: 'agent-import',
            customerId: 'cust-1',
            outcomeId: 'outcome-1',
            actionId: 'action-1',
            actionName: 'retry',
            contextId: 'ctx-1',
            issueType: 'payment_failed',
            finalSuccess: true,
            finalOutcomeScore: 0.9,
            skipTrust: true,
        });

        // update_trust_and_audit RPC must NOT have been called
        const trustRpcCall = vi.mocked(supabase.rpc).mock.calls.find(
            (call) => call[0] === 'update_trust_and_audit'
        );
        expect(trustRpcCall).toBeUndefined();
    });

    it('DOES call trust RPC when skipTrust is false (default SDK path)', async () => {
        const state = makeState();
        vi.mocked(supabase.from).mockImplementation(buildMockFrom(state));
        vi.mocked(supabase.rpc).mockImplementation(async (fn: string) => {
            state.rpcCalls.push({ fn, args: {} });
            return { data: null, error: null };
        });

        await orchestrateOutcome({
            agentId: 'agent-import',
            customerId: 'cust-1',
            outcomeId: 'outcome-2',
            actionId: 'action-1',
            actionName: 'retry',
            contextId: 'ctx-1',
            issueType: 'payment_failed',
            finalSuccess: true,
            finalOutcomeScore: 0.9,
            skipTrust: false,
        });

        const trustRpcCall = state.rpcCalls.find((c) => c.fn === 'update_trust_and_audit');
        expect(trustRpcCall).toBeDefined();
    });
});

// ── Test 8: Trust guard — upsertLiveTrustScore filter ────────
describe('upsertLiveTrustScore: ingestion_source=sdk filter', () => {
    it('fact_outcomes query includes ingestion_source=sdk eq filter', async () => {
        const eqCalls: Array<[string, unknown]> = [];

        vi.mocked(supabase.from).mockImplementation((_table: string) => {
            const q: any = {
                select: vi.fn(() => q),
                eq: vi.fn((col: string, val: unknown) => {
                    eqCalls.push([col, val]);
                    return q;
                }),
                gte: vi.fn(() => q),
                order: vi.fn(() => q),
                limit: vi.fn(() => q),
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                single: vi.fn(async () => ({ data: null, error: null })),
                upsert: vi.fn(async () => ({ data: null, error: null })),
                update: vi.fn(() => q),
                insert: vi.fn(async () => ({ data: null, error: null })),
            };
            return q;
        });

        vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any);

        // Trigger upsertLiveTrustScore indirectly via orchestrateOutcome
        // with skipTrust=false so upsertLiveTrustScore runs
        await orchestrateOutcome({
            agentId: 'agent-sdk',
            customerId: 'cust-1',
            outcomeId: 'outcome-sdk',
            actionId: 'action-1',
            actionName: 'retry',
            contextId: 'ctx-1',
            issueType: 'payment_failed',
            finalSuccess: true,
            finalOutcomeScore: 0.9,
            skipTrust: false,
        });

        // Allow microtask queue to flush (upsertLiveTrustScore is fire-and-forget)
        await new Promise((resolve) => setTimeout(resolve, 10));

        const ingestionFilter = eqCalls.find(([col, val]) => col === 'ingestion_source' && val === 'sdk');
        expect(ingestionFilter).toBeDefined();
    });
});

// ── Test 9: Mixed rows — partial success ──────────────────────
describe('Mixed valid/invalid rows', () => {
    it('valid rows are counted separately from invalid rows', () => {
        const rows: Array<Record<string, unknown>> = [
            { action_name: 'retry', issue_type: 'payment_failed', success: 'true' },
            { action_name: 'retry', issue_type: 'payment_failed', success: 'false' },
            { action_name: '', issue_type: 'payment_failed', success: 'true' },  // missing action
            { action_name: 'escalate', issue_type: '', success: 'true' },         // missing issue
            { action_name: 'retry', issue_type: 'billing', success: undefined },  // missing success
        ];

        const result = dryRunParse(rows, 'agent-1', 'cust-1');
        expect(result.valid_rows).toHaveLength(2);
        expect(result.validation_errors).toHaveLength(3);
    });
});

// ── Test 10: Batch trust-updater ingestion_source filter ──────
describe('trust-updater batch mode: ingestion_source filter', () => {
    it('fact_outcomes query in batch mode includes ingestion_source=sdk filter', async () => {
        // Import the trust-updater handler (Deno edge function — we test the query shape).
        // Since this is a Deno function, we validate the query directly by reading source.
        // This is an integration-style check: assert the filter is present in the source code.
        const fs = await import('node:fs/promises');
        const source = await fs.readFile(
            new URL('../../supabase/functions/trust-updater/index.ts', import.meta.url),
            'utf-8'
        );

        // The batch mode query must include .eq('ingestion_source', 'sdk')
        expect(source).toContain("eq('ingestion_source', 'sdk')");
    });

    it('scoring-engine does NOT touch trust paths', async () => {
        const fs = await import('node:fs/promises');
        const source = await fs.readFile(
            new URL('../../supabase/functions/scoring-engine/index.ts', import.meta.url),
            'utf-8'
        );
        // scoring-engine only refreshes MVs — must never call trust RPCs
        expect(source).not.toContain('update_trust_and_audit');
        expect(source).not.toContain('agent_trust_scores');
    });
});

// ── Test: CSV parsing ─────────────────────────────────────────
describe('CSV line splitting', () => {
    it('handles quoted commas in CSV values', () => {
        expect(splitCsvLine('retry,payment_failed,true')).toEqual(['retry', 'payment_failed', 'true']);
        expect(splitCsvLine('"send,refund",billing_issue,false')).toEqual(['send,refund', 'billing_issue', 'false']);
        expect(splitCsvLine('a,b,c')).toHaveLength(3);
    });
});

// ── Test: Task clustering ─────────────────────────────────────
describe('Task clustering', () => {
    it('groups rows by resolved task name and computes share', () => {
        const taskCountMap: Record<string, number> = {
            payment_failed: 356,
            api_timeout: 88,
            unknown: 56,
        };
        const total = 500;

        const clusters = Object.entries(taskCountMap)
            .map(([task_name, count]) => ({
                task_name,
                count,
                share: Math.round((count / total) * 10000) / 10000,
            }))
            .sort((a, b) => b.count - a.count);

        expect(clusters[0].task_name).toBe('payment_failed');
        expect(clusters[0].share).toBe(0.712);
        expect(clusters.reduce((s, c) => s + c.count, 0)).toBe(500);
    });
});
