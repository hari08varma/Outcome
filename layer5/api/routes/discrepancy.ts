import { Hono } from 'hono';
import { authMiddleware, devAuthMiddleware } from '../middleware/auth.js';
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
    execution_status: 'COMPLETED' | 'FAILED' | null;
    status_origin: string | null;
    failure_reason_code: string | null;
    failure_stage: string | null;
};

type CrossEventOutcomeRow = {
    outcome_id: string;
    action_id: string | null;
    success: boolean;
    outcome_score: number | null;
    signal_confidence: number | null;
    cross_event_status: string | null;
    inconsistency_type: string | null;
    inconsistency_reason: string | null;
    execution_status: 'COMPLETED' | 'FAILED' | null;
    status_origin: string | null;
    failure_reason_code: string | null;
    failure_stage: string | null;
};

type InconsistentOutcomeRow = {
    outcome_id: string;
    action_id: string | null;
    signal_confidence: number | null;
    inconsistency_type: string | null;
    inconsistency_reason: string | null;
    execution_status: 'COMPLETED' | 'FAILED' | null;
    status_origin: string | null;
    failure_reason_code: string | null;
    failure_stage: string | null;
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

type DiscrepancyTraceFields = {
    reason_code: string | null;
    trace_reason_code: string | null;
    trace_stage: string | null;
    trace_gate: string | null;
    source_execution_status: 'COMPLETED' | 'FAILED' | null;
    source_status_origin: string | null;
    source_failure_reason_code: string | null;
    source_failure_stage: string | null;
    trace_payload: Record<string, unknown> | null;
    trace_context: Record<string, unknown> | null;
};

const discrepancyRoute = new Hono();

const primaryAuth = process.env.NODE_ENV === 'production'
    ? authMiddleware
    : devAuthMiddleware;

discrepancyRoute.use('*', primaryAuth);

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

function buildTraceFields(overrides: Partial<DiscrepancyTraceFields>): DiscrepancyTraceFields {
    const normalizedReasonCode = overrides.reason_code ?? overrides.trace_reason_code ?? null;
    const normalizedTracePayload = overrides.trace_payload ?? overrides.trace_context ?? null;

    const merged: DiscrepancyTraceFields = {
        reason_code: normalizedReasonCode,
        trace_reason_code: null,
        trace_stage: null,
        trace_gate: null,
        source_execution_status: null,
        source_status_origin: null,
        source_failure_reason_code: null,
        source_failure_stage: null,
        trace_payload: normalizedTracePayload,
        trace_context: null,
        ...overrides,
    };

    merged.reason_code = normalizedReasonCode;
    merged.trace_reason_code = normalizedReasonCode;
    merged.trace_payload = normalizedTracePayload;
    merged.trace_context = normalizedTracePayload;
    return merged;
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
        let crossEventConflict = 0;
        let pendingStateMismatch = 0;
        let ingestionInconsistency = 0;

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
                    ...buildTraceFields({
                        trace_reason_code: 'pending_signal_expired',
                        trace_stage: 'signal_wait',
                        trace_gate: 'registration_expiry',
                        trace_context: {
                            event_type: row.event_type,
                            platform: row.platform,
                            expiry_at: row.expiry_at,
                        },
                    }),
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
                .select('outcome_id, success, signal_confidence, execution_status, status_origin, failure_reason_code, failure_stage')
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
                trace_reason_code: string | null;
                trace_stage: string | null;
                trace_gate: string | null;
                source_execution_status: 'COMPLETED' | 'FAILED' | null;
                source_status_origin: string | null;
                source_failure_reason_code: string | null;
                source_failure_stage: string | null;
                trace_context: Record<string, unknown> | null;
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
                trace_reason_code: string | null;
                trace_stage: string | null;
                trace_gate: string | null;
                source_execution_status: 'COMPLETED' | 'FAILED' | null;
                source_status_origin: string | null;
                source_failure_reason_code: string | null;
                source_failure_stage: string | null;
                trace_context: Record<string, unknown> | null;
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
                        ...buildTraceFields({
                            trace_reason_code: 'signal_outcome_mismatch',
                            trace_stage: 'signal_reconciliation',
                            trace_gate: 'confidence_polarity',
                            source_execution_status: outcome.execution_status,
                            source_status_origin: outcome.status_origin,
                            source_failure_reason_code: outcome.failure_reason_code,
                            source_failure_stage: outcome.failure_stage,
                            trace_context: {
                                event_type: registration.event_type,
                                platform: registration.platform,
                                expected_outcome: expectedOutcome,
                                actual_outcome: actualOutcome,
                            },
                        }),
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
                        ...buildTraceFields({
                            trace_reason_code: 'confidence_below_threshold',
                            trace_stage: 'signal_reconciliation',
                            trace_gate: 'critical_confidence_floor',
                            source_execution_status: outcome.execution_status,
                            source_status_origin: outcome.status_origin,
                            source_failure_reason_code: outcome.failure_reason_code,
                            source_failure_stage: outcome.failure_stage,
                            trace_context: {
                                event_type: registration.event_type,
                                platform: registration.platform,
                                threshold_used: 0.4,
                                observed_confidence: outcome.signal_confidence,
                            },
                        }),
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

        const { data: crossEventRows, error: crossEventError } = await supabase
            .from('fact_outcomes')
            .select('outcome_id, action_id, success, outcome_score, signal_confidence, cross_event_status, inconsistency_type, inconsistency_reason, execution_status, status_origin, failure_reason_code, failure_stage')
            .eq('customer_id', customerId)
            .eq('cross_event_status', 'conflict')
            .not('outcome_id', 'is', null);

        if (crossEventError) {
            return c.json({ error: 'Failed to load cross-event conflicts', details: crossEventError.message }, 500);
        }

        const crossEventOutcomeIds = [...new Set((crossEventRows ?? []).map((row: any) => row.outcome_id))];
        const existingCrossEventSet = new Set<string>();
        if (crossEventOutcomeIds.length > 0) {
            const { data: existingCrossEvent } = await supabase
                .from('dim_discrepancy_log')
                .select('outcome_id')
                .eq('customer_id', customerId)
                .eq('discrepancy_type', 'cross_event_conflict')
                .eq('resolved', false)
                .in('outcome_id', crossEventOutcomeIds.slice(0, 1000));

            for (const row of existingCrossEvent ?? []) {
                existingCrossEventSet.add((row as any).outcome_id);
            }
        }

        const crossEventInserts = ((crossEventRows ?? []) as CrossEventOutcomeRow[])
            .filter((row) => !existingCrossEventSet.has(row.outcome_id))
            .map((row) => {
                const actualOutcome = row.outcome_score === null
                    ? row.success
                    : row.outcome_score >= 0.5;

                return {
                    customer_id: customerId,
                    outcome_id: row.outcome_id,
                    action_name: row.action_id ? `action:${row.action_id}` : 'unknown_action',
                    discrepancy_type: 'cross_event_conflict',
                    expected_outcome: row.success,
                    actual_outcome: actualOutcome,
                    signal_confidence: row.signal_confidence,
                    detail: row.inconsistency_reason
                        ?? `Cross-event delayed signal conflict detected (expected=${String(row.success)} actual=${String(actualOutcome)}).`,
                    ...buildTraceFields({
                        trace_reason_code: row.inconsistency_type ?? 'cross_event_conflict',
                        trace_stage: 'cross_event_reconciliation',
                        trace_gate: 'cross_event_status_conflict',
                        source_execution_status: row.execution_status,
                        source_status_origin: row.status_origin,
                        source_failure_reason_code: row.failure_reason_code,
                        source_failure_stage: row.failure_stage,
                        trace_context: {
                            cross_event_status: row.cross_event_status,
                            inconsistency_reason: row.inconsistency_reason,
                            expected_outcome: row.success,
                            actual_outcome: actualOutcome,
                        },
                    }),
                };
            });

        if (crossEventInserts.length > 0) {
            const { error: crossEventInsertError } = await supabase
                .from('dim_discrepancy_log')
                .insert(crossEventInserts);

            if (crossEventInsertError) {
                return c.json({ error: 'Failed to write cross-event discrepancies', details: crossEventInsertError.message }, 500);
            }

            detected += crossEventInserts.length;
            crossEventConflict += crossEventInserts.length;
        }

        const { data: pendingOutcomes, error: pendingOutcomesError } = await supabase
            .from('fact_outcomes')
            .select('outcome_id')
            .eq('customer_id', customerId)
            .eq('signal_pending', true)
            .not('outcome_id', 'is', null);

        if (pendingOutcomesError) {
            return c.json({ error: 'Failed to load pending outcomes', details: pendingOutcomesError.message }, 500);
        }

        const { data: unresolvedRegs, error: unresolvedRegsError } = await supabase
            .from('dim_pending_signal_registrations')
            .select('registration_id, outcome_id, event_type, platform')
            .eq('customer_id', customerId)
            .eq('resolved', false)
            .not('outcome_id', 'is', null);

        if (unresolvedRegsError) {
            return c.json({ error: 'Failed to load unresolved registrations', details: unresolvedRegsError.message }, 500);
        }

        const pendingOutcomeSet = new Set<string>((pendingOutcomes ?? []).map((row: any) => row.outcome_id));
        const unresolvedByOutcome = new Map<string, { registration_id: string; event_type: string; platform: string }>();
        for (const reg of (unresolvedRegs ?? []) as Array<{ registration_id: string; outcome_id: string; event_type: string; platform: string }>) {
            if (!unresolvedByOutcome.has(reg.outcome_id)) {
                unresolvedByOutcome.set(reg.outcome_id, {
                    registration_id: reg.registration_id,
                    event_type: reg.event_type,
                    platform: reg.platform,
                });
            }
        }

        const mismatchOutcomeIds = new Set<string>();
        const pendingMismatchCandidates: Array<{
            customer_id: string;
            outcome_id: string;
            registration_id: string | null;
            action_name: string;
            discrepancy_type: 'pending_state_mismatch';
            detail: string;
            trace_reason_code: string | null;
            trace_stage: string | null;
            trace_gate: string | null;
            source_execution_status: 'COMPLETED' | 'FAILED' | null;
            source_status_origin: string | null;
            source_failure_reason_code: string | null;
            source_failure_stage: string | null;
            trace_context: Record<string, unknown> | null;
        }> = [];

        for (const outcomeId of pendingOutcomeSet) {
            if (!unresolvedByOutcome.has(outcomeId)) {
                mismatchOutcomeIds.add(outcomeId);
                pendingMismatchCandidates.push({
                    customer_id: customerId,
                    outcome_id: outcomeId,
                    registration_id: null,
                    action_name: 'signal_pending',
                    discrepancy_type: 'pending_state_mismatch',
                    detail: 'Outcome marked signal_pending=true but no unresolved registration exists.',
                    ...buildTraceFields({
                        trace_reason_code: 'pending_registration_state_mismatch',
                        trace_stage: 'pending_signal_state',
                        trace_gate: 'pending_registration_alignment',
                        trace_context: {
                            outcome_id: outcomeId,
                            pending_signal: true,
                            unresolved_registration_exists: false,
                        },
                    }),
                });
            }
        }

        for (const [outcomeId, reg] of unresolvedByOutcome.entries()) {
            if (!pendingOutcomeSet.has(outcomeId)) {
                mismatchOutcomeIds.add(outcomeId);
                pendingMismatchCandidates.push({
                    customer_id: customerId,
                    outcome_id: outcomeId,
                    registration_id: reg.registration_id,
                    action_name: `${reg.platform}:${reg.event_type}`,
                    discrepancy_type: 'pending_state_mismatch',
                    detail: 'Unresolved pending registration exists while outcome.signal_pending is false.',
                    ...buildTraceFields({
                        trace_reason_code: 'pending_registration_state_mismatch',
                        trace_stage: 'pending_signal_state',
                        trace_gate: 'pending_registration_alignment',
                        trace_context: {
                            outcome_id: outcomeId,
                            pending_signal: false,
                            unresolved_registration_exists: true,
                            event_type: reg.event_type,
                            platform: reg.platform,
                        },
                    }),
                });
            }
        }

        if (pendingMismatchCandidates.length > 0) {
            const { data: existingPendingMismatch } = await supabase
                .from('dim_discrepancy_log')
                .select('outcome_id')
                .eq('customer_id', customerId)
                .eq('discrepancy_type', 'pending_state_mismatch')
                .eq('resolved', false)
                .in('outcome_id', [...mismatchOutcomeIds].slice(0, 1000));

            const existingSet = new Set<string>((existingPendingMismatch ?? []).map((row: any) => row.outcome_id));
            const inserts = pendingMismatchCandidates.filter((row) => !existingSet.has(row.outcome_id));

            if (inserts.length > 0) {
                const { error: pendingMismatchInsertError } = await supabase
                    .from('dim_discrepancy_log')
                    .insert(inserts);

                if (pendingMismatchInsertError) {
                    return c.json({ error: 'Failed to write pending-state mismatches', details: pendingMismatchInsertError.message }, 500);
                }

                detected += inserts.length;
                pendingStateMismatch += inserts.length;
            }
        }

        const { data: inconsistentFactRows, error: inconsistentRowsError } = await supabase
            .from('fact_outcomes')
            .select('outcome_id, action_id, signal_confidence, inconsistency_type, inconsistency_reason, execution_status, status_origin, failure_reason_code, failure_stage')
            .eq('customer_id', customerId)
            .not('inconsistency_type', 'is', null)
            .not('outcome_id', 'is', null);

        if (inconsistentRowsError) {
            return c.json({ error: 'Failed to load ingestion inconsistencies', details: inconsistentRowsError.message }, 500);
        }

        const inconsistentRows = ((inconsistentFactRows ?? []) as InconsistentOutcomeRow[])
            .filter((row) => row.inconsistency_type !== null);
        const inconsistencyOutcomeIds = [...new Set(inconsistentRows.map((row) => row.outcome_id))];
        if (inconsistencyOutcomeIds.length > 0) {
            const { data: existingInconsistency } = await supabase
                .from('dim_discrepancy_log')
                .select('outcome_id')
                .eq('customer_id', customerId)
                .eq('discrepancy_type', 'ingestion_inconsistency')
                .eq('resolved', false)
                .in('outcome_id', inconsistencyOutcomeIds.slice(0, 1000));

            const existingSet = new Set<string>((existingInconsistency ?? []).map((row: any) => row.outcome_id));
            const inserts = inconsistentRows
                .filter((row) => !existingSet.has(row.outcome_id))
                .map((row) => ({
                    customer_id: customerId,
                    outcome_id: row.outcome_id,
                    action_name: row.action_id ? `action:${row.action_id}` : 'unknown_action',
                    discrepancy_type: 'ingestion_inconsistency',
                    signal_confidence: row.signal_confidence,
                    detail:
                        row.inconsistency_reason
                        ?? `Inconsistency taxonomy flagged type=${row.inconsistency_type}.`,
                    ...buildTraceFields({
                        trace_reason_code: row.inconsistency_type ?? 'ingestion_inconsistency',
                        trace_stage: 'ingest_validation',
                        trace_gate: 'inconsistency_taxonomy',
                        source_execution_status: row.execution_status,
                        source_status_origin: row.status_origin,
                        source_failure_reason_code: row.failure_reason_code,
                        source_failure_stage: row.failure_stage,
                        trace_context: {
                            inconsistency_reason: row.inconsistency_reason,
                            inconsistency_type: row.inconsistency_type,
                        },
                    }),
                }));

            if (inserts.length > 0) {
                const { error: inconsistencyInsertError } = await supabase
                    .from('dim_discrepancy_log')
                    .insert(inserts);

                if (inconsistencyInsertError) {
                    return c.json({ error: 'Failed to write ingestion inconsistencies', details: inconsistencyInsertError.message }, 500);
                }

                detected += inserts.length;
                ingestionInconsistency += inserts.length;
            }
        }

        return c.json({
            detected,
            cases: {
                expired,
                mismatch,
                low_confidence: lowConfidence,
            },
            advanced_cases: {
                cross_event_conflict: crossEventConflict,
                pending_state_mismatch: pendingStateMismatch,
                ingestion_inconsistency: ingestionInconsistency,
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
