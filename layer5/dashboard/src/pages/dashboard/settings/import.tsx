/**
 * LAYERINFINITE — Settings → Import History
 * ══════════════════════════════════════════════════════════════
 * Upload historical agent log files to seed the scoring engine
 * before SDK integration. Same API key = seamless continuity.
 *
 * Flow:
 *   1. User selects a file (JSON / JSONL / CSV)
 *   2. Dry-run preview shows: task clusters, quality score, row errors
 *   3. User confirms → POST /v1/import queues the job
 *   4. Progress bar polls GET /v1/import/:job_id until done
 *   5. Completion summary with link to Recommendations
 * ══════════════════════════════════════════════════════════════
 */

import React, { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE } from '../../../lib/config';
import { useAgentApiKey } from '../../../hooks/useAgentApiKey';
import { createAgentFetch } from '../../../lib/api';
import { useToastContext } from '../../../components/Toast';

// ── Types ─────────────────────────────────────────────────────

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

interface RowError {
  row: number;
  field: string;
  reason: string;
}

interface PreviewData {
  job_id?: string;
  dry_run?: boolean;
  queued_rows: number;
  validation_errors: RowError[];
  task_clusters: TaskCluster[];
  quality_summary: QualitySummary;
}

interface JobStatus {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked';
  queued_rows: number;
  rows_processed: number;
  rows_failed: number;
  errors: Array<{ row: number; error: string }>;
  progress_pct: number;
  completed_at: string | null;
}

type UploadStage =
  | 'idle'
  | 'parsing'     // client-side file read
  | 'previewing'  // dry-run result shown, awaiting user confirm
  | 'uploading'   // job queued, polling
  | 'done'
  | 'error';

// ── Helpers ───────────────────────────────────────────────────

function qualityColor(gate: QualitySummary['quality_gate']): string {
  if (gate === 'pass') return 'text-[#00cc66]';
  if (gate === 'warn') return 'text-[#ffaa00]';
  return 'text-[#ff4444]';
}

function qualityBg(gate: QualitySummary['quality_gate']): string {
  if (gate === 'pass') return 'bg-[#00cc66]/10 border-[#00cc66]/30';
  if (gate === 'warn') return 'bg-[#ffaa00]/10 border-[#ffaa00]/30';
  return 'bg-[#ff4444]/10 border-[#ff4444]/30';
}

function formatQuality(q: number): string {
  return `${Math.round(q * 100)}%`;
}

// ── Component ─────────────────────────────────────────────────

