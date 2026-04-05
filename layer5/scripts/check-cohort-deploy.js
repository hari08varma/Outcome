#!/usr/bin/env node

/**
 * Cohort persistence deployment verification.
 *
 * Checks each configured environment for:
 *  1) recommendation_cohort_cycles table exists
 *  2) upsert_recommendation_cohort_cycle RPC exists
 *
 * Exit code:
 *  - 0: all environments pass
 *  - 1: any environment fails or config is invalid
 *
 * Configuration options:
 *
 * A) Multi-env via names:
 *    COHORT_ENVIRONMENTS=dev,staging,prod
 *    DEV_SUPABASE_URL=...
 *    DEV_SUPABASE_SERVICE_ROLE_KEY=...
 *    STAGING_SUPABASE_URL=...
 *    STAGING_SUPABASE_SERVICE_ROLE_KEY=...
 *    PROD_SUPABASE_URL=...
 *    PROD_SUPABASE_SERVICE_ROLE_KEY=...
 *
 * B) Multi-env via JSON:
 *    COHORT_ENVS_JSON='[{"name":"prod","url":"...","serviceRoleKey":"..."}]'
 *
 * C) Single env fallback:
 *    SUPABASE_URL=...
 *    SUPABASE_SERVICE_ROLE_KEY=...
 */

