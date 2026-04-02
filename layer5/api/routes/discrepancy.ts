import { Hono } from 'hono';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { supabase } from '../lib/supabase.js';

type PendingRegistration = {
    registration_id: string;
    outcome_id: string;
    event_type: string;
    platform: string;
    expiry_at: string;
    resolved: boolean;
};

type OutcomeSignalRow = {
    outcome_id: string;
    success: boolean;
    signal_confidence: number | null;
};

type ContractRow = {
    contract_id: string;
    action_id: string;
    event_type: string;
    platform: string;
};

type ActionRow = {
    action_id: string;
    action_name: string;
};

const discrepancyRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

discrepancyRoute.use('*', primaryAuth, rateLimitMiddleware());

async function hasUnresolvedDiscrepancy(
    customerId: string,
    outcomeId: string,
    discrepancyType: string,
): Promise<boolean> {
    const { data, error } = await supabase
        .from('dim_discrepancy_log')
        .select('discrepancy_id')
        .eq('customer_id', customerId)
        .eq('outcome_id', outcomeId)
        .eq('discrepancy_type', discrepancyType)
        .eq('resolved', false)
        .limit(1);

    if (error) {
        throw error;
    }

    return (data ?? []).length > 0;
}

discrepancyRoute.get('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    const { data, error } = await supabase
        .from('dim_discrepancy_log')
        .select('*')
        .eq('customer_id', customerId)
        .eq('resolved', false)
        .order('created_at', { ascending: false });

    if (error) {
        return c.json({ error: 'Failed to list discrepancies', details: error.message }, 500);
    }

    return c.json(data ?? [], 200);
});

discrepancyRoute.get('/summary', async (c) => {
    const customerId = c.get('customer_id') as string;

    const { data, error } = await supabase
        .from('dim_discrepancy_log')
        .select('discrepancy_type')
        .eq('customer_id', customerId)
        .eq('resolved', false);

    if (error) {
        return c.json({ error: 'Failed to summarize discrepancies', details: error.message }, 500);
    }

    const byType: Record<string, number> = {};
    for (const row of data ?? []) {
        const type = String((row as { discrepancy_type?: string }).discrepancy_type ?? 'unknown');
        byType[type] = (byType[type] ?? 0) + 1;
    }

    const total = Object.values(byType).reduce((acc, curr) => acc + curr, 0);

    return c.json({ total, by_type: byType }, 200);
});

