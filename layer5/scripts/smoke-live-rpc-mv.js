/*
 * Focused live smoke-check for key RPC and MV read paths.
 *
 * Required env vars:
 *   SMOKE_SUPABASE_URL
 *   SMOKE_SUPABASE_SERVICE_KEY
 *
 * This script performs read-only checks:
 * 1) Read mv_task_action_performance_context (limit 1)
 * 2) Read mv_task_action_performance_180d (limit 1)
 * 3) Read one embedded context from dim_contexts
 * 4) Invoke match_context_vector RPC with sampled vector/customer/model
 */

const SUPABASE_URL = (process.env.SMOKE_SUPABASE_URL || '').trim().replace(/\/$/, '');
const SERVICE_KEY = (process.env.SMOKE_SUPABASE_SERVICE_KEY || '').trim();

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing required env vars: SMOKE_SUPABASE_URL and/or SMOKE_SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
};

function toVectorLiteral(value) {
    if (Array.isArray(value)) {
        return `[${value.join(',')}]`;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            return trimmed;
        }

        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return `[${parsed.join(',')}]`;
            }
        } catch {
            // ignore parse failure
        }
    }

    return null;
}

function vectorDimensionFromLiteral(literal) {
    if (!literal) return 0;
    const inner = literal.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
    if (!inner) return 0;
    return inner.split(',').length;
}

async function restGet(pathAndQuery) {
    const url = `${SUPABASE_URL}/rest/v1/${pathAndQuery}`;
    const res = await fetch(url, { method: 'GET', headers });
    const text = await res.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { ok: res.ok, status: res.status, body: parsed };
}

async function restPostRpc(functionName, payload) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/${functionName}`;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { ok: res.ok, status: res.status, body: parsed };
}

function buildZeroVectorLiteral(dim = 384) {
    const parts = new Array(dim).fill('0');
    return `[${parts.join(',')}]`;
}

async function resolveAnyCustomerId() {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const fromContexts = await restGet('dim_contexts?select=customer_id&customer_id=not.is.null&limit=10');
    if (fromContexts.ok && Array.isArray(fromContexts.body) && fromContexts.body.length > 0) {
        for (const row of fromContexts.body) {
            const id = typeof row?.customer_id === 'string' ? row.customer_id.trim() : '';
            if (uuidRe.test(id)) return id;
        }
    }

    const fromCustomers = await restGet('dim_customers?select=customer_id&customer_id=not.is.null&limit=10');
    if (fromCustomers.ok && Array.isArray(fromCustomers.body) && fromCustomers.body.length > 0) {
        for (const row of fromCustomers.body) {
            const id = typeof row?.customer_id === 'string' ? row.customer_id.trim() : '';
            if (uuidRe.test(id)) return id;
        }
    }

    return null;
}

async function main() {
    const checks = [];
    let failed = false;

    // Check 1: context-aware MV is readable
    const mvContext = await restGet('mv_task_action_performance_context?select=*&limit=1');
    checks.push({
        name: 'mv_task_action_performance_context read',
        ok: mvContext.ok,
        detail: mvContext.ok
            ? `ok (rows=${Array.isArray(mvContext.body) ? mvContext.body.length : 0})`
            : `status=${mvContext.status}`,
    });
    if (!mvContext.ok) failed = true;

    // Check 2: global MV is readable
    const mvGlobal = await restGet('mv_task_action_performance_180d?select=*&limit=1');
    checks.push({
        name: 'mv_task_action_performance_180d read',
        ok: mvGlobal.ok,
        detail: mvGlobal.ok
            ? `ok (rows=${Array.isArray(mvGlobal.body) ? mvGlobal.body.length : 0})`
            : `status=${mvGlobal.status}`,
    });
    if (!mvGlobal.ok) failed = true;

    // Check 3: sample embedded context for RPC probe
    const contextSample = await restGet(
        'dim_contexts?select=context_id,customer_id,embedding_model,embedding_schema_version,context_vector&context_vector=not.is.null&order=created_at.desc&limit=1'
    );

    if (!contextSample.ok) {
        checks.push({
            name: 'dim_contexts sample read',
            ok: false,
            detail: `status=${contextSample.status}`,
        });
        failed = true;
    } else {
        const rows = Array.isArray(contextSample.body) ? contextSample.body : [];
        if (rows.length === 0) {
            checks.push({
                name: 'dim_contexts sample read',
                ok: true,
                detail: 'ok (no embedded contexts yet; using zero-vector RPC probe)',
            });

            const fallbackCustomerId = await resolveAnyCustomerId();
            if (!fallbackCustomerId) {
                checks.push({
                    name: 'match_context_vector RPC probe',
                    ok: false,
                    detail: 'no customer_id available for RPC probe',
                });
                failed = true;
            } else {
                const rpc = await restPostRpc('match_context_vector', {
                    query_vector: buildZeroVectorLiteral(384),
                    p_customer_id: fallbackCustomerId,
                    p_model: 'gte-small',
                    p_threshold: 0,
                    p_limit: 1,
                    p_schema_version: 2,
                });

                const rpcRows = Array.isArray(rpc.body) ? rpc.body : [];
                checks.push({
                    name: 'match_context_vector RPC probe',
                    ok: rpc.ok,
                    detail: rpc.ok
                        ? `ok (callable, rows=${rpcRows.length})`
                        : `status=${rpc.status}; body=${typeof rpc.body === 'string' ? rpc.body : JSON.stringify(rpc.body)}`,
                });

                if (!rpc.ok) {
                    failed = true;
                }
            }
        } else {
            const row = rows[0];
            const vectorLiteral = toVectorLiteral(row.context_vector);
            const dim = vectorDimensionFromLiteral(vectorLiteral);

            checks.push({
                name: 'dim_contexts sample read',
                ok: !!vectorLiteral,
                detail: vectorLiteral
                    ? `ok (context_id=${row.context_id}, dim=${dim})`
                    : 'context_vector parse failed',
            });
            if (!vectorLiteral) {
                failed = true;
            } else {
                const rpc = await restPostRpc('match_context_vector', {
                    query_vector: vectorLiteral,
                    p_customer_id: row.customer_id,
                    p_model: row.embedding_model || 'gte-small',
                    p_threshold: 0,
                    p_limit: 1,
                    p_schema_version: Number(row.embedding_schema_version || 2),
                });

                const rpcRows = Array.isArray(rpc.body) ? rpc.body : [];
                const top = rpcRows[0] || null;
                const similarity = top && typeof top.similarity === 'number' ? top.similarity : null;
                const similarityOk = similarity === null ? false : similarity >= 0 && similarity <= 1;

                checks.push({
                    name: 'match_context_vector RPC probe',
                    ok: rpc.ok && rpcRows.length > 0 && similarityOk,
                    detail: rpc.ok
                        ? `ok (rows=${rpcRows.length}, top_similarity=${similarity ?? 'n/a'})`
                        : `status=${rpc.status}`,
                });

                if (!(rpc.ok && rpcRows.length > 0 && similarityOk)) {
                    failed = true;
                }
            }
        }
    }

    console.log('LIVE_SMOKE_CHECK_RESULTS_START');
    for (const check of checks) {
        const status = check.ok ? 'PASS' : 'FAIL';
        console.log(`${status} | ${check.name} | ${check.detail}`);
    }
    console.log('LIVE_SMOKE_CHECK_RESULTS_END');

    if (failed) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Smoke check crashed:', err?.message || err);
    process.exit(1);
});
