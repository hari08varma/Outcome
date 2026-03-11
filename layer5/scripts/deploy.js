/**
 * Layer5 — deploy.js
 * Generic deployer: runs a specific set of migration files
 * against the live Supabase database.
 *
 * Usage:
 *   node scripts/deploy.js phase1      ← runs 001,002,003,005,006 + seed + test
 *   node scripts/deploy.js phase2      ← runs 004,009,010 + test
 *   node scripts/deploy.js all         ← runs everything
 *   node scripts/deploy.js sql <file>  ← runs a single SQL file
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DB_URL = process.env.DB_URL;
if (!DB_URL) {
    console.error('ERROR: DB_URL not set in .env');
    process.exit(1);
}

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const SEED = path.join(__dirname, '..', 'supabase', 'seed');
const TESTS = path.join(__dirname, '..', 'tests');

const PHASE_MAP = {
    phase1: [
        `${MIGRATIONS}/001_create_dimensions.sql`,
        `${MIGRATIONS}/002_create_fact_outcomes.sql`,
        `${MIGRATIONS}/003_create_episodes.sql`,
        `${MIGRATIONS}/005_create_indexes.sql`,
        `${MIGRATIONS}/006_create_rls_policies.sql`,
        `${SEED}/cold_start_priors.sql`,
        `${TESTS}/layer1/test_gate.sql`,
    ],
    phase2: [
        `${MIGRATIONS}/004_create_materialized_views.sql`,
        `${MIGRATIONS}/009_add_matview_unique_indexes.sql`,
        `${MIGRATIONS}/010_create_helper_functions.sql`,
        `${TESTS}/layer2/test_gate.sql`,
    ],
    all: null,  // filled below
};

// Build 'all' from sorted migrations + seeds + tests
const allMigrations = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    .map(f => `${MIGRATIONS}/${f}`);
PHASE_MAP.all = [...allMigrations, `${SEED}/cold_start_priors.sql`];

let passCount = 0;
let failCount = 0;

async function runSql(client, filePath, label) {
    const sql = fs.readFileSync(filePath, 'utf-8');
    const short = path.basename(filePath);
    try {
        await client.query(sql);
        console.log(`  ✅  ${short}`);
        passCount++;
        return true;
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('already exists') || msg.includes('duplicate')) {
            console.log(`  ⚠️   ${short} — already exists (OK)`);
            passCount++;
            return true;
        }
        console.error(`  ❌  ${short}`);
        console.error(`       ↳ ${err.message}`);
        if (err.detail) console.error(`       ↳ Detail: ${err.detail}`);
        if (err.hint) console.error(`       ↳ Hint:   ${err.hint}`);
        failCount++;
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    const target = args[0] || 'phase2';
    const sqlFile = args[1];

    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  LAYER5 — Deploy: ${target.toUpperCase()}`);
    console.log('═══════════════════════════════════════════════════\n');

    const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

    console.log('🔌 Connecting...');
    await client.connect();
    const { rows } = await client.query('SELECT version()');
    console.log(`✅ Connected — ${rows[0].version.split(' ').slice(0, 2).join(' ')}\n`);

    let files = [];

    if (target === 'sql' && sqlFile) {
        files = [path.resolve(sqlFile)];
    } else if (PHASE_MAP[target]) {
        files = PHASE_MAP[target];
    } else {
        console.error(`Unknown target: ${target}. Use: phase1, phase2, all, sql <file>`);
        process.exit(1);
    }

    console.log(`Running ${files.length} file(s):\n`);
    for (const f of files) {
        await runSql(client, f, path.basename(f));
    }

    await client.end();

    console.log('\n═══════════════════════════════════════════════════');
    if (failCount === 0) {
        console.log(`  ✅ ${target.toUpperCase()} DEPLOYED — ${passCount} steps passed\n`);
        console.log(`  git commit -m "feat: layer-${target.replace('phase', '')}-complete"`);
    } else {
        console.error(`  ❌ ${failCount} step(s) FAILED — see errors above`);
        process.exit(1);
    }
    console.log('═══════════════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
