#!/usr/bin/env node

const dns = require('node:dns').promises;

function parseUrlList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeOrigin(value) {
    try {
        const url = new URL(value);
        return url.origin;
    } catch {
        return null;
    }
}

async function resolveHost(hostname) {
    try {
        const records = await dns.lookup(hostname, { all: true });
        const ips = [...new Set(records.map((r) => r.address))].sort();
        return { ok: ips.length > 0, ips, error: null };
    } catch (err) {
        return { ok: false, ips: [], error: err instanceof Error ? err.message : String(err) };
    }
}

async function main() {
    const primary = process.env.PRIMARY_API_URL || process.env.LAYERINFINITE_BASE_URL || '';
    const fallbacksRaw = process.env.FALLBACK_API_URLS || process.env.LAYERINFINITE_BASE_URLS || '';
    const fallbackList = parseUrlList(fallbacksRaw);

    const failures = [];
    const warnings = [];

    if (!primary) {
        failures.push('PRIMARY_API_URL (or LAYERINFINITE_BASE_URL) is required.');
    }

    const origins = [];
    if (primary) origins.push(primary);
    origins.push(...fallbackList);

    const normalized = origins
        .map((u) => ({ raw: u, origin: normalizeOrigin(u) }))
        .filter((u) => u.origin !== null);

    if (normalized.length !== origins.length) {
        failures.push('One or more endpoint URLs are invalid. Use full https URLs.');
    }

    const uniqueOrigins = [...new Set(normalized.map((u) => u.origin))];

    if (uniqueOrigins.length < 2) {
        failures.push('At least 2 unique endpoint origins are required (primary + at least one independent fallback).');
    }

    for (const origin of uniqueOrigins) {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'https:') {
            failures.push(`Endpoint must use https: ${origin}`);
        }
    }

    if (uniqueOrigins.length > 0) {
        const primaryOrigin = normalizeOrigin(primary);
        const duplicateFallback = fallbackList.some((f) => normalizeOrigin(f) === primaryOrigin);
        if (duplicateFallback) {
            failures.push('Fallback list includes the same origin as primary endpoint.');
        }
    }

    const dnsInfo = {};
    for (const origin of uniqueOrigins) {
        const host = new URL(origin).hostname;
        dnsInfo[origin] = await resolveHost(host);
        if (!dnsInfo[origin].ok) {
            failures.push(`DNS resolution failed for ${origin}: ${dnsInfo[origin].error}`);
        }
    }

    const ipSets = uniqueOrigins
        .map((origin) => ({ origin, ips: dnsInfo[origin]?.ips || [] }))
        .filter((r) => r.ips.length > 0)
        .map((r) => r.ips.join(','));

    if (ipSets.length >= 2) {
        const allSameIpSet = ipSets.every((value) => value === ipSets[0]);
        if (allSameIpSet) {
            warnings.push('All endpoints currently resolve to identical IP sets. This may indicate shared infrastructure.');
        }
    }

    console.log('=== Endpoint Independence Check ===');
    console.log('Primary:', primary || '(missing)');
    console.log('Fallbacks:', fallbackList.length ? fallbackList.join(', ') : '(none)');
    console.log('Unique origins:', uniqueOrigins.join(', ') || '(none)');
    console.log('');

    for (const origin of uniqueOrigins) {
        const item = dnsInfo[origin];
        if (!item) continue;
        if (item.ok) {
            console.log(`- ${origin} -> ${item.ips.join(', ')}`);
        } else {
            console.log(`- ${origin} -> DNS ERROR: ${item.error}`);
        }
    }

    if (warnings.length) {
        console.log('\nWarnings:');
        for (const warning of warnings) {
            console.log(`- ${warning}`);
        }
    }

    if (failures.length) {
        console.error('\nFailures:');
        for (const failure of failures) {
            console.error(`- ${failure}`);
        }
        process.exit(1);
    }

    if (warnings.length) {
        console.log('\nResult: PASS WITH WARNINGS');
    } else {
        console.log('\nResult: PASS');
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
