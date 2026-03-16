"""
Run all SQL test cases against live Supabase to verify auth provisioning fixes.
"""

import httpx
import json

SUPABASE_PAT = "sbp_e0ca037f0444e4c3d1626541a2e731572c8e0e08"
PROJECT_REF = "fakomwsewdxazaqawjuv"

def run_sql(label: str, sql: str) -> tuple[bool, str]:
    print(f"\n{'='*62}")
    print(f"  {label}")
    print('='*62)

    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
    resp = httpx.post(
        url,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SUPABASE_PAT}",
        },
        json={"query": sql},
        timeout=60,
    )

    if resp.status_code in (200, 201):
        text = resp.text[:2000]
        print(f"✅ SUCCESS ({resp.status_code})")
        if text.strip() and text.strip() != '[]':
            print(f"   Response: {text}")
        return True, text
    else:
        print(f"❌ FAILED ({resp.status_code})")
        print(f"   {resp.text[:2000]}")
        return False, resp.text


# ──────────────────────────────────────────────────────────────
# TEST 1: New signup trigger fires correctly
# ──────────────────────────────────────────────────────────────
test1_sql = """
DO $$
DECLARE
  test_id UUID := gen_random_uuid();
  profile_row RECORD;
  customer_row RECORD;
  agent_row RECORD;
BEGIN
  -- Simulate signup
  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password,
    raw_user_meta_data, aud, role,
    email_confirmed_at, created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    test_id,
    'test_trigger_' || test_id::text || '@example.com',
    crypt('testpass123', gen_salt('bf')),
    '{"full_name": "Test Trigger User"}'::jsonb,
    'authenticated',
    'authenticated',
    NOW(), NOW(), NOW()
  );

  -- Verify user_profiles created
  SELECT * INTO profile_row FROM user_profiles WHERE id = test_id;
  IF profile_row IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: user_profiles row NOT created for %', test_id;
  END IF;

  -- Verify dim_customers created
  SELECT * INTO customer_row FROM dim_customers WHERE customer_id = profile_row.customer_id;
  IF customer_row IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: dim_customers row NOT created';
  END IF;

  -- Verify dim_agents default row created
  SELECT * INTO agent_row FROM dim_agents
  WHERE customer_id = profile_row.customer_id AND agent_name = 'default-agent';
  IF agent_row IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAIL: dim_agents default row NOT created';
  END IF;

  -- Cleanup
  DELETE FROM dim_agents WHERE customer_id = profile_row.customer_id;
  DELETE FROM user_profiles WHERE id = test_id;
  DELETE FROM dim_customers WHERE customer_id = profile_row.customer_id;
  DELETE FROM auth.users WHERE id = test_id;

  RAISE NOTICE 'TEST 1 PASSED: trigger created user_profiles + dim_customers + dim_agents';
END $$;
"""

# ──────────────────────────────────────────────────────────────
# TEST 2: Backfill is idempotent (run 036 twice, check no dupes)
# ──────────────────────────────────────────────────────────────
test2_check_sql = """
SELECT up.id, COUNT(*) as profile_count
FROM user_profiles up
GROUP BY up.id
HAVING COUNT(*) > 1;
"""

# ──────────────────────────────────────────────────────────────
# TEST 3: Trigger never blocks signup (simulate failure)
# ──────────────────────────────────────────────────────────────
test3_sql = """
DO $$
DECLARE
  test_id UUID := gen_random_uuid();
  user_exists BOOLEAN;
  profile_row RECORD;
BEGIN
  -- Insert a user — the trigger should fire and either succeed or fail gracefully
  INSERT INTO auth.users (
    instance_id, id, email, encrypted_password,
    raw_user_meta_data, aud, role,
    email_confirmed_at, created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    test_id,
    'test_resilience_' || test_id::text || '@example.com',
    crypt('testpass123', gen_salt('bf')),
    '{}'::jsonb,
    'authenticated',
    'authenticated',
    NOW(), NOW(), NOW()
  );

  -- Verify signup succeeded
  SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = test_id) INTO user_exists;
  IF NOT user_exists THEN
    RAISE EXCEPTION 'TEST 3 FAIL: signup was blocked';
  END IF;

  -- Cleanup (profile may or may not exist depending on trigger success)
  SELECT * INTO profile_row FROM user_profiles WHERE id = test_id;
  IF profile_row IS NOT NULL THEN
    DELETE FROM dim_agents WHERE customer_id = profile_row.customer_id;
    DELETE FROM user_profiles WHERE id = test_id;
    DELETE FROM dim_customers WHERE customer_id = profile_row.customer_id;
  END IF;
  DELETE FROM auth.users WHERE id = test_id;

  RAISE NOTICE 'TEST 3 PASSED: signup succeeded and trigger did not block';
END $$;
"""

# ──────────────────────────────────────────────────────────────
# TEST 6: Column detection — verify which column exists
# ──────────────────────────────────────────────────────────────
test6_sql = """
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'user_profiles'
  AND column_name IN ('display_name', 'full_name');
"""

# ──────────────────────────────────────────────────────────────
# Run the backfill again to verify idempotency
# ──────────────────────────────────────────────────────────────
with open("supabase/migrations/036_backfill_missing_profiles.sql", "r", encoding="utf-8") as f:
    backfill_sql = f.read()

# ── Execute all tests ────────────────────────────────────────

results = {}

ok, _ = run_sql("TEST 1: New signup trigger fires correctly", test1_sql)
results['T1'] = ok

# Run backfill twice for idempotency test
run_sql("TEST 2a: Run backfill (first pass)", backfill_sql)
run_sql("TEST 2b: Run backfill (second pass — idempotency)", backfill_sql)
ok, resp = run_sql("TEST 2c: Check for duplicate profiles", test2_check_sql)
has_dupes = resp.strip() != '[]' and resp.strip() != ''
results['T2'] = ok and not has_dupes
if has_dupes:
    print("   ❌ DUPLICATES FOUND!")
else:
    print("   ✅ No duplicate profiles — idempotent")

ok, _ = run_sql("TEST 3: Trigger never blocks signup", test3_sql)
results['T3'] = ok

ok, resp = run_sql("TEST 6: Column detection", test6_sql)
results['T6'] = ok
print(f"   Live column: {resp.strip()}")

# ── Summary ───────────────────────────────────────────────────
print(f"\n{'='*62}")
print("  TEST SUMMARY")
print('='*62)
for t, passed in results.items():
    print(f"  {t}: {'✅ PASSED' if passed else '❌ FAILED'}")
print('='*62)
