// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYER5 — Edge Function: notification-dispatcher
// ==============================================================
// Called by pg_cron every 2 minutes.
// Finds undelivered alerts for all active channels.
// Delivers each alert to its configured destination.
// Records delivery result in alert_notification_log.
// Never delivers the same alert to the same channel twice
// (enforced by UNIQUE constraint on log table).
//
// Deploy: supabase functions deploy notification-dispatcher
// Cron:   */2 * * * *  (every 2 minutes)
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const ALERT_FROM_EMAIL = Deno.env.get('ALERT_FROM_EMAIL') ?? 'alerts@layer5.dev';
const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') ?? '';

// ── Helpers ─────────────────────────────────────────────────

function severityEmoji(severity: string): string {
    switch (severity) {
        case 'critical': return '🔴';
        case 'warning':  return '🟡';
        case 'info':     return '🔵';
        default:         return '⚪';
    }
}

const ALERT_TYPE_LABELS: Record<string, string> = {
    degradation: 'Degradation',
    score_flip: 'Score Flip',
    latency_spike: 'Latency Spike',
    context_drift: 'Context Drift',
    coordinated_failure: 'Coordinated Failure',
    silent_failure: 'Silent Failure',
};

function alertTypeLabel(type: string): string {
    return ALERT_TYPE_LABELS[type] ?? type;
}

function formatTimestamp(ts: string): string {
    return new Date(ts).toLocaleString('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
    });
}

// ── Delivery: Slack ─────────────────────────────────────────

interface DeliveryResult {
    ok: boolean;
    status: number | null;
    error: string | null;
}

async function deliverSlack(
    destination: string,
    alert: Record<string, any>,
): Promise<DeliveryResult> {
    const payload = {
        blocks: [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `${severityEmoji(alert.severity)} Layer5 Alert: ${alertTypeLabel(alert.alert_type)}`,
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: alert.message ?? 'No message provided.',
                },
            },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `*Severity:* ${alert.severity} | *Detected:* ${formatTimestamp(alert.detected_at)}`,
                    },
                ],
            },
        ],
    };

    const response = await fetch(destination, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    return {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : `HTTP ${response.status}`,
    };
}

// ── Delivery: Webhook ───────────────────────────────────────

async function deliverWebhook(
    destination: string,
    alert: Record<string, any>,
): Promise<DeliveryResult> {
    const payload = {
        alert_id: alert.alert_id,
        alert_type: alert.alert_type,
        severity: alert.severity,
        message: alert.message,
        agent_id: alert.agent_id,
        action_name: alert.action_name,
        metadata: alert.metadata,
        detected_at: alert.detected_at,
        source: 'layer5',
    };

    const response = await fetch(destination, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Layer5-Alerts/1.0',
            'X-Layer5-Alert-Type': alert.alert_type ?? '',
            'X-Layer5-Severity': alert.severity ?? '',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
    });

    let errorBody = '';
    if (!response.ok) {
        try { errorBody = await response.text(); } catch { /* ignore */ }
    }

    return {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : `HTTP ${response.status}: ${errorBody}`.slice(0, 500),
    };
}

// ── Delivery: Email (Resend) ────────────────────────────────

