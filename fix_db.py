"""
Run DB fixes for migration 063.
Usage:
    set SUPABASE_URL=https://xxxx.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=eyJ...
    set SUPABASE_ACCESS_TOKEN=sbp_...
    python fix_db.py
"""

import os, re, sys
import httpx

# ── Read env vars ─────────────────────────────────────────────
SUPABASE_URL          = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY      = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
ACCESS_TOKEN          = os.environ.get("SUPABASE_ACCESS_TOKEN", "")

if not SUPABASE_URL or not ACCESS_TOKEN:
    print("ERROR: Set SUPABASE_URL and SUPABASE_ACCESS_TOKEN env vars first.")
    sys.exit(1)

# Extract project ref from URL (https://<ref>.supabase.co)
match = re.search(r"https://([^.]+)\.supabase\.co", SUPABASE_URL)
if not match:
    print(f"ERROR: Could not extract project ref from SUPABASE_URL: {SUPABASE_URL}")
    sys.exit(1)
PROJECT_REF = match.group(1)

MGMT_URL = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query"
HEADERS  = {
    "Authorization": f"Bearer {ACCESS_TOKEN}",
    "Content-Type":  "application/json",
}

def run_sql(label: str, sql: str) -> None:
    print(f"\n── {label} ──")
    resp = httpx.post(MGMT_URL, headers=HEADERS, json={"query": sql}, timeout=30)
    if resp.status_code == 200:
        data = resp.json()
        print(f"OK — {data}")
    else:
        print(f"FAILED [{resp.status_code}]: {resp.text}")
        sys.exit(1)

# ── Fix A: event_type check constraint ────────────────────────
run_sql(
    "Drop old event_type constraint",
    "ALTER TABLE agent_trust_audit DROP CONSTRAINT IF EXISTS agent_trust_audit_event_type_check;"
)

run_sql(
    "Recreate constraint with all existing + new values",
    """
DO $$
DECLARE
    all_values text;
BEGIN
    SELECT string_agg(DISTINCT quote_literal(v), ', ')
    INTO all_values
    FROM (
        SELECT event_type AS v FROM agent_trust_audit WHERE event_type IS NOT NULL
        UNION
        SELECT unnest(ARRAY[
            'success', 'failure', 'failure_excluded_infrastructure',
            'manual_override', 'status_change'
        ])
    ) t;
    EXECUTE
        'ALTER TABLE agent_trust_audit '
        'ADD CONSTRAINT agent_trust_audit_event_type_check '
        'CHECK (event_type IN (' || all_values || '))';
    RAISE NOTICE 'Constraint recreated with: %', all_values;
END $$;
"""
)

# ── Fix B: drop episode_id FK on action_sequences ─────────────
run_sql(
    "Drop action_sequences episode_id FK",
    "ALTER TABLE action_sequences DROP CONSTRAINT IF EXISTS action_sequences_episode_id_fkey;"
)

# ── Verify ─────────────────────────────────────────────────────
run_sql(
    "Verify event_type constraint",
    """
SELECT pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conname = 'agent_trust_audit_event_type_check';
"""
)

run_sql(
    "Verify FK is gone",
    """
SELECT COUNT(*) AS fk_still_exists
FROM pg_constraint
WHERE conname = 'action_sequences_episode_id_fkey';
"""
)

print("\n✅ All DB fixes applied.")
