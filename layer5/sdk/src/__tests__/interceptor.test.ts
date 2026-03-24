import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IOInterceptor, drainEmissions, _pendingEmissions } from '../interceptor.js';
import { instrument } from '../instrument.js';
import { executionStore } from '../tracing/execution-context.js';

// ── Shared mock client (satisfies LayerinfiniteClient interface) ─────────────
const mockClient = {
    logOutcome: vi.fn().mockResolvedValue({ logged: true }),
    getScores: vi.fn().mockResolvedValue({ ranked_actions: [] }),
    getApiKey: () => 'test-key',
    getBaseUrl: () => 'http://localhost',
};

// ── Reset state between tests ────────────────────────────────────────────────
beforeEach(() => {
    drainEmissions();         // clear queue
    vi.restoreAllMocks();     // restore any stubbed globals
});

afterEach(() => {
    drainEmissions();         // ensure no leftover emissions
});

// ── Helper: build a fresh interceptor ───────────────────────────────────────
function makeInterceptor(): IOInterceptor {
    return new IOInterceptor(executionStore);
}

// ── Test 1 — instrumentFetch patches globalThis.fetch ───────────────────────
describe('Test 1 — instrumentFetch patches globalThis.fetch', () => {
    it('replaces globalThis.fetch with layerinfiniteFetch', () => {
        const nativeFetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );
        vi.stubGlobal('fetch', nativeFetch);
        const before = globalThis.fetch;

        const interceptor = makeInterceptor();
        interceptor.instrumentFetch();

        expect(globalThis.fetch).not.toBe(before);
        expect(globalThis.fetch.name).toBe('layerinfiniteFetch');
    });
});

