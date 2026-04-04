#!/usr/bin/env node

function parseUrlList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeOrigin(value) {
    return new URL(value).origin;
}

async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        return { ok: true, status: res.status, bodyText: await res.text() };
    } catch (err) {
        return {
            ok: false,
            status: 0,
            bodyText: '',
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function probePath(path, endpoints, timeoutMs) {
    const attempts = [];
    for (let i = 0; i < endpoints.length; i += 1) {
        const endpoint = endpoints[i];
        const url = `${endpoint}${path.startsWith('/') ? path : `/${path}`}`;
        const result = await fetchWithTimeout(url, timeoutMs);

        attempts.push({ endpoint, url, ...result });

        if (!result.ok) {
            continue;
        }

        if (result.status >= 500) {
            continue;
        }

        return {
            recovered: i > 0,
            endpoint,
            status: result.status,
            attempts,
        };
    }

    return {
        recovered: false,
        endpoint: null,
        status: 0,
        attempts,
    };
}

async function main() {
    const fallbackRaw = process.env.DRILL_FALLBACK_URLS || process.env.FALLBACK_API_URLS || process.env.LAYERINFINITE_BASE_URLS || '';
    const configuredPrimary = process.env.DRILL_PRIMARY_URL || process.env.PRIMARY_API_URL || process.env.LAYERINFINITE_BASE_URL || '';
    const timeoutMs = Number.parseInt(process.env.DRILL_TIMEOUT_MS || '10000', 10);
    const forcePrimaryDown = (process.env.DRILL_FORCE_PRIMARY_DOWN || 'true').toLowerCase() !== 'false';

    const fallbacks = parseUrlList(fallbackRaw).map((u) => normalizeOrigin(u));
    if (fallbacks.length === 0) {
        console.error('DRILL_FALLBACK_URLS (or FALLBACK_API_URLS/LAYERINFINITE_BASE_URLS) must include at least one fallback endpoint.');
        process.exit(1);
    }

    const primaryOrigin = configuredPrimary ? normalizeOrigin(configuredPrimary) : null;
    const simulatedPrimary = forcePrimaryDown
        ? 'https://primary-failover-drill.invalid'
        : (primaryOrigin || fallbacks[0]);

    const endpoints = [simulatedPrimary, ...fallbacks].filter((v, idx, arr) => arr.indexOf(v) === idx);
    const probePaths = ['/health', '/health/deep'];

    console.log('=== Failover Drill ===');
    console.log('Primary (simulated):', simulatedPrimary);
    console.log('Fallbacks:', fallbacks.join(', '));
    console.log('Probe paths:', probePaths.join(', '));

    let recoveredCount = 0;
    const failures = [];

    for (const path of probePaths) {
        const result = await probePath(path, endpoints, timeoutMs);

        console.log(`\nPath ${path}:`);
        for (const attempt of result.attempts) {
            if (!attempt.ok) {
                console.log(`- ${attempt.endpoint} -> NETWORK ERROR (${attempt.error})`);
            } else {
                console.log(`- ${attempt.endpoint} -> HTTP ${attempt.status}`);
            }
        }

        if (!result.endpoint) {
            failures.push(`No endpoint succeeded for ${path}`);
            continue;
        }

        const endpointLabel = result.recovered ? `${result.endpoint} (recovered via fallback)` : result.endpoint;
        console.log(`=> SUCCESS via ${endpointLabel}`);

        if (result.recovered) {
            recoveredCount += 1;
        }
    }

    if (failures.length) {
        console.error('\nFailures:');
        for (const failure of failures) {
            console.error(`- ${failure}`);
        }
        process.exit(1);
    }

    if (forcePrimaryDown && recoveredCount === 0) {
        console.error('\nFailure: drill expected fallback recovery, but no fallback switchover was observed.');
        process.exit(1);
    }

    console.log(`\nResult: PASS (fallback recoveries observed: ${recoveredCount})`);
}

main().catch((err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
