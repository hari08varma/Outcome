export interface VerifierSignal {
    source: 'http_status_code' | 'database_row_count' | 'human_review' | 'downstream_webhook' | 'none';
    value?: number | boolean | string;
    verified_at?: string;
}

export function resolveVerifiedSuccess(
    agentSuccess: boolean,
    outcomeScore: number | undefined | null,
    verifierSignal: VerifierSignal | undefined
): {
    verified_success: boolean;
    confidence_override: number | null;
    discrepancy_detected: boolean;
} {
    let verified_success = agentSuccess;
    let confidence_override: number | null = null;

    if (!verifierSignal || verifierSignal.source === 'none') {
        return {
            verified_success,
            confidence_override,
            discrepancy_detected: false,
        };
    }

    if (verifierSignal.source === 'human_review') {
        if (verifierSignal.value === false) {
            verified_success = false;
            confidence_override = 0.0;
        } else if (verifierSignal.value === true) {
            verified_success = true;
            confidence_override = 1.0;
        }
    } else if (verifierSignal.source === 'http_status_code') {
        const status = Number(verifierSignal.value);
        if (status >= 200 && status < 300) {
            verified_success = true;
        } else if (status >= 400) {
            verified_success = false;
            if (status >= 500) {
                confidence_override = 0.0;
            }
        }
    } else if (verifierSignal.source === 'database_row_count') {
        const rows = Number(verifierSignal.value);
        if (rows > 0) {
            verified_success = true;
        } else if (rows === 0) {
            verified_success = false;
            confidence_override = 0.0;
        }
    }

    const discrepancy_detected = agentSuccess === true && verified_success === false;

    return {
        verified_success,
        confidence_override,
        discrepancy_detected,
    };
}
