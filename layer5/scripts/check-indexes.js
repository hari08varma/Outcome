// Quick check: list ALL indexes on live Supabase
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

    const res = await client.query(`
        SELECT tablename, indexname 
        FROM pg_indexes 
        WHERE schemaname = 'public' 
        ORDER BY tablename, indexname
    `);

    console.log(`Found ${res.rows.length} indexes:\n`);
    let currentTable = '';
    for (const r of res.rows) {
        if (r.tablename !== currentTable) {
            currentTable = r.tablename;
            console.log(`\n  ${currentTable}:`);
        }
        console.log(`    - ${r.indexname}`);
    }

    // Check specific expected indexes from 005 and 009
    const indexNames = res.rows.map(r => r.indexname);
    console.log('\n\n═══ EXPECTED INDEX CHECK ═══');
    const expected = [
        // 005
        'idx_outcomes_agent_context_ts',
        'idx_outcomes_action_context',
        'idx_outcomes_session',
        'idx_outcomes_timestamp',
        'idx_outcomes_customer_ts',
        'idx_outcomes_synthetic',
        'idx_actions_name',
        'idx_contexts_issue_type',
        'idx_episodes_agent_context',
        'idx_episodes_customer',
        'idx_episodes_started_at',
        'idx_archive_customer_period',
        'idx_archive_action_context',
        'idx_institutional_context_type',
        'idx_institutional_action',
        // 007
        'idx_trust_scores_agent',
        'idx_trust_scores_status',
        'idx_trust_audit_agent',
        'idx_trust_audit_customer',
        'idx_trust_audit_event_type',
        'idx_trust_audit_performed_at',
        // 009
        'ux_action_scores_composite',
        'ux_episode_patterns_composite',
    ];

    for (const idx of expected) {
        const found = indexNames.includes(idx);
        console.log(`  ${found ? '✅' : '❌'} ${idx}`);
    }

    await client.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
