/**
 * Layer5 — routes/admin/trigger-training.ts
 * POST /v1/admin/trigger-training
 * ══════════════════════════════════════════════════════════════
 * Check training readiness and trigger training manually.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../../lib/supabase.js';

export const triggerTrainingRoute = new Hono();

triggerTrainingRoute.post('/', async (c) => {
    // 1. Checks training readiness
    const { count: outcomeCount } = await supabase
        .from('fact_outcomes')
        .select('*', { count: 'exact', head: true });

    const { count: sequenceCount } = await supabase
        .from('action_sequences')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'closed');

    const { data: model } = await supabase
        .from('world_model_artifacts')
        .select('version, trained_at')
        .eq('is_active', true)
        .order('trained_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    const readyForTier2 = (outcomeCount || 0) >= 200;
    const readyForTier3 = (outcomeCount || 0) >= 1000;

    let trainingRecommended = false;
    let reason = '';

    if (!model && readyForTier2) {
        trainingRecommended = true;
        reason = `${outcomeCount || 0} outcomes available, no model trained yet`;
    } else if (model) {
        const days = Math.floor((Date.now() - new Date(model.trained_at).getTime()) / (1000 * 60 * 60 * 24));
        if (days >= 7) {
            trainingRecommended = true;
            reason = `Model trained ${days} days ago`;
        } else {
            reason = `Model trained recently (${days} days ago)`;
        }
    } else {
        reason = `Not enough outcomes (${outcomeCount || 0}/200) for Tier 2 model`;
    }

    const report = {
        outcome_count: outcomeCount || 0,
        sequence_count: sequenceCount || 0,
        ready_for_tier2: readyForTier2,
        ready_for_tier3: readyForTier3,
        active_model_version: model?.version || null,
        active_model_trained_at: model?.trained_at || null,
        training_recommended: trainingRecommended,
        reason: reason
    };

    const action = c.req.query('action');
    if (action === 'trigger') {
        const webhookUrl = process.env.TRAINING_WEBHOOK_URL;
        if (!webhookUrl) {
            return c.json({
                ...report,
                triggered: false,
                message: "Set TRAINING_WEBHOOK_URL env var to enable remote training triggers. Run training/train_world_model.py manually or set up Cloud Run scheduled job (see training/DEPLOY.md)."
            }, 200);
        }

        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            return c.json({
                ...report,
                triggered: true,
                job_id: 'dispatched via webhook'
            }, 200);
        } catch (err: any) {
            return c.json({ error: 'Failed to trigger training webhook', details: err.message }, 500);
        }
    }

    return c.json(report, 200);
});
