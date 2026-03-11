require('dotenv').config({ path: require('path').join(__dirname, '..', 'api', '.env') });
const { Client } = require('pg');
async function run() {
    const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const { rows } = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE '%trust%' OR table_name LIKE '%agent_trust%')");
    console.log('Trust tables:', rows.length > 0 ? rows.map(r => r.table_name) : 'NONE FOUND');
    await c.end();
}
run().catch(e => console.error(e.message));
