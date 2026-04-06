import type {
    RecommendationNoiseGateMeta,
    RecommendationResult,
} from './engine.js';
import type {
    CohortCycleCloseReason,
    RecommendationCohortCycleResult,
} from './cohort-cycle.js';

export type CohortReliabilityBand = 'stable' | 'watch' | 'anomalous';

export interface CohortReliabilityResult {
    anomaly_score: number;
    reliability_score: number;
    band: CohortReliabilityBand;
    signals: {
        rotation_triggered: boolean;
        rotation_reason: CohortCycleCloseReason | null;
        noisy_task: boolean;
        confidence: number;
        min_sample_count: number;
        silent_failure_warning: boolean;
    };
    reasons: string[];
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function toBand(reliabilityScore: number): CohortReliabilityBand {
    if (reliabilityScore < 0.45) return 'anomalous';
    if (reliabilityScore < 0.75) return 'watch';
    return 'stable';
}

function noiseAnomalyContribution(noiseGate: RecommendationNoiseGateMeta | undefined): {
    score: number;
    reasons: string[];
} {
    if (!noiseGate || !noiseGate.enabled) {
        return { score: 0, reasons: [] };
    }

    if (!noiseGate.is_noisy_task) {
        return { score: 0, reasons: [] };
    }

    const score = Math.max(0.10, Math.min(0.30, noiseGate.task_noise_score * 0.30));
    const reasons = ['task_noise_detected'];
    if (noiseGate.decision_gate_reason) {
        reasons.push(`noise_gate_reason:${noiseGate.decision_gate_reason}`);
    }

    return {
        score: Number(score.toFixed(4)),
        reasons,
    };
}

function cycleAnomalyContribution(
    cohortCycle: RecommendationCohortCycleResult,
): { score: number; reasons: string[] } {
    if (!cohortCycle.rotation_triggered || !cohortCycle.rotation_reason) {
        return { score: 0, reasons: [] };
    }

    const byReason: Record<CohortCycleCloseReason, number> = {
        confidence_drop: 0.35,
        success_rate_drop: 0.30,
        outcome_count: 0.12,
        time_elapsed: 0.08,
    };

    const score = byReason[cohortCycle.rotation_reason] ?? 0.10;

    return {
        score: Number(score.toFixed(4)),
        reasons: [`cycle_rotation:${cohortCycle.rotation_reason}`],
    };
}

export function computeCohortReliability(
    recommendation: RecommendationResult,
    cohortCycle: RecommendationCohortCycleResult,
): CohortReliabilityResult {
    const reasons: string[] = [];
    let anomalyScore = 0;

    const cycleSignal = cycleAnomalyContribution(cohortCycle);
    anomalyScore += cycleSignal.score;
    reasons.push(...cycleSignal.reasons);

    const noiseSignal = noiseAnomalyContribution(recommendation._noise_gate);
    anomalyScore += noiseSignal.score;
    reasons.push(...noiseSignal.reasons);

    const confidence = clamp01(recommendation.confidence ?? 0);
    if (confidence < 0.30) {
        anomalyScore += 0.22;
        reasons.push('confidence_below_0_30');
    } else if (confidence < 0.50) {
        anomalyScore += 0.12;
        reasons.push('confidence_below_0_50');
    }

    const minSamples = Math.max(0, Number(recommendation.min_sample_count ?? 0));
    if (minSamples < 10) {
        anomalyScore += 0.20;
        reasons.push('insufficient_min_samples_lt_10');
    } else if (minSamples < 25) {
        anomalyScore += 0.12;
        reasons.push('insufficient_min_samples_lt_25');
    }

    if (recommendation._silent_failure_warning === true) {
        anomalyScore += 0.20;
        reasons.push('silent_failure_warning_active');
    }

    if (recommendation.state === 'no_data') {
        anomalyScore = Math.max(anomalyScore, 0.70);
        reasons.push('recommendation_state_no_data');
    } else if (recommendation.state === 'early_signal') {
        anomalyScore += 0.08;
        reasons.push('recommendation_state_early_signal');
    }

    const normalizedAnomaly = Number(clamp01(anomalyScore).toFixed(4));
    const reliabilityScore = Number((1 - normalizedAnomaly).toFixed(4));

    return {
        anomaly_score: normalizedAnomaly,
        reliability_score: reliabilityScore,
        band: toBand(reliabilityScore),
        signals: {
            rotation_triggered: cohortCycle.rotation_triggered,
            rotation_reason: cohortCycle.rotation_reason,
            noisy_task: recommendation._noise_gate?.is_noisy_task ?? false,
            confidence,
            min_sample_count: minSamples,
            silent_failure_warning: recommendation._silent_failure_warning === true,
        },
        reasons,
    };
}
