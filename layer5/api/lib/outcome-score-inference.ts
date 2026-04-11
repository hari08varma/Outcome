/**
 * LAYERINFINITE — lib/outcome-score-inference.ts
 * ══════════════════════════════════════════════════════════════
 * Production-Grade 3-Layer Outcome Score Inference Engine
 *
 * Replaces the hardcoded `outcome_score ?? 0.5` fallback with a
 * signal-driven inference pipeline when the developer does not
 * provide an explicit outcome_score via score_fn.
 *
 * Architecture:
 *   Layer 1 — Hard Signals  (success, error_code, retry_attempt)
 *   Layer 2 — Soft Signals  (business_outcome, verifier, cross_event)
 *   Layer 3 — Relative Perf (adaptive baseline from action history)
 *
 * INVARIANTS:
 *   - Developer-provided score_fn always wins — inference is NEVER run
 *     when outcome_score is explicitly provided (score_origin='provided').
 *   - Inference confidence is capped at 0.85 — never as reliable as
 *     developer-provided scores.
 *   - Import rows skip inference by default; opt-in is available via
 *     ingest-core option enableInferenceWhenSkipTrust.
 *   - outcome-weighting.ts is NOT changed — inference feeds it
 *     automatically via the improved outcome_score values.
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

interface BaselineCacheEntry {
    value: ActionBaseline | null;
    expiresAt: number;
}

const actionBaselineCache = new Map<string, BaselineCacheEntry>();

const BASELINE_CACHE_TTL_MS_DEFAULT = 2 * 60 * 1000;
const BASELINE_CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const BASELINE_CACHE_MAX_ENTRIES = 5000;

function readPositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

function getBaselineCacheTtlMs(): number {
    return readPositiveInt(
        process.env.ACTION_BASELINE_CACHE_TTL_MS,
        BASELINE_CACHE_TTL_MS_DEFAULT,
    );
}

function baselineCacheKey(agentId: string, actionId: string): string {
    return `${agentId}:${actionId}`;
}

export function invalidateActionBaselineCache(agentId?: string, actionId?: string): void {
    if (agentId && actionId) {
        actionBaselineCache.delete(baselineCacheKey(agentId, actionId));
        return;
    }
    actionBaselineCache.clear();
}

export function __resetActionBaselineCacheForTests(): void {
    actionBaselineCache.clear();
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of actionBaselineCache.entries()) {
        if (entry.expiresAt <= now) {
            actionBaselineCache.delete(key);
        }
    }
}, BASELINE_CACHE_CLEANUP_INTERVAL_MS).unref();

// ── Types ─────────────────────────────────────────────────────

export interface InferenceSignals {
    // Layer 1 — always available
    success: boolean;
    retryAttempt: number | null;
    responseMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;

    // Layer 2 — optional soft signals
    businessOutcome: string | null;       // 'resolved'|'partial'|'failed'|'unknown'
    feedbackSignal: string | null;        // 'immediate'|'delayed'|'none'
    crossEventStatus: string | null;      // 'confirmed'|'conflict'|'resolved'|'pending_signal'
    verifierSource: string | null;        // from verifier.ts
    verifierValue: string | number | boolean | null;

    // Layer 3 — adaptive baseline (fetched async before inference)
    actionBaseline: ActionBaseline | null;
}

export interface ActionBaseline {
    p50ResponseMs: number;     // median of last 20 outcomes for this (agent, action)
    p75ResponseMs: number;     // 75th percentile
    recentSuccessRate: number; // success rate of last 20 outcomes
    sampleCount: number;       // how many outcomes exist — drives confidence
}

export type OutcomeClass =
    | 'success'          // clean success, no issues
    | 'partial_success'  // succeeded but with friction (retries, slow, partial)
    | 'degraded'         // succeeded technically but signals suggest quality loss
    | 'failure'          // clean failure
    | 'uncertain';       // contradictory signals, cannot classify reliably

export interface InferredOutcomeScore {
    score: number;           // 0.0–1.0
    confidence: number;      // 0.0–1.0 — how reliable this inference is
    class: OutcomeClass;
    origin: 'provided' | 'inferred';
    signalCount: number;     // how many signals contributed
    inferenceNotes: string[]; // human-readable list of what drove the score
}

// ── Layer 1 — Hard Signals ────────────────────────────────────
// Objective, always-present signals. success is the minimum.
// error_code and retry_attempt add granularity to failure/success.

function layer1Score(signals: InferenceSignals): {
    base: number;
    signalCount: number;
    notes: string[];
} {
    const notes: string[] = [];
    let signalCount = 1; // success is always present

    if (!signals.success) {
        // Failure path — classify severity from error_code
        const code = (signals.errorCode ?? '').toLowerCase();
        const msg = (signals.errorMessage ?? '').toLowerCase();

        if (code.includes('timeout') || msg.includes('timeout')) {
            notes.push('timeout_error: score=0.10');
            return { base: 0.10, signalCount, notes };
        }
        if (code.includes('partial') || msg.includes('partial')) {
            notes.push('partial_failure: score=0.25');
            return { base: 0.25, signalCount, notes };
        }
        if (code.includes('rate_limit') || code.includes('throttl')) {
            notes.push('rate_limit: score=0.15');
            return { base: 0.15, signalCount, notes };
        }
        notes.push('hard_failure: score=0.00');
        return { base: 0.00, signalCount, notes };
    }

    // Success path
    let base = 1.0;

    // Retry penalty — succeeded but took multiple attempts
    if (signals.retryAttempt !== null && signals.retryAttempt > 0) {
        signalCount++;
        const penalty = Math.min(0.30, signals.retryAttempt * 0.10);
        base -= penalty;
        notes.push(`retry_attempt=${signals.retryAttempt}: penalty=-${penalty.toFixed(2)}`);
    }

    return { base, signalCount, notes };
}

// ── Layer 2 — Soft Signals ────────────────────────────────────
// Optional high-value signals: business_outcome, cross_event, verifier.
// These can OVERRIDE Layer 1 when they carry stronger signal.

function layer2Adjustment(signals: InferenceSignals, base: number): {
    adjusted: number;
    class: OutcomeClass;
    signalDelta: number;
    notes: string[];
} {
    const notes: string[] = [];
    let adjusted = base;
    let signalDelta = 0;
    let outcomeClass: OutcomeClass = signals.success ? 'success' : 'failure';

    // business_outcome is the highest-value soft signal
    if (signals.businessOutcome) {
        signalDelta++;
        switch (signals.businessOutcome) {
            case 'resolved':
                adjusted = Math.max(adjusted, 0.85);
                outcomeClass = 'success';
                notes.push('business_outcome=resolved: floor=0.85');
                break;
            case 'partial':
                adjusted = Math.min(adjusted, 0.60);
                outcomeClass = 'partial_success';
                notes.push('business_outcome=partial: ceiling=0.60');
                break;
            case 'failed':
                adjusted = Math.min(adjusted, 0.15);
                outcomeClass = 'failure';
                notes.push('business_outcome=failed: ceiling=0.15');
                break;
            case 'unknown':
                // no adjustment — unknown is truly unknown
                break;
        }
    }

    // cross_event_status — downstream confirmation
    if (signals.crossEventStatus) {
        signalDelta++;
        if (signals.crossEventStatus === 'confirmed') {
            adjusted = Math.max(adjusted, 0.80);
            notes.push('cross_event=confirmed: floor=0.80');
        } else if (signals.crossEventStatus === 'conflict') {
            adjusted = Math.min(adjusted, 0.40);
            outcomeClass = 'uncertain';
            notes.push('cross_event=conflict: ceiling=0.40, class=uncertain');
        } else if (signals.crossEventStatus === 'resolved') {
            adjusted = Math.max(adjusted, 0.75);
            notes.push('cross_event=resolved: floor=0.75');
        }
    }

    // feedback_signal
    if (signals.feedbackSignal === 'delayed') {
        // Delayed feedback = deferred confirmation — slight uncertainty
        adjusted *= 0.95;
        signalDelta++;
        notes.push('feedback=delayed: confidence_factor=0.95');
    }

    // verifier contradiction — success=true but verifier says false
    // (verifier.ts already flips verified_success, but we also reflect in score)
    if (signals.verifierSource && signals.verifierSource !== 'none' && signals.verifierValue === false) {
        adjusted = Math.min(adjusted, 0.10);
        outcomeClass = 'failure';
        signalDelta++;
        notes.push(`verifier=${signals.verifierSource} returned false: ceiling=0.10`);
    }

    // Contradiction detection — success=true but got here with low base after retries + partial
    if (signals.success && adjusted < 0.50) {
        outcomeClass = 'degraded';
        notes.push('degraded: success=true but score<0.50 after adjustments');
    }

    return { adjusted, class: outcomeClass, signalDelta, notes };
}

// ── Layer 3 — Relative Performance ────────────────────────────
// Adaptive baseline: compare this outcome's latency against the
// action's own historical p50/p75 — NOT a hardcoded threshold.
// Only active when sufficient history exists (sampleCount >= 5).

function layer3RelativeAdjustment(
    adjusted: number,
    signals: InferenceSignals,
): {
    final: number;
    confidenceDelta: number;
    notes: string[];
} {
    const notes: string[] = [];
    let confidenceDelta = 0;
    const baseline = signals.actionBaseline;

    if (!baseline || baseline.sampleCount < 5) {
        // Not enough history — skip relative adjustment, but note it
        notes.push(`no_baseline: sampleCount=${baseline?.sampleCount ?? 0}`);
        return { final: adjusted, confidenceDelta: 0, notes };
    }

    let final = adjusted;

    // Latency relative to this action's own p75 baseline
    // Not hardcoded 5000ms — adaptive per action
    if (signals.responseMs !== null && baseline.p75ResponseMs > 0) {
        const ratio = signals.responseMs / baseline.p75ResponseMs;
        if (ratio > 3.0) {
            const penalty = Math.min(0.20, (ratio - 3.0) * 0.04);
            final -= penalty;
            confidenceDelta += 0.05; // more signals = more confidence in inference
            notes.push(`latency=${signals.responseMs}ms vs p75=${baseline.p75ResponseMs}ms (${ratio.toFixed(1)}x): penalty=-${penalty.toFixed(2)}`);
        } else if (ratio < 0.5) {
            // Faster than usual — slight positive signal
            final = Math.min(1.0, final + 0.05);
            notes.push(`latency=${signals.responseMs}ms is faster than p75 baseline: +0.05`);
        }
        confidenceDelta += 0.05;
    }

    return { final: Math.max(0, Math.min(1, final)), confidenceDelta, notes };
}

// ── Confidence Calculation ────────────────────────────────────
// Adaptive to signal count and historical sample depth.
// More signals + more history = higher confidence.
// Capped at 0.85 — inference is never as reliable as developer-provided.

function computeInferenceConfidence(
    signalCount: number,
    sampleCount: number,
    hasContradiction: boolean,
): number {
    // Base: more signals = more confident
    // 1 signal (just success) → 0.42
    // 2 signals               → 0.54
    // 3 signals               → 0.66
    // 4+ signals              → 0.75 (capped)
    const base = Math.min(0.75, 0.30 + signalCount * 0.12);

    // History boost: more historical samples = more reliable baseline
    const historyBoost = sampleCount >= 20 ? 0.10
        : sampleCount >= 10 ? 0.06
            : sampleCount >= 5 ? 0.03
                : 0;

    // Contradiction penalty
    const contradictionPenalty = hasContradiction ? 0.20 : 0;

    return Math.max(0.10, Math.min(0.85, base + historyBoost - contradictionPenalty));
}

// ── Baseline Fetch ────────────────────────────────────────────
// Queries last 20 live SDK outcomes for this (agent, action) pair.
// Returns p50/p75 latency, success rate, and sample count.
// Returns null if insufficient data (< 5 outcomes).

export async function fetchActionBaseline(
    agentId: string,
    actionId: string,
): Promise<ActionBaseline | null> {
    const cacheKey = baselineCacheKey(agentId, actionId);
    const now = Date.now();
    const cached = actionBaselineCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const { data } = await supabase
        .from('fact_outcomes')
        .select('response_time_ms, success')
        .eq('agent_id', agentId)
        .eq('action_id', actionId)
        .eq('ingestion_source', 'sdk')    // only live signal
        .eq('is_synthetic', false)
        .eq('is_deleted', false)          // exclude GDPR soft-deletes
        .order('timestamp', { ascending: false })
        .limit(20);

    if (!data || data.length < 5) {
        actionBaselineCache.set(cacheKey, {
            value: null,
            expiresAt: now + getBaselineCacheTtlMs(),
        });
        return null;
    }

    const latencies = data
        .map(r => r.response_time_ms)
        .filter((v): v is number => typeof v === 'number' && v > 0)
        .sort((a, b) => a - b);

    if (latencies.length === 0) {
        actionBaselineCache.set(cacheKey, {
            value: null,
            expiresAt: now + getBaselineCacheTtlMs(),
        });
        return null;
    }

    const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p75 = latencies[Math.floor(latencies.length * 0.75)] ?? p50;
    const successes = data.filter(r => r.success).length;

    const baseline: ActionBaseline = {
        p50ResponseMs: p50,
        p75ResponseMs: p75,
        recentSuccessRate: successes / data.length,
        sampleCount: data.length,
    };

    actionBaselineCache.set(cacheKey, {
        value: baseline,
        expiresAt: now + getBaselineCacheTtlMs(),
    });

    if (actionBaselineCache.size > BASELINE_CACHE_MAX_ENTRIES) {
        const oldestKey = actionBaselineCache.keys().next().value as string | undefined;
        if (oldestKey) actionBaselineCache.delete(oldestKey);
    }

    return baseline;
}

// ── Public Entry Point ────────────────────────────────────────
// Runs all 3 layers sequentially and produces a final score.
// This is the ONLY export that callers need for inference.
// fetchActionBaseline must be called separately before this
// (async DB fetch cannot be inside a sync function).

export function inferOutcomeScore(signals: InferenceSignals): InferredOutcomeScore {
    const l1 = layer1Score(signals);
    const l2 = layer2Adjustment(signals, l1.base);
    const l3 = layer3RelativeAdjustment(l2.adjusted, signals);

    const totalSignalCount = l1.signalCount + l2.signalDelta;
    const hasContradiction = l2.class === 'uncertain';

    const confidence = computeInferenceConfidence(
        totalSignalCount,
        signals.actionBaseline?.sampleCount ?? 0,
        hasContradiction,
    );

    return {
        score: Number(l3.final.toFixed(4)),
        confidence: Number(confidence.toFixed(4)),
        class: l2.class,
        origin: 'inferred',
        signalCount: totalSignalCount,
        inferenceNotes: [...l1.notes, ...l2.notes, ...l3.notes],
    };
}
