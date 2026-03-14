const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbUrl = process.env.DB_URL || process.env.DATABASE_POOLER_URL;
if (!dbUrl) {
    console.error("ERROR: Missing DB_URL or DATABASE_POOLER_URL in .env");
    process.exit(1);
}

const MIGRATIONS = [
    '011_create_cron_schedules.sql',
    '012_create_vector_index.sql',
    '019_create_fact_decisions.sql',
    '020_create_action_sequences.sql',
    '021_create_counterfactuals.sql',
    '022_create_world_model_artifacts.sql',
    '023_create_mv_sequence_scores.sql',
    '024_create_foundation_indexes.sql',
    '025_create_foundation_rls.sql',
    '026_create_mv_refresh_schedule.sql',
    '029_add_idempotency.sql'
];

async function confirm(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(prompt, () => {
            rl.close();
            resolve();
        });
    });
}

async function main() {
    console.log("⚠️  BEFORE RUNNING MIGRATION 011:");
    console.log("   Verify pg_cron is enabled in Supabase Dashboard.");
    console.log("   Run: scripts/verify-pgcron.sql");
    await confirm("   Press ENTER to continue or Ctrl+C to abort.");

    const client = new Client({ connectionString: dbUrl });
    try {
        await client.connect();

        let applied = 0;
        for (const file of MIGRATIONS) {
            const filepath = path.join(__dirname, '..', 'supabase', 'migrations', file);
            if (!fs.existsSync(filepath)) {
                console.log(`⚠️  Skipping ${file} - not found locally.`);
                continue;
            }
            console.log(`Running migration ${file}...`);
            const sql = fs.readFileSync(filepath, 'utf8');
            try {
                await client.query(sql);
                console.log(`✓ Migration ${file} applied`);
                applied++;
            } catch (err) {
                console.error(`\n❌ Error applying ${file}:`);
                console.error(err.message);
                console.error("\nSTOPPING. Do not run next migration.");
                process.exit(1);
            }
        }

        console.log(`\n✅ Summary: ${applied} migrations applied successfully.`);
        console.log("Next step: Run scripts/verify-pgcron.sql to confirm cron jobs are active.");

    } finally {
        await client.end();
    }
}

main();
