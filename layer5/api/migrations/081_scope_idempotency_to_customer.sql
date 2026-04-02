ALTER TABLE fact_outcome_idempotency
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES dim_customers(customer_id);

-- Backfill customer_id from fact_outcomes join
UPDATE fact_outcome_idempotency fi
SET customer_id = fo.customer_id
FROM fact_outcomes fo
WHERE fi.outcome_id = fo.outcome_id;

-- Drop old unique index on idempotency_key alone
DROP INDEX IF EXISTS fact_outcome_idempotency_key_unique;

-- New composite unique index: key is unique PER customer, not globally
CREATE UNIQUE INDEX fact_outcome_idempotency_customer_key_unique
  ON fact_outcome_idempotency (customer_id, idempotency_key);
