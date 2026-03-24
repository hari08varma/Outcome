import { Provenance, computeConfidence } from './provenance.js';
import { CausalGraph } from './causal-graph.js';

export function createTracedPrimitive(
    value: string | number | boolean,
    provenance: Provenance,
    graph: CausalGraph,
): any {
    const wrapper = Object(value);

    Object.defineProperty(wrapper, Symbol.toPrimitive, {
        enumerable: false,
        configurable: false,
        value: (hint: string) => {
            graph.recordComparison({
                actionId: provenance.actionId,
                fieldPath: provenance.fieldPath,
                value,
                hint,
                depth: provenance.depth,
                confidence: computeConfidence(provenance.depth),
            });

            return value;
        },
    });

    Object.defineProperty(wrapper, 'toString', {
        enumerable: false,
        configurable: true,
        value: () => createTracedPrimitive(String(value), provenance, graph),
    });

    Object.defineProperty(wrapper, 'valueOf', {
        enumerable: false,
        configurable: true,
        value: () => {
            graph.recordFieldAccess({
                actionId: provenance.actionId,
                fieldPath: provenance.fieldPath,
                value,
                depth: provenance.depth,
                confidence: computeConfidence(provenance.depth),
            });

            return value;
        },
    });

    Object.defineProperty(wrapper, 'toJSON', {
        enumerable: false,
        configurable: true,
        value: () => value,
    });

    return wrapper;
}
