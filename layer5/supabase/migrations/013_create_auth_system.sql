-- ============================================================
-- LAYERINFINITE — Migration 013: Auth System (Supabase Auth Integration)
-- ============================================================
-- Links Supabase Auth users to dim_customers via user_profiles.
-- On signup, auto-creates a dim_customers record, links the new
-- user via user_profiles, and inserts a default dim_agents row.
-- ============================================================

-- ────────────────────────────────────────────
-- user_profiles: bridge between auth.users and dim_customers
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES dim_customers(customer_id),
  full_name     VARCHAR(255),
  role          VARCHAR(50) DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_customer ON user_profiles(customer_id);

-- ────────────────────────────────────────────
-- Trigger function: auto-create customer + profile + default agent on signup
-- SECURITY DEFINER: bypasses RLS so it can write to all tables.
-- EXCEPTION block: never lets a trigger failure block signup.
-- Includes fallback retry on failure using only guaranteed columns.
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_customer_id     UUID;
  user_display_name   TEXT;
  profile_name_column TEXT;
  customer_has_is_active BOOLEAN;
BEGIN
  -- ── Cache ALL schema checks upfront before any INSERT ──────
  user_display_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

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
      'starter', true, encode(gen_random_bytes(32), 'hex'), NOW()
    )
    RETURNING customer_id INTO new_customer_id;
  ELSE
    INSERT INTO dim_customers (
      company_name, tier, api_key_hash, created_at
    ) VALUES (
      COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'company_name'), ''), NEW.email),
      'starter', encode(gen_random_bytes(32), 'hex'), NOW()
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
    INSERT INTO user_profiles (id, customer_id, display_name, role, created_at)
    VALUES (NEW.id, new_customer_id, user_display_name, 'admin', NOW())
    ON CONFLICT (id) DO NOTHING;
  ELSE
    INSERT INTO user_profiles (id, customer_id, full_name, role, created_at)
    VALUES (NEW.id, new_customer_id, user_display_name, 'admin', NOW())
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
  -- ── Primary attempt failed — try fallback with minimal columns ──
  BEGIN
    -- Fallback: insert dim_customers with only guaranteed columns
    INSERT INTO dim_customers (
      company_name, tier, api_key_hash, created_at
    ) VALUES (
      COALESCE(NEW.email, 'unknown'),
      'starter',
      encode(gen_random_bytes(32), 'hex'),
      NOW()
    )
    RETURNING customer_id INTO new_customer_id;

    IF new_customer_id IS NOT NULL THEN
      -- Fallback: insert user_profiles WITHOUT the name column
      INSERT INTO user_profiles (id, customer_id, role, created_at)
      VALUES (NEW.id, new_customer_id, 'admin', NOW())
      ON CONFLICT (id) DO NOTHING;

      -- Fallback: insert default agent
      INSERT INTO dim_agents (
        agent_name, agent_type, customer_id, is_active, created_at
      ) VALUES (
        'default-agent', 'api-key', new_customer_id, true, NOW()
      )
      ON CONFLICT DO NOTHING;

      RAISE NOTICE 'handle_new_user: fallback succeeded for user %', NEW.id;
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
      'error', SQLERRM,
      'sqlstate', SQLSTATE,
      'occurred_at', NOW()
    )::text
  );

  RAISE WARNING 'handle_new_user failed for user % (email: %): % [%]',
    NEW.id, NEW.email, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- ────────────────────────────────────────────
-- Wire the trigger to auth.users INSERT
-- (DROP + CREATE is idempotent; CREATE OR REPLACE doesn't exist for triggers)
-- ────────────────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ────────────────────────────────────────────
-- RLS: users can only read/update their own profile
-- ────────────────────────────────────────────
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_profile" ON user_profiles;
CREATE POLICY "users_read_own_profile" ON user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "users_update_own_profile" ON user_profiles;
CREATE POLICY "users_update_own_profile" ON user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
