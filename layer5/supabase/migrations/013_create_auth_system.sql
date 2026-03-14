-- ============================================================
-- LAYERINFINITE — Migration 013: Auth System (Supabase Auth Integration)
-- ============================================================
-- Links Supabase Auth users to dim_customers via user_profiles.
-- On signup, auto-creates a dim_customers record and
-- associates the new user with it.
-- ============================================================

-- ────────────────────────────────────────────
-- user_profiles: bridge between auth.users and dim_customers
-- ────────────────────────────────────────────
CREATE TABLE user_profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES dim_customers(customer_id),
  full_name     VARCHAR(255),
  role          VARCHAR(50) DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_profiles_customer ON user_profiles(customer_id);

-- ────────────────────────────────────────────
-- Trigger function: auto-create customer + profile on signup
-- ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_customer_id UUID;
BEGIN
  -- Create a new customer record for this user
  INSERT INTO dim_customers (
    company_name,
    tier,
    api_key_hash
  ) VALUES (
    COALESCE(NEW.raw_user_meta_data->>'company_name', 'My Company'),
    'pro',
    encode(gen_random_bytes(32), 'hex')  -- placeholder, real keys via API
  ) RETURNING customer_id INTO new_customer_id;

  -- Create the user profile linking auth.users → dim_customers
  INSERT INTO user_profiles (id, customer_id, full_name, role)
  VALUES (
    NEW.id,
    new_customer_id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'owner'  -- first user in a customer org is the owner
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ────────────────────────────────────────────
-- Wire the trigger to auth.users INSERT
-- ────────────────────────────────────────────
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ────────────────────────────────────────────
-- RLS: users can only read/update their own profile
-- ────────────────────────────────────────────
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_profile" ON user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "users_update_own_profile" ON user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
