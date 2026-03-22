-- ============================================================
-- LAYERINFINITE — Migration 059: Backfill Missing User Profiles
-- ============================================================
-- Finds auth.users entries without user_profiles and provisions:
--   1) dim_customers row
--   2) user_profiles row
--   3) dim_agents default row
--
-- Safe to run multiple times. Uses ON CONFLICT DO NOTHING and
-- only iterates users missing user_profiles at query time.
--
-- FIX CHECK-1.10-A: This file was previously mislabeled as
-- "044-backfill-missing-profiles.sql" (dash separator, wrong prefix).
-- The canonical file is now "059_backfill_missing_profiles.sql".
-- If your supabase_migrations table has the old name, run:
--   UPDATE supabase_migrations
--     SET name = '059_backfill_missing_profiles'
--     WHERE name = '044-backfill-missing-profiles';
-- before running supabase db push.
-- ============================================================

DO $$
DECLARE
  u RECORD;
  new_customer_id UUID;
  user_display_name TEXT;
  profile_name_column TEXT;
  customer_has_is_active BOOLEAN;
BEGIN
  SELECT CASE
           WHEN EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'user_profiles'
               AND column_name = 'display_name'
           ) THEN 'display_name'
           ELSE 'full_name'
         END
  INTO profile_name_column;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dim_customers'
      AND column_name = 'is_active'
  ) INTO customer_has_is_active;

  FOR u IN
    SELECT au.id, au.email, au.raw_user_meta_data
    FROM auth.users au
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_profiles up
      WHERE up.id = au.id
    )
  LOOP
    user_display_name := COALESCE(
      NULLIF(TRIM(u.raw_user_meta_data->>'full_name'), ''),
      split_part(u.email, '@', 1)
    );

    BEGIN
      IF customer_has_is_active THEN
        INSERT INTO dim_customers (
          company_name,
          tier,
          is_active,
          api_key_hash,
          created_at
        ) VALUES (
          COALESCE(NULLIF(TRIM(u.raw_user_meta_data->>'company_name'), ''), u.email),
          'starter',
          true,
          encode(gen_random_bytes(32), 'hex'),
          NOW()
        )
        RETURNING customer_id INTO new_customer_id;
      ELSE
        INSERT INTO dim_customers (
          company_name,
          tier,
          api_key_hash,
          created_at
        ) VALUES (
          COALESCE(NULLIF(TRIM(u.raw_user_meta_data->>'company_name'), ''), u.email),
          'starter',
          encode(gen_random_bytes(32), 'hex'),
          NOW()
        )
        RETURNING customer_id INTO new_customer_id;
      END IF;

      IF profile_name_column = 'display_name' THEN
        INSERT INTO user_profiles (
          id,
          customer_id,
          display_name,
          role,
          created_at
        ) VALUES (
          u.id,
          new_customer_id,
          user_display_name,
          'admin',
          NOW()
        )
        ON CONFLICT (id) DO NOTHING;
      ELSE
        INSERT INTO user_profiles (
          id,
          customer_id,
          full_name,
          role,
          created_at
        ) VALUES (
          u.id,
          new_customer_id,
          user_display_name,
          'admin',
          NOW()
        )
        ON CONFLICT (id) DO NOTHING;
      END IF;

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

      RAISE NOTICE 'Backfill: provisioned user % (%).', u.id, u.email;

    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_notify(
        'layer5_account_setup_error',
        json_build_object(
          'user_id', u.id,
          'email', u.email,
          'error', SQLERRM,
          'sqlstate', SQLSTATE,
          'occurred_at', NOW(),
          'source', '059-backfill-missing-profiles'
        )::text
      );

      RAISE WARNING 'Backfill failed for user % (%): % [%]',
        u.id, u.email, SQLERRM, SQLSTATE;

      CONTINUE;
    END;
  END LOOP;
END $$;
