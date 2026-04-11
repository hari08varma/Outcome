/**
 * Layerinfinite — lib/predictive-drift.ts
 * ══════════════════════════════════════════════════════════════
 * Predictive drift detection using sliding window linear regression.
 *
 * Analyzes the last N outcomes for an action and projects whether
 * the success rate / outcome score is trending toward a failure
 * threshold. Emits a `predicted_drift` alert to degradation_alert_events
 * BEFORE the action actually degrades.
 *
 * Algorithm:
 *   1. Fetch last 20 outcomes for (action_id, customer_id)
 *   2. Compute simple linear regression: y = a + bx
 *      where y = outcome_score, x = sequence index (0..19)
 *   3. Project score at x = 30 (10 outcomes into the future)
 *   4. If projected score < threshold: emit predicted_drift alert
 *   5. Deduplicate: one alert per action per 24h window
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

// ── Config ────────────────────────────────────────────────────

const MIN_SAMPLES = 20;
const PROJECTION_HORIZON = 10; // project N outcomes into the future
const DEGRADATION_THRESHOLD = 0.35; // projected score below this triggers alert
const ALERT_DEDUP_HOURS = 24;

// ── Linear Regression ─────────────────────────────────────────

export interface RegressionResult {
    slope: number;       // b: change in score per outcome
    intercept: number;   // a: baseline score at x=0
    r2: number;          // R² goodness of fit (0-1)
    projectedScore: number; // score at x = n + PROJECTION_HORIZON
}

/**
 * Simple linear regression: y = a + bx
 * Returns slope, intercept, R², and projected score.
 */
export function linearRegression(scores: number[]): RegressionResult {
    const n = scores.length;
    if (n < 2) {
        return { slope: 0, intercept: scores[0] ?? 0.5, r2: 0, projectedScore: scores[0] ?? 0.5 };
    }

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += scores[i];
        sumXY += i * scores[i];
        sumX2 += i * i;
        sumY2 += scores[i] * scores[i];
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
        const avg = sumY / n;
        return { slope: 0, intercept: avg, r2: 0, projectedScore: avg };
    }

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    // R² calculation
    const ssRes = scores.reduce((acc, y, i) => {
        const predicted = intercept + slope * i;
        return acc + (y - predicted) ** 2;
    }, 0);
    const mean = sumY / n;
    const ssTot = scores.reduce((acc, y) => acc + (y - mean) ** 2, 0);
    const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

    const projectedScore = intercept + slope * (n - 1 + PROJECTION_HORIZON);

    return {
        slope: Number(slope.toFixed(6)),
        intercept: Number(intercept.toFixed(4)),
        r2: Number(r2.toFixed(4)),
        projectedScore: Number(Math.max(0, Math.min(1, projectedScore)).toFixed(4)),
    };
}

// ── Drift Prediction ──────────────────────────────────────────

export interface DriftPrediction {
    predicted: boolean;
    regression: RegressionResult | null;
    alertEmitted: boolean;
    reason: string | null;
}

/**
 * Checks whether an action is trending toward degradation.
 * Only runs when the action has ≥ MIN_SAMPLES outcomes.
 *
 * @param actionId - The action to analyze
 * @param customerId - Customer context
 * @param agentId - Agent context (for alert metadata)
 * @param actionName - Human-readable action name (for alert message)
 */
export async function predictDrift(
    actionId: string,
    customerId: string,
    agentId: string,
    actionName: string,
): Promise<DriftPrediction> {
    // 1. Fetch recent outcomes
    const { data: outcomes } = await supabase
        .from('fact_outcomes')
        .select('outcome_score')
        .eq('action_id', actionId)
        .eq('customer_id', customerId)
        .eq('is_deleted', false)
        .order('timestamp', { ascending: false })
        .limit(MIN_SAMPLES);

    if (!outcomes || outcomes.length < MIN_SAMPLES) {
        return { predicted: false, regression: null, alertEmitted: false, reason: 'insufficient_data' };
    }

    // Reverse to chronological order (oldest first)
    const scores = outcomes
        .reverse()
        .map(o => typeof o.outcome_score === 'number' ? o.outcome_score : 0.5);

    // 2. Run regression
    const regression = linearRegression(scores);

    // 3. Check if trending down significantly
    if (regression.slope >= 0) {
        return { predicted: false, regression, alertEmitted: false, reason: 'trend_stable_or_improving' };
    }

    if (regression.projectedScore >= DEGRADATION_THRESHOLD) {
        return { predicted: false, regression, alertEmitted: false, reason: 'projection_above_threshold' };
    }

    // Require minimum R² to avoid noisy regressions
    if (regression.r2 < 0.15) {
        return { predicted: false, regression, alertEmitted: false, reason: 'low_confidence_fit' };
    }

    // 4. Deduplicate: check for existing alert in last 24h
    const dedupWindow = new Date(Date.now() - ALERT_DEDUP_HOURS * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
        .from('degradation_alert_events')
        .select('id')
        .eq('customer_id', customerId)
        .eq('action_id', actionId)
        .eq('alert_type', 'predicted_drift')
        .gte('created_at', dedupWindow)
        .limit(1);

    if (existing && existing.length > 0) {
        return { predicted: true, regression, alertEmitted: false, reason: 'alert_already_exists' };
    }

    // 5. Emit alert
    const currentAvg = scores.slice(-5).reduce((a, b) => a + b, 0) / 5;
    await supabase.from('degradation_alert_events').insert({
        customer_id: customerId,
        agent_id: agentId,
        action_id: actionId,
        alert_type: 'predicted_drift',
        severity: 'warning',
        message:
            `Predictive drift detected on action "${actionName}". ` +
            `Current avg score: ${currentAvg.toFixed(3)}, projected score in ${PROJECTION_HORIZON} outcomes: ${regression.projectedScore}. ` +
            `Trend slope: ${regression.slope}/outcome (R²=${regression.r2}).`,
    });

    return { predicted: true, regression, alertEmitted: true, reason: null };
}
