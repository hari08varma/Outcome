import crypto from 'node:crypto';

import { supabase } from '../supabase.js';

export const COHORT_CYCLE_MAX_DAYS = 7;
export const COHORT_CYCLE_MAX_OUTCOMES = 100;
export const COHORT_EARLY_CLOSE_CONFIDENCE_DROP = 0.10;
export const COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP = 0.15;

export type CohortCycleCloseReason =
    | 'time_elapsed'
    | 'outcome_count'
    | 'confidence_drop'
    | 'success_rate_drop';

export type RecommendationConfidenceSource =
    | 'bootstrap'
    | 'empirical_warmup'
    | 'empirical_stable'
    | 'hybrid_shadow';

interface CohortCycleState {
    cycle_id: string;
    customer_id: string;
    task_name: string;
    opened_at: string;
    opened_total_outcomes: number;
    opened_median_confidence: number | null;
    opened_median_success_rate: number | null;
    opened_confidence_source: RecommendationConfidenceSource | null;
    opened_confidence_source_reason: string | null;
}

export interface CohortCycleObservation {
    customer_id: string;
    task_name: string;
    observed_at: string;
    total_outcomes: number;
    median_confidence: number | null;
    median_success_rate: number | null;
    confidence_source?: RecommendationConfidenceSource | null;
    confidence_source_reason?: string | null;
}

export interface CohortCycleBoundaryDecision {
    should_rotate: boolean;
    reason: CohortCycleCloseReason | null;
    elapsed_days: number;
    outcomes_in_cycle: number;
    confidence_drop: number | null;
    success_rate_drop: number | null;
}

export interface RecommendationCohortCycleSnapshot {
    cycle_id: string;
    opened_at: string;
    closed_at: string | null;
    close_reason: CohortCycleCloseReason | null;
    elapsed_days: number;
    outcomes_in_cycle: number;
    opened_confidence_source: RecommendationConfidenceSource | null;
    opened_confidence_source_reason: string | null;
}

export interface RecommendationCohortCycleResult {
    active_cycle: RecommendationCohortCycleSnapshot;
    previous_cycle: RecommendationCohortCycleSnapshot | null;
    rotation_triggered: boolean;
    rotation_reason: CohortCycleCloseReason | null;
    thresholds: {
        max_days: number;
        max_outcomes: number;
        confidence_drop: number;
        success_rate_drop: number;
    };
}

const cycleStore = new Map<string, CohortCycleState>();

function cycleKey(customerId: string, taskName: string): string {
    return `${customerId}::${taskName}`;
}

function clamp01(value: number | null | undefined): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, Number(value)));
}

function normalizeConfidenceSource(value: unknown): RecommendationConfidenceSource | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'bootstrap') return 'bootstrap';
    if (normalized === 'empirical_warmup') return 'empirical_warmup';
    if (normalized === 'empirical_stable') return 'empirical_stable';
    if (normalized === 'hybrid_shadow') return 'hybrid_shadow';
    return null;
}

