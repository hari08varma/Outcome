/**
 * Realistic LangChain/LangGraph integration tests.
 * Built from actual LangSmith API schema (docs.smith.langchain.com)
 * and LangGraph CheckpointTuple format.
 *
 * These fixtures simulate what a real user would export from:
 *   - LangSmith: `client.list_runs(project_name=...)`
 *   - LangGraph: `checkpointer.list(config)` serialized via JsonPlusSerializer
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/lib/supabase.js', () => ({
    supabase: { from: vi.fn() },
}));

import {
    isLangChainTrace,
    flattenLangChainTrace,
} from '../../api/lib/adapters/langchain-adapter.js';
import {
    isLangGraphTrace,
    flattenLangGraphTrace,
} from '../../api/lib/adapters/langgraph-adapter.js';

const AGENT_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

// ══════════════════════════════════════════════════════════════
// FIXTURE 1: Real LangSmith API export (client.list_runs)
// ══════════════════════════════════════════════════════════════
const LANGSMITH_API_EXPORT = {
    runs: [
        {
            id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            name: 'AgentExecutor',
            run_type: 'chain',
            inputs: { input: 'What is the refund status for order #12345?' },
            outputs: { output: 'The refund for order #12345 was processed on April 5th.' },
            error: null,
            start_time: '2026-04-10T14:30:00.000Z',
            end_time: '2026-04-10T14:30:08.500Z',
            trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            parent_run_id: null,
            dotted_order: '20260410T143000000000Z',
            metadata: { session_id: 'sess-001' },
            tags: ['production', 'billing'],
            child_runs: [
                {
                    id: 'a1234567-0001-0000-0000-000000000001',
                    name: 'ChatOpenAI',
                    run_type: 'llm',
                    inputs: { messages: [{ role: 'user', content: 'What is the refund status?' }] },
                    outputs: {
                        generations: [[{ text: 'I will look up your order.' }]],
                        llm_output: {
                            token_usage: { prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 },
                            model_name: 'gpt-4o',
                        },
                    },
                    error: null,
                    start_time: '2026-04-10T14:30:00.500Z',
                    end_time: '2026-04-10T14:30:01.800Z',
                    trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    parent_run_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    extra: {
                        token_usage: { prompt_tokens: 45, completion_tokens: 12, total_tokens: 57 },
                    },
                },
                {
                    id: 'a1234567-0002-0000-0000-000000000002',
                    name: 'OrderLookupTool',
                    run_type: 'tool',
                    inputs: { order_id: '12345' },
                    outputs: { status: 'refunded', refund_date: '2026-04-05', amount: 49.99 },
                    error: null,
                    start_time: '2026-04-10T14:30:02.000Z',
                    end_time: '2026-04-10T14:30:03.200Z',
                    trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    parent_run_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    dotted_order: '20260410T143000000000Z.20260410T143002000000Z',
                    extra: {},
                },
                {
                    id: 'a1234567-0003-0000-0000-000000000003',
                    name: 'CustomerDBRetriever',
                    run_type: 'retriever',
                    inputs: { query: 'customer profile order 12345' },
                    outputs: { documents: [{ page_content: 'Customer: John Doe', metadata: {} }] },
                    error: null,
                    start_time: '2026-04-10T14:30:03.500Z',
                    end_time: '2026-04-10T14:30:04.100Z',
                    trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    parent_run_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                },
                {
                    id: 'a1234567-0004-0000-0000-000000000004',
                    name: 'SendRefundConfirmation',
                    run_type: 'tool',
                    inputs: { email: 'john@example.com', order_id: '12345' },
                    outputs: { sent: true, message_id: 'msg-abc123' },
                    error: null,
                    start_time: '2026-04-10T14:30:05.000Z',
                    end_time: '2026-04-10T14:30:06.800Z',
                    trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    parent_run_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                },
                {
                    id: 'a1234567-0005-0000-0000-000000000005',
                    name: 'EscalateToHuman',
                    run_type: 'tool',
                    inputs: { reason: 'Customer requested supervisor' },
                    outputs: null,
                    error: 'HTTPError: Escalation service returned 503',
                    start_time: '2026-04-10T14:30:07.000Z',
                    end_time: '2026-04-10T14:30:08.000Z',
                    trace_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                    parent_run_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
                },
            ],
        },
    ],
};

// ══════════════════════════════════════════════════════════════
// FIXTURE 2: LangSmith bulk export (flat array of runs, no nesting)
// ══════════════════════════════════════════════════════════════
const LANGSMITH_FLAT_EXPORT = [
    {
        id: 'run-001',
        name: 'SearchKnowledgeBase',
        run_type: 'tool',
        inputs: { query: 'shipping policy' },
        outputs: { results: ['Free shipping over $50'] },
        error: null,
        start_time: '2026-04-10T10:00:00Z',
        end_time: '2026-04-10T10:00:00.800Z',
        parent_run_id: 'root-chain-001',
    },
    {
        id: 'run-002',
        name: 'GenerateResponse',
        run_type: 'llm',
        inputs: { prompt: 'Summarize shipping policy' },
        outputs: { text: 'We offer free shipping...' },
        error: null,
        start_time: '2026-04-10T10:00:01Z',
        end_time: '2026-04-10T10:00:02Z',
        parent_run_id: 'root-chain-001',
    },
    {
        id: 'run-003',
        name: 'UpdateCRMStatus',
        run_type: 'tool',
        inputs: { ticket_id: 'TK-9999', status: 'resolved' },
        outputs: { updated: true },
        error: null,
        start_time: '2026-04-10T10:00:02.500Z',
        end_time: '2026-04-10T10:00:03.100Z',
        parent_run_id: 'root-chain-001',
        extra: {
            token_usage: { total_tokens: 120 },
        },
    },
];

// ══════════════════════════════════════════════════════════════
// FIXTURE 3: LangGraph checkpoint array (PostgresSaver.list())
// ══════════════════════════════════════════════════════════════
const LANGGRAPH_CHECKPOINTS = [
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-001',
        node: '__start__',
        channel_values: { messages: [] },
        metadata: { source: 'input', step: 0 },
        created_at: '2026-04-10T12:00:00Z',
        parent_checkpoint_id: null,
    },
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-002',
        node: 'classify_intent',
        channel_values: {
            messages: [{ role: 'user', content: 'I was charged twice' }],
            intent: 'billing_dispute',
        },
        error: null,
        metadata: { source: 'loop', step: 1, writes: { classify_intent: { intent: 'billing_dispute' } } },
        created_at: '2026-04-10T12:00:01Z',
        parent_checkpoint_id: 'cp-001',
    },
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-003',
        node: 'lookup_transaction',
        channel_values: {
            messages: [{ role: 'user', content: 'I was charged twice' }],
            intent: 'billing_dispute',
            transaction: { id: 'txn-555', amount: 29.99 },
        },
        error: null,
        metadata: { source: 'loop', step: 2 },
        created_at: '2026-04-10T12:00:02Z',
        parent_checkpoint_id: 'cp-002',
    },
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-004',
        node: 'process_refund',
        channel_values: {
            messages: [{ role: 'user', content: 'I was charged twice' }],
            refund_status: 'completed',
        },
        error: null,
        metadata: { source: 'loop', step: 3 },
        created_at: '2026-04-10T12:00:03Z',
        parent_checkpoint_id: 'cp-003',
    },
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-005',
        node: 'notify_customer',
        channel_values: {},
        error: 'SMTPError: Connection refused',
        metadata: { source: 'loop', step: 4 },
        created_at: '2026-04-10T12:00:04Z',
        parent_checkpoint_id: 'cp-004',
    },
    {
        thread_id: 'thread-payment-001',
        checkpoint_id: 'cp-006',
        node: '__end__',
        channel_values: { final_status: 'partial' },
        metadata: { source: 'loop', step: 5 },
        created_at: '2026-04-10T12:00:05Z',
        parent_checkpoint_id: 'cp-005',
    },
];

// ══════════════════════════════════════════════════════════════
// FIXTURE 4: LangGraph astream_events format
// ══════════════════════════════════════════════════════════════
const LANGGRAPH_EVENTS = {
    events: [
        { event: 'on_chain_start', name: 'AgentGraph', data: { input: { query: 'billing' } }, run_id: 'ev-1' },
        { event: 'on_tool_start', name: 'search_db', data: { input: { q: 'billing' } }, run_id: 'ev-2', metadata: { thread_id: 'th-99' } },
        { event: 'on_tool_end', name: 'search_db', data: { output: { results: [1, 2, 3] } }, run_id: 'ev-2', metadata: { thread_id: 'th-99' } },
        { event: 'on_tool_start', name: 'send_reply', data: { input: { msg: 'Found it' } }, run_id: 'ev-3', metadata: { thread_id: 'th-99' } },
        { event: 'on_tool_end', name: 'send_reply', data: { output: { sent: true } }, run_id: 'ev-3', metadata: { thread_id: 'th-99' } },
        { event: 'on_chain_end', name: 'AgentGraph', data: { output: { done: true } }, run_id: 'ev-1' },
    ],
};

// ══════════════════════════════════════════════════════════════
// FIXTURE 5: Non-framework data (should NOT match adapters)
// ══════════════════════════════════════════════════════════════
const PLAIN_OUTCOMES = [
    { action_name: 'retry_payment', issue_type: 'billing', success: true, outcome_score: 0.9 },
    { action_name: 'escalate_to_human', issue_type: 'billing', success: false, error_code: 'timeout' },
];

const CSV_CONTENT = 'action_name,issue_type,success\nretry_payment,billing,true';

// ══════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════

describe('Adapter — Real-world LangSmith exports', () => {
    // ── Detection ─────────────────────────────────────────────

    it('detects nested LangSmith chain export', () => {
        expect(isLangChainTrace(LANGSMITH_API_EXPORT)).toBe(true);
    });

    it('detects flat run array export', () => {
        expect(isLangChainTrace(LANGSMITH_FLAT_EXPORT)).toBe(true);
    });

    it('does NOT detect plain outcome JSON as LangChain', () => {
        expect(isLangChainTrace(PLAIN_OUTCOMES)).toBe(false);
    });

    it('does NOT detect LangGraph checkpoints as LangChain', () => {
        expect(isLangChainTrace(LANGGRAPH_CHECKPOINTS)).toBe(false);
    });

    // ── Flattening: nested chain export ───────────────────────

    it('extracts exactly 3 tool runs from nested chain (skips LLM + retriever)', () => {
        const rows = flattenLangChainTrace(LANGSMITH_API_EXPORT, AGENT_ID);

        // Should get: OrderLookupTool, SendRefundConfirmation, EscalateToHuman
        // Should skip: ChatOpenAI (llm), CustomerDBRetriever (retriever), AgentExecutor (chain)
        expect(rows).toHaveLength(3);

        const names = rows.map(r => r.action_name);
        expect(names).toContain('order_lookup_tool');
        expect(names).toContain('send_refund_confirmation');
        expect(names).toContain('escalate_to_human');
    });

    it('maps OrderLookupTool correctly', () => {
        const rows = flattenLangChainTrace(LANGSMITH_API_EXPORT, AGENT_ID);
        const lookup = rows.find(r => r.action_name === 'order_lookup_tool')!;

        expect(lookup.success).toBe(true);
        expect(lookup.response_time_ms).toBe(1200); // 14:30:02 → 14:30:03.2 = 1200ms
        expect(lookup.error_message).toBeNull();
        expect(lookup.episode_id).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479'); // parent chain ID
    });

    it('maps failed EscalateToHuman with error', () => {
        const rows = flattenLangChainTrace(LANGSMITH_API_EXPORT, AGENT_ID);
        const escalate = rows.find(r => r.action_name === 'escalate_to_human')!;

        expect(escalate.success).toBe(false);
        expect(escalate.error_message).toBe('HTTPError: Escalation service returned 503');
        expect(escalate.error_code).toBe('tool_error');
        expect(escalate.response_time_ms).toBe(1000);
    });

    // ── Flattening: flat run array ────────────────────────────

    it('extracts 2 tool runs from flat export (skips LLM)', () => {
        const rows = flattenLangChainTrace(LANGSMITH_FLAT_EXPORT, AGENT_ID);

        expect(rows).toHaveLength(2);
        expect(rows[0].action_name).toBe('search_knowledge_base');
        expect(rows[1].action_name).toBe('update_crm_status');
    });

    it('extracts token usage from flat export tool', () => {
        const rows = flattenLangChainTrace(LANGSMITH_FLAT_EXPORT, AGENT_ID);
        const crm = rows.find(r => r.action_name === 'update_crm_status')!;

        expect(crm.resource_cost_units).toBe(120);
        expect(crm.resource_cost_type).toBe('tokens');
    });

    it('calculates response_time_ms correctly from flat export', () => {
        const rows = flattenLangChainTrace(LANGSMITH_FLAT_EXPORT, AGENT_ID);

        expect(rows[0].response_time_ms).toBe(800);  // 10:00:00.000 → 10:00:00.800
        expect(rows[1].response_time_ms).toBe(600);  // 10:00:02.500 → 10:00:03.100
    });
});

describe('Adapter — Real-world LangGraph exports', () => {
    // ── Detection ─────────────────────────────────────────────

    it('detects checkpoint array', () => {
        expect(isLangGraphTrace(LANGGRAPH_CHECKPOINTS)).toBe(true);
    });

    it('detects astream_events format', () => {
        expect(isLangGraphTrace(LANGGRAPH_EVENTS)).toBe(true);
    });

    it('does NOT detect plain outcomes as LangGraph', () => {
        expect(isLangGraphTrace(PLAIN_OUTCOMES)).toBe(false);
    });

    it('does NOT detect LangChain runs as LangGraph', () => {
        expect(isLangGraphTrace(LANGSMITH_API_EXPORT)).toBe(false);
    });

    // ── Flattening: checkpoints ───────────────────────────────

    it('extracts 4 step nodes from checkpoints (skips __start__ and __end__)', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_CHECKPOINTS, AGENT_ID);

        expect(rows).toHaveLength(4);
        const names = rows.map(r => r.action_name);
        expect(names).toContain('classify_intent');
        expect(names).toContain('lookup_transaction');
        expect(names).toContain('process_refund');
        expect(names).toContain('notify_customer');
    });

    it('maps notify_customer error correctly', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_CHECKPOINTS, AGENT_ID);
        const notify = rows.find(r => r.action_name === 'notify_customer')!;

        expect(notify.success).toBe(false);
        expect(notify.error_message).toBe('SMTPError: Connection refused');
        expect(notify.error_code).toBe('node_error');
    });

    it('maps successful nodes correctly', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_CHECKPOINTS, AGENT_ID);
        const refund = rows.find(r => r.action_name === 'process_refund')!;

        expect(refund.success).toBe(true);
        expect(refund.error_message).toBeNull();
        expect(refund.episode_id).toBe('thread-payment-001');
    });

    it('preserves step metadata from checkpoint', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_CHECKPOINTS, AGENT_ID);
        const classify = rows.find(r => r.action_name === 'classify_intent')!;

        // retry_attempt maps to step number from metadata
        expect(classify.retry_attempt).toBe(1); // step 1
    });

    // ── Flattening: astream_events ────────────────────────────

    it('extracts 2 tool_end events from astream_events', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_EVENTS, AGENT_ID);

        // on_tool_end for search_db and send_reply
        // on_chain_end for AgentGraph is also captured
        expect(rows.length).toBeGreaterThanOrEqual(2);

        const toolNames = rows.map(r => r.action_name);
        expect(toolNames).toContain('search_db');
        expect(toolNames).toContain('send_reply');
    });

    it('preserves thread_id as episode_id from events', () => {
        const rows = flattenLangGraphTrace(LANGGRAPH_EVENTS, AGENT_ID);
        const search = rows.find(r => r.action_name === 'search_db')!;

        expect(search.episode_id).toBe('th-99');
    });
});

describe('Adapter — Cross-contamination guard', () => {
    it('LangChain adapter returns [] for LangGraph data', () => {
        const rows = flattenLangChainTrace(LANGGRAPH_CHECKPOINTS, AGENT_ID);
        expect(rows).toEqual([]);
    });

    it('LangGraph adapter returns [] for LangChain data', () => {
        const rows = flattenLangGraphTrace(LANGSMITH_API_EXPORT, AGENT_ID);
        expect(rows).toEqual([]);
    });

    it('both adapters return [] for plain outcome data', () => {
        expect(flattenLangChainTrace(PLAIN_OUTCOMES, AGENT_ID)).toEqual([]);
        expect(flattenLangGraphTrace(PLAIN_OUTCOMES, AGENT_ID)).toEqual([]);
    });
});
