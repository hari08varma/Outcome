import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { ACCOUNT_SETUP_INCOMPLETE_MESSAGE, useCustomerContext } from './useCustomerContext';

export interface TrustHistoryItem {
  id: string;
  eventType: 'success' | 'failure';
  trustScoreAfter: number;
  actionName: string;
  notes: string;
  createdAt: string;
}

export interface AgentTrustData {
  hasAgent: boolean;
  agentId: string;
  agentName: string;
  agentType: string;
  createdAt: string;
  trustScore: number;
  status: 'trusted' | 'probation' | 'suspended';
  consecutiveFailures: number;
  totalOutcomes: number;
  trustHistory: TrustHistoryItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface AgentRow {
  agent_id: string;
  agent_name: string | null;
  agent_type: string | null;
  created_at: string | null;
}

interface TrustRow {
  trust_score: number | null;
  status?: string | null;
  trust_status?: string | null;
  consecutive_failures: number | null;
  total_outcomes?: number | null;
  total_decisions?: number | null;
}

interface TrustAuditRow {
  id?: string;
  audit_id?: string;
  event_type: string | null;
  trust_score_after?: number | null;
  new_score?: number | null;
  action_name: string | null;
  notes?: string | null;
  reason?: string | null;
  created_at?: string | null;
  performed_at?: string | null;
}

function normalizeStatus(value: string | null | undefined): 'trusted' | 'probation' | 'suspended' {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'suspended' || normalized === 'probation' || normalized === 'trusted') {
    return normalized;
  }
  if (normalized === 'sandbox') {
    return 'probation';
  }
  return 'trusted';
}

function normalizeEventType(value: string | null | undefined): 'success' | 'failure' {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('fail') || normalized.includes('suspend')) {
    return 'failure';
  }
  return 'success';
}

export function useAgentTrust(): AgentTrustData {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [hasAgent, setHasAgent] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentType, setAgentType] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [trustScore, setTrustScore] = useState(0);
  const [status, setStatus] = useState<'trusted' | 'probation' | 'suspended'>('trusted');
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [totalOutcomes, setTotalOutcomes] = useState(0);
  const [trustHistory, setTrustHistory] = useState<TrustHistoryItem[]>([]);
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
    setLoading(true);
    setError(null);

    try {
      const customerId = await ensureCustomerId();

      if (!ctx) {
        setLoading(false);
        return;
      }

      const { data: agentRows, error: agentError } = await supabase
        .from('dim_agents')
        .select('agent_id, agent_name, agent_type, created_at')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (agentError) {
        throw new Error(agentError.message);
      }

      if (!agentRows || agentRows.length === 0) {
        setHasAgent(false);
        setAgentId('');
        setAgentName('');
        setAgentType('');
        setCreatedAt('');
        setTrustScore(0);
        setStatus('trusted');
        setConsecutiveFailures(0);
        setTotalOutcomes(0);
        setTrustHistory([]);
        return;
      }

      const agent = agentRows[0] as AgentRow;
      setHasAgent(true);

      const { data: trustRows, error: trustError } = await supabase
        .from('agent_trust_scores')
        .select('*')
        .eq('agent_id', agent.agent_id)
        .limit(1);

      if (trustError) {
        throw new Error(trustError.message);
      }

      const trustRow = (trustRows?.[0] ?? {}) as TrustRow;

      const { data: historyRows, error: historyError } = await supabase
        .from('agent_trust_audit')
        .select('*')
        .eq('agent_id', agent.agent_id)
        .order('performed_at', { ascending: false })
        .limit(10);

      if (historyError) {
        throw new Error(historyError.message);
      }

      const mappedHistory: TrustHistoryItem[] = ((historyRows ?? []) as TrustAuditRow[]).map((row, idx) => ({
        id: String(row.id ?? row.audit_id ?? idx),
        eventType: normalizeEventType(row.event_type),
        trustScoreAfter: Number(row.trust_score_after ?? row.new_score ?? 0),
        actionName: row.action_name ?? '',
        notes: row.notes ?? row.reason ?? '',
        createdAt: row.performed_at ?? row.created_at ?? new Date().toISOString(),
      }));

      setAgentId(agent.agent_id);
      setAgentName(agent.agent_name ?? '');
      setAgentType(agent.agent_type ?? '');
      setCreatedAt(agent.created_at ?? '');
      setTrustScore(Number(trustRow.trust_score ?? 0));
      setStatus(normalizeStatus(trustRow.status ?? trustRow.trust_status));
      setConsecutiveFailures(Number(trustRow.consecutive_failures ?? 0));
      setTotalOutcomes(Number(trustRow.total_outcomes ?? trustRow.total_decisions ?? 0));
      setTrustHistory(mappedHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent trust');
    } finally {
      setLoading(false);
    }
  }, [ctx, ensureCustomerId]);

  useEffect(() => {
    if (!ctx) {
      if (!ctxLoading) {
        setLoading(false);
      }
      return;
    }
    void load();
  }, [ctx, ctxLoading, tick, load]);

  useEffect(() => {
    if (!ctx?.agentId) {
      return;
    }

    const channel = supabase
      .channel(`agent-trust-${ctx.agentId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'agent_trust_scores',
        filter: `agent_id=eq.${ctx.agentId}`,
      }, () => {
        setTick((v) => v + 1);
      })
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [ctx?.agentId]);

  const refetch = useCallback(() => {
    setTick((v) => v + 1);
  }, []);

  return useMemo(() => ({
    hasAgent,
    agentId,
    agentName,
    agentType,
    createdAt,
    trustScore,
    status,
    consecutiveFailures,
    totalOutcomes,
    trustHistory,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
  }), [
    hasAgent,
    agentId,
    agentName,
    agentType,
    createdAt,
    trustScore,
    status,
    consecutiveFailures,
    totalOutcomes,
    trustHistory,
    loading,
    ctxLoading,
    ctxError,
    error,
    refetch,
  ]);
}
