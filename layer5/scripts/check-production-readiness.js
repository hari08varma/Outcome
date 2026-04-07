#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

function parseUrlList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeOrigin(value) {
    try {
        return new URL(value).origin;
    } catch {
        return null;
    }
}

async function runSingleEndpointSanity(primaryOrigin) {
    const paths = ['/health', '/health/deep'];
    for (const path of paths) {
        const url = `${primaryOrigin}${path}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        console.log(`${url} -> HTTP ${response.status}`);

        if (response.status < 200 || response.status >= 500) {
            throw new Error(`Primary endpoint health probe failed for ${path} (HTTP ${response.status}).`);
        }
    }
}

function runScript(scriptPath, envOverrides = {}) {
    const result = spawnSync(process.execPath, [scriptPath], {
        stdio: 'inherit',
        env: { ...process.env, ...envOverrides },
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function main() {
    const primary = process.env.PRIMARY_API_URL || process.env.LAYERINFINITE_BASE_URL || '';
    const fallbackRaw = process.env.FALLBACK_API_URLS || process.env.LAYERINFINITE_BASE_URLS || '';
    const fallbacks = parseUrlList(fallbackRaw);

    if (!primary) {
        console.error('PRIMARY_API_URL (or LAYERINFINITE_BASE_URL) is required.');
        process.exit(1);
    }

    const primaryOrigin = normalizeOrigin(primary);
    if (!primaryOrigin) {
        console.error('PRIMARY_API_URL must be a valid full URL with scheme and host.');
        process.exit(1);
    }

    const fallbackOrigins = fallbacks
        .map(normalizeOrigin)
        .filter((origin) => origin !== null);

    if (fallbackOrigins.length !== fallbacks.length) {
        console.error('One or more fallback URLs are invalid. Use full https URLs in FALLBACK_API_URLS.');
        process.exit(1);
    }

    const uniqueOrigins = [...new Set([primaryOrigin, ...fallbackOrigins])];
    const independentFallbacks = [...new Set(fallbackOrigins.filter((origin) => origin !== primaryOrigin))];
    const multiEndpointMode = uniqueOrigins.length >= 2 && independentFallbacks.length >= 1;

    console.log('=== Production Readiness Endpoint Checks ===');
    console.log(`Primary: ${primaryOrigin}`);
    console.log(`Fallbacks: ${independentFallbacks.length ? independentFallbacks.join(', ') : '(none)'}`);

    if (!multiEndpointMode) {
        console.log('Mode: single-endpoint (fallback checks skipped)');
        await runSingleEndpointSanity(primaryOrigin);
        console.log('Result: PASS (single-endpoint health sanity check)');
        return;
    }

    console.log('Mode: multi-endpoint');
    runScript('scripts/check-endpoint-independence.js');
    runScript('scripts/check-endpoint-parity.js');
    runScript('scripts/run-failover-drill.js', {
        DRILL_PRIMARY_URL: process.env.DRILL_PRIMARY_URL || primaryOrigin,
        DRILL_FALLBACK_URLS: process.env.DRILL_FALLBACK_URLS || independentFallbacks.join(','),
    });

    console.log('Result: PASS');
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
