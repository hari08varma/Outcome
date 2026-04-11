/**
 * Tests for LangChain/LangSmith trace adapter.
 */

import { describe, expect, it } from 'vitest';
import { flattenLangChainTrace, isLangChainTrace } from '../../api/lib/adapters/langchain-adapter.js';

const AGENT_ID = 'agent-test-123';

describe('LangChain Adapter', () => {
    describe('isLangChainTrace', () => {
        it('detects runs[] with run_type', () => {
            expect(isLangChainTrace({
                runs: [{ run_type: 'chain', name: 'AgentExecutor' }],
            })).toBe(true);
        });

        it('detects single trace with child_runs', () => {
            expect(isLangChainTrace({
                run_type: 'chain',
                child_runs: [{ run_type: 'tool', name: 'search' }],
            })).toBe(true);
        });

        it('detects array of run objects', () => {
            expect(isLangChainTrace([
                { run_type: 'tool', name: 'search' },
            ])).toBe(true);
        });

        it('rejects plain JSON objects', () => {
            expect(isLangChainTrace({ action_name: 'refund', success: true })).toBe(false);
        });

        it('rejects null/undefined', () => {
            expect(isLangChainTrace(null)).toBe(false);
            expect(isLangChainTrace(undefined)).toBe(false);
        });
    });

    describe('flattenLangChainTrace', () => {
        it('extracts only tool runs from nested chain', () => {
            const trace = {
                runs: [{
                    id: 'chain-1',
                    run_type: 'chain',
                    name: 'AgentExecutor',
                    child_runs: [
                        {
                            id: 'llm-1',
                            run_type: 'llm',
                            name: 'ChatOpenAI',
                            outputs: { content: 'I will search...' },
                        },
                        {
                            id: 'tool-1',
                            run_type: 'tool',
                            name: 'SearchDatabase',
                            parent_run_id: 'chain-1',
                            inputs: { query: 'payment status' },
                            outputs: { result: 'found 3 records' },
                            error: null,
                            start_time: '2026-04-10T10:00:00Z',
                            end_time: '2026-04-10T10:00:01.200Z',
                        },
                        {
                            id: 'tool-2',
                            run_type: 'tool',
                            name: 'SendEmail',
                            parent_run_id: 'chain-1',
                            inputs: { to: 'user@test.com' },
                            outputs: { sent: true },
                            error: null,
                            start_time: '2026-04-10T10:00:02Z',
                            end_time: '2026-04-10T10:00:02.500Z',
                        },
                    ],
                }],
            };

            const rows = flattenLangChainTrace(trace, AGENT_ID);

            expect(rows).toHaveLength(2);
            expect(rows[0].action_name).toBe('search_database');
            expect(rows[0].success).toBe(true);
            expect(rows[0].response_time_ms).toBe(1200);
            expect(rows[0].episode_id).toBe('chain-1');

            expect(rows[1].action_name).toBe('send_email');
            expect(rows[1].success).toBe(true);
            expect(rows[1].response_time_ms).toBe(500);
        });

        it('maps tool with error to success: false', () => {
            const trace = {
                runs: [{
                    run_type: 'chain',
                    child_runs: [{
                        id: 'tool-err',
                        run_type: 'tool',
                        name: 'APICall',
                        error: 'TimeoutError: request timed out',
                        outputs: null,
                        start_time: '2026-04-10T10:00:00Z',
                        end_time: '2026-04-10T10:00:05Z',
                    }],
                }],
            };

            const rows = flattenLangChainTrace(trace, AGENT_ID);

            expect(rows).toHaveLength(1);
            expect(rows[0].success).toBe(false);
            expect(rows[0].error_message).toBe('TimeoutError: request timed out');
            expect(rows[0].error_code).toBe('tool_error');
        });

        it('extracts token_usage into resource_cost', () => {
            const trace = {
                runs: [{
                    run_type: 'chain',
                    child_runs: [{
                        run_type: 'tool',
                        name: 'RAGSearch',
                        outputs: { result: 'data' },
                        error: null,
                        extra: {
                            token_usage: { total_tokens: 450, prompt_tokens: 200, completion_tokens: 250 },
                        },
                    }],
                }],
            };

            const rows = flattenLangChainTrace(trace, AGENT_ID);

            expect(rows[0].resource_cost_units).toBe(450);
            expect(rows[0].resource_cost_type).toBe('tokens');
        });

        it('handles tool with no outputs as failure', () => {
            const trace = {
                runs: [{
                    run_type: 'chain',
                    child_runs: [{
                        run_type: 'tool',
                        name: 'BrokenTool',
                        outputs: null,
                        error: null,
                    }],
                }],
            };

            const rows = flattenLangChainTrace(trace, AGENT_ID);

            expect(rows[0].success).toBe(false);
        });

        it('returns empty for non-trace inputs', () => {
            expect(flattenLangChainTrace(null, AGENT_ID)).toEqual([]);
            expect(flattenLangChainTrace({}, AGENT_ID)).toEqual([]);
            expect(flattenLangChainTrace({ runs: [] }, AGENT_ID)).toEqual([]);
        });

        it('uses custom issue_type', () => {
            const trace = {
                runs: [{
                    run_type: 'tool',
                    name: 'Search',
                    outputs: { data: 'ok' },
                }],
            };

            const rows = flattenLangChainTrace(trace, AGENT_ID, 'billing_query');

            expect(rows[0].issue_type).toBe('billing_query');
        });
    });
});
