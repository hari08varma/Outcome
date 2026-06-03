-- ============================================================
-- LAYERINFINITE — Migration 133: get_undelivered_alerts RPC
-- ============================================================
-- The notification-dispatcher edge function calls this RPC to
-- find alerts that haven't been delivered yet. It was referenced
-- but never created in any prior migration (the dispatcher has
-- a raw-query fallback which prevents crashes, but this RPC is
-- the intended design).
-- ============================================================

CREATE OR REPLACE FUNCTION get_undelivered_alerts()
RETURNS TABLE (
    alert_id UUID,
    channel_id UUID,
    channel_type TEXT,
    destination TEXT,
    customer_id UUID,
    alert_type TEXT,
    severity TEXT,
    title TEXT,
    body TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        a.id AS alert_id,
        c.id AS channel_id,
        c.channel_type,
        c.destination,
        a.customer_id,
        a.alert_type,
        a.severity,
        a.title,
        a.body,
        a.created_at
    FROM alert_notifications a
    JOIN alert_notification_channels c
        ON c.customer_id = a.customer_id
        AND c.is_active = TRUE
        AND (c.min_severity IS NULL OR
             CASE a.severity
                 WHEN 'critical' THEN 4
                 WHEN 'high' THEN 3
                 WHEN 'medium' THEN 2
                 WHEN 'low' THEN 1
                 ELSE 0
             END >=
             CASE c.min_severity
                 WHEN 'critical' THEN 4
                 WHEN 'high' THEN 3
                 WHEN 'medium' THEN 2
                 WHEN 'low' THEN 1
                 ELSE 0
             END)
        AND (c.alert_type_filter IS NULL OR c.alert_type_filter = a.alert_type)
    WHERE a.delivered = FALSE
    ORDER BY a.created_at ASC;
END;
$$;
