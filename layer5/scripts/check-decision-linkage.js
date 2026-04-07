#!/usr/bin/env node

function parseIssues(raw) {
    if (!raw) return ['payment_failed', 'network_timeout', 'env_var_missing'];
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function buildUrl(base, issueType, episodeId) {
    const url = new URL('/v1/get-scores', base);
    url.searchParams.set('issue_type', issueType);
    url.searchParams.set('environment', 'production');
    if (episodeId) {
        url.searchParams.set('episode_id', episodeId);
    }
    return url.toString();
}

function uuidLike(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function callGetScores(baseUrl, apiKey, issueType, episodeId) {
    const response = await fetch(buildUrl(baseUrl, issueType, episodeId), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            'X-API-Key': apiKey,
        },
    });

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    return { response, data };
}

async function main() {
    const baseUrl = process.env.PRIMARY_API_URL
        || process.env.LAYERINFINITE_BASE_URL
        || process.env.LAYERINFINITE_API_URL
        || 'https://api.layerinfinite.app';

    const apiKey = process.env.LAYERINFINITE_API_KEY;
    const issues = parseIssues(process.env.DECISION_CHECK_ISSUES);

    if (!apiKey) {
        console.error('LAYERINFINITE_API_KEY is required.');
        process.exit(1);
    }

    console.log('=== Decision Linkage Check ===');
    console.log(`Base URL: ${baseUrl}`);
    console.log(`Issues: ${issues.join(', ')}`);

    const failures = [];

    // Main check: standard calls without episode_id should emit decision_id.
    for (const issue of issues) {
        const { response, data } = await callGetScores(baseUrl, apiKey, issue, null);
        const decisionId = data?.decision_id ?? null;

        console.log(`issue=${issue} status=${response.status} decision_id=${decisionId ?? 'null'}`);

        if (!response.ok) {
            failures.push(`get-scores failed for ${issue} (HTTP ${response.status})`);
            continue;
        }

        if (!uuidLike(decisionId)) {
            failures.push(`decision_id missing for ${issue} (no episode_id request)`);
        }
    }

    // Control check: episode_id path should also emit decision_id.
    const controlEpisodeId = crypto.randomUUID();
    const controlIssue = issues[0];
    const control = await callGetScores(baseUrl, apiKey, controlIssue, controlEpisodeId);
    const controlDecisionId = control.data?.decision_id ?? null;

    console.log(
        `control issue=${controlIssue} episode_id=yes status=${control.response.status} decision_id=${controlDecisionId ?? 'null'}`,
    );

    if (!control.response.ok) {
        failures.push(`control get-scores failed (HTTP ${control.response.status})`);
    } else if (!uuidLike(controlDecisionId)) {
        failures.push('control request with episode_id did not emit decision_id');
    }

    if (failures.length > 0) {
        console.error('Result: FAIL');
        for (const failure of failures) {
            console.error(`- ${failure}`);
        }
        process.exit(1);
    }

    console.log('Result: PASS');
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
