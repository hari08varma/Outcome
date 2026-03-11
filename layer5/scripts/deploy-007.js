// Deploy 007_create_trust_scores.sql to live Supabase
const { Client } = require('pg');
const { readFileSync } = require('fs');
const { config } = require('dotenv');
const { resolve } = require('path');

config({ path: resolve(__dirname, '..', 'api', '.env') });

const sql = readFileSync(
    resolve(__dirname, '..', 'supabase', 'migrations', '007_create_trust_scores.sql'),
    'utf8'
);

const client = new Client({
    connectionString: process.env.DB_URL,
    ssl: { rejectUnauthorized: false },
});

(async () => {
    await client.connect();
    console.log('Connected. Deploying 007_create_trust_scores.sql...');
    await client.query(sql);
    console.log('Migration 007 deployed successfully.');

    // Verify tables
    const res = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agent_trust_scores','agent_trust_audit') ORDER BY table_name"
    );
    console.log('Verified tables:', res.rows.map(r => r.table_name));

    // Check seeded trust rows
    const trust = await client.query('SELECT count(*) as cnt FROM agent_trust_scores');
    console.log('Trust rows auto-seeded:', trust.rows[0].cnt);

    await client.end();
})().catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
