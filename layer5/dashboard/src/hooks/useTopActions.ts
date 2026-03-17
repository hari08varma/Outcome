import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useCustomerContext } from './useCustomerContext';

export type ActionTrend = 'improving' | 'degrading' | 'stable';

export interface TopActionItem {
  actionName: string;
  successRate: number;
  trend: ActionTrend;
  trendDelta: number;
  sampleCount: number;
  barColor: string;
}

export interface DegradingActionItem {
  actionId: string;
  actionName: string;
  successRate: number;
  trendDelta: number;
}

export interface TopActionsResult {
  topActions: TopActionItem[];
  degradingActions: DegradingActionItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface ActionScoreRow {
  action_id: string;
  action_name: string;
  weighted_success_rate: number | null;
  trend_delta: number | null;
  total_attempts: number | null;
}

function getTrend(delta: number): ActionTrend {
  if (delta > 0.05) {
    return 'improving';
  }
  if (delta < -0.05) {
    return 'degrading';
  }
  return 'stable';
}

function getBarColor(rate: number): string {
  if (rate >= 0.95) {
    return '#b8ff00';
  }
  if (rate >= 0.8) {
    return '#44dd66';
  }
  return '#ffaa00';
}

export function useTopActions(): TopActionsResult {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [topActions, setTopActions] = useState<TopActionItem[]>([]);
  const [degradingActions, setDegradingActions] = useState<DegradingActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!ctx) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data: rows, error: rowsError } = await supabase
        .from('mv_action_scores')
        .select('action_id, action_name, weighted_success_rate, trend_delta, total_attempts')
        .eq('customer_id', ctx.customerId)
        .order('weighted_success_rate', { ascending: false });

      if (rowsError) {
        throw new Error(rowsError.message);
      }

      const typedRows = (rows ?? []) as ActionScoreRow[];

      const top = typedRows.slice(0, 5).map((row) => {
        const rate = Number(row.weighted_success_rate ?? 0);
        const trendDelta = Number(row.trend_delta ?? 0);
        return {
          actionName: row.action_name,
          successRate: rate,
          trend: getTrend(trendDelta),
          trendDelta,
          sampleCount: Number(row.total_attempts ?? 0),
          barColor: getBarColor(rate),
        };
      });

      const degrading = typedRows
        .filter((row) => Number(row.trend_delta ?? 0) < -0.05)
        .map((row) => ({
          actionId: row.action_id,
          actionName: row.action_name,
          successRate: Number(row.weighted_success_rate ?? 0),
          trendDelta: Number(row.trend_delta ?? 0),
        }));

      setTopActions(top);
      setDegradingActions(degrading);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load action metrics');
      setTopActions([]);
      setDegradingActions([]);
    } finally {
      setLoading(false);
    }
  }, [ctx]);

  useEffect(() => {
    if (!ctx) {
      if (!ctxLoading) {
        setLoading(false);
      }
      return;
    }
    void load();
  }, [ctx, ctxLoading, tick, load]);

  const refetch = useCallback(() => {
    setTick((v) => v + 1);
  }, []);

  return useMemo(() => ({
    topActions,
    degradingActions,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
  }), [topActions, degradingActions, loading, ctxLoading, ctxError, error, refetch]);
}
