-- Wrap DROP + CREATE in one transaction to prevent a race window where
-- idempotency uniqueness is temporarily unenforced under concurrent traffic.
BEGIN;

ALTER TABLE fact_outcome_idempotency
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES dim_customers(customer_id);

-- Backfill customer_id from fact_outcomes join
UPDATE fact_outcome_idempotency fi
SET customer_id = fo.customer_id
FROM fact_outcomes fo
WHERE fi.outcome_id = fo.outcome_id;

DO $$
DECLARE
  null_customer_id_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO null_customer_id_count
  FROM fact_outcome_idempotency
  WHERE customer_id IS NULL;

  IF null_customer_id_count > 0 THEN
    RAISE EXCEPTION
      'Migration 081 aborted: % rows in fact_outcome_idempotency have NULL customer_id after backfill. Resolve orphaned idempotency records before re-running.',
      null_customer_id_count;
  END IF;
END
$$;

-- Drop old unique index on idempotency_key alone
DROP INDEX IF EXISTS fact_outcome_idempotency_key_unique;

-- New composite unique index: key is unique PER customer, not globally
CREATE UNIQUE INDEX fact_outcome_idempotency_customer_key_unique
  ON fact_outcome_idempotency (customer_id, idempotency_key);

ALTER TABLE fact_outcome_idempotency
  ALTER COLUMN customer_id SET NOT NULL;

COMMIT;
