// Type-only stub. The real client lives in layer5/sdks/typescript/src/client.ts.
// instrument.ts imports only the type — no runtime dependency on this file.

export interface LayerinfiniteClient {
    logOutcome(params: Record<string, unknown>): Promise<unknown>;
    getScores(params: Record<string, unknown>): Promise<unknown>;
    getApiKey(): string;
    getBaseUrl(): string;
}
