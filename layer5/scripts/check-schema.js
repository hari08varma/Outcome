require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const client = new Client({ connectionString: process.env.DB_URL });

async function run() {
    await client.connect();

    // Run a migration file passed as CLI arg
    const migrationFile = process.argv[2];
    if (migrationFile) {
        const sql = fs.readFileSync(path.resolve(migrationFile), 'utf8');
        console.log(`Running migration: ${migrationFile}`);
        try {
            await client.query(sql);
            console.log('SUCCESS');
        } catch (err) {
            console.error('FAILED:', err.message);
        }
    } else {
        // Default: check schema
        const res3 = await client.query(
            `SELECT attname FROM pg_attribute WHERE attrelid = 'mv_action_scores'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`
        );
        console.log('=== mv_action_scores columns ===');
        console.log(res3.rows.map(r => r.attname).join(', '));
    }

    await client.end();
}
run();
