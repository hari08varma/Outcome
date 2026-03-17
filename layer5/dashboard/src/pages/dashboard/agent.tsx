import React, { useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useAgentTrust } from '../../hooks/useAgentTrust';
import { supabase } from '../../supabaseClient';
import { API_BASE } from '../../lib/config';

function statusBadge(status: 'trusted' | 'probation' | 'suspended'): string {
  if (status === 'trusted') {
    return 'bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30';
  }
  if (status === 'probation') {
    return 'bg-[#ffaa00]/10 text-[#ffaa00] border border-[#ffaa00]/30';
  }
  return 'bg-[#ff4444]/10 text-[#ff4444] border border-[#ff4444]/30';
}

function trustColor(status: 'trusted' | 'probation' | 'suspended'): string {
  if (status === 'trusted') {
    return '#00cc66';
  }
  if (status === 'probation') {
    return '#ffaa00';
  }
  return '#ff4444';
}

export default function Agent(): React.ReactElement {
  const navigate = useNavigate();
  const agent = useAgentTrust();
  const [reinstating, setReinstating] = useState(false);

  const createdText = useMemo(() => {
    if (!agent.createdAt) {
      return '';
    }
    return format(parseISO(agent.createdAt), 'MMM dd, yyyy');
  }, [agent.createdAt]);

  const exportCsv = async (): Promise<void> => {
    if (!API_BASE) {
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return;
    }

    const response = await fetch(`${API_BASE}/v1/audit?format=csv`, {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });

    if (!response.ok) {
      return;
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `layerinfinite-audit-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const reinstateAgent = async (): Promise<void> => {
    if (!API_BASE || !agent.agentId) {
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      return;
    }

    setReinstating(true);
    try {
      const response = await fetch(`${API_BASE}/v1/admin/reinstate-agent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ agent_id: agent.agentId }),
      });

      if (response.ok) {
        agent.refetch();
      }
    } finally {
      setReinstating(false);
    }
  };

  if (agent.loading) {
    return <div className="h-[320px] rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />;
  }

  if (agent.error) {
    return (
      <div className="bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl p-4 text-sm">
        {agent.error}
      </div>
    );
  }

  const barColor = trustColor(agent.status);

  return (
    <div className="text-white">
      {(agent.status === 'probation' || agent.status === 'suspended') && (
        <div className={`mb-6 rounded-xl px-4 py-3 text-sm font-medium ${agent.status === 'probation' ? 'bg-[#ffaa00]/10 border border-[#ffaa00]/30 text-[#ffaa00]' : 'bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff4444]'}`}>
          {agent.status === 'probation'
            ? 'Agent on probation - conservative policy active'
            : 'Agent suspended - human review required'}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.5fr] gap-6">
        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-6">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-white">{agent.agentName}</h1>
              <p className="text-[#52525b] text-xs mt-1">Created {createdText}</p>
            </div>
            <span className={`uppercase tracking-wider text-xs font-bold px-3 py-1 rounded-full ${statusBadge(agent.status)}`}>
              {agent.status}
            </span>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#a1a1aa] text-xs font-semibold tracking-wide">TRUST SCORE</span>
              <span className="text-white font-mono text-lg font-bold">{agent.trustScore.toFixed(2)} / 1.0</span>
            </div>
            <div className="h-2 bg-[#1a1a24] rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(agent.trustScore * 100, 100))}%`, backgroundColor: barColor }} />
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
              <button
                className="w-full bg-[#00cc66] hover:bg-[#00b55a] text-black font-semibold py-2.5 rounded-lg disabled:opacity-60"
                onClick={reinstateAgent}
                disabled={reinstating}
              >
                {reinstating ? 'Reinstating...' : 'Reinstate Agent'}
              </button>
            )}
            <button className="w-full bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold py-2.5 rounded-lg" onClick={() => navigate('/dashboard/settings/api-keys')}>
              View API Keys
            </button>
            <button className="w-full border border-[#1a1a24] text-[#a1a1aa] hover:text-white hover:border-[#2a2a34] font-semibold py-2.5 rounded-lg" onClick={exportCsv}>
              Export Data Logs
            </button>
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
            <div className="space-y-4">
              {agent.trustHistory.map((event) => (
                <div key={event.id} className="relative flex items-start gap-4 pb-4 border-b border-[#1a1a24] last:border-b-0">
                  <div className={`z-10 w-8 h-8 rounded-full border flex items-center justify-center ${event.eventType === 'success' ? 'bg-[#00cc66]/10 border-[#00cc66]/40 text-[#00cc66]' : 'bg-[#ff4444]/10 border-[#ff4444]/40 text-[#ff4444]'}`}>
                    {event.eventType === 'success' ? '✓' : '✕'}
                  </div>
                  <div className="flex-1">
                    <div className="text-white text-sm font-mono">{event.actionName}</div>
                    <div className="text-[#a1a1aa] text-xs mt-1">{event.notes || 'No notes available.'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-white font-mono text-sm">{event.trustScoreAfter.toFixed(2)}</div>
                    <div className="text-[#52525b] text-xs mt-1">{formatDistanceToNowStrict(parseISO(event.createdAt), { addSuffix: true })}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button className="mt-6 text-[#b8ff00] text-sm hover:underline" onClick={() => navigate('/dashboard/settings/audit')}>
            View Full Audit {'->'}
          </button>
        </section>
      </div>
    </div>
  );
}
