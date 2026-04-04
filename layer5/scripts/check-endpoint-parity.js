#!/usr/bin/env node

function parseUrlList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeOrigin(value) {
    const url = new URL(value);
    return url.origin;
}

async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const text = await res.text();
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            body = { parse_error: true, raw: text.slice(0, 400) };
        }
        return { ok: res.ok, status: res.status, body };
    } finally {
        clearTimeout(timer);
    }
}

function paritySignature(payload) {
    const checks = payload?.checks || {};
    return {
        apiVersion: payload?.version || 'unknown',
        schemaVersion: checks.schema_version || 'unknown',
        schemaInvariants: checks.schema_invariants || 'unknown',
    };
}

async function main() {
    const primary = process.env.PRIMARY_API_URL || process.env.LAYERINFINITE_BASE_URL || '';
    const fallbacksRaw = process.env.FALLBACK_API_URLS || process.env.LAYERINFINITE_BASE_URLS || '';
    const timeoutMs = Number.parseInt(process.env.ENDPOINT_CHECK_TIMEOUT_MS || '12000', 10);
    const strictStatus = (process.env.ENDPOINT_CHECK_STRICT_STATUS || 'true').toLowerCase() !== 'false';

    if (!primary) {
        console.error('PRIMARY_API_URL (or LAYERINFINITE_BASE_URL) is required.');
        process.exit(1);
    }

    const endpoints = [primary, ...parseUrlList(fallbacksRaw)]
        .map((u) => normalizeOrigin(u));

    const uniqueEndpoints = [...new Set(endpoints)];
    if (uniqueEndpoints.length < 2) {
        console.error('At least two endpoint origins are required for parity checks.');
        process.exit(1);
    }

    console.log('=== Endpoint Parity Check ===');
    console.log('Endpoints:', uniqueEndpoints.join(', '));

    const results = [];
    for (const endpoint of uniqueEndpoints) {
        const probeUrl = `${endpoint}/health/deep`;
        try {
            const result = await fetchJson(probeUrl, timeoutMs);
            const signature = paritySignature(result.body);
            results.push({ endpoint, probeUrl, ...result, signature });
        } catch (err) {
            results.push({
                endpoint,
                probeUrl,
                ok: false,
                status: 0,
                body: { error: err instanceof Error ? err.message : String(err) },
                signature: { apiVersion: 'unknown', schemaVersion: 'unknown', schemaInvariants: 'unknown' },
            });
        }
    }

    const failures = [];

    for (const item of results) {
        const bodyStatus = item.body?.status || 'unknown';
        console.log(`- ${item.endpoint}`);
        console.log(`  HTTP: ${item.status}`);
        console.log(`  health/deep status: ${bodyStatus}`);
        console.log(`  version: ${item.signature.apiVersion}`);
        console.log(`  schema_version: ${item.signature.schemaVersion}`);
        console.log(`  schema_invariants: ${item.signature.schemaInvariants}`);

        if (!item.ok) {
            failures.push(`${item.endpoint} returned HTTP ${item.status}`);
            continue;
        }

        if (strictStatus && bodyStatus !== 'ok') {
            failures.push(`${item.endpoint} health/deep is not ok (status=${bodyStatus})`);
        }
    }

    const baseline = results[0]?.signature;
    for (const item of results.slice(1)) {
        if (!baseline) break;
        if (item.signature.apiVersion !== baseline.apiVersion) {
            failures.push(`API version mismatch: ${item.endpoint}=${item.signature.apiVersion}, baseline=${baseline.apiVersion}`);
        }
        if (item.signature.schemaVersion !== baseline.schemaVersion) {
            failures.push(`Schema version mismatch: ${item.endpoint}=${item.signature.schemaVersion}, baseline=${baseline.schemaVersion}`);
        }
        if (item.signature.schemaInvariants !== baseline.schemaInvariants) {
            failures.push(`Schema invariants mismatch: ${item.endpoint}=${item.signature.schemaInvariants}, baseline=${baseline.schemaInvariants}`);
        }
    }

    if (failures.length) {
        console.error('\nFailures:');
        for (const failure of failures) {
            console.error(`- ${failure}`);
        }
        process.exit(1);
    }

    console.log('\nResult: PASS');
}

main().catch((err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
