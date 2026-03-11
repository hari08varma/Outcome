// Full audit: check all migrations and edge function tables against live Supabase
const { Client } = require('pg');
const { config } = require('dotenv');
const { resolve } = require('path');

config({ path: resolve(__dirname, '..', 'api', '.env') });

const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
});

(async () => {
    await client.connect();
    console.log('Connected to live Supabase.\n');

    // ── 1. Check all tables ──────────────────────────────────
    console.log('═══ TABLES ═══');
    const tables = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `);
    const tableNames = tables.rows.map(r => r.table_name);
    console.log('Found tables:', tableNames);

    const expectedTables = [
        'dim_customers', 'dim_agents', 'dim_actions', 'dim_contexts',           // 001
        'fact_outcomes',                                                          // 002
        'fact_episodes', 'fact_outcomes_archive', 'dim_institutional_knowledge', // 003
        'agent_trust_scores', 'agent_trust_audit',                               // 007
        'degradation_alert_events', 'trend_change_events',                       // 008
    ];

    for (const t of expectedTables) {
        const found = tableNames.includes(t);
        console.log(`  ${found ? '✅' : '❌'} ${t}`);
    }

    // ── 2. Check materialized views ──────────────────────────
    console.log('\n═══ MATERIALIZED VIEWS ═══');
    const matviews = await client.query(`
        SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname
    `);
    const mvNames = matviews.rows.map(r => r.matviewname);
    console.log('Found views:', mvNames);

    const expectedMVs = ['mv_action_scores', 'mv_episode_patterns'];
    for (const mv of expectedMVs) {
        const found = mvNames.includes(mv);
        console.log(`  ${found ? '✅' : '❌'} ${mv}`);
    }

    // ── 3. Check indexes (from 005 + 009) ────────────────────
    console.log('\n═══ KEY INDEXES ═══');
    const indexes = await client.query(`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname
    `);
    const idxNames = indexes.rows.map(r => r.indexname);

    const expectedIndexes = [
        'idx_outcomes_agent_action',
        'idx_outcomes_context_success',
        'idx_outcomes_customer_timestamp',
        'idx_outcomes_session',
        'idx_outcomes_salience',
        'idx_trust_scores_agent',
        'idx_trust_scores_status',
        'idx_trust_audit_agent',
        'mv_action_scores_unique',
        'mv_episode_patterns_unique',
    ];
    for (const idx of expectedIndexes) {
        const found = idxNames.includes(idx);
        console.log(`  ${found ? '✅' : '❌'} ${idx}`);
    }

    // ── 4. Check RLS policies (from 006 + 007) ──────────────
    console.log('\n═══ RLS POLICIES ═══');
    const rls = await client.query(`
        SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname
    `);
    console.log(`Found ${rls.rows.length} RLS policies:`);
    for (const r of rls.rows) {
        console.log(`  ✅ ${r.tablename}: ${r.policyname}`);
    }

    // ── 5. Check functions/triggers (007 + 010) ──────────────
    console.log('\n═══ FUNCTIONS & TRIGGERS ═══');
    const funcs = await client.query(`
        SELECT routine_name FROM information_schema.routines 
        WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
        ORDER BY routine_name
    `);
    const funcNames = funcs.rows.map(r => r.routine_name);
    console.log('Found functions:', funcNames);

    const expectedFuncs = [
        'prevent_outcome_update',       // 002
        'fn_init_agent_trust',          // 007
        'refresh_mv_action_scores',     // 010
        'refresh_mv_episode_patterns',  // 010
    ];
    for (const fn of expectedFuncs) {
        const found = funcNames.includes(fn);
        console.log(`  ${found ? '✅' : '❌'} ${fn}`);
    }

    // ── 6. Check triggers ────────────────────────────────────
    console.log('\n═══ TRIGGERS ═══');
    const triggers = await client.query(`
        SELECT trigger_name, event_object_table FROM information_schema.triggers 
        WHERE trigger_schema = 'public' ORDER BY trigger_name
    `);
    for (const t of triggers.rows) {
        console.log(`  ✅ ${t.event_object_table}: ${t.trigger_name}`);
    }

    // ── 7. Check seed data ───────────────────────────────────
    console.log('\n═══ SEED DATA ═══');
    const customers = await client.query('SELECT count(*) as cnt FROM dim_customers');
    const agents = await client.query('SELECT count(*) as cnt FROM dim_agents');
    const actions = await client.query('SELECT count(*) as cnt FROM dim_actions');
    const contexts = await client.query('SELECT count(*) as cnt FROM dim_contexts');
    const knowledge = await client.query('SELECT count(*) as cnt FROM dim_institutional_knowledge');
    const trust = await client.query('SELECT count(*) as cnt FROM agent_trust_scores');
    console.log(`  dim_customers: ${customers.rows[0].cnt}`);
    console.log(`  dim_agents: ${agents.rows[0].cnt}`);
    console.log(`  dim_actions: ${actions.rows[0].cnt}`);
    console.log(`  dim_contexts: ${contexts.rows[0].cnt}`);
    console.log(`  dim_institutional_knowledge: ${knowledge.rows[0].cnt}`);
    console.log(`  agent_trust_scores: ${trust.rows[0].cnt}`);

    console.log('\n═══ AUDIT COMPLETE ═══');
    await client.end();
})().catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
