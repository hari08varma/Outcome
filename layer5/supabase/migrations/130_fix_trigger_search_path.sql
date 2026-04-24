CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_customer_id     UUID;
  user_display_name   TEXT;
  profile_name_column TEXT;
  customer_has_is_active BOOLEAN;
  original_error_text TEXT;
  original_sqlstate   TEXT;
  new_agent_type      TEXT;
  new_use_case        TEXT;
  new_estimated_volume TEXT;
BEGIN
  -- ── Cache ALL schema checks upfront before any INSERT ──────
  user_display_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  new_agent_type := NULLIF(TRIM(NEW.raw_user_meta_data->>'agent_type'), '');
  new_use_case := NULLIF(TRIM(NEW.raw_user_meta_data->>'use_case'), '');
  new_estimated_volume := NULLIF(TRIM(NEW.raw_user_meta_data->>'estimated_volume'), '');

  -- Check if dim_customers has is_active column
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'dim_customers'
      AND column_name  = 'is_active'
  ) INTO customer_has_is_active;

  -- Check if user_profiles uses display_name or full_name
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'user_profiles'
        AND column_name  = 'display_name'
    ) THEN 'display_name'
    ELSE 'full_name'
  END INTO profile_name_column;

  -- ── Step 1: Create dim_customers row ───────────────────────
  IF customer_has_is_active THEN
    INSERT INTO dim_customers (
      company_name, tier, is_active, api_key_hash, created_at
    ) VALUES (
      COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'company_name'), ''), NEW.email),
      'starter', true, encode(extensions.gen_random_bytes(32), 'hex'), NOW()
    )
    RETURNING customer_id INTO new_customer_id;
  ELSE
    INSERT INTO dim_customers (
      company_name, tier, api_key_hash, created_at
    ) VALUES (
      COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'company_name'), ''), NEW.email),
      'starter', encode(extensions.gen_random_bytes(32), 'hex'), NOW()
    )
    RETURNING customer_id INTO new_customer_id;
  END IF;

  -- Guard: customer insert must return a UUID
  IF new_customer_id IS NULL THEN
    RAISE WARNING 'handle_new_user: dim_customers INSERT returned NULL for user %, aborting profile creation.', NEW.id;
    RETURN NEW;
  END IF;

  -- ── Step 2: Create user_profiles row ───────────────────────
  IF profile_name_column = 'display_name' THEN
    INSERT INTO user_profiles (id, customer_id, display_name, role, agent_type, use_case, estimated_volume, access_status, created_at)
    VALUES (NEW.id, new_customer_id, user_display_name, 'admin', new_agent_type, new_use_case, new_estimated_volume, 'pending', NOW())
    ON CONFLICT (id) DO NOTHING;
  ELSE
    INSERT INTO user_profiles (id, customer_id, full_name, role, agent_type, use_case, estimated_volume, access_status, created_at)
    VALUES (NEW.id, new_customer_id, user_display_name, 'admin', new_agent_type, new_use_case, new_estimated_volume, 'pending', NOW())
    ON CONFLICT (id) DO NOTHING;
  END IF;

  -- ── Step 3: Create default agent ───────────────────────────
  INSERT INTO dim_agents (
    agent_name, agent_type, customer_id, is_active, created_at
  ) VALUES (
    'default-agent', 'api-key', new_customer_id, true, NOW()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  original_error_text := SQLERRM;
  original_sqlstate := SQLSTATE;

  -- ── Primary attempt failed — try fallback with minimal columns ──
  BEGIN
    -- Fallback: insert dim_customers with only guaranteed columns
    INSERT INTO dim_customers (
      company_name, tier, api_key_hash, created_at
    ) VALUES (
      COALESCE(NEW.email, 'unknown'),
      'starter',
      encode(extensions.gen_random_bytes(32), 'hex'),
      NOW()
    )
    RETURNING customer_id INTO new_customer_id;

    IF new_customer_id IS NOT NULL THEN
      -- Fallback: insert user_profiles WITHOUT the name column
      INSERT INTO user_profiles (id, customer_id, role, access_status, created_at)
      VALUES (NEW.id, new_customer_id, 'admin', 'pending', NOW())
      ON CONFLICT (id) DO NOTHING;

      -- Fallback: insert default agent
      INSERT INTO dim_agents (
        agent_name, agent_type, customer_id, is_active, created_at
      ) VALUES (
        'default-agent', 'api-key', new_customer_id, true, NOW()
      )
      ON CONFLICT DO NOTHING;

      RAISE NOTICE 'handle_new_user: fallback succeeded for user %', NEW.id;
    ELSE
      RAISE WARNING 'handle_new_user: fallback dim_customers INSERT returned NULL for user %', NEW.id;
    END IF;

  EXCEPTION WHEN OTHERS THEN
    -- Fallback also failed — log everything but never block signup
    RAISE WARNING 'handle_new_user: FALLBACK also failed for user % (email: %): % [%]',
      NEW.id, NEW.email, SQLERRM, SQLSTATE;
  END;

  -- Notify on the error channel so it's observable in production
  PERFORM pg_notify(
    'layer5_account_setup_error',
    json_build_object(
      'user_id', NEW.id,
      'email', NEW.email,
      'error', original_error_text,
      'sqlstate', original_sqlstate,
      'occurred_at', NOW()
    )::text
  );

  RAISE WARNING 'handle_new_user failed for user % (email: %): % [%]',
    NEW.id, NEW.email, original_error_text, original_sqlstate;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, extensions;
