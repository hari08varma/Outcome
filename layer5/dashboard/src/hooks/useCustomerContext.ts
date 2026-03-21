import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { API_BASE } from '../lib/config';

export const ACCOUNT_SETUP_INCOMPLETE_MESSAGE = 'Account setup incomplete. Please sign out and sign in again to complete setup.';

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
let contextGeneration = 0;

async function tryBootstrapProfile(): Promise<void> {
  if (!API_BASE) {
    throw new Error(
      'API not configured. Set VITE_LAYERINFINITE_API_URL in your ' +
      'deployment environment and redeploy the dashboard.'
    );
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    return;
  }

  try {
    await fetch(`${API_BASE}/v1/auth/api-keys`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
      },
    });
  } catch {
    // Best effort bootstrap call; context lookup below determines final state.
  }
}

async function fetchCustomerContext(): Promise<CustomerContextData> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error(userError?.message ?? 'Unable to resolve authenticated user');
  }

  let { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('customer_id')
    .eq('id', user.id)
    .single();

  if (!profile?.customer_id) {
    await tryBootstrapProfile();

    const retry = await supabase
      .from('user_profiles')
      .select('customer_id')
      .eq('id', user.id)
      .single();

    profile = retry.data;
    profileError = retry.error;
  }

  if (profileError || !profile?.customer_id) {
    throw new Error(ACCOUNT_SETUP_INCOMPLETE_MESSAGE);
  }

  const { data: agent, error: agentError } = await supabase
    .from('dim_agents')
    .select('agent_id, agent_name')
    .eq('customer_id', profile.customer_id)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  let resolvedAgent = agent;

  if (!resolvedAgent?.agent_id) {
    const { data: fallbackAgent, error: fallbackError } = await supabase
      .from('dim_agents')
      .select('agent_id, agent_name')
      .eq('customer_id', profile.customer_id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!fallbackError && fallbackAgent?.agent_id) {
      resolvedAgent = fallbackAgent;
    }
  }

  return {
    userId: user.id,
    email: user.email ?? '',
    customerId: profile.customer_id,
    agentId: resolvedAgent?.agent_id ?? '',
    agentName: resolvedAgent?.agent_name ?? '',
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
    const capturedGen = contextGeneration;
    contextPromise = fetchCustomerContext().then((data) => {
      if (contextGeneration === capturedGen) {
        contextCache = data;
      }
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

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        contextGeneration++;
        contextCache = null;
        contextPromise = null;
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const refetch = useCallback(async () => {
    await load(true);
  }, [load]);

  return { data, loading, error, refetch };
}
