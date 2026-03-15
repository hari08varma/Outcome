-- ============================================================
-- LAYERINFINITE — Migration 036: Backfill Missing User Profiles
-- ============================================================
-- Idempotent backfill for all auth.users rows that have no
-- matching row in user_profiles.
--
-- Dynamically detects whether user_profiles uses 'display_name'
-- or 'full_name', and whether dim_customers has 'is_active'.
-- Uses EXECUTE format() for the profile INSERT.
--
-- Safe to run multiple times — ON CONFLICT DO NOTHING everywhere.
-- ============================================================

DO $$
DECLARE
  u                  RECORD;
  new_cust_id        UUID;
  display_name       TEXT;
  profile_col        TEXT;
  has_is_active      BOOLEAN;
  provisioned_count  INTEGER := 0;
  skipped_count      INTEGER := 0;
BEGIN
  -- ── Detect schema once, before the loop ──────────────────
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'user_profiles'
        AND column_name  = 'display_name'
    ) THEN 'display_name'
    ELSE 'full_name'
  END INTO profile_col;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'dim_customers'
      AND column_name  = 'is_active'
  ) INTO has_is_active;

  RAISE NOTICE 'Backfill: detected profile name column = %, dim_customers.is_active = %',
    profile_col, has_is_active;

  -- ── Loop over users missing a profile ────────────────────
  FOR u IN
    SELECT au.id, au.email, au.raw_user_meta_data
    FROM auth.users au
    WHERE NOT EXISTS (
      SELECT 1 FROM public.user_profiles up WHERE up.id = au.id
    )
  LOOP
    display_name := COALESCE(
      NULLIF(TRIM(u.raw_user_meta_data->>'full_name'), ''),
      split_part(u.email, '@', 1)
    );

    BEGIN
      -- 1. Create dim_customers row
      IF has_is_active THEN
        INSERT INTO public.dim_customers (
          company_name, tier, is_active, api_key_hash, created_at
        ) VALUES (
          COALESCE(NULLIF(TRIM(u.raw_user_meta_data->>'company_name'), ''), u.email),
          'starter', true, encode(gen_random_bytes(32), 'hex'), NOW()
        )
        RETURNING customer_id INTO new_cust_id;
      ELSE
        INSERT INTO public.dim_customers (
          company_name, tier, api_key_hash, created_at
        ) VALUES (
          COALESCE(NULLIF(TRIM(u.raw_user_meta_data->>'company_name'), ''), u.email),
          'starter', encode(gen_random_bytes(32), 'hex'), NOW()
        )
        RETURNING customer_id INTO new_cust_id;
      END IF;

      IF new_cust_id IS NULL THEN
        RAISE WARNING 'Backfill: dim_customers INSERT returned NULL for user %, skipping.', u.id;
        skipped_count := skipped_count + 1;
        CONTINUE;
      END IF;

      -- 2. Create user_profiles row (dynamic column name)
      EXECUTE format(
        'INSERT INTO public.user_profiles (id, customer_id, %I, role, created_at) '
        'VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (id) DO NOTHING',
        profile_col
      ) USING u.id, new_cust_id, display_name, 'admin';

      -- 3. Create default dim_agents row
      INSERT INTO public.dim_agents (
        agent_name, agent_type, customer_id, is_active, created_at
      ) VALUES (
        'default-agent', 'api-key', new_cust_id, true, NOW()
      )
      ON CONFLICT DO NOTHING;

      provisioned_count := provisioned_count + 1;
      RAISE NOTICE 'Backfill: provisioned profile for user % (%)', u.id, u.email;

    EXCEPTION WHEN OTHERS THEN
      skipped_count := skipped_count + 1;
      RAISE WARNING 'Backfill: failed for user % (%): % [SQLSTATE %]',
        u.id, u.email, SQLERRM, SQLSTATE;
      CONTINUE;
    END;
  END LOOP;

  RAISE NOTICE 'Backfill complete: % provisioned, % skipped', provisioned_count, skipped_count;
END $$;
