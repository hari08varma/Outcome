import { useCallback, useEffect, useMemo, useState } from 'react';
import { eachDayOfInterval, format, subDays } from 'date-fns';
import { supabase } from '../supabaseClient';
import { useCustomerContext } from './useCustomerContext';

export interface SuccessRatePoint {
  date: string;
  rate: number | null;
}

interface FactOutcomeTrendRow {
  created_at: string;
  success: boolean;
}

interface UseSuccessRateTrendResult {
  data: SuccessRatePoint[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSuccessRateTrend(contextFilter?: string): UseSuccessRateTrendResult {
  const { data: ctx, loading: ctxLoading, error: ctxError } = useCustomerContext();
  const [data, setData] = useState<SuccessRatePoint[]>([]);
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
      const startDate = subDays(new Date(), 29);
      const endDate = new Date();

      let query = supabase
        .from('fact_outcomes')
        .select('created_at, success')
        .eq('customer_id', ctx.customerId)
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString());

      if (contextFilter) {
        query = query.eq('context_type', contextFilter);
      }

      const { data: rows, error: rowsError } = await query;
      if (rowsError) {
        throw new Error(rowsError.message);
      }

      const grouped = new Map<string, { total: number; success: number }>();

      ((rows ?? []) as FactOutcomeTrendRow[]).forEach((row) => {
        const dayKey = format(new Date(row.created_at), 'yyyy-MM-dd');
        const existing = grouped.get(dayKey) ?? { total: 0, success: 0 };
        existing.total += 1;
        if (row.success) {
          existing.success += 1;
        }
        grouped.set(dayKey, existing);
      });

      const points: SuccessRatePoint[] = eachDayOfInterval({ start: startDate, end: endDate }).map((day) => {
        const key = format(day, 'yyyy-MM-dd');
        const bucket = grouped.get(key);
        if (!bucket || bucket.total === 0) {
          return { date: key, rate: null };
        }
        const rate = Number(((bucket.success / bucket.total) * 100).toFixed(1));
        return { date: key, rate };
      });

      setData(points);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch success rate trend');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [ctx, contextFilter]);

  useEffect(() => {
    if (!ctx) {
      return;
    }
    void load();
  }, [ctx, tick, load]);

  const refetch = useCallback(() => {
    setTick((v) => v + 1);
  }, []);

  return useMemo(() => ({
    data,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
  }), [data, loading, ctxLoading, ctxError, error, refetch]);
}
