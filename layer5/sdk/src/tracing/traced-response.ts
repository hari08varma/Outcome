import { Provenance, computeConfidence, MAX_DEPTH } from './provenance.js';
import { CausalGraph } from './causal-graph.js';
import { createTracedPrimitive } from './traced-primitive.js';

const proxyRegistry = new WeakSet<object>();

export function createTracedResponse(
    target: object,
    provenance: Provenance,
    graph: CausalGraph,
): object {
    if (proxyRegistry.has(target)) {
        return target;
    }

    const proxy = new Proxy(target, {
        get(currentTarget, prop, _receiver) {
            if (typeof prop === 'symbol') {
                return Reflect.get(currentTarget, prop, currentTarget);
            }

            if (prop === 'then' || prop === 'catch' || prop === 'finally') {
                return Reflect.get(currentTarget, prop, currentTarget);
            }

            const confidence = computeConfidence(provenance.depth);

            if (provenance.depth > MAX_DEPTH || confidence === 0) {
                return Reflect.get(currentTarget, prop, currentTarget);
            }

            const value = Reflect.get(currentTarget, prop, currentTarget);

            const fieldPath = provenance.fieldPath
                ? `${provenance.fieldPath}.${String(prop)}`
                : String(prop);

            graph.recordFieldAccess({
                actionId: provenance.actionId,
                fieldPath,
                value,
                depth: provenance.depth,
                confidence,
            });

            const nextProvenance: Provenance = {
                actionId: provenance.actionId,
                actionName: provenance.actionName,
                fieldPath,
                depth: provenance.depth + 1,
            };

            if (value === null || value === undefined) {
                return value;
            }

            if (typeof value === 'function') {
                return function (this: unknown, ...args: unknown[]) {
                    const result = value.apply(currentTarget, args);

                    if (result === null || result === undefined) {
                        return result;
                    }

                    if (typeof result === 'object') {
                        return createTracedResponse(result, nextProvenance, graph);
                    }

                    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
                        return createTracedPrimitive(result, nextProvenance, graph);
                    }

                    return result;
                };
            }

            if (typeof value === 'object') {
                return createTracedResponse(value, nextProvenance, graph);
            }

            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return createTracedPrimitive(value, nextProvenance, graph);
            }

            return value;
        },

        set(currentTarget, prop, value, receiver) {
            return Reflect.set(currentTarget, prop, value, receiver);
        },
    });

    proxyRegistry.add(proxy);

    return proxy;
}
