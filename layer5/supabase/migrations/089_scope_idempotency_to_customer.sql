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

-- Remove orphaned rows that could not be backfilled before enforcing NOT NULL.
DELETE FROM fact_outcome_idempotency
WHERE customer_id IS NULL;

-- Drop old unique index on idempotency_key alone
DROP INDEX IF EXISTS fact_outcome_idempotency_key_unique;

-- New composite unique index: key is unique PER customer, not globally
CREATE UNIQUE INDEX IF NOT EXISTS fact_outcome_idempotency_customer_key_unique
  ON fact_outcome_idempotency (customer_id, idempotency_key);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fact_outcome_idempotency'
      AND column_name = 'customer_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE fact_outcome_idempotency
      ALTER COLUMN customer_id SET NOT NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Migration 089 failed while enforcing NOT NULL on fact_outcome_idempotency.customer_id: %', SQLERRM;
END
$$;

SELECT COUNT(*)
FROM fact_outcome_idempotency
WHERE customer_id IS NULL;
-- Expected: 0

COMMIT;
