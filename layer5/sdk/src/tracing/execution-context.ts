import { AsyncLocalStorage } from 'async_hooks';
import type { CausalGraph } from './causal-graph.js';

interface RequestInit {
    method?: string;
}

export interface ExecutionContext {
    actionId: string;
    actionName: string;
    graph: CausalGraph;
}

export const executionStore = new AsyncLocalStorage<ExecutionContext>();

export function generateActionId(): string {
    return crypto.randomUUID();
}

export function inferActionName(url: string, init?: RequestInit): string {
    void init;

    const withoutQuery = url.split('?')[0] ?? '';
    const pathOnly = withoutQuery.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const normalizedPath = pathOnly.replace(/^\/+/, '');
    const segments = normalizedPath.split('/').filter(Boolean);

    if (segments.length >= 2) {
        return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    }

    return normalizedPath;
}
