/**
 * LAYERINFINITE — routes/import.ts
 * ══════════════════════════════════════════════════════════════
 * Historical log import feature.
 *
 * POST /v1/import
 *   Accepts a JSON/JSONL/CSV file of historical agent outcomes.
 *   Runs a synchronous dry-run parse pass (always), then queues
 *   an async background job for actual ingestion.
 *   Returns immediately with job_id + preview data.
 *
 * GET /v1/import/:job_id
 *   Polls job status. Returns { status, rows_processed, rows_failed, errors }.
 *
 * Design invariants:
 *   - Auth: standard agent API key (same as /v1/log-outcome).
 *     customer_id + agent_id always come from the key — never from payload.
 *   - ingestion_source = 'import' on all inserted rows.
 *   - Trust paths are never triggered for import rows (skipTrust=true).
 *   - Idempotency: SHA-256 key per row prevents duplicate inserts on retry.
 *   - File cap: 5MB / 10,000 rows.
 *   - Async: job runs outside request lifecycle; no timeout risk.
 *   - MV refresh: single end-of-batch call (not per-row).
 *   - Quality gate: blocks ingestion if avg quality < 0.4.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import {
    ingestOutcome,
    resolveTaskName,
    type NormalizedOutcomeRow,
} from '../lib/ingest-core.js';
import { sanitizeString } from '../lib/sanitize.js';

export const importRouter = new Hono();

// ── Constants ─────────────────────────────────────────────────
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROWS = 10_000;
const CHUNK_SIZE = 500;               // rows per processing chunk
const QUALITY_GATE_BLOCK = 0.40;      // block ingestion entirely below this
const QUALITY_GATE_WARN = 0.60;       // warn but allow above this
const ENABLE_IMPORT_INFERENCE = ['1', 'true', 'yes', 'on'].includes(
    (process.env.LI_IMPORT_ENABLE_INFERENCE ?? '').trim().toLowerCase(),
);

// ── Types ─────────────────────────────────────────────────────

interface ParsedRow {
    /** 1-based index in the file */
    row_index: number;
    /** Normalized row ready for ingestOutcome() */
    row: NormalizedOutcomeRow;
    /** Pre-computed idempotency key (deterministic from content) */
    idempotency_key: string;
    /** Data quality score 0–1 for this row (computed during parse) */
    quality: number;
    /** task_name resolved during dry-run */
    resolved_task: string;
}

interface RowError {
    row: number;
    field: string;
    reason: string;
}

interface TaskCluster {
    task_name: string;
    count: number;
    share: number;
}

interface QualitySummary {
    avg_quality: number;
    inconsistency_rate: number;
    score_origin_breakdown: { provided: number; inferred: number };
    quality_gate: 'pass' | 'warn' | 'blocked';
}

interface DryRunResult {
    valid_rows: ParsedRow[];
    validation_errors: RowError[];
    task_clusters: TaskCluster[];
    quality_summary: QualitySummary;
}

// ── File parser ───────────────────────────────────────────────

/**
 * Attempts to recover records from JSON / JSONL / CSV and messy log text.
 * Strategy: salvage as much structure as possible instead of hard-failing
 * on the first malformed line.
 * Never throws — returns { records, error } so the caller can surface
 * a clean HTTP error.
 */
export function parseFileContent(content: string): { records: Record<string, unknown>[]; error?: string } {
    const trimmed = content.trim();
    if (!trimmed) return { records: [], error: 'File is empty.' };

    // 1) Full JSON document parse (array, object, wrapped records).
    const jsonDocRecords = parseJsonDocument(trimmed);
    if (jsonDocRecords.length > 0) return { records: jsonDocRecords };

    // 2) JSON per line / lines containing JSON fragments.
    const jsonLineRecords = parseJsonRecordsFromLines(trimmed);
    if (jsonLineRecords.length > 0) return { records: jsonLineRecords };

    // 3) Embedded JSON object recovery from noisy logs.
    const embeddedJsonRecords = extractJsonObjectsFromText(trimmed);
    if (embeddedJsonRecords.length > 0) return { records: embeddedJsonRecords };

    // 4) Delimited records (CSV/TSV/semicolon/pipe), with or without headers.
    const delimitedRecords = parseDelimitedRecords(trimmed);
    if (delimitedRecords.length > 0) return { records: delimitedRecords };

    // 5) key=value or key:value style log lines.
    const kvRecords = parseKeyValueRecords(trimmed);
    if (kvRecords.length > 0) return { records: kvRecords };

    return {
        records: [],
        error:
            'Could not detect structured records in the file. Include at least action/issue/success fields in JSON, CSV, or log key=value lines.',
    };
}