function parseEnvNameList(raw) {
    return String(raw || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

function maskKey(value) {
    const raw = String(value || '');
    if (raw.length <= 8) return '***';
    return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function normalizeName(name) {
    return name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function loadTargetsFromJson(rawJson) {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
        throw new Error('COHORT_ENVS_JSON must be a JSON array');
    }

    return parsed.map((entry, idx) => {
        const name = String(entry?.name || `env_${idx + 1}`);
        const url = String(entry?.url || '').trim();
        const serviceRoleKey = String(entry?.serviceRoleKey || '').trim();
        return { name, url, serviceRoleKey };
    });
}

function loadTargetsFromNamedVars(rawNames) {
    const names = parseEnvNameList(rawNames);
    return names.map((name) => {
        const normalized = normalizeName(name);
        const url = process.env[`${normalized}_SUPABASE_URL`] || '';
        const serviceRoleKey = process.env[`${normalized}_SUPABASE_SERVICE_ROLE_KEY`] || '';
        return { name, url: String(url).trim(), serviceRoleKey: String(serviceRoleKey).trim() };
    });
}

function loadSingleTarget() {
    const url = String(process.env.SUPABASE_URL || '').trim();
    const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    return [{ name: process.env.COHORT_ENV_NAME || 'default', url, serviceRoleKey }];
}

function loadTargets() {
    const jsonRaw = process.env.COHORT_ENVS_JSON;
    if (jsonRaw && String(jsonRaw).trim().length > 0) {
        return loadTargetsFromJson(String(jsonRaw));
    }

    const namedRaw = process.env.COHORT_ENVIRONMENTS;
    if (namedRaw && String(namedRaw).trim().length > 0) {
        return loadTargetsFromNamedVars(String(namedRaw));
    }

    return loadSingleTarget();
}

function isMissingTableError(error) {
    const code = String(error?.code || '');
    const msg = String(error?.message || '').toLowerCase();
    return (
        code === '42P01' ||
        code === 'PGRST205' ||
        (msg.includes('relation') && msg.includes('recommendation_cohort_cycles'))
    );
}

function isMissingRpcError(error) {
    const code = String(error?.code || '');
    const msg = String(error?.message || '').toLowerCase();

    return (
        code === '42883' ||
        code === 'PGRST202' ||
        (msg.includes('could not find the function') && msg.includes('upsert_recommendation_cohort_cycle')) ||
        (msg.includes('function') && msg.includes('upsert_recommendation_cohort_cycle') && msg.includes('does not exist'))
    );
}

function isAuthError(error) {
    const code = String(error?.code || '').toUpperCase();
    const msg = String(error?.message || '').toLowerCase();
    const hint = String(error?.hint || '').toLowerCase();

    return (
        code === '401' ||
        code === '403' ||
        code === 'PGRST301' ||
        msg.includes('invalid api key') ||
        msg.includes('invalid jwt') ||
        msg.includes('jwt') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        hint.includes('service_role')
    );
}

function summarizeError(error) {
    if (!error || typeof error !== 'object') {
        return 'unknown error';
    }

    const parts = [error.code, error.message, error.hint, error.details]
        .map((v) => (v == null ? '' : String(v).trim()))
        .filter(Boolean);

    if (parts.length > 0) {
        return parts.join(' | ');
    }

    return 'unknown error';
}

function withRestBase(url) {
    return String(url || '').replace(/\/+$/, '');
}

function createRestHeaders(serviceRoleKey) {
    return {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
    };
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonSafe(response) {
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return { message: text };
    }
}

function toProbeError(status, payload) {
    if (payload && typeof payload === 'object') {
        const code = payload.code != null ? String(payload.code) : String(status || '');
        const message = payload.message != null ? String(payload.message) : `HTTP ${status}`;
        const hint = payload.hint != null ? String(payload.hint) : '';
        const details = payload.details != null ? String(payload.details) : '';
        return { code, message, hint, details };
    }
    return { code: String(status || ''), message: `HTTP ${status}` };
}

async function checkTable(target) {
    const baseUrl = withRestBase(target.url);
    const endpoint = `${baseUrl}/rest/v1/recommendation_cohort_cycles?select=cycle_id&limit=1`;

    const response = await fetchWithTimeout(endpoint, {
        method: 'GET',
        headers: createRestHeaders(target.serviceRoleKey),
    });

    if (response.ok) {
        return { ok: true, detail: 'table exists' };
    }

    const payload = await readJsonSafe(response);
    const error = toProbeError(response.status, payload);

    if (isAuthError(error)) {
        return { ok: false, detail: `table probe auth/config error: ${summarizeError(error)}` };
    }

    if (isMissingTableError(error)) {
        return { ok: false, detail: `table missing (${error.code || 'unknown'})` };
    }

    return { ok: false, detail: `table probe failed: ${summarizeError(error)}` };
}

async function checkRpc(target) {
    const payload = {
        // Null customer forces an early validation error in the function body,
        // proving the RPC exists without creating any rows.
        p_customer_id: null,
        p_task_name: '__cohort_deploy_check__',
        p_observed_at: new Date().toISOString(),
        p_total_outcomes: 0,
        p_median_confidence: null,
        p_median_success_rate: null,
    };

    const baseUrl = withRestBase(target.url);
    const endpoint = `${baseUrl}/rest/v1/rpc/upsert_recommendation_cohort_cycle`;

    const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: createRestHeaders(target.serviceRoleKey),
        body: JSON.stringify(payload),
    });

    if (response.ok) {
        return { ok: true, detail: 'rpc exists (call succeeded)' };
    }

    const body = await readJsonSafe(response);
    const error = toProbeError(response.status, body);

    if (isAuthError(error)) {
        return { ok: false, detail: `rpc probe auth/config error: ${summarizeError(error)}` };
    }

    if (isMissingRpcError(error)) {
        return { ok: false, detail: `rpc missing (${error.code || 'unknown'})` };
    }

    if (!error.message && !error.code) {
        return { ok: false, detail: 'rpc probe failed: unknown error' };
    }

    // Any non-missing-function DB error still proves function existence.
    return { ok: true, detail: `rpc exists (returned ${summarizeError(error)})` };
}

function validateTargets(targets) {
    const issues = [];

    if (!targets.length) {
        issues.push('No targets configured. Set COHORT_ENVIRONMENTS or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.');
        return issues;
    }

    targets.forEach((t, idx) => {
        if (!t.url) {
            issues.push(`Target[${idx}] ${t.name}: missing URL`);
        }
        if (!t.serviceRoleKey) {
            issues.push(`Target[${idx}] ${t.name}: missing service role key`);
        }
        if (t.url) {
            try {
                const u = new URL(t.url);
                if (u.protocol !== 'https:') {
                    issues.push(`Target[${idx}] ${t.name}: URL must use https`);
                }
            } catch {
                issues.push(`Target[${idx}] ${t.name}: URL is invalid`);
            }
        }
    });

    return issues;
}

async function runTarget(target) {
    const [tableCheck, rpcCheck] = await Promise.all([
        checkTable(target),
        checkRpc(target),
    ]);

    return {
        target,
        tableCheck,
        rpcCheck,
        ok: tableCheck.ok && rpcCheck.ok,
    };
}

async function main() {
    const targets = loadTargets();
    const configIssues = validateTargets(targets);

    if (configIssues.length > 0) {
        console.error('Configuration errors:');
        for (const issue of configIssues) {
            console.error(`- ${issue}`);
        }
        return 1;
    }

    console.log('=== Cohort Persistence Deployment Check ===');
    console.log(`Targets: ${targets.map((t) => t.name).join(', ')}`);

    const results = [];
    for (const target of targets) {
        console.log(`\n[${target.name}] ${target.url}`);
        console.log(`[${target.name}] key=${maskKey(target.serviceRoleKey)}`);

        try {
            const result = await runTarget(target);
            results.push(result);

            console.log(`  table: ${result.tableCheck.ok ? 'OK' : 'MISSING'} — ${result.tableCheck.detail}`);
            console.log(`  rpc:   ${result.rpcCheck.ok ? 'OK' : 'MISSING'} — ${result.rpcCheck.detail}`);
        } catch (err) {
            results.push({
                target,
                ok: false,
                tableCheck: { ok: false, detail: 'not checked' },
                rpcCheck: { ok: false, detail: 'not checked' },
                fatal: err instanceof Error ? err.message : String(err),
            });
            console.log(`  fatal: ${(err && err.message) || String(err)}`);
        }
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
        console.error('\nResult: FAIL');
        for (const f of failed) {
            const fatalSuffix = f.fatal ? ` | fatal=${f.fatal}` : '';
            console.error(`- ${f.target.name}: table=${f.tableCheck.detail} | rpc=${f.rpcCheck.detail}${fatalSuffix}`);
        }
        return 1;
    }

    console.log('\nResult: PASS');
    return 0;
}

main()
    .then((code) => {
        process.exitCode = Number.isInteger(code) ? code : 1;
    })
    .catch((err) => {
        console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
    });
