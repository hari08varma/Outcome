import type { CausalGraph } from '../tracing/causal-graph.js';

export interface OutcomeLogParams {
    [key: string]: unknown;
    action_id: string;
    outcome_score: number;
    confidence: number;
    derivation_method: 'causal_graph_v1';
    metadata: Record<string, unknown>;
}

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

export function deriveOutcomeParams(
    graph: CausalGraph,
    actionId: string,
    metadata: Record<string, unknown> = {},
): OutcomeLogParams {
    const comparisons = graph.getComparisons().filter((record) => record.actionId === actionId);

    let outcomeScore = 0.5;
    let confidence = 0.5;

    if (comparisons.length > 0) {
        const truthyCount = comparisons.filter((record) => Boolean(record.value)).length;
        outcomeScore = clamp01(truthyCount / comparisons.length);
        confidence = comparisons.reduce(
            (maxConfidence, record) => Math.max(maxConfidence, record.confidence),
            0,
        );
        confidence = clamp01(confidence);
    }

    return {
        action_id: actionId,
        outcome_score: outcomeScore,
        confidence,
        derivation_method: 'causal_graph_v1',
        metadata: {
            ...metadata,
            derivation_method: 'causal_graph_v1',
        },
    };
}
