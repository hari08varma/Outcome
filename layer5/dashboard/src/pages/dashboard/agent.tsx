import React, { useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAgentTrust } from '../../hooks/useAgentTrust';
import { supabase } from '../../supabaseClient';
import { API_BASE } from '../../lib/config';
import { createAgentFetch } from '../../lib/api';
import { AGENT_API_KEY_STORAGE_KEY } from '../../hooks/useAgentApiKey';
import { useToastContext } from '../../components/Toast';

function statusBadge(status: 'trusted' | 'probation' | 'suspended' | 'new'): string {
  if (status === 'new') return 'bg-[#52525b]/10 text-[#52525b] border border-[#52525b]/30';
  if (status === 'trusted') return 'bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30';
  if (status === 'probation') return 'bg-[#ffaa00]/10 text-[#ffaa00] border border-[#ffaa00]/30';
  return 'bg-[#ff4444]/10 text-[#ff4444] border border-[#ff4444]/30';
}

function trustColor(status: 'trusted' | 'probation' | 'suspended' | 'new'): string {
  if (status === 'new') return '#52525b';
  if (status === 'trusted') return '#00cc66';
  if (status === 'probation') return '#ffaa00';
  return '#ff4444';
}

// ── FIX: Parse action name from the reason field ──────────────
// agent_trust_audit has no action_name column.
// The action is embedded in the reason string in two formats:
//   "Outcome success via SDK: send_refund_email"    → "send_refund_email"
//   "Outcome failure recorded: qa_test_no_episode"  → "qa_test_no_episode"
// Returns null for status-change rows (no action embedded).
function parseActionFromReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const sdkMatch = reason.match(/via\s+SDK:\s*(.+)$/i);
  if (sdkMatch) return sdkMatch[1].trim();
  const recordedMatch = reason.match(/recorded:\s*(.+)$/i);
  if (recordedMatch) return recordedMatch[1].trim();
  return null;
}

// ── FIX: Human-readable label for status-change audit rows ────
// Trust-updater writes these reason strings on status changes:
//   "Trust probation → trusted"
//   "Auto-suspended: score=0.210, failures=5"
//   "Batch recalculation: processed 12 outcomes"
// These are policy events, not action rows — show a clear label.
function parseStatusLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const arrowMatch = reason.match(/(\w+)\s*→\s*(\w+)/);
  if (arrowMatch) return `Trust recalibrated: ${arrowMatch[1]} → ${arrowMatch[2]}`;
  if (/auto-suspended/i.test(reason)) return 'Auto-suspended by policy';
  if (/batch recalculation/i.test(reason)) return 'Batch recalibration';
  if (/reinstat/i.test(reason)) return 'Agent reinstated';
  return null;
}

