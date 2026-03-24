import type { LayerinfiniteClient } from '../client.js';
import type { DerivedOutcome } from './outcome-deriver.js';

export class PendingSignalWriter {
    constructor(private readonly client: LayerinfiniteClient) { }

    async write(outcome: DerivedOutcome): Promise<void> {
        try {
            await fetch(`${this.client.getBaseUrl()}/v1/pending-signals`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.client.getApiKey()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    outcome_id: outcome.outcomeId,
                    action_name: outcome.actionName,
                    provider_hint: outcome.providerHint ?? null,
                    feedback_signal: 'delayed',
                }),
            });
        } catch (error) {
            console.error('[PendingSignalWriter] failed to register pending signal', error);
        }
    }
}
