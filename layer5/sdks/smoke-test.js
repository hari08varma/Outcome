#!/usr/bin/env node
/**
 * Layerinfinite SDK Smoke Test
 * ─────────────────────────────
 * Tests the live API without installing the SDK package.
 * Uses only Node.js built-ins (no dependencies).
 *
 * Usage:
 *   API_KEY=layerinfinite_xxx BASE_URL=https://outcome-production.up.railway.app node smoke-test.js
 *
 * Exits 0 on full pass, 1 on any failure.
 */

const API_KEY  = process.env.API_KEY;
const BASE_URL = (process.env.BASE_URL ?? 'https://outcome-production.up.railway.app').replace(/\/$/, '');

const results = [];

// ── Helpers ──────────────────────────────────────────────────────

function pass(name, detail = '') {
    results.push({ ok: true, name });
    console.log(`  ✅ PASS  ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, reason) {
    results.push({ ok: false, name });
    console.error(`  ❌ FAIL  ${name} — ${reason}`);
}

async function get(path, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: 'GET',
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal,
        });
        const body = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, body };
    } finally {
        clearTimeout(timer);
    }
}

// ── Pre-flight ────────────────────────────────────────────────────

console.log('\n🔍 Layerinfinite SDK Smoke Test');
console.log(`   BASE_URL: ${BASE_URL}`);
console.log(`   API_KEY:  ${API_KEY ? API_KEY.slice(0, 18) + '...' : '(not set)'}\n`);

if (!API_KEY) {
    console.error('❌ API_KEY env var is required. Set it to a valid layerinfinite_ key.\n');
    process.exit(1);
}

if (!API_KEY.startsWith('layerinfinite_')) {
    console.error('❌ API_KEY must start with "layerinfinite_".\n');
    process.exit(1);
}

// ── Test 1: GET /health ───────────────────────────────────────────

try {
    const { status, ok, body } = await get('/health');
    if (!ok) {
        fail('GET /health', `HTTP ${status}`);
    } else if (body?.status !== 'ok' && body?.status !== 'degraded') {
        fail('GET /health', `unexpected status field: ${JSON.stringify(body?.status)}`);
    } else {
        pass('GET /health', `status=${body.status} version=${body.version ?? 'n/a'}`);
    }
} catch (err) {
    fail('GET /health', String(err));
}

// ── Test 2: GET /v1/get-scores ────────────────────────────────────

try {
    const { status, ok, body } = await get(
        '/v1/get-scores?agent_id=smoke-test-agent&issue_type=billing&environment=production',
        { 'X-API-Key': API_KEY }
    );

    if (status === 401) {
        fail('GET /v1/get-scores', 'API key rejected (401) — check your key');
    } else if (status === 404) {
        // Agent not found is an acceptable result for a smoke test agent
        pass('GET /v1/get-scores', 'agent not found (404) — API is reachable and auth passed');
    } else if (!ok) {
        fail('GET /v1/get-scores', `HTTP ${status}: ${JSON.stringify(body)}`);
    } else if (!Array.isArray(body?.ranked_actions)) {
        fail('GET /v1/get-scores', `response missing ranked_actions array: ${JSON.stringify(body)}`);
    } else {
        pass('GET /v1/get-scores', `${body.ranked_actions.length} ranked actions returned`);
    }
} catch (err) {
    fail('GET /v1/get-scores', String(err));
}

// ── Summary ───────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const total  = results.length;

console.log(`\n─────────────────────────────`);
console.log(`  Smoke test: ${passed}/${total} passed`);
console.log(`─────────────────────────────\n`);

if (passed < total) {
    process.exit(1);
}