export function splitCsvLine(line: string): string[] {
    return splitDelimitedLine(line, ',');
}

const JSON_CONTAINER_KEYS = [
    'records',
    'rows',
    'data',
    'events',
    'logs',
    'items',
    'results',
    'entries',
] as const;

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;

function normalizeFieldName(raw: string): string {
    return raw
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase()
        .replace(/[\s\-]+/g, '_');
}

function normalizeRecordKeys(record: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        normalized[key] = value;
        const canonical = normalizeFieldName(key);
        if (!(canonical in normalized)) {
            normalized[canonical] = value;
        }
    }
    return normalized;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecords(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter(isRecordObject).map(normalizeRecordKeys);
    }

    if (!isRecordObject(value)) {
        return [];
    }

    for (const key of JSON_CONTAINER_KEYS) {
        const maybeList = value[key];
        if (Array.isArray(maybeList)) {
            const rows = maybeList.filter(isRecordObject).map(normalizeRecordKeys);
            if (rows.length > 0) return rows;
        }
    }

    let largestNestedRows: Record<string, unknown>[] = [];
    for (const nested of Object.values(value)) {
        if (!Array.isArray(nested)) continue;
        const rows = nested.filter(isRecordObject).map(normalizeRecordKeys);
        if (rows.length > largestNestedRows.length) {
            largestNestedRows = rows;
        }
    }
    if (largestNestedRows.length > 0) return largestNestedRows;

    return [normalizeRecordKeys(value)];
}

function tryParseJson(text: string): unknown | null {
    const clean = text.replace(/^\uFEFF/, '').trim();
    if (!clean) return null;

    try {
        return JSON.parse(clean);
    } catch {
        // Best-effort salvage for trailing commas in arrays/objects.
        const relaxed = clean.replace(/,\s*([}\]])/g, '$1');
        if (relaxed !== clean) {
            try {
                return JSON.parse(relaxed);
            } catch {
                return null;
            }
        }
        return null;
    }
}

function parseJsonDocument(text: string): Record<string, unknown>[] {
    const parsed = tryParseJson(text);
    if (parsed === null) return [];
    return toRecords(parsed);
}

function parseJsonRecordsFromLines(text: string): Record<string, unknown>[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const rows: Record<string, unknown>[] = [];
    for (const line of lines) {
        const direct = parseJsonDocument(line);
        if (direct.length > 0) {
            rows.push(...direct);
            continue;
        }

        const firstBrace = line.indexOf('{');
        const lastBrace = line.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            const fragment = line.slice(firstBrace, lastBrace + 1);
            const parsedFragment = parseJsonDocument(fragment);
            if (parsedFragment.length > 0) {
                rows.push(...parsedFragment);
            }
        }
    }
    return rows;
}

function extractJsonObjectsFromText(text: string): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    let depth = 0;
    let start = -1;
    let inQuotes = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];

        if (inQuotes) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inQuotes = false;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
            continue;
        }

        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
            continue;
        }

        if (ch === '}') {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0 && start >= 0) {
                const fragment = text.slice(start, i + 1);
                const parsed = parseJsonDocument(fragment);
                if (parsed.length > 0) rows.push(...parsed);
                start = -1;
            }
        }
    }

    return rows;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
    let inQuotes = false;
    let count = 0;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (!inQuotes && ch === delimiter) {
            count += 1;
        }
    }

    return count;
}

