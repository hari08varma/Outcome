-- ============================================================
-- LAYERINFINITE — Migration 123: Dashboard Trend RPC
-- ============================================================
-- Pushes the heavy 30-day success trend aggregation into Postgres.
-- This prevents the React dashboard from requesting and serializing 
-- 10,000+ raw rows across the network just to chunk them locally.

CREATE OR REPLACE FUNCTION get_dashboard_success_trend(
    p_customer_id UUID,
    p_days_lookback INT,
    p_context_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
    trend_date DATE,
    total_count BIGINT,
    success_count BIGINT,
    success_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    WITH date_series AS (
        SELECT generate_series(
            (CURRENT_DATE - (p_days_lookback - 1) * interval '1 day')::date,
            CURRENT_DATE::date,
            interval '1 day'
        )::date AS d
    ),
    filtered_outcomes AS (
        SELECT 
            fo.timestamp::date AS outcome_date,
            fo.success
        FROM public.fact_outcomes fo
        JOIN public.dim_contexts dc ON fo.context_id = dc.context_id
        WHERE fo.customer_id = p_customer_id
          AND fo.timestamp >= (CURRENT_DATE - (p_days_lookback - 1) * interval '1 day')
          AND (p_context_filter IS NULL OR dc.issue_type = p_context_filter)
    ),
    aggregated AS (
        SELECT 
            outcome_date,
            COUNT(*) AS daily_total,
            SUM(CASE WHEN success THEN 1 ELSE 0 END) AS daily_success
        FROM filtered_outcomes
        GROUP BY outcome_date
    )
    SELECT 
        ds.d AS trend_date,
        COALESCE(a.daily_total, 0) AS total_count,
        COALESCE(a.daily_success, 0) AS success_count,
        CASE 
            WHEN COALESCE(a.daily_total, 0) = 0 THEN NULL::NUMERIC
            ELSE ROUND((COALESCE(a.daily_success, 0)::NUMERIC / a.daily_total::NUMERIC) * 100.0, 1)
        END AS success_rate
    FROM date_series ds
    LEFT JOIN aggregated a ON ds.d = a.outcome_date
    ORDER BY ds.d ASC;
END;
$$ LANGUAGE plpgsql STABLE;
