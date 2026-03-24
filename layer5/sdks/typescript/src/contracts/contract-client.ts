import type { LayerinfiniteConfig } from '../types.js';
import type { SignalContract, SignalContractParams } from './types.js';

const DEFAULT_BASE_URL = 'https://api.layerinfinite.com';

function toSignalContract(row: Record<string, unknown>): SignalContract {
    return {
        id: String(row.id),
        customerId: String(row.customer_id),
        actionName: String(row.action_name),
        successCondition: String(row.success_condition),
        scoreExpression: String(row.score_expression),
        timeoutHours: Number(row.timeout_hours),
        fallbackStrategy: String(row.fallback_strategy) as SignalContract['fallbackStrategy'],
        isActive: Boolean(row.is_active),
        createdAt: String(row.created_at),
    };
}

export class ContractClient {
    constructor(private readonly config: LayerinfiniteConfig) { }

    async registerSignalContract(params: SignalContractParams): Promise<SignalContract> {
        const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;

        const response = await fetch(`${baseUrl}/v1/contracts`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action_name: params.actionName,
                success_condition: params.successCondition,
                score_expression: params.scoreExpression,
                timeout_hours: params.timeoutHours ?? 24,
                fallback_strategy: params.fallbackStrategy ?? 'use_http_status',
            }),
        });

        if (!response.ok) {
            throw new Error(`registerSignalContract failed: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as Record<string, unknown>;
        return toSignalContract(payload);
    }

    async listSignalContracts(): Promise<SignalContract[]> {
        const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;

        const response = await fetch(`${baseUrl}/v1/contracts`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`listSignalContracts failed: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as Record<string, unknown>[];
        return payload.map(toSignalContract);
    }

    async deactivateSignalContract(contractId: string): Promise<void> {
        const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;

        const response = await fetch(`${baseUrl}/v1/contracts/${contractId}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
            },
        });

        if (!response.ok) {
            throw new Error(`deactivateSignalContract failed: ${response.status} ${response.statusText}`);
        }
    }
}
