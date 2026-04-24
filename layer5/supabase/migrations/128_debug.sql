CREATE OR REPLACE FUNCTION debug_trigger() RETURNS text AS $$
DECLARE
  new_customer_id UUID;
BEGIN
  INSERT INTO dim_customers (
      company_name, tier, api_key_hash, created_at
  ) VALUES (
      'unknown',
      'starter',
      encode(gen_random_bytes(32), 'hex'),
      NOW()
  )
  RETURNING customer_id INTO new_customer_id;

  RETURN 'Success ' || new_customer_id::text;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ': ' || SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
