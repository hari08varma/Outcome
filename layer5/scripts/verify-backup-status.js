/**
 * verify-backup-status.js
 * ══════════════════════════════════════════════════════════════
 * Pre-pruning safety check.
 * Counts rows in hot + archive tables and reminds operator
 * to enable Supabase PITR before the pruning cron runs.
 *
 * Usage: node scripts/verify-backup-status.js
 * ══════════════════════════════════════════════════════════════
 */
const { Client } = require('pg');
require('dotenv').config();

async function main() {
    const dbUrl = process.env.DB_URL;
    if (!dbUrl) {
        console.error('❌ DB_URL not set in .env');
        process.exit(1);
    }

    const client = new Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
    });

    try {
        await client.connect();
        console.log('🔌 Connected to database\n');

        // 1. Count hot rows in fact_outcomes
        const hotResult = await client.query(
            `SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE is_deleted = FALSE) AS active,
                    COUNT(*) FILTER (WHERE is_synthetic = TRUE) AS synthetic
             FROM fact_outcomes`
        );
        const hot = hotResult.rows[0];
        console.log('📊 fact_outcomes (hot storage):');
        console.log(`   Total rows:     ${hot.total}`);
        console.log(`   Active rows:    ${hot.active}`);
        console.log(`   Synthetic rows: ${hot.synthetic}`);

        // 2. Count archive rows
        const archiveResult = await client.query(
            `SELECT COUNT(*) AS total FROM fact_outcomes_archive`
        );
        console.log(`\n📦 fact_outcomes_archive (warm storage):`);
        console.log(`   Total rows: ${archiveResult.rows[0].total}`);

        // 3. Last migration applied (check schema)
        const migrationResult = await client.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public'
             ORDER BY table_name`
        );
        console.log(`\n📋 Public tables: ${migrationResult.rows.length}`);
        migrationResult.rows.forEach(r => console.log(`   - ${r.table_name}`));

        // 4. Check oldest outcome timestamp
        const oldestResult = await client.query(
            `SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest
             FROM fact_outcomes WHERE is_deleted = FALSE`
        );
        const oldest = oldestResult.rows[0];
        if (oldest.oldest) {
            console.log(`\n📅 Date range:`);
            console.log(`   Oldest outcome: ${oldest.oldest}`);
            console.log(`   Newest outcome: ${oldest.newest}`);
        } else {
            console.log('\n📅 No outcomes recorded yet.');
        }

        // 5. Print backup reminder
        console.log('\n' + '═'.repeat(60));
        console.log('⚠️  BACKUP REMINDER');
        console.log('═'.repeat(60));
        console.log('Before enabling the pruning-scheduler cron (03:00 UTC):');
        console.log('');
        console.log('  1. Supabase Dashboard → Settings → Database');
        console.log('     → Enable "Point in Time Recovery"');
        console.log('     → Set retention to 30 days (recommended)');
        console.log('');
        console.log('  2. Supabase Dashboard → Database → Backups');
        console.log('     → Create a manual backup NOW');
        console.log('');
        console.log('The pruning-scheduler PERMANENTLY DELETES:');
        console.log('  - Hot rows older than 90 days (low salience)');
        console.log('  - Archive rows older than 365 days');
        console.log('═'.repeat(60));

    } catch (err) {
        console.error('❌ Database error:', err.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
