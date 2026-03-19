import React, { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../supabaseClient';

interface AgentRow {
  agent_id: string;
  agent_name: string;
  agent_type: string | null;
  is_active: boolean;
  created_at: string;
  llm_model: string | null;
  trust_score: number | null;
}

export default function AgentsSettings(): React.ReactElement {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await (supabase as any)
        .from('dim_agents')
        .select(
          'agent_id, agent_name, agent_type, is_active, ' +
          'created_at, llm_model, trust_score'
        )
        .order('created_at', { ascending: false });
      // RLS scopes this to current user's customer_id

      if (error) throw error;
      setAgents((data ?? []) as AgentRow[]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchAgents();
  }, []);

  return (
    <div className="text-white">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Agents</h2>
        <p className="text-sm text-[#a1a1aa] mt-1">
          Your connected AI agents. Agents are created automatically when you generate an API key in API Keys settings.
        </p>
      </div>

      {error && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="text-xs text-white border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={() => void fetchAgents()}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="text-5xl mb-4 opacity-20">🤖</div>
          <h3 className="text-white font-semibold text-lg mb-2">
            No agents yet
          </h3>
          <p className="text-[#52525b] text-sm max-w-sm mb-6">
            Agents are created automatically when you generate
            an API key. Each API key = one agent identity.
          </p>
          <a href="/dashboard/settings/api-keys"
            className="bg-[#b8ff00] text-black font-semibold
              px-5 py-2 rounded-lg text-sm hover:bg-[#a0e600]
              transition-colors">
            Create API Key →
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {agents.map((agent) => (
            <article key={agent.agent_id} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 flex items-center gap-4">
              <Bot size={32} className={agent.is_active ? 'text-[#b8ff00] shrink-0' : 'text-[#52525b] shrink-0'} />

              <div className="flex-1 min-w-0">
                <p className="text-lg font-bold text-white font-mono truncate">{agent.agent_name}</p>
                <p className="text-sm text-[#a1a1aa]">{agent.agent_type ?? 'general'}</p>
                <p className="text-xs text-[#52525b] mt-1">Created {format(new Date(agent.created_at), 'MMM dd, yyyy')}</p>
                <p className="text-xs text-[#52525b] mt-1">
                  Model: {agent.llm_model ?? '—'} | Trust: {agent.trust_score == null ? '—' : agent.trust_score.toFixed(2)}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <span className={agent.is_active
                  ? 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30'
                  : 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'}
                >
                  {agent.is_active ? 'ACTIVE' : 'INACTIVE'}
                </span>

                <button
                  onClick={() => navigate('/dashboard/agent')}
                  className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white rounded-lg px-3 py-1.5 text-sm"
                >
                  View Trust
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
