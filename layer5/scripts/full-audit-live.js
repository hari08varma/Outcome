const pg = require('pg');
require('dotenv').config({ path: 'api/.env' });

const c = new pg.Client({ connectionString: process.env.DB_URL });

async function main() {
  await c.connect();

  // 1) Tables
  const tables = await c.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
  );
  console.log('=== TABLES ===');
  tables.rows.forEach(r => console.log('  ' + r.tablename));

  // 2) Materialized views
  const mv = await c.query(
    "SELECT matviewname FROM pg_matviews WHERE schemaname='public' ORDER BY matviewname"
  );
  console.log('=== MATERIALIZED VIEWS ===');
  mv.rows.forEach(r => console.log('  ' + r.matviewname));

  // 3) Functions
  const fns = await c.query(
    "SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' ORDER BY routine_name"
  );
  console.log('=== FUNCTIONS ===');
  fns.rows.forEach(r => console.log('  ' + r.routine_name));

  // 4) Triggers
  const trigs = await c.query(
    "SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY trigger_name"
  );
  console.log('=== TRIGGERS ===');
  trigs.rows.forEach(r => console.log('  ' + r.trigger_name + ' ON ' + r.event_object_table));

  // 5) Indexes
  const idxs = await c.query(
    "SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' ORDER BY indexname"
  );
  console.log('=== INDEXES ===');
  idxs.rows.forEach(r => console.log('  ' + r.indexname + ' ON ' + r.tablename));

  // 6) RLS policies
  const rls = await c.query(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' ORDER BY tablename, policyname"
  );
  console.log('=== RLS POLICIES ===');
  rls.rows.forEach(r => console.log('  ' + r.policyname + ' ON ' + r.tablename));

  // 7) Seed data counts
  const counts = {};
  for (const t of ['dim_customers','dim_agents','dim_actions','dim_contexts','dim_institutional_knowledge','agent_trust_scores']) {
    const res = await c.query('SELECT count(*)::int as cnt FROM ' + t);
    counts[t] = res.rows[0].cnt;
  }
  console.log('=== SEED DATA ===');
  for (const [k,v] of Object.entries(counts)) {
    console.log('  ' + k + ': ' + v);
  }

  await c.end();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
