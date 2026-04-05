export type OutcomeQuality = 'high' | 'medium' | 'low';

const DAY_MS = 24 * 60 * 60 * 1000;

export const HIGH_QUALITY_WEIGHT = 1.0;
export const MEDIUM_QUALITY_WEIGHT = 0.6;
export const LOW_QUALITY_WEIGHT = 0.25;

export const HIGH_QUALITY_HALF_LIFE_DAYS = 90;
export const MEDIUM_QUALITY_HALF_LIFE_DAYS = 45;
export const LOW_QUALITY_HALF_LIFE_DAYS = 14;

export const LOW_QUALITY_HARD_EXCLUSION_DAYS = 30;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

export function classifyOutcomeQuality(outcomeScore: number): OutcomeQuality {
    const score = clamp01(outcomeScore);
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
}

function qualityWeight(quality: OutcomeQuality): number {
    switch (quality) {
        case 'high':
            return HIGH_QUALITY_WEIGHT;
        case 'medium':
            return MEDIUM_QUALITY_WEIGHT;
        case 'low':
        default:
            return LOW_QUALITY_WEIGHT;
    }
}

function qualityHalfLifeDays(quality: OutcomeQuality): number {
    switch (quality) {
        case 'high':
            return HIGH_QUALITY_HALF_LIFE_DAYS;
        case 'medium':
            return MEDIUM_QUALITY_HALF_LIFE_DAYS;
        case 'low':
        default:
            return LOW_QUALITY_HALF_LIFE_DAYS;
    }
}

export function getAgeDays(timestamp: string | null, nowMs = Date.now()): number | null {
    if (!timestamp) return null;
    const ts = Date.parse(timestamp);
    if (!Number.isFinite(ts)) return null;
    const ageDays = Math.max(0, (nowMs - ts) / DAY_MS);
    return Number(ageDays.toFixed(6));
}

export function computeOutcomeEffectiveWeightForScore(
    outcomeScore: number,
    timestamp: string | null,
    nowMs = Date.now(),
): number {
    const quality = classifyOutcomeQuality(outcomeScore);
    const ageDays = getAgeDays(timestamp, nowMs);

    if (quality === 'low' && ageDays !== null && ageDays > LOW_QUALITY_HARD_EXCLUSION_DAYS) {
        return 0;
    }

    const baseWeight = qualityWeight(quality);
    if (ageDays === null) {
        return baseWeight;
    }

    const halfLifeDays = qualityHalfLifeDays(quality);
    const decay = Math.exp(-Math.LN2 * ageDays / halfLifeDays);
    const effectiveWeight = baseWeight * decay;

    return Number(effectiveWeight.toFixed(6));
}
