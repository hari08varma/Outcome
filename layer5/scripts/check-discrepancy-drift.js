#!/usr/bin/env node

function readRequiredEnv(name) {
    const value = String(process.env[name] || '').trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function readOptionalNumber(name, fallback) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptionalBoolean(name, fallback) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return fallback;
}

function safeRate(numerator, denominator) {
    if (!Number.isFinite(denominator) || denominator <= 0) {
        return null;
    }
    return numerator / denominator;
}

function formatRate(value) {
    if (value === null) return 'n/a';
    return `${(value * 100).toFixed(2)}%`;
}

function parseContentRangeCount(headerValue) {
    if (!headerValue) return null;
    const slash = headerValue.lastIndexOf('/');
    if (slash === -1) return null;

    const rawCount = headerValue.slice(slash + 1).trim();
    if (!rawCount || rawCount === '*') return null;

    const parsed = Number(rawCount);
    return Number.isFinite(parsed) ? parsed : null;
}

function buildRestUrl({ supabaseUrl, table, params = {} }) {
    const baseUrl = String(supabaseUrl || '').replace(/\/+$/, '');
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        query.set(key, String(value));
    }

    const suffix = query.toString();
    return `${baseUrl}/rest/v1/${table}${suffix ? `?${suffix}` : ''}`;
}

function buildServiceHeaders(serviceRoleKey, withCount = false) {
    const headers = {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: 'application/json',
    };

    if (withCount) {
        headers.Prefer = 'count=exact';
        headers.Range = '0-0';
    }

    return headers;
}

