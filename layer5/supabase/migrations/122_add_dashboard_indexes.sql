-- ============================================================
-- LAYERINFINITE — Migration 122: Dashboard Performance Indexes
-- ============================================================
-- The dashboard was crashing under heavy load due to Sequential
-- Scans on fact_outcomes during time filter queries.
-- These covering indexes eliminate the scans entirely, enabling 
-- `count: exact` to execute natively against the B-Tree index.

-- 1. Index for Overview Metrics (Count per customer by time range)
--    We INCLUDE context_id and success specifically to act as a 
--    covering index for useSuccessRateTrend.ts.
CREATE INDEX IF NOT EXISTS idx_fact_outcomes_customer_time_covering 
ON public.fact_outcomes USING btree (customer_id, timestamp DESC)
INCLUDE (success, context_id);

-- 2. Index for Degradation Alert queries (Unresolved alerts by customer)
CREATE INDEX IF NOT EXISTS idx_degradation_alerts_unresolved 
ON public.degradation_alert_events USING btree (customer_id) 
WHERE acknowledged = false;
