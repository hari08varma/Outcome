-- ============================================================
-- LAYERINFINITE — Migration 036: Backfill Missing User Profiles
-- ============================================================
-- Idempotent backfill for all auth.users rows that have no
-- matching row in user_profiles (e.g. users who signed up
-- before the trigger was working correctly).
--
-- Safe to run multiple times — uses ON CONFLICT DO NOTHING.
-- ============================================================

DO $$
DECLARE
  u             RECORD;
  new_cust_id   UUID;
  display_name  TEXT;
BEGIN
  FOR u IN
    SELECT au.id, au.email, au.raw_user_meta_data
    FROM auth.users au
    WHERE NOT EXISTS (
      SELECT 1 FROM user_profiles up WHERE up.id = au.id
    )
  LOOP
    -- Derive display name: full_name metadata → email prefix
    display_name := COALESCE(
      NULLIF(TRIM(u.raw_user_meta_data->>'full_name'), ''),
      split_part(u.email, '@', 1)
    );

    BEGIN
      -- 1. Create dim_customers row for this user
      INSERT INTO dim_customers (
        company_name,
        tier,
        is_active,
        api_key_hash,
        created_at
      ) VALUES (
        COALESCE(
          NULLIF(TRIM(u.raw_user_meta_data->>'company_name'), ''),
          u.email
        ),
        'starter',
        true,
        encode(gen_random_bytes(32), 'hex'),
        NOW()
      )
      RETURNING customer_id INTO new_cust_id;

      IF new_cust_id IS NULL THEN
        RAISE WARNING 'Backfill: could not create dim_customers for user %, skipping.', u.id;
        CONTINUE;
      END IF;

      -- 2. Create user_profiles row
      INSERT INTO user_profiles (
        id,
        customer_id,
        full_name,
        role,
        created_at
      ) VALUES (
        u.id,
        new_cust_id,
        display_name,
        'admin',
        NOW()
      )
      ON CONFLICT (id) DO NOTHING;

      -- 3. Create default dim_agents row
      INSERT INTO dim_agents (
        agent_name,
        agent_type,
        customer_id,
        is_active,
        created_at
      ) VALUES (
        'default-agent',
        'api-key',
        new_cust_id,
        true,
        NOW()
      )
      ON CONFLICT DO NOTHING;

      RAISE NOTICE 'Backfill: provisioned profile for user % (%)', u.id, u.email;

    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Backfill: failed for user % (%): % — %', u.id, u.email, SQLERRM, SQLSTATE;
      -- Continue to next user rather than aborting the whole backfill
      CONTINUE;
    END;
  END LOOP;

  RAISE NOTICE 'Backfill complete.';
END $$;