export default function ImportSettings(): React.ReactElement {
  const { apiKey, handleAuthFailure } = useAgentApiKey();
  const { showToast } = useToastContext();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<UploadStage>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pollHandle, setPollHandle] = useState<ReturnType<typeof setInterval> | null>(null);

  const agentFetch = useCallback(
    (url: string, opts?: RequestInit) => {
      if (!apiKey) throw new Error('No API key');
      return createAgentFetch(apiKey, handleAuthFailure)(url, opts);
    },
    [apiKey, handleAuthFailure],
  );

  // ── File selection ─────────────────────────────────────────
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset state
      setSelectedFile(file);
      setPreview(null);
      setJob(null);
      setErrorMsg(null);
      setStage('parsing');

      if (!apiKey) {
        setErrorMsg('No API key found. Create one in Settings → API Keys first.');
        setStage('error');
        return;
      }

      // Run dry-run preview
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('dry_run', 'true');

        const res = await agentFetch(`${API_BASE}/v1/import`, {
          method: 'POST',
          headers: {}, // let browser set multipart boundary
          body: form,
        });

        const data = await res.json() as PreviewData & { error?: string; code?: string };

        if (!res.ok) {
          if (res.status === 422 && data.quality_summary) {
            // Quality gate blocked — show preview with error state
            setPreview(data as PreviewData);
            setStage('previewing');
            return;
          }
          setErrorMsg(data.error ?? `Server error ${res.status}`);
          setStage('error');
          return;
        }

        setPreview(data);
        setStage('previewing');
      } catch (err: any) {
        setErrorMsg(err.message ?? 'Failed to preview file.');
        setStage('error');
      }
    },
    [apiKey, agentFetch],
  );

  // ── Confirm import ─────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    if (!selectedFile || !apiKey) return;
    setStage('uploading');

    try {
      const form = new FormData();
      form.append('file', selectedFile);

      const res = await agentFetch(`${API_BASE}/v1/import`, {
        method: 'POST',
        headers: {},
        body: form,
      });

      const data = await res.json() as PreviewData & { job_id?: string; error?: string };

      if (!res.ok || !data.job_id) {
        setErrorMsg(data.error ?? `Server error ${res.status}`);
        setStage('error');
        return;
      }

      // Start polling
      const jid = data.job_id;
      const handle = setInterval(async () => {
        try {
          const statusRes = await agentFetch(`${API_BASE}/v1/import/${jid}`);
          const status = await statusRes.json() as JobStatus;
          setJob(status);

          if (status.status === 'done' || status.status === 'failed') {
            clearInterval(handle);
            setPollHandle(null);
            setStage(status.status === 'done' ? 'done' : 'error');
            if (status.status === 'done') {
              showToast(`Import complete — ${status.rows_processed} outcomes loaded.`, 'success');
            } else {
              setErrorMsg('Import job failed. See errors below.');
            }
          }
        } catch {
          // Poll error is non-fatal — keep polling
        }
      }, 2000);

      setPollHandle(handle);
    } catch (err: any) {
      setErrorMsg(err.message ?? 'Failed to start import.');
      setStage('error');
    }
  }, [selectedFile, apiKey, agentFetch, showToast]);

  // ── Reset ──────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    if (pollHandle) clearInterval(pollHandle);
    setStage('idle');
    setSelectedFile(null);
    setPreview(null);
    setJob(null);
    setErrorMsg(null);
    setPollHandle(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [pollHandle]);

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold text-white mb-1">Import History</h2>
      <p className="text-sm text-[#a1a1aa] mb-6">
        Upload historical agent logs to seed recommendations before SDK integration.
        Use the same API key as your SDK — outcomes merge automatically.
      </p>

      {/* ── Format guide ─────────────────────────────────── */}
      <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6">
        <h3 className="text-sm font-medium text-white mb-3">Accepted formats</h3>
        <div className="grid grid-cols-3 gap-3 text-xs">
          {[
            { label: 'JSON array', example: '[{"action_name":"retry","issue_type":"payment_failed","success":true}]' },
            { label: 'JSONL', example: '{"action_name":"retry","success":true}\n{"action_name":"escalate","success":false}' },
            { label: 'CSV', example: 'action_name,issue_type,success\nretry,payment_failed,true' },
          ].map(({ label, example }) => (
            <div key={label} className="bg-[#0a0a0f] rounded-lg p-3">
              <div className="text-[#a1a1aa] font-medium mb-2">{label}</div>
              <pre className="text-[#71717a] whitespace-pre-wrap break-all leading-relaxed">{example}</pre>
            </div>
          ))}
        </div>
        <div className="mt-3 text-xs text-[#71717a]">
          Required fields: <span className="text-white">action_name</span>,{' '}
          <span className="text-white">issue_type</span> (or task_type / category),{' '}
          <span className="text-white">success</span> (true/false).
          Optional: outcome_score, business_outcome, timestamp, response_ms.
          Max 10,000 rows · 5 MB.
        </div>
      </section>

      {/* ── Upload zone ──────────────────────────────────── */}
      {(stage === 'idle' || stage === 'error') && (
        <section className="mb-6">
          <label
            htmlFor="import-file"
            className={`flex flex-col items-center justify-center w-full h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors
              ${stage === 'error'
                ? 'border-[#ff4444]/40 bg-[#ff4444]/5 hover:bg-[#ff4444]/10'
                : 'border-[#1a1a24] bg-[#111118] hover:bg-[#1a1a24]'}`}
          >
            <span className="text-2xl mb-2">📂</span>
            <span className="text-sm text-white font-medium">
              {selectedFile ? selectedFile.name : 'Click to select file'}
            </span>
            <span className="text-xs text-[#71717a] mt-1">JSON, JSONL, or CSV</span>
            <input
              id="import-file"
              ref={fileInputRef}
              type="file"
              accept=".json,.jsonl,.csv,application/json,text/csv,text/plain"
              className="hidden"
              onChange={handleFileChange}
            />
          </label>
          {errorMsg && (
            <div className="mt-3 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm">
              {errorMsg}
            </div>
          )}
        </section>
      )}

      {/* ── Parsing spinner ───────────────────────────────── */}
      {stage === 'parsing' && (
        <div className="flex items-center gap-3 text-sm text-[#a1a1aa] mb-6">
          <div className="w-4 h-4 border-2 border-[#b8ff00] border-t-transparent rounded-full animate-spin" />
          Analysing file…
        </div>
      )}

      {/* ── Dry-run preview ───────────────────────────────── */}
      {stage === 'previewing' && preview && (
        <section className="mb-6 space-y-4">
          {/* Quality gate banner */}
          <div className={`border rounded-xl px-4 py-3 text-sm ${qualityBg(preview.quality_summary.quality_gate)}`}>
            <div className="flex items-center justify-between">
              <span className={`font-semibold ${qualityColor(preview.quality_summary.quality_gate)}`}>
                Data quality: {formatQuality(preview.quality_summary.avg_quality)}
                {preview.quality_summary.quality_gate === 'blocked' && ' — too low to import'}
                {preview.quality_summary.quality_gate === 'warn' && ' — low signal, import allowed'}
                {preview.quality_summary.quality_gate === 'pass' && ' — good'}
              </span>
              <span className="text-[#a1a1aa] text-xs">
                {preview.queued_rows} valid row{preview.queued_rows !== 1 ? 's' : ''}
                {preview.validation_errors.length > 0 && `, ${preview.validation_errors.length} skipped`}
              </span>
            </div>
            {preview.quality_summary.inconsistency_rate > 0.1 && (
              <p className="text-[#a1a1aa] mt-1 text-xs">
                {Math.round(preview.quality_summary.inconsistency_rate * 100)}% inconsistent signals
                (success=true but low score). These rows are imported but flagged.
              </p>
            )}
            {preview.quality_summary.score_origin_breakdown.inferred > 0.5 && (
              <p className="text-[#a1a1aa] mt-1 text-xs">
                {Math.round(preview.quality_summary.score_origin_breakdown.inferred * 100)}% of rows
                have no outcome_score — confidence will be inferred from success/failure.
              </p>
            )}
          </div>

          {/* Task clusters */}
          {preview.task_clusters.length > 0 && (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4">
              <h3 className="text-sm font-medium text-white mb-3">Detected tasks</h3>
              <div className="space-y-2">
                {preview.task_clusters.map((cluster) => (
                  <div key={cluster.task_name} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-white font-mono truncate">{cluster.task_name}</span>
                        <span className="text-[#a1a1aa] ml-2 shrink-0">
                          {cluster.count} rows · {Math.round(cluster.share * 100)}%
                        </span>
                      </div>
                      <div className="h-1.5 bg-[#1a1a24] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#b8ff00] rounded-full"
                          style={{ width: `${Math.round(cluster.share * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[#71717a] mt-3">
                Confirm these match your SDK's task names. Edit your file if a task name looks wrong.
              </p>
            </div>
          )}

          {/* Validation errors (first 10) */}
          {preview.validation_errors.length > 0 && (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4">
              <h3 className="text-sm font-medium text-white mb-3">
                Skipped rows ({preview.validation_errors.length})
              </h3>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {preview.validation_errors.slice(0, 10).map((err, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="text-[#71717a] shrink-0">Row {err.row}</span>
                    <span className="text-[#ff8a8a]">{err.field}:</span>
                    <span className="text-[#a1a1aa]">{err.reason}</span>
                  </div>
                ))}
                {preview.validation_errors.length > 10 && (
                  <p className="text-xs text-[#71717a] pt-1">
                    …and {preview.validation_errors.length - 10} more
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {preview.quality_summary.quality_gate !== 'blocked' && preview.queued_rows > 0 ? (
              <button
                onClick={handleConfirm}
                className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-5 py-2 rounded-lg text-sm"
              >
                Import {preview.queued_rows} outcomes
              </button>
            ) : (
              <div className="text-sm text-[#ff8a8a] py-2">
                Fix the issues above and re-upload.
              </div>
            )}
            <button
              onClick={handleReset}
              className="border border-[#1a1a24] rounded-lg px-4 py-2 text-[#a1a1aa] hover:text-white text-sm"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/* ── Upload progress ───────────────────────────────── */}
      {stage === 'uploading' && (
        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between text-sm mb-3">
            <span className="text-white font-medium">Importing…</span>
            <span className="text-[#a1a1aa]">
              {job ? `${job.rows_processed + job.rows_failed} / ${job.queued_rows}` : 'Starting…'}
            </span>
          </div>
          <div className="h-2 bg-[#1a1a24] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#b8ff00] rounded-full transition-all duration-500"
              style={{ width: `${job?.progress_pct ?? 0}%` }}
            />
          </div>
          {job && job.rows_failed > 0 && (
            <p className="text-xs text-[#ffaa00] mt-2">
              {job.rows_failed} row{job.rows_failed !== 1 ? 's' : ''} failed so far
            </p>
          )}
        </section>
      )}

      {/* ── Completion summary ────────────────────────────── */}
      {stage === 'done' && job && (
        <section className="bg-[#00cc66]/10 border border-[#00cc66]/30 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-[#00cc66] mb-2">Import complete</h3>
          <div className="grid grid-cols-3 gap-4 text-sm mb-4">
            <div>
              <div className="text-2xl font-bold text-white">{job.rows_processed}</div>
              <div className="text-xs text-[#a1a1aa]">outcomes imported</div>
            </div>
            {job.rows_failed > 0 && (
              <div>
                <div className="text-2xl font-bold text-[#ff8a8a]">{job.rows_failed}</div>
                <div className="text-xs text-[#a1a1aa]">rows skipped</div>
              </div>
            )}
          </div>
          {job.errors && job.errors.length > 0 && (
            <div className="mb-4 max-h-32 overflow-y-auto space-y-1">
              {job.errors.slice(0, 20).map((e, i) => (
                <div key={i} className="text-xs text-[#ff8a8a]">Row {e.row}: {e.error}</div>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <Link
              to="/dashboard/recommendations"
              className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg text-sm"
            >
              View recommendations →
            </Link>
            <button
              onClick={handleReset}
              className="border border-[#1a1a24] rounded-lg px-4 py-2 text-[#a1a1aa] hover:text-white text-sm"
            >
              Import another file
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
