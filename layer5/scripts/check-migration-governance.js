const fs = require('fs');
const path = require('path');

const strict = process.argv.includes('--strict');
const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

function readSql(fileName) {
    const fullPath = path.join(migrationsDir, fileName);
    return fs.readFileSync(fullPath, 'utf8');
}

function parsePrefix(fileName) {
    const match = fileName.match(/^(\d+)_/);
    if (!match) return null;
    return Number(match[1]);
}

function detectDuplicatePrefixes(files) {
    const seen = new Map();
    const duplicates = new Map();

    for (const file of files) {
        const prefix = parsePrefix(file);
        if (prefix === null) continue;
        const key = String(prefix).padStart(3, '0');
        const list = seen.get(key) ?? [];
        list.push(file);
        seen.set(key, list);
    }

    for (const [prefix, fileList] of seen.entries()) {
        if (fileList.length > 1) {
            duplicates.set(prefix, fileList);
        }
    }

    return duplicates;
}

function latestMvActionScoresDefinition(files) {
    const mvFiles = files
        .filter((file) => /\.sql$/i.test(file))
        .filter((file) => {
            const sql = readSql(file);
            return /create\s+materialized\s+view\s+mv_action_scores\s+as/i.test(sql);
        })
        .map((file) => ({ file, prefix: parsePrefix(file) ?? -1 }))
        .sort((a, b) => {
            if (a.prefix !== b.prefix) return a.prefix - b.prefix;
            return a.file.localeCompare(b.file);
        });

    return mvFiles.length > 0 ? mvFiles[mvFiles.length - 1] : null;
}

