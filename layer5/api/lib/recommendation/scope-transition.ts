import { MIN_SAMPLES, MIN_SAMPLES_STABLE } from './constants.js';

export type RecommendationScope = 'agent_scoped' | 'customer_blended';

export interface ScopeTransitionCandidate {
    state: 'no_data' | 'early_signal' | 'stable';
    min_sample_count: number;
    confidence: number | null;
    has_best_action: boolean;
}

export const AGENT_SCOPE_MIN_CONFIDENCE = 0.50;
export const BLENDED_FALLBACK_MIN_CONFIDENCE = 0.30;
export const BLENDED_EVIDENCE_MARGIN = 0.15;

function confidenceValue(result: ScopeTransitionCandidate): number {
    return Math.max(0, Math.min(1, result.confidence ?? 0));
}

function evidenceScore(result: ScopeTransitionCandidate): number {
    const normalizedSamples = Math.min(1, result.min_sample_count / MIN_SAMPLES_STABLE);
    const confidence = confidenceValue(result);
    return Number((normalizedSamples * 0.6 + confidence * 0.4).toFixed(4));
}

function isAgentEvidenceMature(result: ScopeTransitionCandidate): boolean {
    if (result.state === 'stable') {
        return true;
    }
    return result.min_sample_count >= MIN_SAMPLES_STABLE
        && confidenceValue(result) >= AGENT_SCOPE_MIN_CONFIDENCE;
}

function canUseBlendedFallback(result: ScopeTransitionCandidate): boolean {
    if (result.state === 'no_data') {
        return false;
    }
    if (!result.has_best_action) {
        return false;
    }
    return result.min_sample_count >= MIN_SAMPLES
        && confidenceValue(result) >= BLENDED_FALLBACK_MIN_CONFIDENCE;
}

export function chooseScopedOrBlendedCandidate(
    scopedResult: ScopeTransitionCandidate,
    blendedResult: ScopeTransitionCandidate,
): {
    servedScope: RecommendationScope;
    reason: string | null;
} {
    if (isAgentEvidenceMature(scopedResult)) {
        return {
            servedScope: 'agent_scoped',
            reason: null,
        };
    }

    if (!canUseBlendedFallback(blendedResult)) {
        return {
            servedScope: 'agent_scoped',
            reason: 'Agent-specific evidence is still warming, and blended cohort evidence did not pass minimum reliability gates.',
        };
    }

    const scopedEvidence = evidenceScore(scopedResult);
    const blendedEvidence = evidenceScore(blendedResult);

    if (blendedEvidence < scopedEvidence + BLENDED_EVIDENCE_MARGIN) {
        return {
            servedScope: 'agent_scoped',
            reason: 'Agent-specific evidence is warming, but blended cohort evidence is not meaningfully stronger yet.',
        };
    }

    return {
        servedScope: 'customer_blended',
        reason: 'Agent-specific evidence is below reliability targets. Serving blended cohort evidence to reduce early-run uncertainty.',
    };
}
