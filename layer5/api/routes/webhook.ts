import { Context } from 'hono';
import { supabase } from '../lib/supabase.js';
import {
    verifySendgridSignature,
    verifySharedSecret,
    verifyStripeSignature,
} from '../lib/webhook-auth.js';

type Provider = 'stripe' | 'sendgrid' | 'generic';
type BusinessOutcome = 'resolved' | 'partial' | 'failed' | 'unknown';

interface CanonicalWebhookPayload {
    outcomeId: string;
    finalScore: number;
    businessOutcome: BusinessOutcome;
}

function clamp01(value: number): number {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function getObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

function extractStripePayload(payloadInput: unknown): CanonicalWebhookPayload | null {
    const payload = getObject(payloadInput);
    const eventData = getObject(payload.data);
    const eventObject = getObject(eventData.object);
    const objectPayload = Object.keys(eventObject).length > 0 ? eventObject : payload;

    const metadata = getObject(objectPayload.metadata);
    const outcomeId = metadata.layerinfinite_outcome_id;
    const amountRefunded = Number(objectPayload.amount_refunded ?? 0);
    const amount = Number(objectPayload.amount ?? objectPayload.amount_received ?? 0);
    const eventType = String(payload.type ?? objectPayload.status ?? '').toLowerCase();

    if (typeof outcomeId !== 'string') return null;

    let finalScore = 0.5;
    let businessOutcome: BusinessOutcome = 'unknown';

    if (Number.isFinite(amount) && amount > 0 && Number.isFinite(amountRefunded) && amountRefunded > 0) {
        finalScore = clamp01(amountRefunded / amount);
        businessOutcome = finalScore >= 1 ? 'resolved' : 'partial';
    } else if (
        eventType.includes('succeeded')
        || eventType.includes('completed')
        || eventType.includes('paid')
    ) {
        finalScore = 1.0;
        businessOutcome = 'resolved';
    } else if (
        eventType.includes('failed')
        || eventType.includes('canceled')
        || eventType.includes('expired')
    ) {
        finalScore = 0.0;
        businessOutcome = 'failed';
    }

    return { outcomeId, finalScore, businessOutcome };
}

function extractSendgridPayload(payloadInput: unknown): CanonicalWebhookPayload | null {
    const events = Array.isArray(payloadInput) ? payloadInput : [payloadInput];

    for (const eventRow of events) {
        const eventPayload = getObject(eventRow);
        if (Object.keys(eventPayload).length === 0) continue;

        const customArgs = getObject(eventPayload.custom_args);
        const uniqueArgs = getObject(eventPayload.unique_args);
        const outcomeId = customArgs.outcome_id ?? uniqueArgs.outcome_id;
        const event = String(eventPayload.event ?? '').toLowerCase();

        if (typeof outcomeId !== 'string') {
            continue;
        }

        if (event === 'delivered' || event === 'processed') {
            return { outcomeId, finalScore: 1.0, businessOutcome: 'resolved' };
        }

        if (
            event === 'bounce'
            || event === 'blocked'
            || event === 'dropped'
            || event === 'deferred'
            || event === 'spamreport'
        ) {
            return { outcomeId, finalScore: 0.0, businessOutcome: 'failed' };
        }

        return { outcomeId, finalScore: 0.5, businessOutcome: 'unknown' };
    }

    return null;
}

function extractGenericPayload(payloadInput: unknown): CanonicalWebhookPayload | null {
    const payload = getObject(payloadInput);
    const outcomeId = payload.outcome_id;
    const finalScore = Number(payload.final_score);
    const businessOutcome = String(payload.business_outcome) as BusinessOutcome;

    const allowedOutcomes = ['resolved', 'partial', 'failed', 'unknown'];
    if (typeof outcomeId !== 'string') return null;
    if (Number.isNaN(finalScore)) return null;
    if (!allowedOutcomes.includes(businessOutcome)) return null;

    return {
        outcomeId,
        finalScore: clamp01(finalScore),
        businessOutcome,
    };
}

function extractPayload(provider: Provider, payloadInput: unknown): CanonicalWebhookPayload | null {
    if (provider === 'stripe') return extractStripePayload(payloadInput);
    if (provider === 'sendgrid') return extractSendgridPayload(payloadInput);
    return extractGenericPayload(payloadInput);
}

function isWebhookAuthorized(params: {
    provider: Provider;
    c: Context;
    rawBody: string;
}): boolean {
    const sharedSecret = process.env.LI_WEBHOOK_SHARED_SECRET;
    const providedSharedSecret = params.c.req.header('x-layerinfinite-webhook-secret');

    if (verifySharedSecret(sharedSecret, providedSharedSecret)) {
        return true;
    }

    if (params.provider === 'stripe') {
        const stripeSigningSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;
        const stripeSignature = params.c.req.header('stripe-signature');
        const tolerance = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300);

        if (verifyStripeSignature(params.rawBody, stripeSignature, stripeSigningSecret, tolerance)) {
            return true;
        }
    }

    if (params.provider === 'sendgrid') {
        const sendgridPublicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
        const sendgridSignature = params.c.req.header('x-twilio-email-event-webhook-signature');
        const sendgridTimestamp = params.c.req.header('x-twilio-email-event-webhook-timestamp');

        if (verifySendgridSignature(params.rawBody, sendgridTimestamp, sendgridSignature, sendgridPublicKey)) {
            return true;
        }
    }

    // Keep local dev easy to test while keeping production strict.
    if (process.env.NODE_ENV !== 'production') {
        return true;
    }

    return false;
}

