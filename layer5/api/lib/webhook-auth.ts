import crypto from 'node:crypto';

export function verifySharedSecret(expectedSecret: string | undefined, providedSecret: string | undefined): boolean {
    if (!expectedSecret) return false;

    const expected = Buffer.from(expectedSecret);
    const provided = Buffer.from(providedSecret ?? '');

    if (expected.length === 0 || expected.length !== provided.length) {
        return false;
    }

    return crypto.timingSafeEqual(expected, provided);
}

export function verifyStripeSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    signingSecret: string | undefined,
    toleranceSeconds = 300,
    nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
    if (!signatureHeader || !signingSecret) return false;

    let timestamp: number | null = null;
    const v1Candidates: string[] = [];

    for (const part of signatureHeader.split(',')) {
        const [key, value] = part.trim().split('=', 2);
        if (!key || !value) continue;

        if (key === 't') {
            const parsed = Number(value);
            timestamp = Number.isFinite(parsed) ? parsed : null;
        }

        if (key === 'v1') {
            v1Candidates.push(value.toLowerCase());
        }
    }

    if (timestamp === null || v1Candidates.length === 0) {
        return false;
    }

    const ageSeconds = Math.abs(nowSeconds - timestamp);
    if (ageSeconds > Math.max(1, toleranceSeconds)) {
        return false;
    }

    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = crypto
        .createHmac('sha256', signingSecret)
        .update(signedPayload)
        .digest('hex')
        .toLowerCase();

    for (const candidate of v1Candidates) {
        if (verifySharedSecret(expectedSignature, candidate)) {
            return true;
        }
    }

    return false;
}

export function verifySendgridSignature(
    rawBody: string,
    timestampHeader: string | undefined,
    signatureHeader: string | undefined,
    publicKeyPem: string | undefined,
): boolean {
    if (!timestampHeader || !signatureHeader || !publicKeyPem) {
        return false;
    }

    try {
        const verifier = crypto.createVerify('sha256');
        verifier.update(`${timestampHeader}${rawBody}`);
        verifier.end();
        return verifier.verify(publicKeyPem, signatureHeader, 'base64');
    } catch {
        return false;
    }
}