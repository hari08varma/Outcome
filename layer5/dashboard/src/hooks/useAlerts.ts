import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useCustomerContext } from './useCustomerContext';

export type AlertsFilter =
  | 'all'
  | 'latency_spike'
  | 'context_drift'
  | 'coordinated_failure'
  | 'silent_failure';

export interface AlertItem {
  id: string;
  alertType: string;
  severity: 'critical' | 'warning';
  message: string;
  actionName: string;
  currentValue: number | null;
  baselineValue: number | null;
  spikeRatio: number | null;
  affectedAgentCount: number | null;
  createdAt: string;
  resolved: boolean;
}

export interface AlertsResult {
  alerts: AlertItem[];
  unresolvedCount: number;
  resolveAlert: (id: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

interface AlertRow {
  alert_id: string;
  alert_type: string;
  severity: string;
  message: string | null;
  action_name: string | null;
  current_value: number | null;
  baseline_value: number | null;
  spike_ratio: number | null;
  affected_agent_count: number | null;
  detected_at: string;
  acknowledged: boolean | null;
}

export function useAlerts(filter: AlertsFilter, showResolved: boolean): AlertsResult {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!ctx) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let query = supabase
        .from('degradation_alert_events')
        .select('alert_id, alert_type, severity, message, action_name, current_value, baseline_value, spike_ratio, affected_agent_count, detected_at, acknowledged')
        .eq('customer_id', ctx.customerId)
        .order('detected_at', { ascending: false })
        .limit(50);

      if (!showResolved) {
        query = query.eq('acknowledged', false);
      }

      if (filter !== 'all') {
        query = query.eq('alert_type', filter);
      }

      const { data: rows, error: rowsError } = await query;
      if (rowsError) {
        throw new Error(rowsError.message);
      }

      const mapped: AlertItem[] = ((rows ?? []) as AlertRow[]).map((row) => {
        const severity: 'critical' | 'warning' = row.severity.toLowerCase() === 'critical'
          ? 'critical'
          : 'warning';

        return {
          id: row.alert_id,
          alertType: row.alert_type,
          severity,
          message: row.message ?? '',
          actionName: row.action_name ?? 'unknown_action',
          currentValue: row.current_value,
          baselineValue: row.baseline_value,
          spikeRatio: row.spike_ratio,
          affectedAgentCount: row.affected_agent_count,
          createdAt: row.detected_at,
          resolved: Boolean(row.acknowledged),
        };
      });

      const { count: unresolved, error: unresolvedError } = await supabase
        .from('degradation_alert_events')
        .select('alert_id', { count: 'exact', head: true })
        .eq('customer_id', ctx.customerId)
        .eq('acknowledged', false);

      if (unresolvedError) {
        throw new Error(unresolvedError.message);
      }

      setAlerts(mapped);
      setUnresolvedCount(unresolved ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
      setAlerts([]);
      setUnresolvedCount(0);
    } finally {
      setLoading(false);
    }
  }, [ctx, filter, showResolved]);

  useEffect(() => {
    if (!ctx) {
      return;
    }
    void load();
  }, [ctx, tick, load]);

  useEffect(() => {
    if (!ctx) {
      return;
    }

    const channel = supabase
      .channel(`alerts-${ctx.customerId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'degradation_alert_events',
        filter: `customer_id=eq.${ctx.customerId}`,
      }, () => {
        setTick((v) => v + 1);
      })
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [ctx]);

  const resolveAlert = useCallback(async (id: string) => {
    if (!ctx) {
      return;
    }

    const { error: updateError } = await supabase
      .from('degradation_alert_events')
      .update({
        acknowledged: true,
        acknowledged_at: new Date().toISOString(),
      })
      .eq('customer_id', ctx.customerId)
      .eq('alert_id', id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    setAlerts((prev) => prev.filter((row) => row.id !== id));
    setUnresolvedCount((prev) => Math.max(0, prev - 1));
  }, [ctx]);

  return useMemo(() => ({
    alerts,
    unresolvedCount,
    resolveAlert,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
  }), [alerts, unresolvedCount, resolveAlert, loading, ctxLoading, ctxError, error]);
}
