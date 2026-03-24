export const MAX_DEPTH = 8;
export const CONFIDENCE_BASE = 0.90;
export const DECAY_RATE = 0.04;

export interface Provenance {
    actionId: string;
    actionName: string;
    fieldPath: string;
    depth: number;
}

export function computeConfidence(depth: number): number {
    if (depth > MAX_DEPTH) {
        return 0;
    }

    return Math.max(0, CONFIDENCE_BASE - (depth * DECAY_RATE));
}