export default async function webhookRoute(c: Context): Promise<Response> {
    try {
        const provider = c.req.param('provider') as Provider;
        if (!['stripe', 'sendgrid', 'generic'].includes(provider)) {
            return c.json({ resolved: false }, 200);
        }

        const rawBody = await c.req.text();

        if (!isWebhookAuthorized({ provider, c, rawBody })) {
            return c.json({ resolved: false }, 401);
        }

        let parsedPayload: unknown;
        try {
            parsedPayload = JSON.parse(rawBody);
        } catch {
            return c.json({ resolved: false }, 200);
        }

        const payload = extractPayload(provider, parsedPayload);

        if (!payload) {
            return c.json({ resolved: false }, 200);
        }

        const { data: pending } = await supabase
            .from('dim_pending_signal_registrations')
            .select('registration_id, customer_id, resolved, event_type, platform')
            .eq('outcome_id', payload.outcomeId)
            .eq('platform', provider)
            .eq('resolved', false)
            .limit(1)
            .maybeSingle();

        if (!pending) {
            return c.json({ resolved: false, outcome_id: payload.outcomeId }, 200);
        }

        const { data: currentOutcome } = await supabase
            .from('fact_outcomes')
            .select('outcome_id, success')
            .eq('outcome_id', payload.outcomeId)
            .eq('customer_id', pending.customer_id)
            .limit(1)
            .maybeSingle();

        if (!currentOutcome) {
            return c.json({ resolved: false, outcome_id: payload.outcomeId }, 200);
        }

        const finalSignalSuccess = payload.finalScore >= 0.5;
        const crossEventStatus = currentOutcome.success === finalSignalSuccess
            ? 'confirmed'
            : 'conflict';
        const nowIso = new Date().toISOString();

        const { error: outcomeUpdateError } = await supabase
            .from('fact_outcomes')
            .update({
                outcome_score: payload.finalScore,
                business_outcome: payload.businessOutcome,
                feedback_received_at: nowIso,
                signal_pending: false,
                signal_updated_at: nowIso,
                cross_event_status: crossEventStatus,
                cross_event_last_updated: nowIso,
                pending_registration_id: pending.registration_id,
            })
            .eq('outcome_id', payload.outcomeId)
            .eq('customer_id', pending.customer_id);

        if (outcomeUpdateError) {
            return c.json({ resolved: false, outcome_id: payload.outcomeId }, 200);
        }

        await supabase
            .from('dim_pending_signal_registrations')
            .update({
                resolved: true,
                resolved_at: nowIso,
                resolved_by: `${provider}_webhook`,
            })
            .eq('registration_id', pending.registration_id)
            .eq('customer_id', pending.customer_id);

        if (crossEventStatus === 'conflict') {
            const { data: existingConflict } = await supabase
                .from('dim_discrepancy_log')
                .select('discrepancy_id')
                .eq('customer_id', pending.customer_id)
                .eq('outcome_id', payload.outcomeId)
                .eq('discrepancy_type', 'cross_event_conflict')
                .eq('resolved', false)
                .limit(1);

            if (!existingConflict || existingConflict.length === 0) {
                await supabase
                    .from('dim_discrepancy_log')
                    .insert({
                        customer_id: pending.customer_id,
                        outcome_id: payload.outcomeId,
                        registration_id: pending.registration_id,
                        action_name: `${pending.platform}:${pending.event_type}`,
                        discrepancy_type: 'cross_event_conflict',
                        expected_outcome: currentOutcome.success,
                        actual_outcome: finalSignalSuccess,
                        signal_confidence: payload.finalScore,
                        detail:
                            `Webhook ${provider} contradicted initial outcome polarity. ` +
                            `initial_success=${String(currentOutcome.success)} final_score=${payload.finalScore.toFixed(4)}.`,
                    });
            }
        }

        return c.json({
            resolved: true,
            outcome_id: payload.outcomeId,
            cross_event_status: crossEventStatus,
        }, 200);
    } catch {
        return c.json({ resolved: false }, 200);
    }
}
