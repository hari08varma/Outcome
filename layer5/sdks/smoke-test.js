const baseUrl = process.env.BASE_URL;
const apiKey = process.env.API_KEY;

if (!baseUrl || !apiKey) {
    console.log("SMOKE_TEST_SKIPPED: BASE_URL or API_KEY not set");
    process.exit(0);
}

async function runTest() {
    try {
        const healthRes = await fetch(`${baseUrl}/health`);
        const healthBody = await healthRes.json();
        if (healthRes.status !== 200 || healthBody.status !== "ok") {
            throw new Error(`health check returned status ${healthRes.status}`);
        }
        console.log("✅ PASS: health endpoint");

        const qRes = await fetch(`${baseUrl}/v1/get-scores?agent_id=smoke-test&issue_type=test`, {
            headers: { 'X-API-Key': apiKey }
        });
        
        if (qRes.status !== 200 && qRes.status !== 401 && qRes.status !== 404) {
            throw new Error(`get-scores returned status ${qRes.status}`);
        }
        if (!qRes.headers.get('Content-Type')?.includes('application/json')) {
            throw new Error(`get-scores invalid Content-Type`);
        }
        console.log("✅ PASS: get-scores endpoint reachable");
        console.log("🚀 Smoke test complete");
    } catch (err) {
        console.error(`❌ FAIL: API check — ${err.message}`);
        process.exit(1);
    }
}

runTest();
