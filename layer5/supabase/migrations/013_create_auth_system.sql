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
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_customer_id UUID;
  display_name    TEXT;
BEGIN
  -- Derive a human-readable display name from metadata or email prefix
  display_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    split_part(NEW.email, '@', 1)
  );

  -- 1. Create a new customer record for this user
  INSERT INTO dim_customers (
    company_name,
    tier,
    is_active,
    api_key_hash,
    created_at
  ) VALUES (
    COALESCE(
      NULLIF(TRIM(NEW.raw_user_meta_data->>'company_name'), ''),
      NEW.email   -- fallback: use full email as company_name for solo signups
    ),
    'starter',
    true,
    encode(gen_random_bytes(32), 'hex'),  -- placeholder; real keys are managed via the API
    NOW()
  )
  ON CONFLICT DO NOTHING
  RETURNING customer_id INTO new_customer_id;

  -- Guard: if ON CONFLICT fired and RETURNING returned nothing, look up the existing row.
  -- (Extremely unlikely — customer_id is a UUID — but defensive.)
  IF new_customer_id IS NULL THEN
    RAISE WARNING 'handle_new_user: dim_customers insert returned NULL for user %; skipping profile creation.', NEW.id;
    RETURN NEW;
  END IF;

  -- 2. Create the user profile linking auth.users → dim_customers
  INSERT INTO user_profiles (
    id,
    customer_id,
    full_name,
    role,
    created_at
  ) VALUES (
    NEW.id,
    new_customer_id,
    display_name,
    'admin',   -- first user of an account is always admin
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  -- 3. Create a default agent for this customer so the API Keys page is never empty
  INSERT INTO dim_agents (
    agent_name,
    agent_type,
    customer_id,
    is_active,
    created_at
  ) VALUES (
    'default-agent',
    'api-key',
    new_customer_id,
    true,
    NOW()
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- Log the full error but NEVER let signup fail because of provisioning.
  RAISE WARNING 'handle_new_user failed for user % (email: %): % — %',
    NEW.id, NEW.email, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
