/**
 * Layer5 — Verify all migrations are deployed to live Supabase
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', 'api', '.env') });
const { Client } = require('pg');

async function run() {
    const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const { rows: ver } = await c.query('SELECT version()');
    console.log('Connected:', ver[0].version.split(' ').slice(0, 2).join(' '));

    console.log('\n=== TABLES ===');
    const { rows: tables } = await c.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    tables.forEach(r => console.log('  ', r.table_name));

    console.log('\n=== MATERIALIZED VIEWS ===');
    const { rows: mvs } = await c.query(
        "SELECT matviewname FROM pg_matviews WHERE schemaname='public'"
    );
    mvs.forEach(r => console.log('  ', r.matviewname));

    console.log('\n=== UNIQUE INDEXES ON MATVIEWS ===');
    const { rows: ux } = await c.query(
        "SELECT indexname, tablename FROM pg_indexes WHERE tablename LIKE 'mv_%'"
    );
    ux.forEach(r => console.log('  ', r.indexname, 'ON', r.tablename));

    console.log('\n=== RPC FUNCTIONS ===');
    const { rows: fns } = await c.query(
        "SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' AND routine_type='FUNCTION' ORDER BY routine_name"
    );
    fns.forEach(r => console.log('  ', r.routine_name));

    console.log('\n=== TRIGGERS ===');
    const { rows: trigs } = await c.query(
        "SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema='public'"
    );
    trigs.forEach(r => console.log('  ', r.trigger_name, 'ON', r.event_object_table));

    console.log('\n=== RLS STATUS ===');
    const { rows: rls } = await c.query(
        "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    rls.forEach(r => console.log('  ', r.tablename, r.rowsecurity ? 'RLS ON' : 'RLS OFF'));

    console.log('\n=== SEED DATA COUNTS ===');
    try {
        const { rows: counts } = await c.query(`SELECT
            (SELECT COUNT(*) FROM dim_customers) AS customers,
            (SELECT COUNT(*) FROM dim_actions) AS actions,
            (SELECT COUNT(*) FROM dim_contexts) AS contexts,
            (SELECT COUNT(*) FROM dim_agents) AS agents,
            (SELECT COUNT(*) FROM dim_institutional_knowledge) AS knowledge
        `);
        const d = counts[0];
        console.log('  customers:', d.customers, 'actions:', d.actions, 'contexts:', d.contexts, 'agents:', d.agents, 'knowledge:', d.knowledge);
    } catch (e) {
        console.error('  count error:', e.message);
    }

    // Check expected tables
    const expected = [
        'dim_customers', 'dim_agents', 'dim_actions', 'dim_contexts',
        'fact_outcomes', 'fact_episodes', 'fact_outcomes_archive',
        'dim_institutional_knowledge',
        'degradation_alert_events', 'trend_change_events'
    ];
    const tableNames = tables.map(r => r.table_name);
    console.log('\n=== MIGRATION CHECK ===');
    for (const t of expected) {
        const exists = tableNames.includes(t);
        console.log('  ', exists ? 'OK' : 'MISSING', t);
    }

    const mvNames = mvs.map(r => r.matviewname);
    for (const mv of ['mv_action_scores', 'mv_episode_patterns']) {
        console.log('  ', mvNames.includes(mv) ? 'OK' : 'MISSING', mv);
    }

    const fnNames = fns.map(r => r.routine_name);
    for (const fn of ['refresh_mv_action_scores', 'refresh_mv_episode_patterns', 'prevent_outcome_update']) {
        console.log('  ', fnNames.includes(fn) ? 'OK' : 'MISSING', fn);
    }

    await c.end();
}

run().catch(e => console.error('Fatal:', e.message));
