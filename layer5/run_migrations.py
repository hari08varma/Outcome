import httpx

PAT = "sbp_e0ca037f0444e4c3d1626541a2e731572c8e0e08"
REF = "fakomwsewdxazaqawjuv"
API = f"https://api.supabase.com/v1/projects/{REF}/database/query"
HDR = {"Content-Type": "application/json", "Authorization": f"Bearer {PAT}"}

def q(label, sql):
    r = httpx.post(API, headers=HDR, json={"query": sql}, timeout=30)
    s = "OK" if r.status_code in (200,201) else "FAIL"
    print(f"{s} [{r.status_code}] {label}")
    if r.text.strip() and r.text.strip() != '[]':
        print(f"  {r.text[:500]}")
    return r.status_code in (200,201)

with open("supabase/migrations/013_create_auth_system.sql","r") as f: sql1=f.read()
with open("supabase/migrations/036_backfill_missing_profiles.sql","r") as f: sql2=f.read()

ok1 = q("Deploy 013 (trigger)", sql1)
ok2 = q("Deploy 036 (backfill)", sql2) if ok1 else False
print(f"\n013={'OK' if ok1 else 'FAIL'} | 036={'OK' if ok2 else 'FAIL'}")
