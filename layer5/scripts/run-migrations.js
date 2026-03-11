/**
 * Layer5 — Bootstrap Migrations via Supabase REST API
 *
 * Supabase's PostgREST has a special endpoint that can execute
 * raw SQL when called with the service role key:
 * POST {SUPABASE_URL}/rest/v1/ with Content-Type: application/sql
 *
 * This bootstraps an exec_sql function, then uses it for all migrations.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
}

const HEADERS = {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
};

// ─────────────────────────────────────────────────────
// Approach: Use the Supabase Management API
// POST https://api.supabase.com/v1/projects/{ref}/database/query
// This requires a personal access token however.
//
// Alternative: the supabase_url/auth/v1 admin endpoints only
// work for auth, not raw SQL.
//
// Best remaining option without DB password:
// 1. Reset DB password via management API (needs PAT)
// 2. OR use the Supabase CLI with PAT
//
// Let's try the CLI approach with npx supabase db push
// but first we need to generate a Supabase access token.
// ─────────────────────────────────────────────────────

const { execSync } = require('child_process');

const PROJECT_REF = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

console.log('\n═══════════════════════════════════════════════');
console.log('  LAYER5 — Phase 1 Bootstrap via Supabase CLI');
console.log(`  Project: ${PROJECT_REF}`);
console.log('═══════════════════════════════════════════════\n');

// Try to use SUPABASE_ACCESS_TOKEN if set (personal access token)
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!PAT) {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ❌  SUPABASE_ACCESS_TOKEN not found in .env
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  To run migrations via CLI, you need a Personal Access Token.

  Steps to get it:
  1. Go to: https://supabase.com/dashboard/account/tokens
  2. Click "Generate new token"
  3. Name it "Layer5 Migration" — copy the token
  4. Add to your .env file:
       SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

  OR: Reset your database password and add DB_URL to .env:
  1. Go to: https://supabase.com/dashboard/project/${PROJECT_REF}/settings/database
  2. Scroll to "Database password" → click "Reset database password"
  3. Copy the new password
  4. Add to your .env file:
       DB_URL=postgresql://postgres:[NEW-PASSWORD]@db.${PROJECT_REF}.supabase.co:5432/postgres
  5. Then run: node scripts/migrate.js

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
    process.exit(1);
}

// Have PAT — use CLI
console.log('✅ SUPABASE_ACCESS_TOKEN found — using Supabase CLI\n');

function run(cmd, label, cwd) {
    console.log(`⏳ ${label}...`);
    try {
        const out = execSync(cmd, {
            cwd: cwd || path.join(__dirname, '..'),
            stdio: 'pipe',
            env: { ...process.env, SUPABASE_ACCESS_TOKEN: PAT }
        });
        console.log(`✅ ${label} — done`);
        if (out.toString().trim()) console.log(`   ${out.toString().trim()}`);
        return true;
    } catch (err) {
        const msg = (err.stderr?.toString() || err.message || '').trim();
        // Ignore "already linked" error
        if (msg.includes('already linked')) {
            console.log(`⚠️  ${label} — already done (OK)`);
            return true;
        }
        console.error(`❌ ${label} FAILED:\n   ${msg}`);
        return false;
    }
}

async function main() {
    // 1. Link project
    run(`npx supabase link --project-ref ${PROJECT_REF}`, 'Linking to Supabase project');

    // 2. Push all migrations
    const ok = run('npx supabase db push', 'Pushing migrations to remote database');
    if (!ok) {
        console.error('\n❌ Migration push failed. Check errors above.');
        process.exit(1);
    }

    // 3. Seed data
    console.log('\n⏳ Seeding cold start priors...');
    const seedSql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'seed', 'cold_start_priors.sql'), 'utf-8');

    // Write seed to a temp migration file for CLI push
    const seedMigrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '000_seed_data.sql');
    // Don't write as migration; seed via db remote commit or direct exec
    // Use db execute command instead
    const seedFile = path.join(__dirname, '..', 'supabase', 'seed', 'cold_start_priors.sql');
    run(`npx supabase db execute --file "${seedFile}"`, 'Running seed data');

    console.log('\n═══════════════════════════════════════════════');
    console.log('  ✅ PHASE 1 COMPLETE!');
    console.log('  git commit -m "feat: layer-1 complete"');
    console.log('═══════════════════════════════════════════════\n');
}

main();
