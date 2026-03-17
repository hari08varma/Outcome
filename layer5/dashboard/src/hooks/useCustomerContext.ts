import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface CustomerContextData {
  userId: string;
  email: string;
  customerId: string;
  agentId: string;
  agentName: string;
}

interface CustomerContextState {
  data: CustomerContextData | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

let contextCache: CustomerContextData | null = null;
let contextPromise: Promise<CustomerContextData> | null = null;

async function fetchCustomerContext(): Promise<CustomerContextData> {
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
    .maybeSingle();

  if (profileError || !profile?.customer_id) {
    throw new Error(profileError?.message ?? 'Unable to resolve customer profile');
  }

  const { data: agent, error: agentError } = await supabase
    .from('dim_agents')
    .select('agent_id, agent_name')
    .eq('customer_id', profile.customer_id)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (agentError || !agent?.agent_id) {
    throw new Error(agentError?.message ?? 'Unable to resolve customer agent');
  }

  return {
    userId: user.id,
    email: user.email ?? '',
    customerId: profile.customer_id,
    agentId: agent.agent_id,
    agentName: agent.agent_name ?? 'default-agent',
  };
}

async function resolveCustomerContext(forceRefresh = false): Promise<CustomerContextData> {
  if (forceRefresh) {
    contextCache = null;
    contextPromise = null;
  }

  if (contextCache) {
    return contextCache;
  }

  if (!contextPromise) {
    contextPromise = fetchCustomerContext().then((data) => {
      contextCache = data;
      return data;
    }).finally(() => {
      contextPromise = null;
    });
  }

  return contextPromise;
}

export function useCustomerContext(): CustomerContextState {
  const [data, setData] = useState<CustomerContextData | null>(contextCache);
  const [loading, setLoading] = useState<boolean>(!contextCache);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const resolved = await resolveCustomerContext(forceRefresh);
      setData(resolved);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load customer context';
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (contextCache) {
      setLoading(false);
      setData(contextCache);
      return;
    }
    void load();
  }, [load]);

  const refetch = useCallback(async () => {
    await load(true);
  }, [load]);

  return { data, loading, error, refetch };
}