function detectDelimiter(lines: string[]): string {
    let bestDelimiter = ',';
    let bestScore = -1;
    const sample = lines.slice(0, 25);

    for (const delimiter of DELIMITER_CANDIDATES) {
        const score = sample.reduce((sum, line) => sum + countDelimiterOutsideQuotes(line, delimiter), 0);
        if (score > bestScore) {
            bestScore = score;
            bestDelimiter = delimiter;
        }
    }

    return bestDelimiter;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === delimiter && !inQuotes) {
            result.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    result.push(current.trim());
    return result.map((v) => v.replace(/^["']|["']$/g, ''));
}

function looksLikeHeader(values: string[]): boolean {
    if (values.length === 0) return false;

    const knownFields = new Set([
        ...ACTION_FIELDS,
        ...ISSUE_FIELDS,
        ...SUCCESS_FIELDS,
        ...SCORE_FIELDS,
        ...TIMESTAMP_FIELDS,
        'business_outcome',
        'session_id',
        'response_time_ms',
    ]);

    let knownMatches = 0;
    for (const v of values) {
        if (knownFields.has(normalizeFieldName(v))) {
            knownMatches += 1;
        }
    }
    return knownMatches > 0;
}

function parseDelimitedRecords(text: string): Record<string, unknown>[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return [];

    const delimiter = detectDelimiter(lines);
    const firstRow = splitDelimitedLine(lines[0], delimiter);
    if (firstRow.length < 2) return [];

    const hasHeader = looksLikeHeader(firstRow);
    const headers = hasHeader
        ? firstRow.map((h) => normalizeFieldName(h))
        : firstRow.map((_, idx) => `col_${idx + 1}`);

    const startIndex = hasHeader ? 1 : 0;
    const rows: Record<string, unknown>[] = [];

    for (let i = startIndex; i < lines.length; i += 1) {
        const values = splitDelimitedLine(lines[i], delimiter);
        if (values.length === 0 || values.every((v) => v.length === 0)) continue;

        const width = Math.max(headers.length, values.length);
        const row: Record<string, unknown> = {};
        for (let col = 0; col < width; col += 1) {
            const key = headers[col] ?? `col_${col + 1}`;
            row[key] = values[col] ?? '';
        }

        if (!hasHeader && values.length >= 3) {
            if (row.action_name === undefined) row.action_name = values[0];
            if (row.issue_type === undefined) row.issue_type = values[1];
            if (row.success === undefined) row.success = values[2];
            if (values.length >= 4 && row.outcome_score === undefined) row.outcome_score = values[3];
            if (values.length >= 5 && row.business_outcome === undefined) row.business_outcome = values[4];
        }

        rows.push(normalizeRecordKeys(row));
    }

    return rows;
}

function stripQuoted(value: string): string {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseKeyValueRecords(text: string): Record<string, unknown>[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const rows: Record<string, unknown>[] = [];
    const kvPattern = /([a-zA-Z_][a-zA-Z0-9_.-]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,\s]+)/g;

    for (const line of lines) {
        const row: Record<string, unknown> = {};
        let match: RegExpExecArray | null;
        while ((match = kvPattern.exec(line)) !== null) {
            const key = normalizeFieldName(match[1]);
            const value = stripQuoted(match[2]);
            row[key] = value;
        }
        if (Object.keys(row).length > 0) {
            rows.push(row);
        }
    }

    return rows;
}

// ── Field extraction from raw record ─────────────────────────

const ACTION_FIELDS = ['action_name', 'action', 'action_taken', 'handler', 'function_name'];
const ISSUE_FIELDS = ['issue_type', 'task_type', 'task', 'issue', 'type', 'context', 'category', 'event_type'];
const SUCCESS_FIELDS = ['success', 'result', 'outcome', 'status', 'passed', 'succeeded'];
const SCORE_FIELDS = ['outcome_score', 'score', 'confidence', 'quality'];
const TIMESTAMP_FIELDS = ['timestamp', 'created_at', 'occurred_at', 'event_at', 'logged_at', 'date', 'time'];
const ENVIRONMENT_FIELDS = ['environment', 'env', 'runtime_environment', 'deployment_environment', 'stage'];
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractField<T = string>(
    record: Record<string, unknown>,
    candidates: string[],
    transform: (v: unknown) => T | null,
): T | null {
    for (const key of candidates) {
        const val = record[key] ?? record[key.toUpperCase()] ?? record[key.toLowerCase()];
        if (val !== undefined && val !== null && val !== '') {
            const result = transform(val);
            if (result !== null) return result;
        }
    }
    return null;
}

export function extractSuccess(record: Record<string, unknown>): boolean | null {
    return extractField(record, SUCCESS_FIELDS, (v) => {
        const s = String(v).toLowerCase().trim();
        if (['true', '1', 'yes', 'success', 'pass', 'passed', 'ok', 'resolved'].includes(s)) return true;
        if (['false', '0', 'no', 'fail', 'failed', 'error', 'failure', 'partial'].includes(s)) return false;
        return null;
    });
}

export function extractScore(record: Record<string, unknown>): number | null {
    return extractField(record, SCORE_FIELDS, (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        // Handle percentage-style scores (e.g. 85 -> 0.85).
        // Keep low decimal values above 1 (e.g. 1.5) on the 0-1 scale by clamping.
        if (n > 1 && n <= 100 && n >= 10) return Math.round((n / 100) * 10000) / 10000;
        return Math.max(0, Math.min(1, n));
    });
}

function extractTimestamp(record: Record<string, unknown>): Date | null {
    return extractField(record, TIMESTAMP_FIELDS, (v) => {
        const d = new Date(String(v));
        return Number.isNaN(d.getTime()) ? null : d;
    });
}

export function normalizeEnvironment(raw: unknown): 'production' | 'staging' | 'development' {
    const normalized = String(raw ?? 'production').trim().toLowerCase();
    const aliases: Record<string, 'production' | 'staging' | 'development'> = {
        prod: 'production',
        production: 'production',
        stage: 'staging',
        stg: 'staging',
        qa: 'staging',
        test: 'staging',
        uat: 'staging',
        staging: 'staging',
        dev: 'development',
        develop: 'development',
        development: 'development',
    };
    return aliases[normalized] ?? 'production';
}

export function normalizeBusinessOutcome(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.toLowerCase().trim();
    if (['resolved', 'success', 'done', 'complete', 'completed'].includes(s)) return 'resolved';
    if (['partial', 'partial_success', 'partial_failure'].includes(s)) return 'partial';
    if (['failed', 'failure', 'error', 'rejected'].includes(s)) return 'failed';
    return 'unknown';
}

// ── Dry-run parse pass ────────────────────────────────────────

/**
 * Parses the entire file, normalizes all fields, computes quality scores,
 * clusters tasks. Does NOT write to the DB.
 * Returns valid rows ready for ingestion + validation errors.
 */
export function dryRunParse(
    records: Record<string, unknown>[],
    agentId: string,
    customerId: string,
): DryRunResult {
    const validRows: ParsedRow[] = [];
    const validationErrors: RowError[] = [];
    const taskCountMap: Record<string, number> = {};

    let totalQuality = 0;
    let inconsistentCount = 0;
    let providedScoreCount = 0;

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const rowIndex = i + 1;
        const rowErrors: RowError[] = [];

        // Required: action_name
        const actionNameRaw = extractField(rec, ACTION_FIELDS, (v) => {
            const s = sanitizeString(String(v), 255).trim();
            return s.length > 0 ? s : null;
        });
        if (!actionNameRaw) {
            rowErrors.push({ row: rowIndex, field: 'action_name', reason: 'Missing or empty. Add action_name, action, or handler field.' });
        }

        // Required: issue_type (used for task inference)
        const issueTypeRaw = extractField(rec, ISSUE_FIELDS, (v) => {
            const s = sanitizeString(String(v), 255).trim();
            return s.length > 0 ? s : null;
        });
        if (!issueTypeRaw) {
            rowErrors.push({ row: rowIndex, field: 'issue_type', reason: 'Missing. Add issue_type, task_type, task, or category field.' });
        }

        // Required: success
        const success = extractSuccess(rec);
        if (success === null) {
            rowErrors.push({ row: rowIndex, field: 'success', reason: 'Cannot determine success/failure. Add result=true/false or success=1/0.' });
        }

        if (rowErrors.length > 0) {
            validationErrors.push(...rowErrors);
            continue;
        }

        // Optional fields
        const outcomeScore = extractScore(rec);
        const timestamp = extractTimestamp(rec);
        const businessOutcomeRaw = extractField(rec, ['business_outcome', 'outcome', 'resolution', 'resolution_status'], (v) => String(v));
        const businessOutcome = normalizeBusinessOutcome(businessOutcomeRaw);
        const responseMs = extractField(rec, ['response_ms', 'response_time_ms', 'latency_ms', 'duration_ms', 'latency'], (v) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
        });
        const sessionId = extractField(rec, ['session_id', 'session', 'request_id', 'trace_id'], (v) => {
            const s = String(v).trim();
            return UUID_RE.test(s) ? s : null;
        });
        const environment = extractField(rec, ENVIRONMENT_FIELDS, (v) => normalizeEnvironment(v)) ?? 'production';

        // Task resolution
        const providedTask = extractField(rec, ['task_name', 'task_type', 'task'], (v) => {
            const s = String(v).trim();
            return s.length > 0 ? s : null;
        });
        const taskResult = resolveTaskName(providedTask, issueTypeRaw!);

        // Validate task resolved to something non-empty
        if (!taskResult.task || taskResult.task.trim().length === 0) {
            validationErrors.push({ row: rowIndex, field: 'task_name', reason: 'Could not infer task name from issue_type. Provide task_name explicitly.' });
            continue;
        }

        // Idempotency key — deterministic from content so retries are safe
        const idemBase = `${customerId}|${agentId}|${actionNameRaw}|${issueTypeRaw}|${String(success)}|${timestamp?.toISOString() ?? i}`;
        const idempotencyKey = crypto.createHash('sha256').update(idemBase).digest('hex').slice(0, 64);

        // Quality scoring (mirrors computeDataQuality in ingest-core)
        const isInconsistent = success === true && outcomeScore !== null && outcomeScore < 0.3;
        let quality = 1.0;
        if (outcomeScore === null) quality -= 0.25;
        if (isInconsistent) quality -= 0.20;
        if (taskResult.confidence < 0.70) quality -= 0.20;
        if (!businessOutcome) quality -= 0.10;
        quality = Math.max(0.0, quality);

        totalQuality += quality;
        if (isInconsistent) inconsistentCount++;
        if (outcomeScore !== null) providedScoreCount++;
        taskCountMap[taskResult.task] = (taskCountMap[taskResult.task] ?? 0) + 1;

        validRows.push({
            row_index: rowIndex,
            row: {
                agent_id: agentId,
                action_name: actionNameRaw!,
                issue_type: issueTypeRaw!,
                success: success!,
                outcome_score: outcomeScore,
                business_outcome: businessOutcome,
                session_id: sessionId,
                response_time_ms: responseMs,
                feedback_signal: 'immediate',
                environment,
                task_name: taskResult.task,
                task_mapping_confidence: taskResult.confidence,
                task_mapping_tier: taskResult.tier,
                idempotency_key: idempotencyKey,
            },
            idempotency_key: idempotencyKey,
            quality,
            resolved_task: taskResult.task,
            // sourceEventAt attached separately when creating IngestCoreOptions
        });

        // Attach timestamp to row for later use
        (validRows[validRows.length - 1] as any).__sourceEventAt = timestamp;
    }

    // Build task clusters
    const totalValid = validRows.length;
    const taskClusters: TaskCluster[] = Object.entries(taskCountMap)
        .map(([task_name, count]) => ({
            task_name,
            count,
            share: totalValid > 0 ? Math.round((count / totalValid) * 10000) / 10000 : 0,
        }))
        .sort((a, b) => b.count - a.count);

    // Quality summary
    const avgQuality = totalValid > 0 ? Math.round((totalQuality / totalValid) * 10000) / 10000 : 0;
    const inconsistencyRate = totalValid > 0 ? Math.round((inconsistentCount / totalValid) * 10000) / 10000 : 0;
    const providedShare = totalValid > 0 ? Math.round((providedScoreCount / totalValid) * 10000) / 10000 : 0;

    const qualityGate: QualitySummary['quality_gate'] =
        avgQuality < QUALITY_GATE_BLOCK ? 'blocked' :
            avgQuality < QUALITY_GATE_WARN ? 'warn' : 'pass';

    return {
        valid_rows: validRows,
        validation_errors: validationErrors,
        task_clusters: taskClusters,
        quality_summary: {
            avg_quality: avgQuality,
            inconsistency_rate: inconsistencyRate,
            score_origin_breakdown: {
                provided: providedShare,
                inferred: Math.round((1 - providedShare) * 10000) / 10000,
            },
            quality_gate: qualityGate,
        },
    };
}

// ── Background job processor ──────────────────────────────────

/**
 * Processes an import job asynchronously.
 * Called fire-and-forget from POST /v1/import.
 * Updates import_jobs table with progress and final status.
 */
async function processImportJob(
    jobId: string,
    validRows: ParsedRow[],
    customerId: string,
): Promise<void> {
    // Mark job as running
    await supabase
        .from('import_jobs')
        .update({ status: 'running' })
        .eq('job_id', jobId);

    let rowsProcessed = 0;
    let rowsFailed = 0;
    const errors: Array<{ row: number; error: string }> = [];

    // Process in chunks to avoid memory pressure
    for (let offset = 0; offset < validRows.length; offset += CHUNK_SIZE) {
        const chunk = validRows.slice(offset, offset + CHUNK_SIZE);

        for (const parsed of chunk) {
            try {
                const sourceEventAt: Date | null = (parsed as any).__sourceEventAt ?? null;
                await ingestOutcome(parsed.row, customerId, {
                    skipTrustUpdate: true,
                    ingestionSource: 'import',
                    // Import defaults to no inference for predictable historical replays.
                    // Opt in only when explicitly enabled for this deployment.
                    enableInferenceWhenSkipTrust: ENABLE_IMPORT_INFERENCE,
                    sourceEventAt,
                    importJobId: jobId,
                });
                rowsProcessed++;
            } catch (err: any) {
                rowsFailed++;
                errors.push({ row: parsed.row_index, error: err.message ?? 'Unknown error' });
                // Log but continue — partial success is valid
                console.warn('[import] row failed:', { jobId, row: parsed.row_index, error: err.message });
            }
        }

        // Update progress in DB after each chunk
        await supabase
            .from('import_jobs')
            .update({ rows_processed: rowsProcessed, rows_failed: rowsFailed })
            .eq('job_id', jobId);
    }

    // End-of-batch: refresh both MVs and clear score cache
    try {
        await Promise.all([
            supabase.rpc('refresh_task_action_performance'),
            supabase.rpc('refresh_action_scores'),
        ]);
        console.info('[import] MV refresh complete', { jobId });
    } catch (err: any) {
        console.warn('[import] MV refresh failed (non-fatal):', err.message);
    }

    // Clear in-memory score cache so next getScores() reads fresh data
    try {
        const internalSecret = process.env.LAYERINFINITE_INTERNAL_SECRET;
        const apiBase = process.env.API_CACHE_REFRESH_URL ?? '';
        if (internalSecret && apiBase) {
            await fetch(`${apiBase}/internal/refresh-score-cache`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${internalSecret}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ triggered_by: 'import', job_id: jobId }),
            });
        }
    } catch (err: any) {
        console.warn('[import] cache refresh notification failed (non-fatal):', err.message);
    }

    // Mark job complete
    const finalStatus = rowsFailed === validRows.length && validRows.length > 0 ? 'failed' : 'done';
    await supabase
        .from('import_jobs')
        .update({
            status: finalStatus,
            rows_processed: rowsProcessed,
            rows_failed: rowsFailed,
            errors: errors.slice(0, 500), // cap stored errors to avoid JSONB blowup
            completed_at: new Date().toISOString(),
        })
        .eq('job_id', jobId);

    console.info('[import] job complete', { jobId, rowsProcessed, rowsFailed, status: finalStatus });
}

