/**
 * Layerinfinite — lib/adapters/langgraph-adapter.ts
 * ══════════════════════════════════════════════════════════════
 * Flattens LangGraph checkpoint/state exports into NormalizedOutcomeRow[].
 *
 * LangGraph uses a state machine model:
 *   - Nodes represent processing steps (tools, LLM calls, routing)
 *   - State transitions carry channel_values between nodes
 *   - Checkpoints capture the full graph state at each node exit
 *
 * Maps:
 *   node_name         → action_name
 *   error in state    → success: false
 *   channel_values    → outcome context
 *   timestamps        → response_time_ms
 *   thread_id          → episode_id
 * ══════════════════════════════════════════════════════════════
 */

import type { NormalizedOutcomeRow } from '../ingest-core.js';

// ── Types ─────────────────────────────────────────────────────

interface LangGraphCheckpoint {
    thread_id?: string;
    checkpoint_id?: string;
    node?: string;
    channel_values?: Record<string, unknown>;
    error?: string | null;
    metadata?: {
        source?: string;
        step?: number;
        writes?: Record<string, unknown>;
        [key: string]: unknown;
    };
    created_at?: string;
    parent_checkpoint_id?: string | null;
    [key: string]: unknown;
}

interface LangGraphEvent {
    event?: string;
    name?: string;
    data?: {
        input?: Record<string, unknown>;
        output?: Record<string, unknown>;
        chunk?: unknown;
    };
    metadata?: {
        thread_id?: string;
        checkpoint_id?: string;
        [key: string]: unknown;
    };
    run_id?: string;
    parent_ids?: string[];
    tags?: string[];
    [key: string]: unknown;
}

// ── Detection ─────────────────────────────────────────────────

/**
 * Detects whether raw parsed JSON looks like a LangGraph export.
 * Checks for checkpoint arrays or astream_events format.
 */
export function isLangGraphTrace(data: unknown): boolean {
    if (data === null || typeof data !== 'object') return false;

    // Array of checkpoints
    if (Array.isArray(data)) {
        return (data as unknown[]).some(
            (item: unknown) =>
                typeof item === 'object' &&
                item !== null &&
                ('channel_values' in item || 'checkpoint_id' in item),
        );
    }

    const obj = data as Record<string, unknown>;

    // Direct checkpoint export with channel_values
    if (obj.channel_values && typeof obj.node === 'string') return true;

    // astream_events format
    if (Array.isArray(obj.events)) {
        return (obj.events as unknown[]).some(
            (ev: unknown) =>
                typeof ev === 'object' &&
                ev !== null &&
                'event' in ev &&
                typeof (ev as Record<string, unknown>).event === 'string' &&
                ((ev as Record<string, unknown>).event as string).startsWith('on_'),
        );
    }

    // Nested under checkpoints key
    if (Array.isArray(obj.checkpoints)) {
        return (obj.checkpoints as unknown[]).some(
            (item: unknown) =>
                typeof item === 'object' &&
                item !== null &&
                ('channel_values' in item || 'node' in item),
        );
    }

    return false;
}

// ── Helpers ───────────────────────────────────────────────────

const SKIP_NODES = new Set([
    '__start__',
    '__end__',
    '__root__',
    'start',
    'end',
]);

function normalizeNodeName(name: string | undefined): string {
    if (!name || typeof name !== 'string') return 'unknown_node';
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        || 'unknown_node';
}

function hasError(checkpoint: LangGraphCheckpoint): boolean {
    if (typeof checkpoint.error === 'string' && checkpoint.error.length > 0) return true;
    // Check for error in channel_values
    const channels = checkpoint.channel_values;
    if (channels && typeof channels === 'object') {
        if ('error' in channels && channels.error) return true;
    }
    return false;
}

function extractErrorMessage(checkpoint: LangGraphCheckpoint): string | null {
    if (typeof checkpoint.error === 'string' && checkpoint.error.length > 0) {
        return checkpoint.error.slice(0, 1000);
    }
    const channels = checkpoint.channel_values;
    if (channels && typeof channels === 'object' && 'error' in channels) {
        const err = channels.error;
        if (typeof err === 'string') return err.slice(0, 1000);
        if (err && typeof err === 'object' && 'message' in err) {
            return String((err as any).message).slice(0, 1000);
        }
    }
    return null;
}

// ── Checkpoint Flatten ────────────────────────────────────────