export default function Agent(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedAgentId = searchParams.get('id') ?? undefined;
  const agent = useAgentTrust(selectedAgentId);
  const { showToast } = useToastContext();
  const [reinstating, setReinstating] = useState(false);

  const createdText = useMemo(() => {
    if (!agent.createdAt) return '';
    return format(parseISO(agent.createdAt), 'MMM dd, yyyy');
  }, [agent.createdAt]);

  const exportCsv = async (): Promise<void> => {
    if (!API_BASE) return;
    const storedKey = localStorage.getItem(AGENT_API_KEY_STORAGE_KEY);
    if (!storedKey) {
      showToast('API key not found. Go to Settings → API Keys to create one.', 'warning', 4500);
      return;
    }
    const agentFetch = createAgentFetch(storedKey, () => {
      localStorage.removeItem(AGENT_API_KEY_STORAGE_KEY);
      window.location.href = '/onboarding?step=2&reason=expired';
    });
    try {
      const response = await agentFetch(`${API_BASE}/v1/audit?format=csv`);
      if (!response.ok) { showToast('Failed to export CSV logs.', 'critical', 4500); return; }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `layerinfinite-audit-${format(new Date(), 'yyyy-MM-dd')}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      showToast('Audit CSV exported.', 'success', 2500);
    } catch { showToast('Network error during export.', 'critical', 4500); }
  };

  const reinstateAgent = async (): Promise<void> => {
    if (!API_BASE || !agent.agentId) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { showToast('Session expired — please sign in again.', 'warning', 4500); navigate('/auth?mode=login'); return; }
    setReinstating(true);
    try {
      const reinstatedBy = session.user.email ?? 'dashboard_admin';
      const response = await fetch(`${API_BASE}/v1/admin/reinstate-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ agent_id: agent.agentId, reinstated_by: reinstatedBy }),
      });
      if (response.ok) { showToast('Agent reinstated. Status set to probation.', 'success', 4500); agent.refetch(); }
      else { const body = await response.json().catch(() => ({} as Record<string, string>)); showToast(body.error ?? 'Failed to reinstate agent.', 'critical', 4500); }
    } catch { showToast('Network error — could not reinstate agent.', 'critical', 4500); }
    finally { setReinstating(false); }
  };

  if (agent.loading) return <div className="h-[320px] rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />;

  if (agent.error) return (
    <div className="bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl p-4 text-sm flex items-center justify-between gap-3">
      <span>{agent.error}</span>
      <button className="text-white text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={agent.refetch}>Retry</button>
    </div>
  );

  if (!agent.hasAgent) return (
    <section className="flex flex-col items-center justify-center py-24 text-center text-white">
      <div className="text-5xl mb-4 opacity-20">🤖</div>
      <h3 className="text-white font-semibold text-lg mb-2">No agents connected</h3>
      <p className="text-[#52525b] text-sm max-w-sm mb-6">Your agents appear here once they start logging outcomes via the SDK.</p>
      <button className="bg-[#b8ff00] text-black font-semibold px-5 py-2 rounded-lg text-sm hover:bg-[#a0e600]" onClick={() => navigate('/dashboard/settings/api-keys')}>Create API Key</button>
    </section>
  );

  const barColor = trustColor(agent.status);

  return (
    <div className="text-white">
      {(agent.status === 'probation' || agent.status === 'suspended') && (
        <div className={`mb-6 rounded-xl px-4 py-3 text-sm font-medium ${agent.status === 'probation' ? 'bg-[#ffaa00]/10 border border-[#ffaa00]/30 text-[#ffaa00]' : 'bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff4444]'}`}>
          {agent.status === 'probation' ? 'Agent on probation - conservative policy active' : 'Agent suspended - human review required'}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.5fr] gap-6">
        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">{agent.agentName}</h1>
              <p className="text-[#52525b] text-xs mt-1">Created {createdText}</p>
            </div>
            <span className={`uppercase tracking-wider text-xs font-bold px-3 py-1 rounded-full ${statusBadge(agent.status)}`}>{agent.status}</span>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#a1a1aa] text-xs font-semibold tracking-wide">TRUST SCORE</span>
              {agent.trustScore !== null ? (
                <span className="text-white font-mono text-lg font-bold">{agent.trustScore.toFixed(2)} / 1.0</span>
              ) : (
                <span className="text-[#52525b] text-sm font-normal">No outcomes logged yet</span>
              )}
            </div>
            <div className="h-2 bg-[#1a1a24] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min((agent.trustScore ?? 0) * 100, 100))}%`, backgroundColor: barColor }} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="bg-[#0a0a0f] border border-[#1a1a24] rounded-xl p-4">
              <p className="text-[11px] tracking-wide text-[#a1a1aa]">RECENT ERRORS</p>
              <p className="text-xl font-bold mt-1" style={{ color: agent.consecutiveFailures > 0 ? '#ff4444' : '#ffffff' }}>{agent.consecutiveFailures}</p>
            </div>
            <div className="bg-[#0a0a0f] border border-[#1a1a24] rounded-xl p-4">
              <p className="text-[11px] tracking-wide text-[#a1a1aa]">OUTCOMES</p>
              <p className="text-xl font-bold mt-1">{agent.totalOutcomes.toLocaleString()}</p>
            </div>
          </div>

          <div className="space-y-3">
            {agent.status === 'suspended' && (
              <button className="w-full bg-[#00cc66] hover:bg-[#00b55a] text-black font-semibold py-2.5 rounded-lg disabled:opacity-60" onClick={reinstateAgent} disabled={reinstating}>
                {reinstating ? 'Reinstating...' : 'Reinstate Agent'}
              </button>
            )}
            <button className="w-full bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold py-2.5 rounded-lg" onClick={() => navigate('/dashboard/settings/api-keys')}>View API Keys</button>
            <button className="w-full border border-[#1a1a24] text-[#a1a1aa] hover:text-white hover:border-[#2a2a34] font-semibold py-2.5 rounded-lg" onClick={exportCsv}>Export Data Logs</button>
          </div>
        </section>

        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold">Trust History <span className="text-[#52525b] text-sm font-normal">(last 10 events)</span></h2>
            <div className="flex items-center gap-2 text-xs text-[#00cc66]">
              <span className="inline-block w-2 h-2 rounded-full bg-[#00cc66]" />
              <span>Live Updates Enabled</span>
            </div>
          </div>

          <div className="relative">
            <div className="absolute left-4 top-0 bottom-0 w-px bg-[#1a1a24]" />
            {agent.trustHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="text-3xl mb-3 opacity-20">📋</div>
                <p className="text-[#52525b] text-sm">
                  Trust history appears here once your agent logs its first outcome.
                </p>
              </div>
            ) : (
            <div className="space-y-4">
              {agent.trustHistory.map((event) => {
                // ── Resolve display label ─────────────────────────────
                // Priority:
                //   1. actionName already resolved by the hook (future-proof)
                //   2. Parse action from "Outcome ... via SDK: X" reason
                //   3. Parse label from status-change reason strings
                //   4. Generic fallback — never shows "Action unavailable"
                const displayName =
                  event.actionName
                  ?? parseActionFromReason(event.reason)
                  ?? parseStatusLabel(event.reason)
                  ?? 'Policy event';

                // Sub-label: show reason only for non-action rows
                const subLabel =
                  event.notes
                  ?? (parseActionFromReason(event.reason)
                    ? `Trust score updated`
                    : (event.reason ?? 'No details available'));

                return (
                  <div key={event.id} className="relative flex items-start gap-4 pb-4 border-b border-[#1a1a24] last:border-b-0">
                    <div className={`z-10 w-8 h-8 rounded-full border flex items-center justify-center flex-shrink-0 ${event.eventType === 'success' ? 'bg-[#00cc66]/10 border-[#00cc66]/40 text-[#00cc66]' : 'bg-[#ff4444]/10 border-[#ff4444]/40 text-[#ff4444]'}`}>
                      {event.eventType === 'success' ? '✓' : '✕'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm font-mono truncate">{displayName}</div>
                      <div className="text-[#a1a1aa] text-xs mt-1 truncate">{subLabel}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-white font-mono text-sm">{event.trustScoreAfter.toFixed(2)}</div>
                      <div className="text-[#52525b] text-xs mt-1">{formatDistanceToNowStrict(parseISO(event.createdAt), { addSuffix: true })}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>

          <button className="mt-6 text-[#b8ff00] text-sm hover:underline" onClick={() => navigate('/dashboard/settings/audit')}>
            View Full Audit {'->'}
          </button>
        </section>
      </div>
    </div>
  );
}