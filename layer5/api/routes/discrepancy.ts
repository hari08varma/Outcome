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

        for (const row of (expiredRows ?? []) as PendingRegistration[]) {
            const duplicate = await hasUnresolvedDiscrepancy(customerId, row.outcome_id, 'expired_no_signal');
            if (duplicate) continue;

            const { error: insertError } = await supabase
                .from('dim_discrepancy_log')
                .insert({
                    customer_id: customerId,
                    outcome_id: row.outcome_id,
                    registration_id: row.registration_id,
                    action_name: row.event_type,
                    discrepancy_type: 'expired_no_signal',
                    detail: 'Signal registration expired without receiving a webhook',
                });

            if (insertError) {
                return c.json({ error: 'Failed to write expired discrepancy', details: insertError.message }, 500);
            }

            detected++;
            expired++;
        }

        const { data: allRegistrations, error: registrationError } = await supabase
            .from('dim_pending_signal_registrations')
            .select('registration_id, outcome_id, event_type, platform')
            .eq('customer_id', customerId);

        if (registrationError) {
            return c.json({ error: 'Failed to load pending registrations', details: registrationError.message }, 500);
        }

        const registrations = (allRegistrations ?? []) as Array<Pick<PendingRegistration, 'registration_id' | 'outcome_id' | 'event_type' | 'platform'>>;
        const outcomeIds = registrations.map((r) => r.outcome_id);

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
                    const duplicate = await hasUnresolvedDiscrepancy(customerId, outcome.outcome_id, 'outcome_mismatch');
                    if (!duplicate) {
                        const { error: insertError } = await supabase
                            .from('dim_discrepancy_log')
                            .insert({
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

                        if (insertError) {
                            return c.json({ error: 'Failed to write outcome mismatch discrepancy', details: insertError.message }, 500);
                        }

                        detected++;
                        mismatch++;
                    }
                }

                if (outcome.signal_confidence < 0.4 && actualOutcome === true) {
                    const duplicate = await hasUnresolvedDiscrepancy(customerId, outcome.outcome_id, 'confidence_below_threshold');
                    if (!duplicate) {
                        const { error: insertError } = await supabase
                            .from('dim_discrepancy_log')
                            .insert({
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

                        if (insertError) {
                            return c.json({ error: 'Failed to write low confidence discrepancy', details: insertError.message }, 500);
                        }

                        detected++;
                        lowConfidence++;
                    }
                }
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
