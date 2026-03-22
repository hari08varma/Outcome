import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { ACCOUNT_SETUP_INCOMPLETE_MESSAGE, useCustomerContext } from './useCustomerContext';

export interface OverviewMetrics {
  hasScores: boolean;
  hasData: boolean;
  agentHealthScore: number;
  agentHealthDelta: number;
  decisionsToday: number;
  decisionsDelta: number;
  successRate7d: number;
  successRateDelta: number;
  activeAlerts: number;
  alertSeverity: 'critical' | 'warning' | 'none';
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface ActionScoreRow {
  weighted_success_rate: number | null;
  trend_delta: number | null;
}

interface AlertSeverityRow {
  severity: string | null;
}

function getIsoBounds(hoursAgoStart: number, hoursAgoEnd: number): { from: string; to: string } {
  const end = new Date(Date.now() - hoursAgoEnd * 60 * 60 * 1000);
  const start = new Date(Date.now() - hoursAgoStart * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function useOverviewMetrics(): OverviewMetrics {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [hasScores, setHasScores] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [agentHealthScore, setAgentHealthScore] = useState(0);
  const [agentHealthDelta, setAgentHealthDelta] = useState(0);
  const [decisionsToday, setDecisionsToday] = useState(0);
  const [decisionsDelta, setDecisionsDelta] = useState(0);
  const [successRate7d, setSuccessRate7d] = useState(0);
  const [successRateDelta, setSuccessRateDelta] = useState(0);
  const [activeAlerts, setActiveAlerts] = useState(0);
  const [alertSeverity, setAlertSeverity] = useState<'critical' | 'warning' | 'none'>('none');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

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

  const loadMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    setHasScores(false);
    setHasData(false);

    try {
      const customerId = await ensureCustomerId();

      if (!ctx) {
        setLoading(false);
        return;
      }

      let trustRow: Record<string, unknown> | undefined;
      if (isUuid(ctx.agentId)) {
        const { data: trustRows, error: trustError } = await supabase
          .from('agent_trust_scores')
          .select('*')
          .eq('agent_id', ctx.agentId)
          .limit(1);

        if (trustError) {
          throw new Error(trustError.message);
        }

        trustRow = trustRows?.[0] as Record<string, unknown> | undefined;
      }

      const trustScore = Number((trustRow?.trust_score as number | null) ?? 0);
      const totalDecisions = Number((trustRow?.total_decisions as number | null) ?? 0);
      setHasData(totalDecisions > 0);

      const todayBounds = getIsoBounds(24, 0);
      const previousBounds = getIsoBounds(48, 24);

      const { count: todayCount, error: todayError } = await supabase
        .from('fact_outcomes')
        .select('outcome_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .gte('timestamp', todayBounds.from)
        .lt('timestamp', todayBounds.to);

      if (todayError) {
        throw new Error(todayError.message);
      }

      const { count: previousCount, error: previousError } = await supabase
        .from('fact_outcomes')
        .select('outcome_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .gte('timestamp', previousBounds.from)
        .lt('timestamp', previousBounds.to);

      if (previousError) {
        throw new Error(previousError.message);
      }

      const { data: actionRows, error: actionError } = await supabase
        .from('mv_action_scores')
        .select('weighted_success_rate, trend_delta')
        .eq('customer_id', customerId);

      if (actionError) {
        throw new Error(actionError.message);
      }

      const typedRows = (actionRows ?? []) as ActionScoreRow[];
      const actionCount = typedRows.length;
      setHasScores(actionCount > 0);
      const currentRate = actionCount > 0
        ? typedRows.reduce((sum, row) => sum + Number(row.weighted_success_rate ?? 0), 0) / actionCount
        : 0;

      const baselineRate = actionCount > 0
        ? typedRows.reduce((sum, row) => {
          const weighted = Number(row.weighted_success_rate ?? 0);
          const trend = Number(row.trend_delta ?? 0);
          return sum + (weighted - trend);
        }, 0) / actionCount
        : 0;

      const { count: unresolvedCount, error: unresolvedError } = await supabase
        .from('degradation_alert_events')
        .select('alert_id', { count: 'exact', head: true })
        .eq('customer_id', customerId)
        .eq('acknowledged', false);

      if (unresolvedError) {
        throw new Error(unresolvedError.message);
      }

      const { data: severityRows, error: severityError } = await supabase
        .from('degradation_alert_events')
        .select('severity')
        .eq('customer_id', customerId)
        .eq('acknowledged', false)
        .limit(200);

      if (severityError) {
        throw new Error(severityError.message);
      }

      const normalizedSeverities = ((severityRows ?? []) as AlertSeverityRow[])
        .map((row) => (row.severity ?? '').toLowerCase());

      const nextAlertSeverity: 'critical' | 'warning' | 'none' = normalizedSeverities.includes('critical')
        ? 'critical'
        : normalizedSeverities.includes('warning')
          ? 'warning'
          : 'none';

      const nextHealthScore = Math.round((trustScore * 0.5 + currentRate * 0.5) * 100);
      const previousHealthScore = Math.round((trustScore * 0.5 + baselineRate * 0.5) * 100);

      setAgentHealthScore(nextHealthScore);
      setAgentHealthDelta(nextHealthScore - previousHealthScore);
      setDecisionsToday(todayCount ?? 0);
      setDecisionsDelta((todayCount ?? 0) - (previousCount ?? 0));
      setSuccessRate7d(currentRate);
      setSuccessRateDelta((currentRate - baselineRate) * 100);
      setActiveAlerts(unresolvedCount ?? 0);
      setAlertSeverity(nextAlertSeverity);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch overview metrics');
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
    void loadMetrics();
  }, [ctx, ctxLoading, refreshTick, loadMetrics]);

  useEffect(() => {
    if (!ctx) {
      return;
    }

    const channel = supabase
      .channel(`overview-outcomes-${ctx.customerId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'fact_outcomes',
        filter: `customer_id=eq.${ctx.customerId}`,
      }, () => {
        setRefreshTick((v) => v + 1);
      })
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [ctx]);

  useEffect(() => {
    if (!ctx) {
      return;
    }

    const timer = window.setInterval(() => {
      setRefreshTick((v) => v + 1);
    }, 30000);

    return () => {
      window.clearInterval(timer);
    };
  }, [ctx]);

  const refetch = useCallback(() => {
    setRefreshTick((v) => v + 1);
  }, []);

  return useMemo(() => ({
    hasScores,
    hasData,
    agentHealthScore,
    agentHealthDelta,
    decisionsToday,
    decisionsDelta,
    successRate7d,
    successRateDelta,
    activeAlerts,
    alertSeverity,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
  }), [
    hasScores,
    hasData,
    agentHealthScore,
    agentHealthDelta,
    decisionsToday,
    decisionsDelta,
    successRate7d,
    successRateDelta,
    activeAlerts,
    alertSeverity,
    loading,
    ctxLoading,
    ctxError,
    error,
    refetch,
  ]);
}
