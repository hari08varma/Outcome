import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface AgentSettingsItem {
  agentId: string;
  agentName: string;
  agentType: string;
  isActive: boolean;
  createdAt: string;
}

interface AgentRow {
  agent_id: string;
  agent_name: string | null;
  agent_type: string | null;
  is_active: boolean | null;
  created_at: string | null;
  llm_model: string | null;
}

interface UseAgentsSettingsResult {
  agents: AgentSettingsItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  toggleAgent: (agentId: string, isActive: boolean) => Promise<void>;
}

export function useAgentsSettings(): UseAgentsSettingsResult {
  const [agents, setAgents] = useState<AgentSettingsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { data, error: loadError } = await (supabase as any)
        .from('dim_agents')
        .select('agent_id, agent_name, agent_type, is_active, created_at, llm_model')
        .order('created_at', { ascending: false });

      if (loadError) {
        throw new Error(loadError.message);
      }

      const mapped = ((data ?? []) as AgentRow[]).map((row) => ({
        agentId: row.agent_id,
        agentName: row.agent_name ?? '',
        agentType: row.agent_type ?? '',
        isActive: Boolean(row.is_active),
        createdAt: row.created_at ?? '',
      }));

      setAgents(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const toggleAgent = useCallback(async (agentId: string, isActive: boolean) => {
    const { error: toggleError } = await supabase
      .from('dim_agents')
      .update({ is_active: !isActive })
      .eq('agent_id', agentId);

    if (toggleError) {
      throw new Error(toggleError.message);
    }

    await fetchAgents();
  }, [fetchAgents]);

  const refetch = useCallback(() => {
    void fetchAgents();
  }, [fetchAgents]);

  return useMemo(() => ({
    agents,
    loading,
    error,
    refetch,
    toggleAgent,
  }), [agents, loading, error, refetch, toggleAgent]);
}
