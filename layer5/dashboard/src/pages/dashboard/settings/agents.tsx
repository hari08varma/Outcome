import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useToastContext } from '../../../components/Toast';
import { useAgentsSettings } from '../../../hooks/useAgentsSettings';

type AgentTypeOption = 'customer_support' | 'sales' | 'operations' | 'data_analysis' | 'general' | 'custom';

const TYPE_OPTIONS: AgentTypeOption[] = ['customer_support', 'sales', 'operations', 'data_analysis', 'general', 'custom'];

export default function AgentsSettings(): React.ReactElement {
  const navigate = useNavigate();
  const { showToast } = useToastContext();
  const { agents, loading, error, refetch, createAgent, toggleAgent } = useAgentsSettings();

  const [showForm, setShowForm] = useState(false);
  const [agentName, setAgentName] = useState('');
  const [agentType, setAgentType] = useState<AgentTypeOption>('general');
  const [customType, setCustomType] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDisableId, setConfirmingDisableId] = useState<string | null>(null);

  const hasAgents = useMemo(() => agents.length > 0, [agents.length]);

  const resolvedAgentType = agentType === 'custom' ? customType.trim() : agentType;

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!agentName.trim() || !resolvedAgentType) {
      return;
    }

    setSaving(true);
    try {
      await createAgent(agentName.trim(), resolvedAgentType);
      showToast('Agent registered successfully', 'success', 3500);
      setAgentName('');
      setAgentType('general');
      setCustomType('');
      setShowForm(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to register agent', 'critical', 4500);
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (agentId: string, isActive: boolean): Promise<void> => {
    if (isActive && confirmingDisableId !== agentId) {
      setConfirmingDisableId(agentId);
      return;
    }

    try {
      await toggleAgent(agentId, isActive);
      showToast(isActive ? 'Agent disabled successfully' : 'Agent enabled successfully', 'success', 3000);
      setConfirmingDisableId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update agent', 'critical', 4500);
    }
  };

  return (
    <div className="text-white">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold">Agents</h2>
          <p className="text-sm text-[#a1a1aa] mt-1">Manage your registered AI agents</p>
        </div>
        <button
          onClick={() => setShowForm((value) => !value)}
          className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
        >
          Register New Agent
        </button>
      </div>

      <section className={`bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6 transition-all duration-300 ${showForm ? 'block' : 'hidden'}`}>
        <form className="grid grid-cols-1 md:grid-cols-2 gap-4" onSubmit={onSubmit}>
          <div className="md:col-span-2">
            <label className="text-xs text-[#a1a1aa] block mb-1">Agent Name</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. support-agent-v2"
              value={agentName}
              required
              onChange={(event) => setAgentName(event.target.value)}
            />
          </div>

          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Agent Type</label>
            <select
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              value={agentType}
              onChange={(event) => setAgentType(event.target.value as AgentTypeOption)}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>

          {agentType === 'custom' && (
            <div>
              <label className="text-xs text-[#a1a1aa] block mb-1">Custom Type Name</label>
              <input
                className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
                value={customType}
                required
                onChange={(event) => setCustomType(event.target.value)}
              />
            </div>
          )}

          <div className="md:col-span-2 flex items-center gap-3 mt-1">
            <button
              type="submit"
              disabled={saving}
              className="bg-[#00cc66] hover:bg-[#00b55a] text-black font-semibold px-4 py-2 rounded-lg disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Submit'}
            </button>
            <button
              type="button"
              className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white rounded-lg px-4 py-2"
              onClick={() => setShowForm(false)}
            >
              Cancel
            </button>
          </div>
        </form>
        <p className="text-xs text-[#52525b] mt-4">After registering, go to API Keys to generate a key for this agent.</p>
      </section>

      {error && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="text-xs text-white border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={refetch}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
          <div className="h-24 rounded-xl bg-[#111118] border border-[#1a1a24] animate-pulse" />
        </div>
      ) : !hasAgents ? (
        <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-10 text-center">
          <Bot size={48} className="mx-auto text-[#52525b]" />
          <p className="text-white text-lg font-medium mt-4">No agents registered yet</p>
          <p className="text-[#a1a1aa] text-sm mt-1">Register your first agent to start logging outcomes</p>
          <button
            className="mt-5 bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
            onClick={() => setShowForm(true)}
          >
            Register Your First Agent
          </button>
        </section>
      ) : (
        <div className="space-y-4">
          {agents.map((agent) => (
            <article key={agent.agentId} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 flex items-center gap-4">
              <Bot size={32} className={agent.isActive ? 'text-[#b8ff00] shrink-0' : 'text-[#52525b] shrink-0'} />

              <div className="flex-1 min-w-0">
                <p className="text-lg font-bold text-white font-mono truncate">{agent.agentName}</p>
                <p className="text-sm text-[#a1a1aa]">{agent.agentType}</p>
                <p className="text-xs text-[#52525b] mt-1">Created {format(new Date(agent.createdAt), 'MMM dd, yyyy')}</p>
              </div>

              <div className="flex items-center gap-3">
                <span className={agent.isActive
                  ? 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30'
                  : 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'}
                >
                  {agent.isActive ? 'ACTIVE' : 'INACTIVE'}
                </span>

                <button
                  onClick={() => navigate('/dashboard/agent')}
                  className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white rounded-lg px-3 py-1.5 text-sm"
                >
                  View Trust
                </button>

                {agent.isActive && confirmingDisableId === agent.agentId ? (
                  <div className="flex items-center gap-2">
                    <button
                      className="text-xs text-[#52525b]"
                      onClick={() => setConfirmingDisableId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="text-xs border border-[#ffaa00] text-[#ffaa00] rounded-lg px-3 py-1.5"
                      onClick={() => void onToggle(agent.agentId, agent.isActive)}
                    >
                      Disable agent?
                    </button>
                  </div>
                ) : (
                  <button
                    className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${agent.isActive ? 'bg-[#00cc66]' : 'bg-[#1a1a24]'}`}
                    onClick={() => void onToggle(agent.agentId, agent.isActive)}
                  >
                    <span className={`inline-block h-5 w-5 rounded-full bg-white mt-0.5 transition-transform ${agent.isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
