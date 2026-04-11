/**
 * Layerinfinite — lib/adapters/langchain-adapter.ts
 * ══════════════════════════════════════════════════════════════
 * Flattens LangChain/LangSmith trace exports into NormalizedOutcomeRow[].
 *
 * LangSmith exports contain nested `runs[]` with `run_type`:
 *   - "chain"  → wrapper, skip
 *   - "llm"    → LLM call, skip (no action outcome)
 *   - "tool"   → actual action execution → extract as outcome
 *
 * Maps:
 *   name            → action_name
 *   error !== null   → success: false
 *   outputs          → success: true (if no error)
 *   start_time/end   → response_time_ms
 *   extra.token_usage → resource_cost_units
 *   parent_run_id    → episode_id (groups agent steps)
 * ══════════════════════════════════════════════════════════════
 */

import type { NormalizedOutcomeRow } from '../ingest-core.js';

// ── Types ─────────────────────────────────────────────────────

interface LangChainRun {
    id?: string;
    name?: string;
    run_type?: string;
    parent_run_id?: string | null;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown> | null;
    error?: string | null;
    start_time?: string;
    end_time?: string;
    execution_order?: number;
    child_runs?: LangChainRun[];
    extra?: {
        token_usage?: {
            total_tokens?: number;
            prompt_tokens?: number;
            completion_tokens?: number;
        };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface LangChainTrace {
    runs?: LangChainRun[];
    // LangSmith export may also have a top-level run
    id?: string;
    name?: string;
    run_type?: string;
    child_runs?: LangChainRun[];
    [key: string]: unknown;
}

// ── Detection ─────────────────────────────────────────────────

/**
 * Detects whether raw parsed JSON looks like a LangChain/LangSmith trace.
 * Checks for `runs[]` array with objects containing `run_type` field,
 * or a single top-level object with `run_type`.
 */
export function isLangChainTrace(data: unknown): boolean {
    if (data === null || typeof data !== 'object') return false;

    const obj = data as Record<string, unknown>;

    // Array of runs
    if (Array.isArray(obj.runs)) {
        return obj.runs.some(
            (run: unknown) =>
                typeof run === 'object' &&
                run !== null &&
                'run_type' in run,
        );
    }

    // Single trace export with child_runs
    if (typeof obj.run_type === 'string' && Array.isArray(obj.child_runs)) {
        return true;
    }

    // Array of run objects at top level
    if (Array.isArray(data)) {
        return (data as unknown[]).some(
            (item: unknown) =>
                typeof item === 'object' &&
                item !== null &&
                'run_type' in item,
        );
    }

    return false;
}

// ── Extraction ────────────────────────────────────────────────

function collectToolRuns(runs: LangChainRun[], parentEpisodeId?: string): LangChainRun[] {
    const tools: (LangChainRun & { _episodeId?: string })[] = [];

    for (const run of runs) {
        const episodeId = run.parent_run_id ?? parentEpisodeId;

        if (run.run_type === 'tool') {
            (run as any)._episodeId = episodeId;
            tools.push(run as any);
        }

        // Recursively collect from child_runs
        if (Array.isArray(run.child_runs) && run.child_runs.length > 0) {
            tools.push(...collectToolRuns(run.child_runs, run.id ?? episodeId));
        }
    }

    return tools;
}

function computeResponseMs(startTime?: string, endTime?: string): number | null {
    if (!startTime || !endTime) return null;
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
    return Math.round(end - start);
}

function extractTokenUsage(run: LangChainRun): number | null {
    // Direct token_usage on the tool run
    const directTokens = run.extra?.token_usage?.total_tokens;
    if (typeof directTokens === 'number' && directTokens > 0) return directTokens;

    // Check for token_usage in outputs (some frameworks put it there)
    const outputTokens = (run.outputs as any)?.token_usage?.total_tokens;
    if (typeof outputTokens === 'number' && outputTokens > 0) return outputTokens;

    return null;
}

function extractErrorMessage(run: LangChainRun): string | null {
    if (typeof run.error === 'string' && run.error.length > 0) {
        return run.error.slice(0, 1000);
    }
    return null;
}

function normalizeActionName(name: string | undefined): string {
    if (!name || typeof name !== 'string') return 'unknown_tool';
    // Snake-case normalize: SearchDatabase → search_database
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        || 'unknown_tool';
}

// ── Main Flatten Function ─────────────────────────────────────

/**
 * Flattens a LangChain/LangSmith trace into NormalizedOutcomeRow[].
 * Only extracts `run_type: "tool"` runs — chains and LLM calls are skipped.
 *
 * @param trace Raw parsed JSON from LangSmith export
 * @param agentId Agent ID from the API key (caller provides)
 * @param issueType Issue type context (caller provides or defaults to 'langchain_trace')
 * @returns Array of normalized outcome rows ready for the import pipeline
 */
export function flattenLangChainTrace(
    trace: unknown,
    agentId: string,
    issueType: string = 'langchain_trace',
): NormalizedOutcomeRow[] {
    if (!trace || typeof trace !== 'object') return [];

    const obj = trace as LangChainTrace;

    // Collect all runs from various export formats
    let allRuns: LangChainRun[] = [];

    if (Array.isArray(obj.runs)) {
        allRuns = obj.runs;
    } else if (Array.isArray(trace)) {
        allRuns = trace as LangChainRun[];
    } else if (obj.run_type && Array.isArray(obj.child_runs)) {
        // Single trace at top level — treat as one run tree
        allRuns = [obj as unknown as LangChainRun];
    }

    if (allRuns.length === 0) return [];

    // Extract only tool-level runs (recursive)
    const toolRuns = collectToolRuns(allRuns);

    return toolRuns.map((run): NormalizedOutcomeRow => {
        const hasError = run.error !== null && run.error !== undefined && run.error !== '';
        const hasOutput = run.outputs !== null && run.outputs !== undefined;
        const success = !hasError && hasOutput;
        const responseMs = computeResponseMs(run.start_time, run.end_time);
        const tokenCost = extractTokenUsage(run);
        const errorMessage = extractErrorMessage(run);

        return {
            agent_id: agentId,
            action_name: normalizeActionName(run.name),
            issue_type: issueType,
            success,
            response_time_ms: responseMs,
            error_message: errorMessage,
            error_code: hasError ? 'tool_error' : null,
            episode_id: (run as any)._episodeId ?? null,
            session_id: run.id ?? null,
            resource_cost_units: tokenCost,
            resource_cost_type: tokenCost !== null ? 'tokens' : null,
            environment: 'production',
            feedback_signal: 'immediate',
            signal_source: 'explicit',
        };
    });
}
