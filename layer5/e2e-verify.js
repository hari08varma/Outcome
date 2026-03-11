const http = require('http');

async function checkE2E() {
    console.log('--- LAYER5 E2E VERIFICATION ---');
    let allPassed = true;

    // 1. GET /v1/get-scores -> update_app is top recommendation
    try {
        const res = await fetch('http://localhost:3000/v1/get-scores?issue_type=payment_failed', {
            headers: { 'X-API-Key': 'key123', 'X-Customer-ID': 'a0000000-0000-0000-0000-000000000001' }
        });
        const json = await res.json();
        const topAction = json.top_action?.action_name;
        console.log(`1. GET /v1/get-scores -> Top Action: ${topAction}`);
        if (topAction !== 'update_app') {
            console.error('  -> FAILED: Expected update_app');
            allPassed = false;
        } else {
            console.log('  -> PASSED');
        }
    } catch (e) {
        console.error('  -> Error GET get-scores:', e.message);
        allPassed = false;
    }

    // 2. POST /v1/admin/actions without auth -> 401
    try {
        const res = await fetch('http://localhost:3000/v1/admin/actions', { method: 'POST' });
        console.log(`2. POST /v1/admin/actions without auth -> Status: ${res.status}`);
        if (res.status !== 401) {
            console.error(`  -> FAILED: Expected 401, got ${res.status}`);
            allPassed = false;
        } else {
            console.log('  -> PASSED');
        }
    } catch (e) {
        console.error('  -> Error POST admin/actions:', e.message);
        allPassed = false;
    }

    // 3. POST /v1/log-outcome with fake action -> 400 (not 422)
    try {
        const res = await fetch('http://localhost:3000/v1/log-outcome', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': 'key123',
                'X-Agent-ID': 'd0000000-0000-0000-0000-000000000001',
                'X-Customer-ID': 'a0000000-0000-0000-0000-000000000001'
            },
            body: JSON.stringify({
                session_id: '00000000-0000-0000-0000-000000000123',
                action_name: 'fake_action_does_not_exist',
                issue_type: 'payment_failed',
                success: true
            })
        });
        console.log(`3. POST /v1/log-outcome fake action -> Status: ${res.status}`);
        if (res.status !== 400) {
            console.error(`  -> FAILED: Expected 400, got ${res.status}`);
            allPassed = false;
        } else {
            const json = await res.json();
            console.log(`     Error Code: ${json.error}`);
            console.log('  -> PASSED');
        }
    } catch (e) {
        console.error('  -> Error POST log-outcome:', e.message);
        allPassed = false;
    }

    console.log('-------------------------------');
    if (allPassed) {
        console.log('ALL E2E CHECKS PASSED SUCCESSFULLY!');
    } else {
        console.log('SOME CHECKS FAILED.');
    }
}

checkE2E();
