require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const dbUrl = process.env.DB_URL;
if (!dbUrl) {
    console.error("Missing DB_URL in .env");
    process.exit(1);
}

const client = new Client({ connectionString: dbUrl });

async function runSQL() {
    try {
        await client.connect();
        console.log("Connected to Supabase DB via pg.");

        // Run the seed sql
        const sqlPath = path.join(__dirname, 'supabase', 'seed', 'cold_start_priors.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log("Applying cold_start_priors.sql...");
        await client.query(sql);
        console.log("Successfully applied priors.");

        // Refresh the view
        console.log("Refreshing materialized view...");
        await client.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_action_scores;");
        console.log("Materialized view refreshed.");

    } catch (err) {
        console.error("Error executing SQL:", err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runSQL();
