#!/usr/bin/env node
// Run locally to verify the health endpoint works
// before setting up external monitoring.

const API_URL = process.env.LAYERINFINITE_API_URL
    || 'http://localhost:3000';

async function checkHealth() {
    console.log(`Checking ${API_URL}/health...`);

    try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json();

        if (res.status !== 200) {
            console.error('❌ Health check FAILED:', data);
            process.exit(1);
        }

        console.log('✓ Status:', data.status);
        console.log('✓ DB connected:', data.checks?.database === 'ok');

        if (data.status !== 'ok') {
            console.warn('⚠ Status is not "ok":', data.status);
            process.exit(2);
        }

        console.log('\n✅ Health check passed.');
        console.log('Ready to set up external monitoring.');

    } catch (err) {
        if (err instanceof Error) {
            console.error('❌ Cannot reach API:', err.message);
        } else {
            console.error('❌ Cannot reach API:', err);
        }
        console.error('Check that the API is running and');
        console.error('LAYERINFINITE_API_URL is set correctly.');
        process.exit(1);
    }
}

checkHealth();
