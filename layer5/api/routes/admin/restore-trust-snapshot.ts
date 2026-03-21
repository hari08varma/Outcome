/**
 * Layerinfinite — routes/admin/restore-trust-snapshot.ts
 * POST /v1/admin/restore-trust-snapshot
 * ══════════════════════════════════════════════════════════════
 * Restores an agent's trust score to its most recent pre-incident
 * snapshot. Used after a coordinated infrastructure failure resolves.
 *
 * Body:
 *   agent_id    — UUID of the agent to restore
 *   incident_id — (optional) filter to snapshots tagged with this incident
 *   restored_by — name/identifier of the operator performing the restore
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../../lib/supabase.js';

export const restoreTrustSnapshotRouter = new Hono();

const RestoreBody = z.object({
    agent_id: z.string().uuid(),
    incident_id: z.string().optional(),
    restored_by: z.string().min(1).max(255),
});

restoreTrustSnapshotRouter.post('/', async (c) => {
    const customerId = c.get('customer_id') as string;

    let body: z.infer<typeof RestoreBody>;
    try {
        body = RestoreBody.parse(await c.req.json());
    } catch (err: any) {
        return c.json({ error: 'Invalid request body', details: err.errors ?? err.message }, 400);
    }

    // ── Verify agent belongs to this customer ──────────────────
    const { data: agent, error: agentErr } = await supabase
        .from('dim_agents')
        .select('agent_id, agent_name, customer_id')
        .eq('agent_id', body.agent_id)
        .eq('customer_id', customerId)
        .maybeSingle();

    if (agentErr) return c.json({ error: 'Agent lookup failed', details: agentErr.message }, 500);
    if (!agent) return c.json({ error: 'Agent not found or does not belong to your account' }, 404);

    // ── Fetch current trust score ──────────────────────────────
    const { data: currentTrust, error: trustErr } = await supabase
        .from('agent_trust_scores')
        .select('trust_score, trust_status, consecutive_failures')
        .eq('agent_id', body.agent_id)
        .maybeSingle();

    if (trustErr) return c.json({ error: 'Trust lookup failed', details: trustErr.message }, 500);
    if (!currentTrust) return c.json({ error: 'Trust record not found for agent' }, 404);

    // ── Find the most recent matching snapshot ─────────────────
    let snapshotQuery = supabase
        .from('agent_trust_snapshots')
        .select('id, trust_score, trust_status, consecutive_failures, snapshot_reason, incident_id, created_at')
        .eq('agent_id', body.agent_id)
        .order('created_at', { ascending: false })
        .limit(1);

    if (body.incident_id) {
        snapshotQuery = snapshotQuery.eq('incident_id', body.incident_id);
    } else {
        // Without a specific incident, restore from the most recent pre_incident snapshot
        snapshotQuery = snapshotQuery.eq('snapshot_reason', 'pre_incident');
    }

    const { data: snapshot, error: snapErr } = await snapshotQuery.maybeSingle();

    if (snapErr) return c.json({ error: 'Snapshot lookup failed', details: snapErr.message }, 500);
    if (!snapshot) {
        return c.json(
            {
                error: 'No matching snapshot found',
                hint: body.incident_id
                    ? `No snapshot found for incident "${body.incident_id}"`
                    : 'No pre_incident snapshot found. Use POST /v1/admin/reinstate-agent for manual reinstatement.',
            },
            404
        );
    }

    // ── Restore trust to snapshot values ──────────────────────
    const { error: updateErr } = await supabase
        .from('agent_trust_scores')
        .update({
            trust_score: snapshot.trust_score,
            trust_status: snapshot.trust_status,
            consecutive_failures: snapshot.consecutive_failures,
            suspension_reason: null,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', body.agent_id);

    if (updateErr) return c.json({ error: 'Failed to restore trust snapshot', details: updateErr.message }, 500);

    // ── Audit log ──────────────────────────────────────────────
    await supabase.from('agent_trust_audit').insert({
        agent_id: body.agent_id,
        customer_id: customerId,
        event_type: 'reinstated',
        old_score: currentTrust.trust_score,
        new_score: snapshot.trust_score,
        old_status: currentTrust.trust_status,
        new_status: snapshot.trust_status,
        performed_by: body.restored_by,
        reason: `Trust restored from snapshot (incident: ${body.incident_id ?? 'latest pre_incident'}, snapshot_id: ${snapshot.id}). Operator: ${body.restored_by}.`,
    });

    return c.json({
        restored: true,
        agent_id: body.agent_id,
        agent_name: agent.agent_name,
        snapshot_id: snapshot.id,
        snapshot_created_at: snapshot.created_at,
        incident_id: snapshot.incident_id,
        previous_score: currentTrust.trust_score,
        previous_status: currentTrust.trust_status,
        restored_score: snapshot.trust_score,
        restored_status: snapshot.trust_status,
        message: `Trust for "${agent.agent_name}" restored to pre-incident snapshot (score: ${snapshot.trust_score.toFixed(3)}, status: ${snapshot.trust_status}).`,
    });
});