function detectConfidenceDenominator(sql) {
    const compact = sql.replace(/\s+/g, ' ').toLowerCase();
    if (/count\(\*\)::numeric \/ nullif\(count\(\*\) \+ 10, 0\)/.test(compact)) {
        return 10;
    }
    if (/count\(\*\)::numeric \/ nullif\(count\(\*\) \+ 5, 0\)/.test(compact)) {
        return 5;
    }

    const generic = compact.match(/count\(\*\)::numeric\s*\/\s*nullif\(count\(\*\)\s*\+\s*(\d+)/);
    if (generic) {
        return Number(generic[1]);
    }

    return null;
}

function getMigrationFilesByPrefix(files, prefix) {
    return files.filter((file) => parsePrefix(file) === prefix);
}

function assertSqlContains(fileName, sql, checks, issues) {
    for (const check of checks) {
        if (!check.pattern.test(sql)) {
            issues.push(
                `${fileName} missing status-schema contract: ${check.description}`
            );
        }
    }
}

function validateStatusSchemaMigrations(files, issues, warnings) {
    const migrationSpecs = [
        {
            prefix: 110,
            label: 'execution status + failure trace base schema',
            checks: [
                { pattern: /add\s+column\s+if\s+not\s+exists\s+execution_status/i, description: 'execution_status column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+failure_reason_code/i, description: 'failure_reason_code column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+failure_stage/i, description: 'failure_stage column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+status_origin/i, description: 'status_origin column' },
                { pattern: /chk_fact_outcomes_execution_status_enum/i, description: 'execution_status enum check constraint' },
                { pattern: /chk_fact_outcomes_status_origin_enum/i, description: 'status_origin enum check constraint' },
                { pattern: /chk_fact_outcomes_failure_fields_for_status/i, description: 'failure fields coherence check constraint' },
                { pattern: /chk_fact_outcomes_success_status_coherence/i, description: 'success/status coherence check constraint' },
            ],
        },
        {
            prefix: 111,
            label: 'feedback mutability + discrepancy source trace schema',
            checks: [
                { pattern: /create\s+or\s+replace\s+function\s+prevent_outcome_update/i, description: 'mutable-fields trigger function update' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+source_execution_status/i, description: 'source_execution_status column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+source_status_origin/i, description: 'source_status_origin column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+source_failure_reason_code/i, description: 'source_failure_reason_code column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+source_failure_stage/i, description: 'source_failure_stage column' },
                { pattern: /chk_discrepancy_source_execution_status_enum/i, description: 'discrepancy source execution-status constraint' },
            ],
        },
        {
            prefix: 112,
            label: 'status vocab hardening + staged score/status coherence',
            checks: [
                { pattern: /chk_fact_outcomes_failure_reason_code_vocab/i, description: 'failure_reason_code bounded-vocab constraint' },
                { pattern: /chk_fact_outcomes_failure_stage_vocab/i, description: 'failure_stage bounded-vocab constraint' },
                { pattern: /chk_fact_outcomes_status_score_raw_coherence/i, description: 'status/outcome_score_raw coherence constraint' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+reason_code/i, description: 'discrepancy reason_code column' },
                { pattern: /add\s+column\s+if\s+not\s+exists\s+trace_payload/i, description: 'discrepancy trace_payload column' },
            ],
        },
        {
            prefix: 113,
            label: 'final validation of status/outcome_score_raw coherence',
            checks: [
                { pattern: /chk_fact_outcomes_status_score_raw_coherence/i, description: 'status/outcome_score_raw coherence constraint reference' },
                { pattern: /validate\s+constraint\s+chk_fact_outcomes_status_score_raw_coherence/i, description: 'constraint validation step' },
            ],
        },
    ];

    for (const spec of migrationSpecs) {
        const matchingFiles = getMigrationFilesByPrefix(files, spec.prefix);

        if (matchingFiles.length === 0) {
            issues.push(
                `Missing required migration prefix ${String(spec.prefix).padStart(3, '0')} for ${spec.label}.`
            );
            continue;
        }

        if (matchingFiles.length > 1) {
            warnings.push(
                `Multiple migration files found for prefix ${String(spec.prefix).padStart(3, '0')}: ${matchingFiles.join(', ')}`
            );
        }

        for (const fileName of matchingFiles) {
            const sql = readSql(fileName);
            assertSqlContains(fileName, sql, spec.checks, issues);
        }
    }
}

function main() {
    if (!fs.existsSync(migrationsDir)) {
        console.error(`[migration-governance] Missing directory: ${migrationsDir}`);
        process.exit(1);
    }

    const files = fs
        .readdirSync(migrationsDir)
        .filter((file) => /\.sql$/i.test(file))
        .sort((a, b) => a.localeCompare(b));

    const issues = [];
    const warnings = [];

    const duplicates = detectDuplicatePrefixes(files);
    if (duplicates.size > 0) {
        for (const [prefix, fileList] of duplicates.entries()) {
            warnings.push(
                `Duplicate migration prefix ${prefix}: ${fileList.join(', ')}`
            );
        }
    }

    const latestMvDef = latestMvActionScoresDefinition(files);
    if (!latestMvDef) {
        issues.push('No mv_action_scores definition migration found.');
    } else {
        const sql = readSql(latestMvDef.file);
        const denominator = detectConfidenceDenominator(sql);

        if (denominator === null) {
            warnings.push(
                `Could not detect confidence denominator in ${latestMvDef.file}.`
            );
        } else if (denominator !== 10) {
            issues.push(
                `Latest mv_action_scores definition (${latestMvDef.file}) uses n+${denominator}. Canonical denominator is n+10.`
            );
        }
    }

    validateStatusSchemaMigrations(files, issues, warnings);

    console.log('[migration-governance] Scan complete');
    console.log(`[migration-governance] Total SQL migrations: ${files.length}`);

    if (warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of warnings) {
            console.log(`  - ${warning}`);
        }
    }

    if (issues.length > 0) {
        console.log('\nIssues:');
        for (const issue of issues) {
            console.log(`  - ${issue}`);
        }
    }

    if (strict && (warnings.length > 0 || issues.length > 0)) {
        process.exit(1);
    }

    process.exit(0);
}

main();
