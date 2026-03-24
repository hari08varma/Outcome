import { Context } from 'hono';
import { supabase } from '../lib/supabase.js';

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

function extractStripePayload(payload: Record<string, unknown>): CanonicalWebhookPayload | null {
    const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
    const outcomeId = metadata.layerinfinite_outcome_id;
    const amountRefunded = Number(payload.amount_refunded ?? 0);
    const amount = Number(payload.amount ?? 0);
    const status = String(payload.status ?? '');

    if (typeof outcomeId !== 'string') return null;

    const finalScore = amount > 0 ? clamp01(amountRefunded / amount) : 0.5;
    const businessOutcome: BusinessOutcome = status === 'succeeded' ? 'resolved' : 'failed';

    return { outcomeId, finalScore, businessOutcome };
}

function extractSendgridPayload(payload: Record<string, unknown>): CanonicalWebhookPayload | null {
    const customArgs = (payload.custom_args ?? {}) as Record<string, unknown>;
    const outcomeId = customArgs.outcome_id;
    const event = String(payload.event ?? '');

    if (typeof outcomeId !== 'string') return null;

    const finalScore = event === 'delivered' ? 1.0 : event === 'bounce' ? 0.0 : 0.5;
    const businessOutcome: BusinessOutcome = event === 'delivered' ? 'resolved' : 'failed';

    return { outcomeId, finalScore, businessOutcome };
}

function extractGenericPayload(payload: Record<string, unknown>): CanonicalWebhookPayload | null {
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

function extractPayload(provider: Provider, payload: Record<string, unknown>): CanonicalWebhookPayload | null {
    if (provider === 'stripe') return extractStripePayload(payload);
    if (provider === 'sendgrid') return extractSendgridPayload(payload);
    return extractGenericPayload(payload);
}

export default async function webhookRoute(c: Context): Promise<Response> {
    try {
        const provider = c.req.param('provider') as Provider;
        if (!['stripe', 'sendgrid', 'generic'].includes(provider)) {
            return c.json({ resolved: false }, 200);
        }

        const rawPayload = await c.req.json();
        const payload = extractPayload(provider, (rawPayload ?? {}) as Record<string, unknown>);

        if (!payload) {
            return c.json({ resolved: false }, 200);
        }

        const { data: pending } = await supabase
            .from('dim_pending_signal_registrations')
            .select('id, customer_id, is_resolved')
            .eq('outcome_id', payload.outcomeId)
            .eq('is_resolved', false)
            .limit(1)
            .maybeSingle();

        if (!pending) {
            return c.json({ resolved: false, outcome_id: payload.outcomeId }, 200);
        }

        await supabase
            .from('dim_pending_signal_registrations')
            .update({
                is_resolved: true,
                resolved_at: new Date().toISOString(),
                final_score: payload.finalScore,
            })
            .eq('id', pending.id);

        await supabase
            .from('fact_outcomes')
            .update({
                outcome_score: payload.finalScore,
                business_outcome: payload.businessOutcome,
                feedback_received_at: new Date().toISOString(),
            })
            .eq('outcome_id', payload.outcomeId);

        return c.json({ resolved: true, outcome_id: payload.outcomeId }, 200);
    } catch {
        return c.json({ resolved: false }, 200);
    }
}
