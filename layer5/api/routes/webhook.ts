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
            .select('registration_id, customer_id, resolved, event_type, platform')
            .eq('outcome_id', payload.outcomeId)
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
            .eq('outcome_id', payload.outcomeId);

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
            .eq('registration_id', pending.registration_id);

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