discrepancyRoute.post('/detect', async (c) => {
    const customerId = c.get('customer_id') as string;

    try {
        let detected = 0;
        let expired = 0;
        let mismatch = 0;
        let lowConfidence = 0;

        const nowIso = new Date().toISOString();

        const { data: expiredRows, error: expiredError } = await supabase
            .from('dim_pending_signal_registrations')
            .select('registration_id, outcome_id, event_type, platform, expiry_at, resolved')
            .eq('customer_id', customerId)
            .eq('resolved', false)
            .lt('expiry_at', nowIso);

        if (expiredError) {
            return c.json({ error: 'Failed to scan expired registrations', details: expiredError.message }, 500);
        }

        if ((expiredRows ?? []).length > 0) {
            const expiredOutcomeIds = (expiredRows ?? []).map((r: PendingRegistration) => r.outcome_id);
            const existingExpiredSet = new Set<string>();
            if (expiredOutcomeIds.length > 0) {
                const { data: existingDups } = await supabase
                    .from('dim_discrepancy_log')
                    .select('outcome_id')
                    .eq('customer_id', customerId)
                    .eq('discrepancy_type', 'expired_no_signal')
                    .eq('resolved', false)
                    .in('outcome_id', expiredOutcomeIds.slice(0, 1000));

                for (const row of existingDups ?? []) {
                    existingExpiredSet.add((row as any).outcome_id);
                }
            }

            const expiredInserts = (expiredRows ?? [])
                .filter((row: PendingRegistration) => !existingExpiredSet.has(row.outcome_id))
                .map((row: PendingRegistration) => ({
                    customer_id: customerId,
                    outcome_id: row.outcome_id,
                    registration_id: row.registration_id,
                    action_name: row.event_type,
                    discrepancy_type: 'expired_no_signal',
                    detail: 'Signal registration expired without receiving a webhook',
                }));

            if (expiredInserts.length > 0) {
                const { error: bulkExpiredErr } = await supabase
                    .from('dim_discrepancy_log')
                    .insert(expiredInserts);
                if (bulkExpiredErr) {
                    return c.json({ error: 'Failed to write expired discrepancies', details: bulkExpiredErr.message }, 500);
                }
                expired += expiredInserts.length;
                detected += expiredInserts.length;
            }
        }

        const { data: allRegistrations, error: registrationError } = await supabase
            .from('dim_pending_signal_registrations')
            .select('registration_id, outcome_id, event_type, platform')
            .eq('customer_id', customerId);

        if (registrationError) {
            return c.json({ error: 'Failed to load pending registrations', details: registrationError.message }, 500);
        }

        const registrations = (allRegistrations ?? []) as Array<Pick<PendingRegistration, 'registration_id' | 'outcome_id' | 'event_type' | 'platform'>>;
        // Cap at 1000 — beyond this, the .in() clause exceeds PostgREST limits.
        // A scheduled job should handle bulk backlog; the /detect endpoint is for
        // real-time incremental detection only.
        const outcomeIds = registrations.map((r) => r.outcome_id).slice(0, 1000);

        if (outcomeIds.length > 0) {
            const registrationByOutcome = new Map<string, Pick<PendingRegistration, 'registration_id' | 'event_type' | 'platform'>>();
            for (const reg of registrations) {
                if (!registrationByOutcome.has(reg.outcome_id)) {
                    registrationByOutcome.set(reg.outcome_id, {
                        registration_id: reg.registration_id,
                        event_type: reg.event_type,
                        platform: reg.platform,
                    });
                }
            }

            const { data: contracts, error: contractsError } = await supabase
                .from('dim_signal_contracts')
                .select('contract_id, action_id, event_type, platform')
                .eq('customer_id', customerId)
                .eq('is_active', true);

            if (contractsError) {
                return c.json({ error: 'Failed to load active contracts', details: contractsError.message }, 500);
            }

            const activeContracts = (contracts ?? []) as ContractRow[];
            const contractByEventPlatform = new Map<string, ContractRow>();
            for (const contract of activeContracts) {
                const key = `${contract.event_type}::${contract.platform}`;
                if (!contractByEventPlatform.has(key)) {
                    contractByEventPlatform.set(key, contract);
                }
            }

            const actionIds = [...new Set(activeContracts.map((contract) => contract.action_id))];
            const actionNameById = new Map<string, string>();
            if (actionIds.length > 0) {
                const { data: actions, error: actionsError } = await supabase
                    .from('dim_actions')
                    .select('action_id, action_name')
                    .in('action_id', actionIds);

                if (actionsError) {
                    return c.json({ error: 'Failed to resolve action names', details: actionsError.message }, 500);
                }

                for (const action of (actions ?? []) as ActionRow[]) {
                    actionNameById.set(action.action_id, action.action_name);
                }
            }

            const { data: outcomes, error: outcomesError } = await supabase
                .from('fact_outcomes')
                .select('outcome_id, success, signal_confidence')
                .in('outcome_id', outcomeIds)
                .not('signal_confidence', 'is', null);

            if (outcomesError) {
                return c.json({ error: 'Failed to scan outcomes', details: outcomesError.message }, 500);
            }

            const mismatchCandidates: Array<{
                customer_id: string;
                outcome_id: string;
                registration_id: string;
                contract_id: string | null;
                action_name: string;
                discrepancy_type: 'outcome_mismatch';
                expected_outcome: boolean;
                actual_outcome: boolean;
                signal_confidence: number;
                detail: string;
            }> = [];
            const lowConfidenceCandidates: Array<{
                customer_id: string;
                outcome_id: string;
                registration_id: string;
                contract_id: string | null;
                action_name: string;
                discrepancy_type: 'confidence_below_threshold';
                actual_outcome: true;
                signal_confidence: number;
                threshold_used: number;
                detail: string;
            }> = [];

            for (const outcome of (outcomes ?? []) as OutcomeSignalRow[]) {
                const registration = registrationByOutcome.get(outcome.outcome_id);
                if (!registration || outcome.signal_confidence === null) continue;

                const key = `${registration.event_type}::${registration.platform}`;
                const contract = contractByEventPlatform.get(key);
                const actionName = contract
                    ? (actionNameById.get(contract.action_id) ?? registration.event_type)
                    : registration.event_type;

                const expectedOutcome = outcome.signal_confidence >= 0.5;
                const actualOutcome = Boolean(outcome.success);

                if (actualOutcome !== expectedOutcome) {
                    mismatchCandidates.push({
                        customer_id: customerId,
                        outcome_id: outcome.outcome_id,
                        registration_id: registration.registration_id,
                        contract_id: contract?.contract_id ?? null,
                        action_name: actionName,
                        discrepancy_type: 'outcome_mismatch',
                        expected_outcome: expectedOutcome,
                        actual_outcome: actualOutcome,
                        signal_confidence: outcome.signal_confidence,
                        detail: 'Signal outcome contradicts confidence score',
                    });
                }

                if (outcome.signal_confidence < 0.4 && actualOutcome === true) {
                    lowConfidenceCandidates.push({
                        customer_id: customerId,
                        outcome_id: outcome.outcome_id,
                        registration_id: registration.registration_id,
                        contract_id: contract?.contract_id ?? null,
                        action_name: actionName,
                        discrepancy_type: 'confidence_below_threshold',
                        actual_outcome: true,
                        signal_confidence: outcome.signal_confidence,
                        threshold_used: 0.4,
                        detail: 'Outcome marked success but confidence is critically low',
                    });
                }
            }

            const mismatchOutcomeIds = [...new Set(mismatchCandidates.map((row) => row.outcome_id))];
            const existingMismatchSet = new Set<string>();
            if (mismatchOutcomeIds.length > 0) {
                const { data: existingMismatch } = await supabase
                    .from('dim_discrepancy_log')
                    .select('outcome_id')
                    .eq('customer_id', customerId)
                    .eq('discrepancy_type', 'outcome_mismatch')
                    .eq('resolved', false)
                    .in('outcome_id', mismatchOutcomeIds.slice(0, 1000));

                for (const row of existingMismatch ?? []) {
                    existingMismatchSet.add((row as any).outcome_id);
                }
            }

            const mismatchInserts = mismatchCandidates
                .filter((row) => !existingMismatchSet.has(row.outcome_id));
            if (mismatchInserts.length > 0) {
                const { error: bulkMismatchErr } = await supabase
                    .from('dim_discrepancy_log')
                    .insert(mismatchInserts);

                if (bulkMismatchErr) {
                    return c.json({ error: 'Failed to write outcome mismatch discrepancy', details: bulkMismatchErr.message }, 500);
                }

                detected += mismatchInserts.length;
                mismatch += mismatchInserts.length;
            }

            const lowConfidenceOutcomeIds = [...new Set(lowConfidenceCandidates.map((row) => row.outcome_id))];
            const existingLowConfidenceSet = new Set<string>();
            if (lowConfidenceOutcomeIds.length > 0) {
                const { data: existingLowConfidence } = await supabase
                    .from('dim_discrepancy_log')
                    .select('outcome_id')
                    .eq('customer_id', customerId)
                    .eq('discrepancy_type', 'confidence_below_threshold')
                    .eq('resolved', false)
                    .in('outcome_id', lowConfidenceOutcomeIds.slice(0, 1000));

                for (const row of existingLowConfidence ?? []) {
                    existingLowConfidenceSet.add((row as any).outcome_id);
                }
            }

            const lowConfidenceInserts = lowConfidenceCandidates
                .filter((row) => !existingLowConfidenceSet.has(row.outcome_id));
            if (lowConfidenceInserts.length > 0) {
                const { error: bulkLowConfidenceErr } = await supabase
                    .from('dim_discrepancy_log')
                    .insert(lowConfidenceInserts);

                if (bulkLowConfidenceErr) {
                    return c.json({ error: 'Failed to write low confidence discrepancy', details: bulkLowConfidenceErr.message }, 500);
                }

                detected += lowConfidenceInserts.length;
                lowConfidence += lowConfidenceInserts.length;
            }
        }

        return c.json({
            detected,
            cases: {
                expired,
                mismatch,
                low_confidence: lowConfidence,
            },
        }, 200);
    } catch (err: any) {
        return c.json({ error: 'Failed to run discrepancy detection', details: err?.message ?? 'Unknown error' }, 500);
    }
});

discrepancyRoute.patch('/:discrepancy_id/resolve', async (c) => {
    const customerId = c.get('customer_id') as string;
    const discrepancyId = c.req.param('discrepancy_id');

    const { data, error } = await supabase
        .from('dim_discrepancy_log')
        .update({
            resolved: true,
            resolved_at: new Date().toISOString(),
        })
        .eq('discrepancy_id', discrepancyId)
        .eq('customer_id', customerId)
        .select('discrepancy_id');

    if (error) {
        return c.json({ error: 'Failed to resolve discrepancy', details: error.message }, 500);
    }

    if (!data || data.length === 0) {
        return c.json({ error: 'Discrepancy not found', code: 'NOT_FOUND' }, 404);
    }

    return new Response(null, { status: 204 });
});

export default discrepancyRoute;
