import { supabase } from './supabase.js';
import crypto from 'node:crypto';

export interface DecisionRow {
    agent_id: string | null;
    context_id: string;
    context_hash: string;
    ranked_actions: unknown[];
    episode_id: string | null;
    episode_position: number;
}

const buffer: (DecisionRow & { _id: string })[] = [];
const MAX_BUFFER_SIZE = 100;

let failureCount = 0;
let circuitOpenUntil = 0;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const FLUSH_INTERVAL_MS = 2000;

function toInsertRow(row: DecisionRow & { _id: string }) {
    const { _id, ...rest } = row;
    const insertRow: Record<string, unknown> = { id: _id, ...rest };

    // Compatibility: some live DBs may still carry a non-null/defaulted
    // episode_id column shape. Omitting null lets nullable/default semantics
    // apply instead of forcing an explicit NULL write.
    if (insertRow.episode_id == null) {
        delete insertRow.episode_id;
    }

    return insertRow;
}

async function upsertDecisionRows(rows: Array<DecisionRow & { _id: string }>): Promise<void> {
    const insertRows = rows.map(toInsertRow);
    const { error } = await supabase
        .from('fact_decisions')
        .upsert(insertRows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
}

export function bufferDecision(row: DecisionRow): string {
    const uuid = crypto.randomUUID();
    buffer.push({ ...row, _id: uuid });
    if (buffer.length >= MAX_BUFFER_SIZE) {
        flushDecisions().catch(() => { });
    }
    return uuid;
}

export async function persistDecision(row: DecisionRow): Promise<string | null> {
    // fact_decisions.agent_id is required at the DB level.
    if (!row.agent_id) {
        return null;
    }

    const uuid = crypto.randomUUID();
    const bufferedRow = { ...row, _id: uuid };

    try {
        await upsertDecisionRows([bufferedRow]);
        failureCount = 0;
        return uuid;
    } catch (err: any) {
        // Preserve data for async retry, but do not return an unusable decision_id.
        buffer.push(bufferedRow);
        failureCount += 1;

        if (failureCount >= FAILURE_THRESHOLD) {
            circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
            console.error('[decision-writer] Circuit OPEN — synchronous decision writes failed 3 times.');
        }

        console.warn('[decision-writer] Immediate decision persist failed; queued for retry:', err?.message ?? err);
        return null;
    }
}

export async function flushDecisions(): Promise<void> {
    if (Date.now() < circuitOpenUntil) {
        console.warn('[decision-writer] Circuit open — skipping flush');
        return;
    }

    const rows = buffer.splice(0, buffer.length);
    if (rows.length === 0) return;

    try {
        await upsertDecisionRows(rows);
        failureCount = 0;
    } catch (err: any) {
        buffer.unshift(...rows);
        failureCount++;
        if (failureCount >= FAILURE_THRESHOLD) {
            circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
            console.error('[decision-writer] Circuit OPEN — 3 consecutive flush failures. DB writes paused for 60s.');
        }
        throw err;
    }
}

setInterval(() => {
    flushDecisions().catch(() => { });
}, FLUSH_INTERVAL_MS).unref();

process.on('SIGTERM', () => {
    flushDecisions().catch(() => { }).finally(() => process.exit(0));
});