function flattenCheckpoints(
    checkpoints: LangGraphCheckpoint[],
    agentId: string,
    issueType: string,
): NormalizedOutcomeRow[] {
    return checkpoints
        .filter((cp) => {
            const nodeName = cp.node ?? cp.metadata?.source;
            return typeof nodeName === 'string' && !SKIP_NODES.has(nodeName.toLowerCase());
        })
        .map((cp, index): NormalizedOutcomeRow => {
            const nodeName = cp.node ?? cp.metadata?.source ?? 'unknown_node';
            const errored = hasError(cp);
            
            // Dynamic context extraction for tasks
            let resolvedIssue = issueType;
            if (cp.channel_values && typeof cp.channel_values === 'object') {
                const cv = cp.channel_values as Record<string, unknown>;
                if (typeof cv.issue_type === 'string' && cv.issue_type.trim()) resolvedIssue = cv.issue_type.trim();
                else if (typeof cv.task_name === 'string' && cv.task_name.trim()) resolvedIssue = cv.task_name.trim();
                else if (typeof cv.task === 'string' && cv.task.trim()) resolvedIssue = cv.task.trim();
            }

            return {
                agent_id: agentId,
                action_name: normalizeNodeName(nodeName),
                issue_type: resolvedIssue,
                success: !errored,
                error_message: extractErrorMessage(cp),
                error_code: errored ? 'node_error' : null,
                episode_id: cp.thread_id ?? null,
                session_id: cp.checkpoint_id ?? null,
                environment: 'production',
                feedback_signal: 'immediate',
                signal_source: 'explicit',
                retry_attempt: cp.metadata?.step ?? index,
                raw_context: {
                    channel_values: cp.channel_values,
                },
            };
        });
}

// ── Event Stream Flatten ──────────────────────────────────────

function flattenEvents(
    events: LangGraphEvent[],
    agentId: string,
    issueType: string,
): NormalizedOutcomeRow[] {
    // Only extract on_tool_end events (actual action completions)
    return events
        .filter((ev) => ev.event === 'on_tool_end' || ev.event === 'on_chain_end')
        .filter((ev) => {
            const name = ev.name ?? '';
            return !SKIP_NODES.has(name.toLowerCase());
        })
        .map((ev): NormalizedOutcomeRow => {
            const hasOutput = ev.data?.output !== null && ev.data?.output !== undefined;
            const errored = !hasOutput;

            let resolvedIssue = issueType;
            if (ev.data && typeof ev.data === 'object') {
                const ed = ev.data as Record<string, unknown>;
                if (typeof ed.issue_type === 'string' && ed.issue_type.trim()) resolvedIssue = ed.issue_type.trim();
                else if (typeof ed.task_name === 'string' && ed.task_name.trim()) resolvedIssue = ed.task_name.trim();
            } else if (ev.metadata && typeof ev.metadata === 'object') {
                const md = ev.metadata as Record<string, unknown>;
                if (typeof md.issue_type === 'string' && md.issue_type.trim()) resolvedIssue = md.issue_type.trim();
            }

            return {
                agent_id: agentId,
                action_name: normalizeNodeName(ev.name),
                issue_type: resolvedIssue,
                success: !errored,
                episode_id: ev.metadata?.thread_id ?? ev.run_id ?? null,
                session_id: ev.run_id ?? null,
                environment: 'production',
                feedback_signal: 'immediate',
                signal_source: 'explicit',
                raw_context: ev.data ?? ev,
            };
        });
}

// ── Main Flatten Function ─────────────────────────────────────

/**
 * Flattens a LangGraph trace export into NormalizedOutcomeRow[].
 * Supports checkpoint arrays and astream_events format.
 *
 * @param trace Raw parsed JSON from LangGraph export
 * @param agentId Agent ID from the API key
 * @param issueType Issue type context (defaults to 'langgraph_trace')
 * @returns Array of normalized outcome rows
 */
export function flattenLangGraphTrace(
    trace: unknown,
    agentId: string,
    issueType: string = 'langgraph_trace',
): NormalizedOutcomeRow[] {
    if (!trace || typeof trace !== 'object') return [];

    // Array of checkpoints at top level
    if (Array.isArray(trace)) {
        const items = trace as unknown[];
        const hasCheckpoints = items.some(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                ('channel_values' in item || 'checkpoint_id' in item),
        );
        if (hasCheckpoints) {
            return flattenCheckpoints(items as LangGraphCheckpoint[], agentId, issueType);
        }
        // Could be array of events
        const hasEvents = items.some(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                'event' in item,
        );
        if (hasEvents) {
            return flattenEvents(items as LangGraphEvent[], agentId, issueType);
        }
        return [];
    }

    const obj = trace as Record<string, unknown>;

    // Nested under checkpoints key
    if (Array.isArray(obj.checkpoints)) {
        return flattenCheckpoints(obj.checkpoints as LangGraphCheckpoint[], agentId, issueType);
    }

    // Nested under events key
    if (Array.isArray(obj.events)) {
        return flattenEvents(obj.events as LangGraphEvent[], agentId, issueType);
    }

    // Single checkpoint
    if (obj.channel_values && typeof obj.node === 'string') {
        return flattenCheckpoints([obj as unknown as LangGraphCheckpoint], agentId, issueType);
    }

    return [];
}
