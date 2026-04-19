import { useCallback, useEffect, useMemo, useState } from 'react';
import { eachDayOfInterval, format, subDays } from 'date-fns';
import { supabase } from '../supabaseClient';
import { ACCOUNT_SETUP_INCOMPLETE_MESSAGE, useCustomerContext } from './useCustomerContext';

export interface SuccessRatePoint {
  date: string;
  rate: number | null;
}

interface FactOutcomeTrendRow {
  timestamp: string;
  success: boolean;
  context_id: string;
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

      const { data: rows, error: rowsError } = await supabase.rpc('get_dashboard_success_trend', {
        p_customer_id: customerId,
        p_days_lookback: 30,
        p_context_filter: contextFilter ?? null
      });

      if (rowsError) {
        throw new Error(rowsError.message);
      }

      const points: SuccessRatePoint[] = (rows ?? []).map((row: any) => ({
        date: format(new Date(row.trend_date), 'yyyy-MM-dd'),
        rate: row.success_rate !== null ? Number(row.success_rate) : null
      }));

      setData(points);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch success rate trend');
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [ctx, contextFilter, ensureCustomerId]);

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
    data,
    loading: loading || ctxLoading,
    error: ctxError ?? error,
    refetch,
  }), [data, loading, ctxLoading, ctxError, error, refetch]);
}
