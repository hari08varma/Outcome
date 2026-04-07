-- ============================================================================
-- Migration 098: Backfill unknown_task names from context issue_type
--
-- Why:
--   Some historical rows were stored with task_name='unknown_task', which can
--   mask usable task-level learning signals in recommendation aggregation.
--
-- What this migration does:
--   1) Re-derives task_name for unknown_task rows from dim_contexts.issue_type
--      using the same canonical mapping + slug fallback strategy as runtime.
--   2) Updates mapping_tier/mapping_confidence for rewritten rows.
--   3) Refreshes task/action materialized views via refresh_task_action_performance().
--
-- Safety:
--   - Idempotent (re-runs only touch remaining unknown_task rows)
--   - No schema changes
-- ============================================================================

BEGIN;

WITH issue_mapping(issue_slug, mapped_task) AS (
    VALUES
        ('billing_dispute', 'payment_failed'),
        ('payment_failure', 'payment_failed'),
        ('payment_failed', 'payment_failed'),
        ('charge_failed', 'payment_failed'),
        ('invoice_dispute', 'payment_failed'),
        ('refund_request', 'refund_processing'),
        ('refund_failed', 'refund_processing'),
        ('subscription_cancel', 'subscription_management'),
        ('subscription_failed', 'subscription_management'),
        ('ticket_open', 'ticket_resolution'),
        ('ticket_escalation', 'ticket_resolution'),
        ('support_request', 'ticket_resolution'),
        ('complaint', 'ticket_resolution'),
        ('angry_customer', 'ticket_resolution'),
        ('login_failed', 'auth_recovery'),
        ('account_locked', 'auth_recovery'),
        ('password_reset', 'auth_recovery'),
        ('access_denied', 'auth_recovery'),
        ('order_failed', 'order_recovery'),
        ('delivery_failed', 'order_recovery'),
        ('order_cancelled', 'order_recovery'),
        ('item_missing', 'order_recovery'),
        ('onboarding_stuck', 'onboarding'),
        ('setup_failed', 'onboarding'),
        ('integration_failed', 'onboarding')
),
candidate_unknown AS (
    SELECT
        fo.outcome_id,
        btrim(
            regexp_replace(
                regexp_replace(
                    lower(
                        regexp_replace(
                            regexp_replace(btrim(dc.issue_type), '[\s\-]+', '_', 'g'),
                            '[^a-zA-Z0-9_]+',
                            '_',
                            'g'
                        )
                    ),
                    '_{2,}',
                    '_',
                    'g'
                ),
                '^_+|_+$',
                '',
                'g'
            ),
            '_'
        ) AS issue_slug
    FROM fact_outcomes fo
    JOIN dim_contexts dc
      ON dc.context_id = fo.context_id
     AND dc.customer_id = fo.customer_id
    WHERE fo.task_name = 'unknown_task'
      AND fo.is_deleted = false
      AND dc.issue_type IS NOT NULL
      AND btrim(dc.issue_type) <> ''
),
resolved AS (
    SELECT
        c.outcome_id,
        COALESCE(
            m.mapped_task,
            CASE
                WHEN c.issue_slug = '' THEN NULL
                WHEN c.issue_slug IN ('unknown', 'unknown_task', 'unspecified', 'n_a', 'na', 'none', 'null', 'undefined')
                    THEN 'unspecified_issue'
                WHEN c.issue_slug ~ '^[a-z]'
                    THEN left(c.issue_slug, 64)
                ELSE left('task_' || c.issue_slug, 64)
            END
        ) AS new_task_name,
        CASE
            WHEN m.mapped_task IS NOT NULL THEN 'exact_match'
            WHEN c.issue_slug = '' THEN NULL
            ELSE 'slugified_fallback'
        END AS new_mapping_tier,
        CASE
            WHEN m.mapped_task IS NOT NULL THEN 0.90
            WHEN c.issue_slug = '' THEN NULL
            ELSE 0.50
        END AS new_mapping_confidence
    FROM candidate_unknown c
    LEFT JOIN issue_mapping m
      ON m.issue_slug = c.issue_slug
),
updated AS (
    UPDATE fact_outcomes fo
       SET task_name = r.new_task_name,
           mapping_tier = COALESCE(r.new_mapping_tier, fo.mapping_tier),
           mapping_confidence = COALESCE(r.new_mapping_confidence, fo.mapping_confidence)
      FROM resolved r
     WHERE fo.outcome_id = r.outcome_id
       AND r.new_task_name IS NOT NULL
       AND r.new_task_name <> 'unknown_task'
    RETURNING fo.outcome_id
)
SELECT COUNT(*) AS rows_rewritten
FROM updated;

SELECT refresh_task_action_performance();

COMMIT;

-- Verification
SELECT customer_id, task_name, COUNT(*) AS action_rows
FROM mv_task_action_performance_180d
GROUP BY customer_id, task_name
ORDER BY action_rows DESC
LIMIT 20;
