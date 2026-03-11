/**
 * Test connection to Supabase via Transaction Pooler
 */
const { Client } = require('pg');
require('dotenv').config();

const ref = 'fakomwsewdxazaqawjuv';
const pw = process.env.DB_PASSWORD || '[Harinathvarma2005]';

// Try multiple connection methods
const urls = [
    // Transaction pooler (most accessible)
    `postgresql://postgres.${ref}:${pw}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`,
    // Direct connection
    `postgresql://postgres:${pw}@db.${ref}.supabase.co:5432/postgres`,
    // Session pooler
    `postgresql://postgres.${ref}:${pw}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
];

async function tryUrl(url) {
    const masked = url.replace(/:([^@]+)@/, ':***@');
    console.log(`\n🔌 Trying: ${masked}`);
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
    try {
        await client.connect();
        const { rows } = await client.query('SELECT version()');
        console.log(`✅ SUCCESS: ${rows[0].version.split(' ').slice(0, 2).join(' ')}`);
        await client.end();
        return url;  // return working URL
    } catch (err) {
        console.log(`❌ Failed: ${err.message}`);
        try { await client.end(); } catch { }
        return null;
    }
}

async function main() {
    console.log('Testing Supabase connection methods...');
    for (const url of urls) {
        const result = await tryUrl(url);
        if (result) {
            console.log('\n✅ Working URL found! Add to .env:');
            console.log(`DB_URL=${result.replace(/:([^@]+)@/, ':[PASSWORD]@')}`);
            process.exit(0);
        }
    }
    console.log('\n❌ All connection methods failed.');
    console.log('   The database may be paused or network may be blocking port 5432/6543.');
    process.exit(1);
}

main();
