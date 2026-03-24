export type FallbackStrategy =
    | 'use_http_status'
    | 'explicit_only'
    | 'always_pending';

export interface SignalContractParams {
    actionName: string;
    successCondition: string;
    scoreExpression: string;
    timeoutHours?: number;
    fallbackStrategy?: FallbackStrategy;
}

export interface SignalContract {
    id: string;
    customerId: string;
    actionName: string;
    successCondition: string;
    scoreExpression: string;
    timeoutHours: number;
    fallbackStrategy: FallbackStrategy;
    isActive: boolean;
    createdAt: string;
}