// ── POST /v1/import ───────────────────────────────────────────

importRouter.post('/', async (c) => {
    const agentId = c.get('agent_id') as string | undefined;
    const customerId = c.get('customer_id') as string | undefined;
    const agentNameFromKey = c.get('agent_name') as string | undefined;

    if (!customerId || !agentId) {
        return c.json({ error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' }, 401);
    }

    // ── Parse multipart body ───────────────────────────────
    let fileContent: string;
    let assertedAgentName: string | null = null;
    let isDryRun = false;

    try {
        const contentType = c.req.header('content-type') ?? '';

        if (contentType.includes('multipart/form-data')) {
            const formData = await c.req.formData();
            const file = formData.get('file');
            if (!file || typeof file === 'string') {
                return c.json({ error: 'Missing file field in multipart body.', code: 'MISSING_FILE' }, 400);
            }
            const fileBlob = file as File;

            // File size guard
            if (fileBlob.size > MAX_FILE_BYTES) {
                return c.json({
                    error: `File too large. Maximum size is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
                    code: 'FILE_TOO_LARGE',
                    max_bytes: MAX_FILE_BYTES,
                }, 413);
            }

            fileContent = await fileBlob.text();
            assertedAgentName = (formData.get('agent_name') as string | null)?.trim() || null;
            isDryRun = (formData.get('dry_run') as string | null) === 'true';
        } else {
            // Accept raw JSON body for programmatic use
            const body = await c.req.json() as Record<string, unknown>;
            const raw = body.content ?? body.file_content;
            if (typeof raw !== 'string' || !raw.trim()) {
                return c.json({ error: 'Missing content field.', code: 'MISSING_CONTENT' }, 400);
            }
            if (new TextEncoder().encode(raw).length > MAX_FILE_BYTES) {
                return c.json({ error: 'Content too large.', code: 'FILE_TOO_LARGE' }, 413);
            }
            fileContent = raw;
            assertedAgentName = typeof body.agent_name === 'string' ? body.agent_name.trim() : null;
            isDryRun = body.dry_run === true;
        }
    } catch (err: any) {
        return c.json({ error: `Failed to read request body: ${err.message}`, code: 'PARSE_ERROR' }, 400);
    }

    // ── Agent name assertion ───────────────────────────────
    // Key-derived identity always wins. If caller provides agent_name,
    // assert it matches the key's agent name to prevent confusion.
    if (assertedAgentName && agentNameFromKey && assertedAgentName !== agentNameFromKey) {
        return c.json({
            error: `agent_name mismatch. API key belongs to agent "${agentNameFromKey}" but you provided "${assertedAgentName}". Use the API key that belongs to this agent.`,
            code: 'AGENT_NAME_MISMATCH',
            key_agent_name: agentNameFromKey,
        }, 400);
    }

    // ── Parse file ─────────────────────────────────────────
    const { records, error: parseError } = parseFileContent(fileContent);
    if (parseError) {
        return c.json({ error: parseError, code: 'PARSE_ERROR' }, 422);
    }

    if (records.length === 0) {
        return c.json({ error: 'No records found in file.', code: 'EMPTY_FILE' }, 422);
    }

    // Row count guard
    if (records.length > MAX_ROWS) {
        return c.json({
            error: `Too many rows. Maximum is ${MAX_ROWS} rows per upload. Found ${records.length}.`,
            code: 'TOO_MANY_ROWS',
            found: records.length,
            max: MAX_ROWS,
        }, 422);
    }

    // ── Dry-run parse pass (always runs) ──────────────────
    const dryRun = dryRunParse(records, agentId, customerId);

    // Quality gate: block if average quality is too low
    if (dryRun.quality_summary.quality_gate === 'blocked') {
        return c.json({
            error: 'Data quality too low to import. Fix your log fields and retry.',
            code: 'QUALITY_GATE_BLOCKED',
            task_clusters: dryRun.task_clusters,
            quality_summary: dryRun.quality_summary,
            validation_errors: dryRun.validation_errors.slice(0, 50),
        }, 422);
    }

    // If dry_run=true, return preview without queuing
    if (isDryRun || dryRun.valid_rows.length === 0) {
        return c.json({
            dry_run: true,
            queued_rows: dryRun.valid_rows.length,
            validation_errors: dryRun.validation_errors.slice(0, 200),
            task_clusters: dryRun.task_clusters,
            quality_summary: dryRun.quality_summary,
        }, 200);
    }

    // ── Create job record ──────────────────────────────────
    const { data: job, error: jobErr } = await supabase
        .from('import_jobs')
        .insert({
            customer_id: customerId,
            agent_id: agentId,
            status: 'queued',
            queued_rows: dryRun.valid_rows.length,
            quality_summary: dryRun.quality_summary,
            task_clusters: dryRun.task_clusters,
        })
        .select('job_id')
        .single();

    if (jobErr || !job) {
        console.error('[import] Failed to create job record:', jobErr?.message);
        return c.json({ error: 'Failed to queue import job.', code: 'JOB_CREATE_ERROR' }, 500);
    }

    const jobId: string = job.job_id;

    // ── Queue background processing ────────────────────────
    // Fire-and-forget: processImportJob runs outside the request lifecycle.
    // The response returns immediately with job_id.
    // The client polls GET /v1/import/:job_id for status.
    setImmediate(() => {
        processImportJob(jobId, dryRun.valid_rows, customerId).catch(err => {
            console.error('[import] processImportJob unhandled error:', {
                jobId,
                error: (err as Error).message,
            });
            // Mark job as failed in DB so client knows it errored
            void (async () => {
                try {
                    await supabase
                        .from('import_jobs')
                        .update({ status: 'failed', errors: [{ error: (err as Error).message }] })
                        .eq('job_id', jobId);
                } catch {
                    // Best-effort error marker only.
                }
            })();
        });
    });

    return c.json({
        job_id: jobId,
        status: 'queued',
        queued_rows: dryRun.valid_rows.length,
        validation_errors: dryRun.validation_errors.slice(0, 200),
        task_clusters: dryRun.task_clusters,
        quality_summary: dryRun.quality_summary,
    }, 202);
});

// ── GET /v1/import/:job_id ────────────────────────────────────

importRouter.get('/:job_id', async (c) => {
    const customerId = c.get('customer_id') as string | undefined;
    if (!customerId) {
        return c.json({ error: 'Unauthorized', code: 'MISSING_CUSTOMER_ID' }, 401);
    }

    const jobId = c.req.param('job_id');
    if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
        return c.json({ error: 'Invalid job_id format.', code: 'INVALID_JOB_ID' }, 400);
    }

    const { data: job, error } = await supabase
        .from('import_jobs')
        .select('job_id, status, queued_rows, rows_processed, rows_failed, errors, quality_summary, task_clusters, created_at, completed_at')
        .eq('job_id', jobId)
        .eq('customer_id', customerId)  // tenant isolation
        .maybeSingle();

    if (error) {
        console.error('[import] job fetch error:', error.message);
        return c.json({ error: 'Failed to fetch job status.', code: 'DB_ERROR' }, 500);
    }

    if (!job) {
        return c.json({ error: 'Import job not found.', code: 'NOT_FOUND' }, 404);
    }

    return c.json({
        job_id: job.job_id,
        status: job.status,
        queued_rows: job.queued_rows,
        rows_processed: job.rows_processed,
        rows_failed: job.rows_failed,
        errors: (job.errors as Array<unknown> ?? []).slice(0, 100),
        quality_summary: job.quality_summary,
        task_clusters: job.task_clusters,
        created_at: job.created_at,
        completed_at: job.completed_at ?? null,
        progress_pct: job.queued_rows > 0
            ? Math.round(((job.rows_processed + job.rows_failed) / job.queued_rows) * 100)
            : 0,
    }, 200);
});
