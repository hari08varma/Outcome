import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useCustomerContext } from './useCustomerContext';

const ACCOUNT_SETUP_INCOMPLETE_MESSAGE = 'Account setup incomplete. Please sign out and sign in again to complete setup.';

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
}

interface UseAgentsSettingsResult {
  agents: AgentSettingsItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  createAgent: (name: string, type: string) => Promise<void>;
  toggleAgent: (agentId: string, isActive: boolean) => Promise<void>;
}

export function useAgentsSettings(): UseAgentsSettingsResult {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [agents, setAgents] = useState<AgentSettingsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const ensureCustomerId = useCallback(async (): Promise<string> => {
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      throw new Error(userError?.message ?? 'Unable to resolve authenticated user');
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('customer_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.customer_id) {
      throw new Error(ACCOUNT_SETUP_INCOMPLETE_MESSAGE);
    }

    return profile.customer_id as string;
  }, []);

  const load = useCallback(async () => {
    if (!ctx) {
      if (!ctxLoading) {
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const customerId = await ensureCustomerId();

      const { data, error: loadError } = await supabase
        .from('dim_agents')
        .select('agent_id, agent_name, agent_type, is_active, created_at')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false });

      if (loadError) {
        throw new Error(loadError.message);
      }

      const mapped = ((data ?? []) as AgentRow[]).map((row) => ({
        agentId: row.agent_id,
        agentName: row.agent_name ?? 'default-agent',
        agentType: row.agent_type ?? 'general',
        isActive: Boolean(row.is_active),
        createdAt: row.created_at ?? new Date().toISOString(),
      }));

      setAgents(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [ctx, ctxLoading, ensureCustomerId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const createAgent = useCallback(async (name: string, type: string) => {
    const customerId = await ensureCustomerId();

    const { error: createError } = await supabase
      .from('dim_agents')
      .insert({
        agent_name: name,
        agent_type: type,
        customer_id: customerId,
        is_active: true,
        api_key_hash: '',
      });

    if (createError) {
      throw new Error(createError.message);
    }

    setTick((value) => value + 1);
  }, [ensureCustomerId]);

  const toggleAgent = useCallback(async (agentId: string, isActive: boolean) => {
    const customerId = await ensureCustomerId();

    const { error: toggleError } = await supabase
      .from('dim_agents')
      .update({ is_active: !isActive })
      .eq('agent_id', agentId)
      .eq('customer_id', customerId);

    if (toggleError) {
      throw new Error(toggleError.message);
    }

    setTick((value) => value + 1);
  }, [ensureCustomerId]);

  const refetch = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return useMemo(() => ({
    agents,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
    createAgent,
    toggleAgent,
  }), [agents, loading, ctxLoading, ctxError, error, refetch, createAgent, toggleAgent]);
}
