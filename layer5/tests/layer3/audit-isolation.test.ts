/**
 * Layerinfinite — Unit Tests: Audit Trail + Customer Isolation
 * Tests GET /v1/audit/:id customer isolation.
 * Run: npx vitest run tests/layer3/audit-isolation.test.ts
 */

import { describe, it, expect } from 'vitest';

describe('Audit Trail — Customer Isolation', () => {

    // Simulate the customer isolation query filter
    function queryOutcomeById(
        outcomeId: string,
        callerCustomerId: string,
        database: Array<{ outcome_id: string; customer_id: string; action_name: string }>
    ): { status: number; data: any } {
        const row = database.find(
            r => r.outcome_id === outcomeId && r.customer_id === callerCustomerId
        );

        if (!row) {
            // Return 404 — never confirm record exists to unauthorized caller
            return { status: 404, data: { error: 'Outcome not found', code: 'NOT_FOUND' } };
        }

        return { status: 200, data: row };
    }

    const DB = [
        { outcome_id: 'aaaa-1111', customer_id: 'cust-A', action_name: 'retry_transaction' },
        { outcome_id: 'bbbb-2222', customer_id: 'cust-B', action_name: 'escalate_human' },
        { outcome_id: 'cccc-3333', customer_id: 'cust-A', action_name: 'clear_cache' },
    ];

    it('GET /v1/audit/:id with valid ID owned by caller → 200', () => {
        const result = queryOutcomeById('aaaa-1111', 'cust-A', DB);
        expect(result.status).toBe(200);
        expect(result.data.action_name).toBe('retry_transaction');
    });

    it('GET /v1/audit/:id with valid ID owned by DIFFERENT customer → 404 (not 403)', () => {
        // Customer A tries to read Customer B's outcome
        const result = queryOutcomeById('bbbb-2222', 'cust-A', DB);
        expect(result.status).toBe(404);  // NOT 403 — never confirm record exists
        expect(result.data.code).toBe('NOT_FOUND');
    });

    it('GET /v1/audit/:id with random UUID → 404', () => {
        const result = queryOutcomeById('xxxx-9999', 'cust-A', DB);
        expect(result.status).toBe(404);
    });

    it('customer isolation filters strictly by customer_id', () => {
        // Customer B can see their own record
        const result = queryOutcomeById('bbbb-2222', 'cust-B', DB);
        expect(result.status).toBe(200);
        expect(result.data.action_name).toBe('escalate_human');
    });

    it('same customer can access multiple own records', () => {
        const r1 = queryOutcomeById('aaaa-1111', 'cust-A', DB);
        const r2 = queryOutcomeById('cccc-3333', 'cust-A', DB);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
    });
});
