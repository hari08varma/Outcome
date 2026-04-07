import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
    verifySendgridSignature,
    verifySharedSecret,
    verifyStripeSignature,
} from '../../api/lib/webhook-auth.js';

describe('webhook auth helpers', () => {
    it('validates shared secret with timing-safe compare', () => {
        expect(verifySharedSecret('top-secret', 'top-secret')).toBe(true);
        expect(verifySharedSecret('top-secret', 'wrong-secret')).toBe(false);
        expect(verifySharedSecret(undefined, 'anything')).toBe(false);
    });

    it('validates stripe webhook signature', () => {
        const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
        const secret = 'whsec_test_secret';
        const timestamp = 1_700_000_000;
        const expected = createHmac('sha256', secret)
            .update(`${timestamp}.${payload}`)
            .digest('hex');
        const header = `t=${timestamp},v1=${expected}`;

        expect(verifyStripeSignature(payload, header, secret, 300, timestamp + 5)).toBe(true);
        expect(verifyStripeSignature(payload, header, secret, 3, timestamp + 10)).toBe(false);
        expect(verifyStripeSignature(payload, header, 'wrong', 300, timestamp + 5)).toBe(false);
    });

    it('validates sendgrid signed webhook payload', () => {
        const payload = JSON.stringify([{ event: 'delivered', custom_args: { outcome_id: 'abc' } }]);
        const timestamp = '1700000000';

        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

        const signer = createSign('sha256');
        signer.update(`${timestamp}${payload}`);
        signer.end();
        const signature = signer.sign(privateKey, 'base64');

        expect(verifySendgridSignature(payload, timestamp, signature, publicPem)).toBe(true);
        expect(verifySendgridSignature(payload, timestamp, 'invalid-signature', publicPem)).toBe(false);
    });
});