async function deliverEmail(
    destination: string,
    alert: Record<string, any>,
): Promise<DeliveryResult> {
    if (!RESEND_API_KEY) {
        return {
            ok: false,
            status: null,
            error: 'Email delivery requires RESEND_API_KEY env var. Set it in Supabase Edge Function secrets.',
        };
    }

    const subject = `[Layer5] ${alert.severity.toUpperCase()}: ${alertTypeLabel(alert.alert_type)} detected`;
    const alertsLink = DASHBOARD_URL ? `${DASHBOARD_URL}/alerts` : '';
    const settingsLink = DASHBOARD_URL ? `${DASHBOARD_URL}/settings/notifications` : '';

    const textBody = [
        `Layer5 Alert: ${alertTypeLabel(alert.alert_type)}`,
        `Severity: ${alert.severity}`,
        '',
        alert.message ?? 'No message provided.',
        '',
        `Detected: ${formatTimestamp(alert.detected_at)}`,
        alertsLink ? `View alerts: ${alertsLink}` : '',
        settingsLink ? `Manage settings: ${settingsLink}` : '',
    ].filter(Boolean).join('\n');

    const htmlBody = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px;">
            <h2 style="margin: 0 0 8px;">${severityEmoji(alert.severity)} ${alertTypeLabel(alert.alert_type)}</h2>
            <p style="color: #666; font-size: 14px; margin: 0 0 16px;">Severity: <strong>${alert.severity}</strong></p>
            <p style="font-size: 15px; line-height: 1.5;">${alert.message ?? 'No message provided.'}</p>
            <p style="color: #999; font-size: 13px; margin-top: 16px;">Detected: ${formatTimestamp(alert.detected_at)}</p>
            ${alertsLink ? `<p><a href="${alertsLink}" style="color: #3b82f6;">View alerts in dashboard</a></p>` : ''}
            ${settingsLink ? `<p style="font-size: 12px; color: #999;"><a href="${settingsLink}" style="color: #999;">Manage alert settings</a></p>` : ''}
        </div>
    `;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
            from: ALERT_FROM_EMAIL,
            to: [destination],
            subject,
            text: textBody,
            html: htmlBody,
        }),
        signal: AbortSignal.timeout(10000),
    });

    return {
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : `Resend HTTP ${response.status}`,
    };
}

// ── Main handler ────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const isCronInvocation = req.headers.get('x-supabase-event') === 'cron';

    if (!isCronInvocation && authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
    });

    const results = {
        alerts_found: 0,
        delivered: 0,
        failed: 0,
        errors: [] as string[],
    };

    // ── Check for test mode (single channel test) ──────────────
    let testMode = false;
    let testChannelId: string | null = null;
    let testAlert: Record<string, any> | null = null;

    if (req.method === 'POST') {
        try {
            const body = await req.json();
            if (body.test === true && body.channel_id) {
                testMode = true;
                testChannelId = body.channel_id;
                testAlert = {
                    alert_id: '00000000-0000-0000-0000-000000000000',
                    alert_type: body.alert_type ?? 'latency_spike',
                    severity: body.severity ?? 'warning',
                    message: body.message ?? 'This is a test notification from Layer5. Your alert channel is configured correctly.',
                    agent_id: null,
                    action_name: 'test_action',
                    metadata: { test: true },
                    detected_at: new Date().toISOString(),
                };
            }
        } catch {
            // Not JSON or missing fields — continue to normal mode
        }
    }

    // ── Test mode: deliver to single channel ───────────────────
    if (testMode && testChannelId && testAlert) {
        const { data: channel, error: chErr } = await supabase
            .from('alert_notification_channels')
            .select('id, channel_type, destination, label, customer_id')
            .eq('id', testChannelId)
            .maybeSingle();

        if (chErr || !channel) {
            return new Response(
                JSON.stringify({ success: false, error: 'Channel not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
        }

        let result: DeliveryResult;
        if (channel.channel_type === 'slack_webhook') {
            result = await deliverSlack(channel.destination, testAlert);
        } else if (channel.channel_type === 'webhook') {
            result = await deliverWebhook(channel.destination, testAlert);
        } else {
            result = await deliverEmail(channel.destination, testAlert);
        }

        return new Response(
            JSON.stringify({ success: result.ok, error: result.error, http_status: result.status }),
            { status: result.ok ? 200 : 502, headers: { 'Content-Type': 'application/json' } },
        );
    }

    // ── Normal mode: find undelivered alerts ───────────────────
    const { data: pending, error: queryErr } = await supabase.rpc(
        'get_undelivered_alerts',
    ).catch(() => ({ data: null, error: { message: 'RPC not found, using fallback query' } }));

    // Fallback: raw query if RPC doesn't exist
    let rows: Record<string, any>[] = [];

    if (queryErr || !pending) {
        // Use a simpler approach: fetch active channels, then match alerts
        const { data: channels } = await supabase
            .from('alert_notification_channels')
            .select('id, channel_type, destination, label, customer_id, min_severity, alert_type_filter')
            .eq('is_active', true);

        if (!channels || channels.length === 0) {
            console.log('[notification-dispatcher] No active channels found');
            return new Response(
                JSON.stringify({ ...results, duration_ms: Date.now() - startTime }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        }

        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        for (const ch of channels) {
            // Get alerts for this channel's customer
            const { data: alerts } = await supabase
                .from('degradation_alert_events')
                .select('alert_id, alert_type, severity, message, agent_id, action_name, metadata, detected_at')
                .gte('detected_at', cutoff)
                .order('detected_at', { ascending: true })
                .limit(100);

            if (!alerts || alerts.length === 0) continue;

            // Filter by customer's agents
            const { data: agentIds } = await supabase
                .from('dim_agents')
                .select('agent_id')
                .eq('customer_id', ch.customer_id);

            const customerAgentIds = new Set((agentIds ?? []).map((a: any) => a.agent_id));

            // Get already-delivered alert IDs for this channel
            const { data: delivered } = await supabase
                .from('alert_notification_log')
                .select('alert_id')
                .eq('channel_id', ch.id);

            const deliveredIds = new Set((delivered ?? []).map((d: any) => d.alert_id));

            const sevOrder: Record<string, number> = { info: 0, warning: 1, critical: 2 };
            const minSevLevel = sevOrder[ch.min_severity] ?? 1;

            for (const alert of alerts) {
                // Skip if already delivered
                if (deliveredIds.has(alert.alert_id)) continue;

                // Skip if agent doesn't belong to customer (null agent_id = system alert, include it)
                if (alert.agent_id && !customerAgentIds.has(alert.agent_id)) continue;

                // Severity filter
                const alertSevLevel = sevOrder[alert.severity] ?? 0;
                if (alertSevLevel < minSevLevel) continue;

                // Type filter (empty = all)
                if (ch.alert_type_filter && ch.alert_type_filter.length > 0) {
                    if (!ch.alert_type_filter.includes(alert.alert_type)) continue;
                }

                rows.push({
                    channel_id: ch.id,
                    channel_type: ch.channel_type,
                    destination: ch.destination,
                    label: ch.label,
                    customer_id: ch.customer_id,
                    ...alert,
                });
            }
        }
    } else {
        rows = pending as Record<string, any>[];
    }

    // Cap at 100 per run
    rows = rows.slice(0, 100);
    results.alerts_found = rows.length;

    console.log(`[notification-dispatcher] Found ${rows.length} undelivered alerts`);

    // ── Deliver each alert ─────────────────────────────────────
    for (const row of rows) {
        try {
            let result: DeliveryResult;

            if (row.channel_type === 'slack_webhook') {
                result = await deliverSlack(row.destination, row);
            } else if (row.channel_type === 'webhook') {
                result = await deliverWebhook(row.destination, row);
            } else if (row.channel_type === 'email') {
                result = await deliverEmail(row.destination, row);
            } else {
                result = { ok: false, status: null, error: `Unknown channel type: ${row.channel_type}` };
            }

            // Write to log REGARDLESS of success (prevents retry loops)
            await supabase
                .from('alert_notification_log')
                .upsert(
                    {
                        channel_id: row.channel_id,
                        alert_id: row.alert_id,
                        success: result.ok,
                        error_message: result.error,
                        http_status: result.status,
                    },
                    { onConflict: 'channel_id,alert_id' },
                );

            // Update last delivery stats on channel
            await supabase
                .from('alert_notification_channels')
                .update({
                    last_delivery_at: new Date().toISOString(),
                    last_delivery_ok: result.ok,
                    last_delivery_error: result.error,
                })
                .eq('id', row.channel_id);

            if (result.ok) {
                results.delivered++;
            } else {
                results.failed++;
                results.errors.push(`${row.channel_type}:${row.alert_id}: ${result.error}`);
            }
        } catch (err) {
            console.error('[notification-dispatcher] Delivery error:', err);
            results.failed++;

            // Still write to log so we don't retry infinitely
            try {
                await supabase
                    .from('alert_notification_log')
                    .upsert(
                        {
                            channel_id: row.channel_id,
                            alert_id: row.alert_id,
                            success: false,
                            error_message: String(err).slice(0, 500),
                            http_status: null,
                        },
                        { onConflict: 'channel_id,alert_id' },
                    );
            } catch {
                // Last resort — can't even log the failure
                console.error('[notification-dispatcher] Failed to log delivery failure');
            }
        }
    }

    const duration = Date.now() - startTime;
    console.log(`[notification-dispatcher] Done in ${duration}ms: ${results.delivered} delivered, ${results.failed} failed`);

    return new Response(
        JSON.stringify({ ...results, duration_ms: duration }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
});