// ── Test 2 — fetch interception returns TracedResponse ──────────────────────
describe('Test 2 — fetch interception returns TracedResponse', () => {
    it('returns an object with status and ok fields from the response', async () => {
        const fakeResponse = new Response('{}', { status: 200 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

        const interceptor = makeInterceptor();
        interceptor.instrumentFetch();

        const response = await fetch('https://stripe.com/v1/refunds');

        expect(Number(response.status)).toBe(200);
        expect(Boolean(response.ok)).toBe(true);
    });
});

// ── Test 3 — fetch populates _pendingEmissions ───────────────────────────────
describe('Test 3 — fetch populates _pendingEmissions', () => {
    it('adds one emission with correct fields after a successful fetch', async () => {
        const fakeResponse = new Response('{}', { status: 200 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

        const interceptor = makeInterceptor();
        interceptor.instrumentFetch();

        await fetch('https://api.stripe.com/v1/refunds/re_abc');

        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
        expect(emissions[0]!.actionName).toContain('refunds');
        expect(emissions[0]!.httpSuccess).toBe(true);
        expect(typeof emissions[0]!.responseMs).toBe('number');
        expect(emissions[0]!.responseMs).toBeGreaterThanOrEqual(0);
    });
});

// ── Test 4 — fetch re-throws on network error ────────────────────────────────
describe('Test 4 — fetch re-throws on network error', () => {
    it('propagates the error and still emits to pipeline', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

        const interceptor = makeInterceptor();
        interceptor.instrumentFetch();

        await expect(fetch('https://stripe.com/v1/charges')).rejects.toThrow('ECONNREFUSED');

        // Pipeline still gets an emission (httpSuccess: false)
        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
        expect(emissions[0]!.httpSuccess).toBe(false);
    });
});

// ── Test 5 — idempotency: double instrumentFetch() does not double-wrap ──────
describe('Test 5 — idempotency: double instrumentFetch() does not double-wrap', () => {
    it('produces exactly one emission for one fetch call', async () => {
        const fakeResponse = new Response('{}', { status: 200 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

        const interceptor = makeInterceptor();
        interceptor.instrumentFetch();
        interceptor.instrumentFetch();  // second call — must be no-op

        await fetch('https://example.com/api');

        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
    });
});

// ── Test 6 — database interception wraps pool.query ─────────────────────────
describe('Test 6 — database interception wraps pool.query', () => {
    it('replaces pool.query with layerinfiniteQuery', () => {
        const originalQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
        const pool = { query: originalQuery };

        const interceptor = makeInterceptor();
        interceptor.instrumentDatabase(pool);

        expect(pool.query).not.toBe(originalQuery);
        expect(pool.query.name).toBe('layerinfiniteQuery');
    });
});

// ── Test 7 — database interception returns TracedResponse over rows ──────────
describe('Test 7 — database interception returns TracedResponse over rows', () => {
    it('wraps result so rows[0].id is accessible and emits dbSuccess=true', async () => {
        const pool = {
            query: vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }),
        };

        const interceptor = makeInterceptor();
        interceptor.instrumentDatabase(pool);

        const result = await pool.query('SELECT * FROM users');

        expect(Number(result.rows[0]!.id)).toBe(1);

        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
        expect(emissions[0]!.dbSuccess).toBe(true);
    });
});

// ── Test 8 — database re-throws on query error ───────────────────────────────
describe('Test 8 — database re-throws on query error', () => {
    it('propagates DB errors and emits an emission with the query name', async () => {
        const pool = {
            query: vi.fn().mockRejectedValue(new Error('relation "users" does not exist')),
        };

        const interceptor = makeInterceptor();
        interceptor.instrumentDatabase(pool);

        await expect(pool.query('SELECT * FROM users')).rejects.toThrow('relation "users" does not exist');

        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
        expect(emissions[0]!.actionName).toContain('SELECT');
        expect(emissions[0]!.dbSuccess).toBe(false);
    });
});

// ── Test 9 — execTracked returns exitCode 0 on success ──────────────────────
describe('Test 9 — execTracked returns exitCode 0 on success', () => {
    it('resolves with exitCode=0 and captured stdout', async () => {
        // Spy on the real exec by running a harmless command
        const interceptor = makeInterceptor();
        interceptor.instrumentChildProcess();

        // Use a universally available command
        const result = await interceptor.execTracked('node --version');

        expect(Number(result.exitCode)).toBe(0);
        // stdout should contain something (node version string)
        expect(String(result.stdout).length).toBeGreaterThan(0);

        const emissions = drainEmissions();
        expect(emissions).toHaveLength(1);
        expect(Number(emissions[0]!.exitCode)).toBe(0);
    });
});

// ── Test 10 — execTracked returns exitCode 1 on failure (no exception) ───────
describe('Test 10 — execTracked returns exitCode 1 on failure (no exception)', () => {
    it('does not throw when the command exits non-zero', async () => {
        const interceptor = makeInterceptor();
        interceptor.instrumentChildProcess();

        // 'node -e "process.exit(1)"' exits with code 1
        let result: { exitCode: number; stdout: string; stderr: string } | undefined;
        let threw = false;

        try {
            result = await interceptor.execTracked('node -e "process.exit(1)"');
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
        expect(Number(result!.exitCode)).toBe(1);
    });
});

// ── Test 11 — instrument() returns interceptor, fetch is patched ─────────────
describe('Test 11 — instrument() returns interceptor with exec/spawn helpers', () => {
    it('returns an IOInterceptor with execTracked and spawnTracked', () => {
        const fakeResponse = new Response('{}', { status: 200 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

        const result = instrument(mockClient);

        expect(typeof result.interceptor.execTracked).toBe('function');
        expect(typeof result.interceptor.spawnTracked).toBe('function');
        expect(globalThis.fetch.name).toBe('layerinfiniteFetch');

        result.pipeline.stop();
    });
});

// ── Test 12 — instrument() with pool option patches pool.query ───────────────
describe('Test 12 — instrument() with pool option patches pool.query', () => {
    it('replaces pool.query when pool is provided', () => {
        const fakeResponse = new Response('{}', { status: 200 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

        const pool = { query: vi.fn() };
        const result = instrument(mockClient, { pool });

        expect(pool.query.name).toBe('layerinfiniteQuery');

        result.pipeline.stop();
    });
});
