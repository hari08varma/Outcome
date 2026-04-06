import {
    MIN_SAMPLES,
    MIN_SAMPLES_HIGH_CONFIDENCE,
    MIN_SAMPLES_STABLE,
} from './constants.js';

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
    if (value === undefined) return defaultValue;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseFiniteNumber(value: string | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return parsed;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
    const parsed = Math.floor(parseFiniteNumber(value, defaultValue));
    if (parsed <= 0) return defaultValue;
    return parsed;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
    return clamp(value, 0, 1);
}

export interface RecommendationRolloutConfig {
    noiseAwareGateEnabled: boolean;
    simulationShadowEnabled: boolean;
    simulationConfidenceCeilingEnabled: boolean;
    simulationExploitGateEnabled: boolean;

    normalWarmupSamples: number;
    stableSamples: number;
    highConfidenceSamples: number;

    noisyWarmupSamples: number;
    noisyStableSamples: number;
    noisyHighConfidenceSamples: number;

    noiseWinRateLower: number;
    noiseWinRateUpper: number;
    noiseGapMax: number;
    noiseScoreThreshold: number;

    simulationShadowBlendCap: number;
    simulationShadowBlendUntilSamples: number;
    simulationShadowDecisionLookback: number;
    simulationShadowRecentPerAction: number;

    simulationConfidenceCeiling: number;
    simulationExploitGateMinSamples: number;
}

export function getRecommendationRolloutConfig(
    env: NodeJS.ProcessEnv = process.env,
): RecommendationRolloutConfig {
    const noiseWinRateLower = clamp01(parseFiniteNumber(env.LI_NOISE_WIN_RATE_LOWER, 0.40));
    const noiseWinRateUpper = clamp01(
        parseFiniteNumber(env.LI_NOISE_WIN_RATE_UPPER, Math.max(0.55, noiseWinRateLower + 0.01)),
    );

    return {
        // Strict rollout defaults: all new gates are disabled unless explicitly enabled.
        noiseAwareGateEnabled: parseBoolean(env.LI_FEATURE_NOISE_AWARE_EVIDENCE_GATE_V1, false),
        simulationShadowEnabled: parseBoolean(env.LI_FEATURE_SIMULATION_SHADOW_V1, false),
        simulationConfidenceCeilingEnabled: parseBoolean(env.LI_FEATURE_SIMULATION_CONFIDENCE_CEILING_V1, false),
        simulationExploitGateEnabled: parseBoolean(env.LI_FEATURE_SIMULATION_EXPLOIT_GATE_V1, false),

        normalWarmupSamples: MIN_SAMPLES,
        stableSamples: MIN_SAMPLES_STABLE,
        highConfidenceSamples: MIN_SAMPLES_HIGH_CONFIDENCE,

        noisyWarmupSamples: Math.max(
            MIN_SAMPLES,
            parsePositiveInt(env.LI_NOISY_WARMUP_MIN_SAMPLES, 30),
        ),
        noisyStableSamples: Math.max(
            MIN_SAMPLES_STABLE,
            parsePositiveInt(env.LI_NOISY_STABLE_MIN_SAMPLES, MIN_SAMPLES_STABLE),
        ),
        noisyHighConfidenceSamples: Math.max(
            MIN_SAMPLES_HIGH_CONFIDENCE,
            parsePositiveInt(env.LI_NOISY_HIGH_CONFIDENCE_SAMPLES, 150),
        ),

        noiseWinRateLower,
        noiseWinRateUpper: Math.max(noiseWinRateLower + 0.01, noiseWinRateUpper),
        noiseGapMax: clamp(parseFiniteNumber(env.LI_NOISE_GAP_MAX, 0.10), 0.01, 1),
        noiseScoreThreshold: clamp01(parseFiniteNumber(env.LI_NOISE_SCORE_THRESHOLD, 0.55)),

        simulationShadowBlendCap: clamp(
            parseFiniteNumber(env.LI_SIMULATION_SHADOW_BLEND_CAP, 0.20),
            0,
            0.5,
        ),
        simulationShadowBlendUntilSamples: Math.max(
            MIN_SAMPLES,
            parsePositiveInt(env.LI_SIMULATION_SHADOW_BLEND_UNTIL_SAMPLES, 30),
        ),
        simulationShadowDecisionLookback: parsePositiveInt(
            env.LI_SIMULATION_SHADOW_DECISION_LOOKBACK,
            200,
        ),
        simulationShadowRecentPerAction: clamp(
            parsePositiveInt(env.LI_SIMULATION_SHADOW_RECENT_PER_ACTION, 5),
            1,
            20,
        ),

        simulationConfidenceCeiling: clamp01(
            parseFiniteNumber(env.LI_SIMULATION_CONFIDENCE_CEILING, 0.65),
        ),
        simulationExploitGateMinSamples: Math.max(
            MIN_SAMPLES,
            parsePositiveInt(env.LI_SIMULATION_EXPLOIT_GATE_MIN_SAMPLES, 60),
        ),
    };
}