function normalizeConfidenceSourceReason(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeTotalOutcomes(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

function toEpochMs(iso: string): number {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildActiveSnapshot(
    state: CohortCycleState,
    elapsedDays: number,
    outcomesInCycle: number,
): RecommendationCohortCycleSnapshot {
    return {
        cycle_id: state.cycle_id,
        opened_at: state.opened_at,
        closed_at: null,
        close_reason: null,
        elapsed_days: Number(elapsedDays.toFixed(4)),
        outcomes_in_cycle: outcomesInCycle,
        opened_confidence_source: state.opened_confidence_source,
        opened_confidence_source_reason: state.opened_confidence_source_reason,
    };
}

export function evaluateCohortCycleBoundary(
    active: CohortCycleState,
    observation: CohortCycleObservation,
): CohortCycleBoundaryDecision {
    const openedMs = toEpochMs(active.opened_at);
    const observedMs = toEpochMs(observation.observed_at);
    const elapsedDays = Math.max(0, (observedMs - openedMs) / (24 * 60 * 60 * 1000));

    const outcomesInCycle = Math.max(
        0,
        normalizeTotalOutcomes(observation.total_outcomes) - active.opened_total_outcomes,
    );

    const currentConfidence = clamp01(observation.median_confidence);
    const openedConfidence = clamp01(active.opened_median_confidence);
    const confidenceDrop =
        openedConfidence !== null && currentConfidence !== null
            ? Number((openedConfidence - currentConfidence).toFixed(4))
            : null;

    const currentSuccessRate = clamp01(observation.median_success_rate);
    const openedSuccessRate = clamp01(active.opened_median_success_rate);
    const successRateDrop =
        openedSuccessRate !== null && currentSuccessRate !== null
            ? Number((openedSuccessRate - currentSuccessRate).toFixed(4))
            : null;

    if (confidenceDrop !== null && confidenceDrop >= COHORT_EARLY_CLOSE_CONFIDENCE_DROP) {
        return {
            should_rotate: true,
            reason: 'confidence_drop',
            elapsed_days: Number(elapsedDays.toFixed(4)),
            outcomes_in_cycle: outcomesInCycle,
            confidence_drop: confidenceDrop,
            success_rate_drop: successRateDrop,
        };
    }

    if (successRateDrop !== null && successRateDrop >= COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP) {
        return {
            should_rotate: true,
            reason: 'success_rate_drop',
            elapsed_days: Number(elapsedDays.toFixed(4)),
            outcomes_in_cycle: outcomesInCycle,
            confidence_drop: confidenceDrop,
            success_rate_drop: successRateDrop,
        };
    }

    if (outcomesInCycle >= COHORT_CYCLE_MAX_OUTCOMES) {
        return {
            should_rotate: true,
            reason: 'outcome_count',
            elapsed_days: Number(elapsedDays.toFixed(4)),
            outcomes_in_cycle: outcomesInCycle,
            confidence_drop: confidenceDrop,
            success_rate_drop: successRateDrop,
        };
    }

    if (elapsedDays >= COHORT_CYCLE_MAX_DAYS) {
        return {
            should_rotate: true,
            reason: 'time_elapsed',
            elapsed_days: Number(elapsedDays.toFixed(4)),
            outcomes_in_cycle: outcomesInCycle,
            confidence_drop: confidenceDrop,
            success_rate_drop: successRateDrop,
        };
    }

    return {
        should_rotate: false,
        reason: null,
        elapsed_days: Number(elapsedDays.toFixed(4)),
        outcomes_in_cycle: outcomesInCycle,
        confidence_drop: confidenceDrop,
        success_rate_drop: successRateDrop,
    };
}

function newCycleState(observation: CohortCycleObservation): CohortCycleState {
    return {
        cycle_id: crypto.randomUUID(),
        customer_id: observation.customer_id,
        task_name: observation.task_name,
        opened_at: observation.observed_at,
        opened_total_outcomes: normalizeTotalOutcomes(observation.total_outcomes),
        opened_median_confidence: clamp01(observation.median_confidence),
        opened_median_success_rate: clamp01(observation.median_success_rate),
        opened_confidence_source: normalizeConfidenceSource(observation.confidence_source),
        opened_confidence_source_reason: normalizeConfidenceSourceReason(observation.confidence_source_reason),
    };
}

export function resetRecommendationCohortCycleStore(): void {
    cycleStore.clear();
}

function fallbackUpsertRecommendationCohortCycle(
    observation: CohortCycleObservation,
): RecommendationCohortCycleResult {
    const key = cycleKey(observation.customer_id, observation.task_name);
    const existing = cycleStore.get(key);

    if (!existing) {
        const created = newCycleState(observation);
        cycleStore.set(key, created);

        return {
            active_cycle: buildActiveSnapshot(created, 0, 0),
            previous_cycle: null,
            rotation_triggered: false,
            rotation_reason: null,
            thresholds: {
                max_days: COHORT_CYCLE_MAX_DAYS,
                max_outcomes: COHORT_CYCLE_MAX_OUTCOMES,
                confidence_drop: COHORT_EARLY_CLOSE_CONFIDENCE_DROP,
                success_rate_drop: COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP,
            },
        };
    }

    const decision = evaluateCohortCycleBoundary(existing, observation);

    if (!decision.should_rotate || !decision.reason) {
        return {
            active_cycle: buildActiveSnapshot(
                existing,
                decision.elapsed_days,
                decision.outcomes_in_cycle,
            ),
            previous_cycle: null,
            rotation_triggered: false,
            rotation_reason: null,
            thresholds: {
                max_days: COHORT_CYCLE_MAX_DAYS,
                max_outcomes: COHORT_CYCLE_MAX_OUTCOMES,
                confidence_drop: COHORT_EARLY_CLOSE_CONFIDENCE_DROP,
                success_rate_drop: COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP,
            },
        };
    }

    const previousCycle: RecommendationCohortCycleSnapshot = {
        cycle_id: existing.cycle_id,
        opened_at: existing.opened_at,
        closed_at: observation.observed_at,
        close_reason: decision.reason,
        elapsed_days: decision.elapsed_days,
        outcomes_in_cycle: decision.outcomes_in_cycle,
        opened_confidence_source: existing.opened_confidence_source,
        opened_confidence_source_reason: existing.opened_confidence_source_reason,
    };

    const nextCycle = newCycleState(observation);
    cycleStore.set(key, nextCycle);

    return {
        active_cycle: buildActiveSnapshot(nextCycle, 0, 0),
        previous_cycle: previousCycle,
        rotation_triggered: true,
        rotation_reason: decision.reason,
        thresholds: {
            max_days: COHORT_CYCLE_MAX_DAYS,
            max_outcomes: COHORT_CYCLE_MAX_OUTCOMES,
            confidence_drop: COHORT_EARLY_CLOSE_CONFIDENCE_DROP,
            success_rate_drop: COHORT_EARLY_CLOSE_SUCCESS_RATE_DROP,
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isCohortCycleResult(value: unknown): value is RecommendationCohortCycleResult {
    if (!isObject(value)) return false;
    if (!isObject(value.active_cycle)) return false;
    if (typeof value.rotation_triggered !== 'boolean') return false;
    if (!isObject(value.thresholds)) return false;
    return typeof value.active_cycle.cycle_id === 'string';
}

function isMissingRpcFunctionError(error: { code?: string | null; message?: string | null }): boolean {
    const msg = String(error.message ?? '').toLowerCase();
    return error.code === '42883' || (msg.includes('upsert_recommendation_cohort_cycle') && msg.includes('function'));
}

export async function upsertRecommendationCohortCycle(
    observation: CohortCycleObservation,
): Promise<RecommendationCohortCycleResult> {
    const resolvedConfidenceSource = normalizeConfidenceSource(observation.confidence_source);
    const resolvedConfidenceSourceReason = normalizeConfidenceSourceReason(observation.confidence_source_reason);

    const payload = {
        p_customer_id: observation.customer_id,
        p_task_name: observation.task_name,
        p_observed_at: observation.observed_at,
        p_total_outcomes: normalizeTotalOutcomes(observation.total_outcomes),
        p_median_confidence: clamp01(observation.median_confidence),
        p_median_success_rate: clamp01(observation.median_success_rate),
        p_opened_confidence_source: resolvedConfidenceSource,
        p_opened_confidence_source_reason: resolvedConfidenceSourceReason,
    };

    try {
        const { data, error } = await supabase.rpc('upsert_recommendation_cohort_cycle', payload as any);

        if (error) {
            const fallback = fallbackUpsertRecommendationCohortCycle(observation);
            if (isMissingRpcFunctionError(error)) {
                console.warn(
                    '[cohort-cycle] upsert_recommendation_cohort_cycle RPC unavailable; using in-memory fallback:',
                    error.message,
                );
                return fallback;
            }

            console.warn(
                '[cohort-cycle] RPC failed; using in-memory fallback:',
                error.message,
            );
            return fallback;
        }

        if (!isCohortCycleResult(data)) {
            console.warn(
                '[cohort-cycle] RPC returned unexpected payload shape; using in-memory fallback.',
            );
            return fallbackUpsertRecommendationCohortCycle(observation);
        }

        return {
            ...data,
            active_cycle: {
                ...data.active_cycle,
                opened_confidence_source:
                    data.active_cycle.opened_confidence_source
                    ?? resolvedConfidenceSource
                    ?? null,
                opened_confidence_source_reason:
                    data.active_cycle.opened_confidence_source_reason
                    ?? resolvedConfidenceSourceReason
                    ?? null,
            },
            previous_cycle: data.previous_cycle
                ? {
                    ...data.previous_cycle,
                    opened_confidence_source:
                        data.previous_cycle.opened_confidence_source ?? null,
                    opened_confidence_source_reason:
                        data.previous_cycle.opened_confidence_source_reason ?? null,
                }
                : null,
        };
    } catch (err: any) {
        console.warn(
            '[cohort-cycle] RPC threw; using in-memory fallback:',
            err?.message ?? 'unknown error',
        );
        return fallbackUpsertRecommendationCohortCycle(observation);
    }
}
