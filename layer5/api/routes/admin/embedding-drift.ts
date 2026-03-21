/**
 * Layerinfinite — routes/admin/embedding-drift.ts
 * ══════════════════════════════════════════════════════════════
 * GET  /v1/admin/embedding-drift         → latest drift report
 * POST /v1/admin/embedding-drift/check   → run drift detection now
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { supabase } from '../../lib/supabase.js';
import { runDriftDetection } from '../../lib/drift-detector.js';

export const embeddingDriftRouter = new Hono();

// GET latest drift report
embeddingDriftRouter.get('/', async (c) => {
    const { data, error } = await supabase
        .from('embedding_drift_reports')
        .select('*')
        .order('checked_at', { ascending: false })
        .limit(10);

    if (error) return c.json({ error: 'Failed to fetch drift reports', details: error.message }, 500);

    return c.json({
        reports: data ?? [],
        latest: data?.[0] ?? null,
    });
});

// POST trigger a drift check
embeddingDriftRouter.post('/check', async (c) => {
    const report = await runDriftDetection();
    return c.json(report, report.drift_detected ? 200 : 200);
});