async function requestWithTimeout({ url, method, headers, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            method,
            headers,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

async function queryCount({ supabaseUrl, serviceRoleKey, table, filters, timeoutMs }) {
    const url = buildRestUrl({
        supabaseUrl,
        table,
        params: {
            select: '*',
            ...filters,
        },
    });

    const headResponse = await requestWithTimeout({
        url,
        method: 'HEAD',
        headers: buildServiceHeaders(serviceRoleKey, true),
        timeoutMs,
    });

    if (!headResponse.ok) {
        throw new Error(`HEAD ${table} failed (${headResponse.status})`);
    }

    const headerCount = parseContentRangeCount(headResponse.headers.get('content-range'));
    if (headerCount !== null) {
        return headerCount;
    }

    const getResponse = await requestWithTimeout({
        url,
        method: 'GET',
        headers: buildServiceHeaders(serviceRoleKey, true),
        timeoutMs,
    });

    const raw = await getResponse.text();
    let payload;
    try {
        payload = raw ? JSON.parse(raw) : [];
    } catch {
        payload = [];
    }

    if (!getResponse.ok) {
        throw new Error(`GET ${table} failed (${getResponse.status}): ${JSON.stringify(payload)}`);
    }

    const fallbackHeaderCount = parseContentRangeCount(getResponse.headers.get('content-range'));
    if (fallbackHeaderCount !== null) {
        return fallbackHeaderCount;
    }

    return Array.isArray(payload) ? payload.length : 0;
}

function normalizeFilterScope(customerId) {
    if (!customerId) return {};
    return { customer_id: `eq.${customerId}` };
}

function daysAgoIso(days) {
    const now = Date.now();
    const ms = Math.max(0, Number(days)) * 24 * 60 * 60 * 1000;
    return new Date(now - ms).toISOString();
}

async function run() {
    const supabaseUrl = readRequiredEnv('SUPABASE_URL').replace(/\/+$/, '');
    const serviceRoleKey = readRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    const customerId = String(process.env.DRIFT_MONITOR_CUSTOMER_ID || process.env.DRIFT_CUSTOMER_ID || '').trim();
    const lookbackDays = readOptionalNumber('DRIFT_LOOKBACK_DAYS', 7);
    const timeoutMs = readOptionalNumber('DRIFT_MONITOR_TIMEOUT_MS', 15000);

    const discrepancyRateThreshold = readOptionalNumber('DRIFT_DISCREPANCY_RATE_THRESHOLD', 0.03);
    const conflictRateThreshold = readOptionalNumber('DRIFT_CONFLICT_RATE_THRESHOLD', 0.01);
    const conflictShareThreshold = readOptionalNumber('DRIFT_CONFLICT_SHARE_THRESHOLD', 0.35);
    const openDiscrepancyThreshold = readOptionalNumber('DRIFT_OPEN_DISCREPANCY_THRESHOLD', 80);
    const openConflictThreshold = readOptionalNumber('DRIFT_OPEN_CONFLICT_THRESHOLD', 30);
    const minOpenForShare = readOptionalNumber('DRIFT_MIN_OPEN_FOR_SHARE', 10);
    const failOnBreach = readOptionalBoolean('DRIFT_FAIL_ON_BREACH', true);

    const sinceIso = daysAgoIso(lookbackDays);
    const scope = normalizeFilterScope(customerId);

    const discrepancyTypes = [
        'cross_event_conflict',
        'outcome_mismatch',
        'expired_no_signal',
        'confidence_below_threshold',
        'pending_state_mismatch',
        'ingestion_inconsistency',
        'contract_violation',
    ];

    const [
        openTotal,
        openConflict,
        recentDiscrepancies,
        recentConflicts,
        observedOutcomesRecent,
        ...typedCounts
    ] = await Promise.all([
        queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'dim_discrepancy_log',
            filters: { ...scope, resolved: 'eq.false' },
            timeoutMs,
        }),
        queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'dim_discrepancy_log',
            filters: {
                ...scope,
                resolved: 'eq.false',
                discrepancy_type: 'eq.cross_event_conflict',
            },
            timeoutMs,
        }),
        queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'dim_discrepancy_log',
            filters: {
                ...scope,
                created_at: `gte.${sinceIso}`,
            },
            timeoutMs,
        }),
        queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'dim_discrepancy_log',
            filters: {
                ...scope,
                discrepancy_type: 'eq.cross_event_conflict',
                created_at: `gte.${sinceIso}`,
            },
            timeoutMs,
        }),
        queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'fact_outcomes',
            filters: {
                ...scope,
                timestamp: `gte.${sinceIso}`,
            },
            timeoutMs,
        }),
        ...discrepancyTypes.map((type) => queryCount({
            supabaseUrl,
            serviceRoleKey,
            table: 'dim_discrepancy_log',
            filters: {
                ...scope,
                resolved: 'eq.false',
                discrepancy_type: `eq.${type}`,
            },
            timeoutMs,
        })),
    ]);

    const byType = {};
    for (let i = 0; i < discrepancyTypes.length; i++) {
        byType[discrepancyTypes[i]] = Number(typedCounts[i] || 0);
    }

    const openConflictShare = safeRate(openConflict, openTotal) ?? 0;
    const recentConflictShare = safeRate(recentConflicts, recentDiscrepancies) ?? 0;
    const discrepancyRate = safeRate(recentDiscrepancies, observedOutcomesRecent);
    const conflictRate = safeRate(recentConflicts, observedOutcomesRecent);

    const breaches = [];

    if (openTotal > openDiscrepancyThreshold) {
        breaches.push(`open discrepancies ${openTotal} > threshold ${openDiscrepancyThreshold}`);
    }

    if (openConflict > openConflictThreshold) {
        breaches.push(`open conflicts ${openConflict} > threshold ${openConflictThreshold}`);
    }

    if (discrepancyRate !== null && discrepancyRate > discrepancyRateThreshold) {
        breaches.push(
            `recent discrepancy rate ${formatRate(discrepancyRate)} > threshold ${formatRate(discrepancyRateThreshold)}`,
        );
    }

    if (conflictRate !== null && conflictRate > conflictRateThreshold) {
        breaches.push(
            `recent conflict rate ${formatRate(conflictRate)} > threshold ${formatRate(conflictRateThreshold)}`,
        );
    }

    if (openTotal >= minOpenForShare && openConflictShare > conflictShareThreshold) {
        breaches.push(
            `open conflict share ${formatRate(openConflictShare)} > threshold ${formatRate(conflictShareThreshold)} (open total ${openTotal})`,
        );
    }

    console.log('Discrepancy drift monitor summary');
    console.log(JSON.stringify({
        customer_scope: customerId || 'all_customers',
        lookback_days: lookbackDays,
        since: sinceIso,
        observed_outcomes_recent: observedOutcomesRecent,
        recent_discrepancies: recentDiscrepancies,
        recent_conflicts: recentConflicts,
        recent_conflict_share: recentConflictShare,
        open_total_discrepancies: openTotal,
        open_conflict_discrepancies: openConflict,
        open_conflict_share: openConflictShare,
        discrepancy_rate: discrepancyRate,
        conflict_rate: conflictRate,
        by_type: byType,
        thresholds: {
            discrepancy_rate: discrepancyRateThreshold,
            conflict_rate: conflictRateThreshold,
            conflict_share: conflictShareThreshold,
            open_discrepancies: openDiscrepancyThreshold,
            open_conflicts: openConflictThreshold,
            min_open_for_share: minOpenForShare,
        },
    }, null, 2));

    if (breaches.length > 0) {
        console.error('Discrepancy drift threshold breach detected:');
        for (const breach of breaches) {
            console.error(`- ${breach}`);
        }

        if (failOnBreach) {
            process.exit(1);
        }
    }
}

run().catch((error) => {
    console.error('Discrepancy drift monitor failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
