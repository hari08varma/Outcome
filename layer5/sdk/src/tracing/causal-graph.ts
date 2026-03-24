import { Provenance, computeConfidence } from './provenance.js';

export interface FieldAccessRecord {
    actionId: string;
    fieldPath: string;
    value: unknown;
    depth: number;
    confidence: number;
    timestamp: number;
}

export interface ComparisonRecord {
    actionId: string;
    fieldPath: string;
    value: unknown;
    hint: string;
    depth: number;
    confidence: number;
    timestamp: number;
}

export interface OutcomeDerivation {
    actionId: string;
    success: boolean;
    confidence: number;
    fieldPaths: string[];
    timestamp: number;
}

export class CausalGraph {
    private fieldAccesses: FieldAccessRecord[] = [];
    private comparisons: ComparisonRecord[] = [];

    recordFieldAccess(params: {
        actionId: string;
        fieldPath: string;
        value: unknown;
        depth: number;
        confidence: number;
    }): void {
        this.fieldAccesses.push({
            ...params,
            timestamp: Date.now(),
        });
    }

    recordComparison(params: {
        actionId: string;
        fieldPath: string;
        value: unknown;
        hint: string;
        depth: number;
        confidence: number;
    }): void {
        this.comparisons.push({
            ...params,
            timestamp: Date.now(),
        });
    }

    deriveOutcome(): OutcomeDerivation | null {
        if (this.comparisons.length === 0) {
            return null;
        }

        const byActionId = new Map<string, ComparisonRecord[]>();

        for (const comparison of this.comparisons) {
            const existing = byActionId.get(comparison.actionId);
            if (existing) {
                existing.push(comparison);
            } else {
                byActionId.set(comparison.actionId, [comparison]);
            }
        }

        let selected: {
            actionId: string;
            success: boolean;
            confidence: number;
            fieldPaths: string[];
            latestTimestamp: number;
        } | null = null;

        for (const [actionId, records] of byActionId.entries()) {
            const success = records.some((record) => Boolean(record.value));
            const confidence = records.reduce(
                (maxConfidence, record) => Math.max(maxConfidence, record.confidence),
                0,
            );
            const fieldPaths = Array.from(new Set(records.map((record) => record.fieldPath)));
            const latestTimestamp = records.reduce(
                (maxTimestamp, record) => Math.max(maxTimestamp, record.timestamp),
                0,
            );

            if (
                selected === null
                || confidence > selected.confidence
                || (confidence === selected.confidence && latestTimestamp > selected.latestTimestamp)
            ) {
                selected = {
                    actionId,
                    success,
                    confidence,
                    fieldPaths,
                    latestTimestamp,
                };
            }
        }

        if (selected === null) {
            return null;
        }

        return {
            actionId: selected.actionId,
            success: selected.success,
            confidence: selected.confidence,
            fieldPaths: selected.fieldPaths,
            timestamp: Date.now(),
        };
    }

    getFieldAccesses(): FieldAccessRecord[] {
        return [...this.fieldAccesses];
    }

    getComparisons(): ComparisonRecord[] {
        return [...this.comparisons];
    }

    clear(): void {
        this.fieldAccesses = [];
        this.comparisons = [];
    }
}
