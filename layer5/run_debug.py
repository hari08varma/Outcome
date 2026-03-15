"""Fast targeted checks — each query is independent and runs quickly."""
import httpx

PAT = "sbp_e0ca037f0444e4c3d1626541a2e731572c8e0e08"
REF = "fakomwsewdxazaqawjuv"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
HDR = {"Content-Type": "application/json", "Authorization": f"Bearer {PAT}"}

def q(label, sql):
    r = httpx.post(API, headers=HDR, json={"query": sql}, timeout=20)
    out = r.text[:1500]
    status = "✅" if r.status_code in (200, 201) else "❌"
    print(f"\n{status} {label} ({r.status_code})\n{out}")
    return r.status_code in (200, 201), out

# 1. dim_customers NOT NULL constraints (most likely trigger failure cause)
q("dim_customers NOT NULL cols", """
SELECT column_name, is_nullable, data_type, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dim_customers'
ORDER BY ordinal_position;
""")

# 2. user_profiles NOT NULL constraints
q("user_profiles cols", """
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='user_profiles'
ORDER BY ordinal_position;
""")

# 3. dim_agents NOT NULL constraints
q("dim_agents NOT NULL cols", """
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='dim_agents'
    AND is_nullable='NO'
ORDER BY ordinal_position;
""")

# 4. Check live trigger function body (first 3000 chars)
q("Live trigger function", """
SELECT substring(pg_get_functiondef(p.oid), 1, 3000) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname='handle_new_user' AND n.nspname='public';
""")

# 5. Check if trigger is attached
q("Trigger attached?", """
SELECT trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE event_object_schema='auth' AND event_object_table='users';
""")
