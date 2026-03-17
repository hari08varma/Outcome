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
const MAX_BUFFER_SIZE = 50;

let failureCount = 0;
let circuitOpenUntil = 0;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const FLUSH_INTERVAL_MS = 5000;

export function bufferDecision(row: DecisionRow): string {
    const uuid = crypto.randomUUID();
    buffer.push({ ...row, _id: uuid });
    if (buffer.length >= MAX_BUFFER_SIZE) {
        flushDecisions().catch(() => {});
    }
    return uuid;
}

export async function flushDecisions(): Promise<void> {
    if (Date.now() < circuitOpenUntil) {
        console.warn('[decision-writer] Circuit open — skipping flush');
        return;
    }

    const rows = buffer.splice(0, buffer.length);
    if (rows.length === 0) return;

    const insertRows = rows.map(r => {
        const { _id, ...rest } = r;
        return { id: _id, ...rest };
    });

    try {
        const { error } = await supabase.from('fact_decisions').insert(insertRows);
        if (error) throw error;
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
    flushDecisions().catch(() => {});
}, FLUSH_INTERVAL_MS).unref();

process.on('SIGTERM', () => {
    flushDecisions().catch(() => {}).finally(() => process.exit(0));
});
