import React, { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../../../lib/config';
import { createAgentFetch } from '../../../lib/api';
import { useAgentApiKey } from '../../../hooks/useAgentApiKey';

interface AuditOutcome {
  outcome_id: string;
  session_id: string;
  timestamp: string;
  success: boolean;
  response_time_ms: number | null;
  error_code: string | null;
  agent: { id: string; name: string; type: string };
  action: { id: string; name: string; category: string };
  context: { id: string; issue_type: string; environment: string };
}

interface AuditResponse {
  outcomes: AuditOutcome[];
  pagination: { total_rows: number; has_more: boolean; next_cursor: string | null };
}

export default function AuditPage(): React.ReactElement {
  const navigate = useNavigate();
  const { apiKey, isValid, handleAuthFailure } = useAgentApiKey();

  const [outcomes, setOutcomes] = useState<AuditOutcome[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const fetchAudit = useCallback(async (reset: boolean, cursor: string | null = null): Promise<void> => {
    if (!isValid || !apiKey || !API_BASE) return;

    setLoading(true);
    if (reset) setError(null);

    try {
      const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
      const params = new URLSearchParams();
      if (appliedFrom) params.set('from', appliedFrom);
      if (appliedTo) params.set('to', appliedTo);
      if (cursor) params.set('cursor', cursor);

      const res = await agentFetch(`${API_BASE}/v1/audit?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }

      const data = await res.json() as AuditResponse;
      setOutcomes((prev) => reset ? data.outcomes : [...prev, ...data.outcomes]);
      setHasMore(data.pagination.has_more);
      setNextCursor(data.pagination.next_cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit trail');
    } finally {
      setLoading(false);
    }
  }, [isValid, apiKey, handleAuthFailure, appliedFrom, appliedTo]);

  useEffect(() => {
    if (isValid) {
      void fetchAudit(true);
    }
  }, [fetchAudit, isValid]);

  const applyFilter = (): void => {
    setAppliedFrom(from);
    setAppliedTo(to);
  };

  const exportCSV = async (): Promise<void> => {
    if (!isValid || !apiKey || !API_BASE) return;
    try {
      const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
      const params = new URLSearchParams({ format: 'csv' });
      if (appliedFrom) params.set('from', appliedFrom);
      if (appliedTo) params.set('to', appliedTo);
      const res = await agentFetch(`${API_BASE}/v1/audit?${params.toString()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `layerinfinite-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('CSV export failed. Try again.');
    }
  };

  return (
    <div className="text-white">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold">Audit Trail</h2>
          <p className="text-sm text-[#a1a1aa] mt-1">Every outcome logged by your agents, in order.</p>
        </div>
        {isValid && (
          <button
            onClick={() => void exportCSV()}
            className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg text-sm"
          >
            Export CSV
          </button>
        )}
      </div>

      {/* Date filter */}
      {isValid && (
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <label className="text-xs text-[#a1a1aa] flex items-center gap-2">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-2 py-1 text-sm text-white"
            />
          </label>
          <label className="text-xs text-[#a1a1aa] flex items-center gap-2">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-2 py-1 text-sm text-white"
            />
          </label>
          <button
            onClick={applyFilter}
            className="border border-[#1a1a24] text-white px-3 py-1.5 rounded-lg text-sm hover:bg-[#1a1a24]"
          >
            Apply
          </button>
        </div>
      )}

      {/* No API key banner */}
      {!isValid && (
        <div className="bg-[#ffaa00]/10 border border-[#ffaa00]/30 text-[#ffaa00] rounded-xl px-4 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <span className="text-sm">
            To view your audit trail, go to Settings → API Keys and create an API key first.
            The API key authenticates your audit data.
          </span>
          <button
            onClick={() => navigate('/dashboard/settings/api-keys')}
            className="shrink-0 bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg text-sm"
          >
            Go to API Keys
          </button>
        </div>
      )}

      {/* Error banner */}
      {isValid && error && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => void fetchAudit(true)}
            className="border border-[#1a1a24] rounded-lg px-3 py-1.5 text-xs text-white"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table / states */}
      {isValid && (
        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
          {loading && outcomes.length === 0 ? (
            <div className="p-5 space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
              ))}
            </div>
          ) : !loading && outcomes.length === 0 && !error ? (
            <div className="p-12 text-center">
              <div className="text-4xl mb-3 opacity-30">📋</div>
              <p className="text-white text-base font-medium">No outcomes logged yet</p>
              <p className="text-[#a1a1aa] text-sm mt-1 max-w-sm mx-auto">
                Every decision your agent makes is recorded here. Start logging outcomes to build your audit trail.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#1a1a24] text-[#a1a1aa]">
                    <th className="text-left px-4 py-3 font-medium">TIMESTAMP</th>
                    <th className="text-left px-4 py-3 font-medium">AGENT</th>
                    <th className="text-left px-4 py-3 font-medium">ACTION</th>
                    <th className="text-left px-4 py-3 font-medium">CONTEXT</th>
                    <th className="text-left px-4 py-3 font-medium">SUCCESS</th>
                    <th className="text-left px-4 py-3 font-medium">RESPONSE TIME</th>
                    <th className="text-left px-4 py-3 font-medium">ERROR</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.map((o) => (
                    <tr key={o.outcome_id} className="border-b border-[#1a1a24]/70 hover:bg-[#1a1a24] transition-colors">
                      <td className="px-4 py-3 text-[#a1a1aa] whitespace-nowrap font-mono text-xs">
                        {format(new Date(o.timestamp), 'MMM dd HH:mm:ss')}
                      </td>
                      <td className="px-4 py-3 text-white">{o.agent.name}</td>
                      <td className="px-4 py-3 text-[#a1a1aa]">{o.action.name}</td>
                      <td className="px-4 py-3 text-[#a1a1aa]">{o.context.issue_type}</td>
                      <td className="px-4 py-3">
                        {o.success ? (
                          <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30">
                            ✓
                          </span>
                        ) : (
                          <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-[#ff4444]/10 text-[#ff8a8a] border border-[#ff4444]/30">
                            ✕
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#a1a1aa]">
                        {o.response_time_ms != null ? `${o.response_time_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-3 text-[#52525b] font-mono text-xs">
                        {o.error_code ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Load More */}
          {hasMore && (
            <div className="px-4 py-3 border-t border-[#1a1a24]">
              <button
                onClick={() => void fetchAudit(false, nextCursor)}
                disabled={loading}
                className="text-sm text-[#a1a1aa] hover:text-white disabled:opacity-50"
              >
                {loading ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
