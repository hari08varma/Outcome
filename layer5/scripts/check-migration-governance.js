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
