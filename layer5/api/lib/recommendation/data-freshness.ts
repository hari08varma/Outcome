export const RECOMMENDATION_STALE_THRESHOLD_HOURS = 72;

export interface RecommendationDataFreshness {
    source: 'mv' | 'fact_fallback' | 'unknown';
    last_seen_at: string | null;
    age_hours: number | null;
    is_stale: boolean;
    stale_threshold_hours: number;
}

function parseAgeHours(lastSeenAt: string | null): number | null {
    if (!lastSeenAt) return null;
    const ts = Date.parse(lastSeenAt);
    if (!Number.isFinite(ts)) return null;

    const ageMs = Math.max(0, Date.now() - ts);
    return Number((ageMs / (60 * 60 * 1000)).toFixed(2));
}

export function buildRecommendationDataFreshness(
    source: RecommendationDataFreshness['source'],
    lastSeenAt: string | null,
    staleThresholdHours = RECOMMENDATION_STALE_THRESHOLD_HOURS,
): RecommendationDataFreshness {
    const ageHours = parseAgeHours(lastSeenAt);
    return {
        source,
        last_seen_at: lastSeenAt,
        age_hours: ageHours,
        is_stale: ageHours !== null && ageHours > staleThresholdHours,
        stale_threshold_hours: staleThresholdHours,
    };
}