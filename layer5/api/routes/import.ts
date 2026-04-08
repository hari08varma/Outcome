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
 * Auto-detects JSON / JSONL / CSV and returns raw record objects.
 * Never throws — returns { records, error } so the caller can surface
 * a clean HTTP error.
 */
export function parseFileContent(content: string): { records: Record<string, unknown>[]; error?: string } {
    const trimmed = content.trim();
    if (!trimmed) return { records: [], error: 'File is empty.' };

    // ── JSON array ─────────────────────────────────────────
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (!Array.isArray(parsed)) return { records: [], error: 'JSON root must be an array.' };
            return { records: parsed };
        } catch (e: any) {
            return { records: [], error: `Invalid JSON: ${e.message}` };
        }
    }

    // ── JSONL (one JSON object per line) ───────────────────
    if (trimmed.startsWith('{')) {
        const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
        const records: Record<string, unknown>[] = [];
        for (let i = 0; i < lines.length; i++) {
            try {
                const obj = JSON.parse(lines[i]);
                if (typeof obj === 'object' && obj !== null) records.push(obj as Record<string, unknown>);
            } catch {
                return { records: [], error: `Invalid JSON on line ${i + 1}.` };
            }
        }
        return { records };
    }

    // ── CSV ────────────────────────────────────────────────
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return { records: [], error: 'CSV must have at least a header row and one data row.' };

    const headers = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
    const records: Record<string, unknown>[] = [];

    for (let i = 1; i < lines.length; i++) {
        const values = splitCsvLine(lines[i]);
        if (values.length !== headers.length) continue; // skip malformed rows silently
        const obj: Record<string, unknown> = {};
        headers.forEach((h, idx) => { obj[h] = values[idx]; });
        records.push(obj);
    }
    return { records };
}

export function splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    result.push(current.trim());
    return result;
}

// ── Field extraction from raw record ─────────────────────────

const ACTION_FIELDS = ['action_name', 'action', 'action_taken', 'handler', 'function_name'];
const ISSUE_FIELDS = ['issue_type', 'task_type', 'task', 'issue', 'type', 'context', 'category', 'event_type'];
const SUCCESS_FIELDS = ['success', 'result', 'outcome', 'status', 'passed', 'succeeded'];
const SCORE_FIELDS = ['outcome_score', 'score', 'confidence', 'quality'];
const TIMESTAMP_FIELDS = ['timestamp', 'created_at', 'occurred_at', 'event_at', 'logged_at', 'date', 'time'];
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
