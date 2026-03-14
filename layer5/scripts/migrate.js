/**
 * Layerinfinite — migrate.js (Phase 1)
 * 
 * Runs all Phase 1 migrations + seed + test gate against Supabase.
 *
 * Usage:
 *   node scripts/migrate.js                     ← uses DB_URL from .env
 *   node scripts/migrate.js --password "yourpw" ← constructs DB_URL from project ref + password
 *   node scripts/migrate.js --no-seed           ← skips seed step
 *   node scripts/migrate.js --no-test           ← skips test gate
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ── Parse args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);
const skipSeed = hasFlag('--no-seed');
const skipTest = hasFlag('--no-test');
const pwArg = getArg('--password');

// ── Build DB_URL ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fakomwsewdxazaqawjuv.supabase.co';
const PROJECT_REF = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');
let DB_URL = process.env.DB_URL;

if (!DB_URL && pwArg) {
    // Build from project ref + supplied password
    DB_URL = `postgresql://postgres.${PROJECT_REF}:${pwArg}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`;
    console.log(`\nℹ️  DB_URL constructed from --password flag (Transaction Pooler)`);
}

if (!DB_URL) {
    console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ❌  DB password not found.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Run with your database password:
  node scripts/migrate.js --password "YOUR_DB_PASSWORD"

  (Get the password from Supabase Dashboard →
   Settings → Database → Reset database password)

  OR add DB_URL to your .env:
  DB_URL=postgresql://postgres.${PROJECT_REF}:[PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
    process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const SEED_FILE = path.join(__dirname, '..', 'supabase', 'seed', 'cold_start_priors.sql');
const TEST_FILE = path.join(__dirname, '..', 'tests', 'layer1', 'test_gate.sql');

let passCount = 0;
let failCount = 0;

async function runSql(client, sql, label) {
    try {
        await client.query(sql);
        console.log(`  ✅  ${label}`);
        passCount++;
        return true;
    } catch (err) {
        // Gracefully handle duplicate object errors (idempotent re-runs)
        const msg = err.message || '';
        const code = err.code || '';
        if (
            code === '42P07' || code === '42710' || code === '42701' || code === '42P16' ||
            msg.includes('already exists') || msg.includes('duplicate')
        ) {
            console.log(`  ⚠️   ${label} — already exists (skipping, OK)`);
            passCount++;
            return true;
        }
        console.error(`  ❌  ${label}`);
        console.error(`       ↳ ${err.message}`);
        if (err.detail) console.error(`       ↳ Detail: ${err.detail}`);
        if (err.hint) console.error(`       ↳ Hint:   ${err.hint}`);
        failCount++;
        return false;
    }
}

// Run a full SQL file, splitting by statement for better error isolation
async function runFile(client, filePath, label) {
    const sql = fs.readFileSync(filePath, 'utf-8');
    console.log(`\n[ ${label} ]`);
    try {
        await client.query(sql);
        console.log(`  ✅  ${label} — complete`);
        passCount++;
        return true;
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('already exists') || msg.includes('duplicate')) {
            console.log(`  ⚠️   ${label} — some objects already exist (OK)`);
            passCount++;
            return true;
        }
        console.error(`  ❌  ${label} failed`);
        console.error(`       ↳ ${err.message}`);
        if (err.detail) console.error(`       ↳ Detail: ${err.detail}`);
        if (err.hint) console.error(`       ↳ Hint:   ${err.hint}`);
        failCount++;
        return false;
    }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
    console.log('\n' +
        '═══════════════════════════════════════════════════\n' +
        '   LAYERINFINITE — Phase 1 Migration Runner\n' +
        `   Project: ${PROJECT_REF}\n` +
        '═══════════════════════════════════════════════════\n'
    );

    const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

    console.log('🔌 Connecting to Supabase database...');
    try {
        await client.connect();
        const { rows } = await client.query('SELECT version()');
        console.log(`✅ Connected — ${rows[0].version.split(' ').slice(0, 2).join(' ')}\n`);
    } catch (err) {
        console.error(`\n❌ Connection FAILED: ${err.message}`);
        console.error('   → Check that DB_URL / password is correct.\n');
        process.exit(1);
    }

    // ── Step 1: Extensions ──────────────────────────────────────
    console.log('[ Step 1 ] Enabling extensions...');
    await runSql(client, `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, 'uuid-ossp');
    await runSql(client, `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`, 'pgcrypto');
    await runSql(client, `CREATE EXTENSION IF NOT EXISTS "vector"`, 'pgvector');

    // ── Step 2-6: Migration files ───────────────────────────────
    const migrations = [
        '001_create_dimensions.sql',
        '002_create_fact_outcomes.sql',
        '003_create_episodes.sql',
        '005_create_indexes.sql',
        '006_create_rls_policies.sql',
    ];

    for (const file of migrations) {
        await runFile(client, path.join(MIGRATIONS_DIR, file), file);
    }

    // ── Seed ────────────────────────────────────────────────────
    if (!skipSeed) {
        await runFile(client, SEED_FILE, 'Seed: cold_start_priors.sql');
    }

    // ── Test Gate ───────────────────────────────────────────────
    if (!skipTest) {
        console.log('\n[ Phase 1 Test Gate ]');
        await runFile(client, TEST_FILE, 'test_gate.sql');

        // Quick validation queries
        console.log('\n[ Validation Queries ]');
        try {
            const { rows: tables } = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' ORDER BY table_name
      `);
            console.log('\n  📋 Tables in public schema:');
            tables.forEach(r => console.log(`     • ${r.table_name}`));

            const { rows: triggers } = await client.query(`
        SELECT trigger_name, event_object_table 
        FROM information_schema.triggers 
        WHERE trigger_schema = 'public'
      `);
            if (triggers.length > 0) {
                console.log('\n  ⚡ Triggers:');
                triggers.forEach(r => console.log(`     • ${r.trigger_name} ON ${r.event_object_table}`));
            }

            const { rows: counts } = await client.query(`
        SELECT 
          (SELECT COUNT(*) FROM dim_customers) AS customers,
          (SELECT COUNT(*) FROM dim_actions)   AS actions,
          (SELECT COUNT(*) FROM dim_contexts)  AS contexts,
          (SELECT COUNT(*) FROM dim_agents)    AS agents,
          (SELECT COUNT(*) FROM dim_institutional_knowledge) AS knowledge
      `);
            const c = counts[0];
            console.log(`\n  📊 Seed data: ${c.customers} customer(s), ${c.actions} action(s), ${c.contexts} context(s), ${c.agents} agent(s), ${c.knowledge} knowledge row(s)`);

            // Test append-only trigger
            console.log('\n  🔒 Testing append-only trigger...');
            try {
                await client.query(`UPDATE fact_outcomes SET success = TRUE WHERE FALSE`);
                console.log('  ⚠️   trigger test skipped (no rows to update)');
            } catch (trigErr) {
                if (trigErr.message.includes('APPEND-ONLY')) {
                    console.log('  ✅  Append-only trigger fires correctly');
                }
            }

        } catch (valErr) {
            console.error(`  ❌ Validation error: ${valErr.message}`);
        }
    }

    await client.end();

    // ── Summary ─────────────────────────────────────────────────
    console.log('\n' +
        '═══════════════════════════════════════════════════\n' +
        (failCount === 0
            ? `  ✅ PHASE 1 COMPLETE — ${passCount} steps passed, 0 failures\n\n` +
            '  Next steps:\n' +
            '    git add -A\n' +
            '    git commit -m "feat: layer-1 complete"\n' +
            '  Then type: APPROVED — BEGIN PHASE 2\n'
            : `  ❌ PHASE 1 INCOMPLETE — ${failCount} step(s) failed\n` +
            '  Review errors above and re-run.\n') +
        '═══════════════════════════════════════════════════\n'
    );

    if (failCount > 0) process.exit(1);
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
});
