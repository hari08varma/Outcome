/**
 * Layerinfinite — routes/admin/test-notification.ts
 * POST /v1/admin/test-notification
 * ══════════════════════════════════════════════════════════════
 * Sends a test notification to a specific channel.
 * Verifies the channel belongs to the authenticated customer.
 * Returns { success, error? } so the dashboard can show results.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';

export const testNotificationRouter = new Hono();

const TestBody = z.object({
    channel_id: z.string().uuid(),
});

testNotificationRouter.post('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    let body: z.infer<typeof TestBody>;
    try {
        body = TestBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    // ── Verify channel belongs to this customer ────────────────
    const { data: channel, error: chErr } = await supabase
        .from('alert_notification_channels')
        .select('id, channel_type, destination, label, customer_id')
        .eq('id', body.channel_id)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (chErr) {
        return c.json({ error: 'Channel lookup failed', details: chErr.message }, 500);
    }
    if (!channel) {
        return c.json({ error: 'Channel not found or does not belong to your account', code: 'NOT_FOUND' }, 404);
    }

    // ── Build synthetic test alert ─────────────────────────────
    const testAlert = {
        alert_id: '00000000-0000-0000-0000-000000000000',
        alert_type: 'latency_spike',
        severity: 'warning',
        message: 'This is a test notification from Layerinfinite. Your alert channel is configured correctly.',
        agent_id: null,
        action_name: 'test_action',
        metadata: { test: true },
        detected_at: new Date().toISOString(),
    };

    // ── Deliver based on channel type ──────────────────────────
    try {
        let ok = false;
        let status: number | null = null;
        let errorMessage: string | null = null;

        if (channel.channel_type === 'slack_webhook') {
            const payload = {
                blocks: [
                    {
                        type: 'header',
                        text: { type: 'plain_text', text: '🟡 Layerinfinite Test: Latency Spike' },
                    },
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: testAlert.message },
                    },
                    {
                        type: 'context',
                        elements: [{
                            type: 'mrkdwn',
                            text: `*Severity:* warning | *This is a test notification*`,
                        }],
                    },
                ],
            };

            const res = await fetch(channel.destination, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            ok = res.ok;
            status = res.status;
            if (!res.ok) errorMessage = `Slack returned HTTP ${res.status}`;
        } else if (channel.channel_type === 'webhook') {
            const payload = {
                ...testAlert,
                source: 'layerinfinite',
            };

            const res = await fetch(channel.destination, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Layerinfinite-Alerts/1.0',
                    'X-Layerinfinite-Alert-Type': 'latency_spike',
                    'X-Layerinfinite-Severity': 'warning',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            ok = res.ok;
            status = res.status;
            if (!res.ok) {
                let errBody = '';
                try { errBody = await res.text(); } catch { /* ignore */ }
                errorMessage = `Webhook returned HTTP ${res.status}: ${errBody}`.slice(0, 500);
            }
        } else if (channel.channel_type === 'email') {
            const resendKey = process.env.RESEND_API_KEY;
            if (!resendKey) {
                return c.json({
                    success: false,
                    error: 'Email delivery requires RESEND_API_KEY env var. Set it in your environment.',
                }, 200);
            }

            const fromEmail = process.env.ALERT_FROM_EMAIL ?? 'alerts@layerinfinite.dev';
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${resendKey}`,
                },
                body: JSON.stringify({
                    from: fromEmail,
                    to: [channel.destination],
                    subject: '[Layerinfinite] TEST: Latency Spike detected',
                    text: testAlert.message,
                    html: `<p>${testAlert.message}</p>`,
                }),
                signal: AbortSignal.timeout(10000),
            });
            ok = res.ok;
            status = res.status;
            if (!res.ok) errorMessage = `Resend returned HTTP ${res.status}`;
        } else {
            return c.json({ success: false, error: `Unknown channel type: ${channel.channel_type}` }, 400);
        }

        // Update last delivery stats on the channel
        await supabase
            .from('alert_notification_channels')
            .update({
                last_delivery_at: new Date().toISOString(),
                last_delivery_ok: ok,
                last_delivery_error: errorMessage,
            })
            .eq('id', channel.id);

        return c.json({ success: ok, error: errorMessage, http_status: status }, 200);
    } catch (err: any) {
        return c.json({ success: false, error: err.message ?? 'Delivery failed' }, 200);
    }
});
