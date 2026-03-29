import type {
    RecommendationResult,
    RecommendationState,
} from './engine.js';
import { MIN_SAMPLES, MIN_SAMPLES_HIGH_CONFIDENCE } from './engine.js';

function pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high' | 'very_high';
type SuggestedAction = 'collect_more_data' | 'monitor' | 'replace';

export interface ConfidenceMeta {
    value: number;
    percent: number;
}

type InternalConfidenceMeta = ConfidenceMeta & {
    label: ConfidenceLabel;
};

function toConfidenceMeta(confidence: number | null): InternalConfidenceMeta {
    if (confidence === null) {
        return {
            value: 0,
            percent: 0,
            label: 'none',
        };
    }

    const rounded = Math.max(0, Math.min(1, confidence));
    if (rounded < 0.2) {
        return {
            value: rounded,
            percent: Math.round(rounded * 100),
            label: 'low',
        };
    }
    if (rounded < 0.5) {
        return {
            value: rounded,
            percent: Math.round(rounded * 100),
            label: 'medium',
        };
    }
    if (rounded < 0.8) {
        return {
            value: rounded,
            percent: Math.round(rounded * 100),
            label: 'high',
        };
    }
    return {
        value: rounded,
        percent: Math.round(rounded * 100),
        label: 'very_high',
    };
}

function templateNoData(
    taskName: string,
    totalOutcomes: number,
    ctx?: RecommendationResult['_qualification_context'],
): string {
    if (totalOutcomes === 0) {
        return (
            `No outcome data found for task "${taskName}". ` +
            `Ensure task_name is included when calling log_outcome.`
        );
    }

    // Has a qualified leader but needs a second qualified action
    if (ctx && ctx.qualified_count === 1 && ctx.leading_action) {
        const l = ctx.leading_action;
        const needing = ctx.actions_needing_more
            .map((a) => `${a.action_name} needs ${a.needed} more outcome${a.needed === 1 ? '' : 's'}`)
            .join('; ');
        return (
            `"${l.name}" is the leading action for "${taskName}" ` +
            `(${l.total} outcomes, ${(l.rate * 100).toFixed(1)}% success rate). ` +
            `A second qualified action is needed to generate a recommendation. ` +
            (needing ? `Progress: ${needing}.` : `Log more outcomes for other actions.`)
        );
    }

    // Generic: multiple actions but none qualified
    if (ctx && ctx.actions_needing_more.length > 0) {
        const needing = ctx.actions_needing_more
            .map((a) => `${a.action_name} (${a.current}/${MIN_SAMPLES})`)
            .join(', ');
        return (
            `Collecting data for "${taskName}". ` +
            `Actions need ${MIN_SAMPLES}+ outcomes each: ${needing}.`
        );
    }

    return (
        `Collecting data for "${taskName}" ` +
        `(${totalOutcomes} outcome${totalOutcomes === 1 ? '' : 's'} ` +
        `logged so far, ` +
        `need ${MIN_SAMPLES}+ per action across 2+ distinct actions).`
    );
}

const STATE_META: Record<RecommendationState, { ui_label: string; explanation: string }> = {
    no_data: {
        ui_label: 'Collecting Data',
        explanation: 'Not enough outcomes yet to compare actions.',
    },
    early_signal: {
        ui_label: 'Early Signal',
        explanation: 'A difference exists but confidence is low. Monitor before acting.',
    },
    stable: {
        ui_label: 'Stable Signal',
        explanation: 'A consistent performance gap has been detected.',
    },
};

export interface ActionableOutput {
    // Identity
    task: string;
    state: RecommendationState;
    ui_label: string;
    explanation: string;

    // Decision block
    decision: {
        type: SuggestedAction;
        action_required: boolean;
    };

    // Insight block
    insight: {
        best_action: string | null;
        best_rate: number | null;
        worst_action: string | null;
        worst_rate: number | null;
        delta: number | null;
        sample_size: { best: number; worst: number } | null;
    };

    progress: {
        current_samples: number;
        target_samples: number;
        percent_complete: number;
    };

    // Confidence block
    confidence: number;
    confidence_label: ConfidenceLabel;
    confidence_meta: ConfidenceMeta;

    // Human text
    message: string;
    reason: {
        summary: string;
        evidence: string;
        confidence_note: string;
    };
    problem: string | null;
    risk_context: string | null;

    // Improvement (stable only)
    expected_improvement: {
        baseline: string;
        improved: string;
        delta: string;
        delta_raw: number;
        based_on_samples: number;
        caution: string | null;
    } | null;

    validation_hint: string | null;

    // Meta
    sample_size: { best: number; worst: number; min: number } | null;
    generated_at: string;

    // Issue 1+2: confidence-qualified improvement display
    improvement_display: {
        raw_delta_pct: string;
        qualified_delta_pct: string;
        is_estimate: boolean;
        samples_basis: number;
    } | null;

    // Issue 3: actionable monitoring steps
    monitor_steps: string[] | null;

    // Issue 4: unlock threshold explanation
    unlock_hint: string | null;

    // Issue 5: time dimension
    data_window: {
        first_seen_at: string | null;
        last_seen_at: string | null;
        last_updated_label: string;
    } | null;

    // Issue 6: per-action uncertainty bands
    action_uncertainty: {
        best: { action: string; rate_pct: string; margin_pct: string };
        worst: { action: string; rate_pct: string; margin_pct: string };
    } | null;

    // Issue 7: decision threshold hint
    threshold_hint: string;

    // Issue 8: agent scope label
    scope_label: string;
}

// Issue 1+2: Raw delta with uncertainty label, plus confidence-weighted delta
function buildImprovementDisplay(
    delta: number,
    confidence: number | null,
    minSamples: number,
    isEarlySignal: boolean,
): ActionableOutput['improvement_display'] {
    if (delta <= 0) return null;
    const conf = confidence ?? 0;
    const rawPct = `+${(delta * 100).toFixed(1)}%`;
    const qualifiedRaw = delta * conf;
    const qualifiedPct = `+${(qualifiedRaw * 100).toFixed(1)}%`;
    return {
        raw_delta_pct: rawPct,
        qualified_delta_pct: qualifiedPct,
        is_estimate: isEarlySignal || conf < 0.5,
        samples_basis: minSamples,
    };
}

// Issue 3: Concrete monitor steps
function buildMonitorSteps(
    currentSamples: number,
    targetSamples: number,
    bestAction: string,
    taskName: string,
): string[] {
    const remaining = Math.max(0, targetSamples - currentSamples);
    return [
        `Continue logging outcomes for task "${taskName}" with task_name="${taskName}" in your log_outcome calls`,
        `Run at least ${remaining} more executions of ${bestAction} to reach ${targetSamples} total samples`,
        `Do NOT switch actions yet — wait for the confidence bar to reach 50%+`,
        `Re-check this page after every ~10 new outcomes`,
    ];
}

// Issue 4: Unlock hint text
function buildUnlockHint(
    currentSamples: number,
    targetSamples: number,
    _confidencePct: number,
): string {
    const remaining = Math.max(0, targetSamples - currentSamples);
    if (remaining === 0) {
        return `Enough samples collected. Confidence will unlock once signal stabilizes above 50%.`;
    }
    return (
        `~${remaining} more outcomes needed to approach a stable signal. ` +
        `A high-confidence recommendation unlocks at ~${targetSamples} samples + 80% confidence.`
    );
}

// Issue 6: Per-action margin of error using Wilson score interval (simplified)
// margin ≈ 1.96 × sqrt(p(1-p)/n) — 95% confidence interval half-width
function wilsonMargin(successRate: number, n: number): string {
    if (n === 0) return '±?%';
    const p = Math.min(1, Math.max(0, successRate));
    const margin = 1.96 * Math.sqrt((p * (1 - p)) / n);
    return `±${(margin * 100).toFixed(1)}%`;
}

function buildActionUncertainty(
    best: { action_name: string; success_rate: number; total_count: number },
    worst: { action_name: string; success_rate: number; total_count: number },
): ActionableOutput['action_uncertainty'] {
    return {
        best: {
            action: best.action_name,
            rate_pct: `${(best.success_rate * 100).toFixed(1)}%`,
            margin_pct: wilsonMargin(best.success_rate, best.total_count),
        },
        worst: {
            action: worst.action_name,
            rate_pct: `${(worst.success_rate * 100).toFixed(1)}%`,
            margin_pct: wilsonMargin(worst.success_rate, worst.total_count),
        },
    };
}

// Issue 5: Relative time label from ISO string
function relativeTimeLabel(isoString: string | null): string {
    if (!isoString) return 'Unknown';
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 2) return 'Updated just now';
    if (mins < 60) return `Updated ${mins} minutes ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Updated ${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    const days = Math.floor(hrs / 24);
    return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

function buildInsight(r: RecommendationResult): ActionableOutput['insight'] {
    if (!r.best_action) {
        return {
            best_action: null,
            best_rate: null,
            worst_action: null,
            worst_rate: null,
            delta: null,
            sample_size: null,
        };
    }
    return {
        best_action: r.best_action.action_name,
        best_rate: Number(r.best_action.success_rate.toFixed(4)),
        worst_action: r.worst_action?.action_name ?? null,
        worst_rate: r.worst_action
            ? Number(r.worst_action.success_rate.toFixed(4))
            : null,
        delta: r.worst_action
            ? Number((r.best_action.success_rate - r.worst_action.success_rate).toFixed(4))
            : null,
        sample_size: r.worst_action
            ? { best: r.best_action.total_count, worst: r.worst_action.total_count }
            : null,
    };
}

function buildMessage(
    state: RecommendationState,
    actionRequired: boolean,
    confidenceMeta: InternalConfidenceMeta,
    best: string | null,
    worst: string | null,
): string {
    if (state === 'no_data') {
        return 'We are observing this task. No action recommended yet. ' +
            'Log more outcomes to unlock a recommendation.';
    }
    if (state === 'early_signal') {
        return `Early signal: ${best ?? 'best action'} appears ahead of ` +
            `${worst ?? 'current action'}, but confidence is too low to act. ` +
            'Monitor and collect more outcomes before switching.';
    }
    if (!actionRequired) {
        return `${best ?? 'best action'} is outperforming, but confidence is ` +
            `${confidenceMeta.percent}%. Pilot it before a full rollout.`;
    }
    return `Replace ${worst ?? 'current action'} with ${best ?? 'best action'}. ` +
        `This recommendation has ${confidenceMeta.percent}% confidence.`;
}

function buildProgress(minSampleCount: number): ActionableOutput['progress'] {
    const current = minSampleCount;
    const target = MIN_SAMPLES_HIGH_CONFIDENCE;
    const pctComplete = Math.min(100, Math.round((current / target) * 100));
    return {
        current_samples: current,
        target_samples: target,
        percent_complete: pctComplete,
    };
}

function buildReason(
    r: RecommendationResult,
    confidenceMeta: InternalConfidenceMeta,
): ActionableOutput['reason'] {
    if (r.state === 'no_data') {
        const trustBlocked = (r as any)._trust_gate_blocked === true;
        const totalOutcomes = r.all_actions.reduce(
            (sum, a) => sum + a.total_count,
            0,
        );
        const reasonText = trustBlocked
            ? `Agent suspended (trust_status: ${(r as any)._trust_status ?? 'suspended'})`
            : templateNoData(r.task, totalOutcomes, r._qualification_context);
        return {
            summary: trustBlocked
                ? 'Agent is suspended'
                : `Collecting data for "${r.task}"`,
            evidence: totalOutcomes > 0
                ? `${totalOutcomes} total outcome${totalOutcomes === 1 ? '' : 's'} logged`
                : 'No outcomes logged yet',
            confidence_note: reasonText,
        };
    }

    const b = r.best_action!;
    const w = r.worst_action!;
    const confText = `${confidenceMeta.percent}% confidence`;
    const uncertainNote = confidenceMeta.label === 'low' || confidenceMeta.label === 'none'
        ? ' — result may change with more data'
        : confidenceMeta.label === 'very_high'
            ? ' — high confidence, signal is stable'
            : '';

    if (r.state === 'early_signal') {
        const delta = b.success_rate - w.success_rate;
        return {
            summary: delta < 0.08
                ? `${b.action_name} and ${w.action_name} perform similarly`
                : `${b.action_name} outperforms ${w.action_name}`,
            evidence: `${pct(b.success_rate)} vs ${pct(w.success_rate)} (${b.total_count} and ${w.total_count} runs)`,
            confidence_note: `${confText}${uncertainNote}`,
        };
    }

    const imp = r.improvement!;
    return {
        summary: `${b.action_name} outperforms ${w.action_name}`,
        evidence: `${pct(imp.improved_rate)} vs ${pct(imp.baseline_rate)} (+${pct(imp.absolute_delta)}, ${r.min_sample_count} runs each)`,
        confidence_note: `${confText}${uncertainNote}`,
    };
}

export function buildActionableOutput(
    r: RecommendationResult,
): ActionableOutput {
    const confidenceMeta = toConfidenceMeta(r.confidence);
    const confidenceLabel = confidenceMeta.label;
    const stateMeta = STATE_META[r.state];

    // Issue 7: threshold hint — always present
    const thresholdHint =
        `Recommendations appear at 50%+ confidence and stabilize at 80%+. ` +
        `High-confidence (80%+) recommendations include a direct "replace" action.`;

    // Issue 8: scope label — placeholder, overwritten by route via spread
    const scopeLabel = '';

    const base = {
        task: r.task,
        state: r.state,
        ui_label: stateMeta.ui_label,
        explanation: stateMeta.explanation,
        confidence_meta: {
            value: confidenceMeta.value,
            percent: confidenceMeta.percent,
            label: confidenceMeta.label,
        },
        progress: buildProgress(r.min_sample_count),
        generated_at: r.generated_at,
    };

    if (r.state === 'no_data') {
        const trustBlocked = (r as any)._trust_gate_blocked === true;
        return {
            ...base,
            decision: {
                type: 'collect_more_data',
                action_required: false,
            },
            problem: null,
            risk_context: trustBlocked
                ? 'This agent has critically low trust. Acting on its history may cause regressions.'
                : 'Evidence is insufficient. Acting now may cause regressions without measurable upside.',
            expected_improvement: null,
            reason: buildReason(r, confidenceMeta),
            confidence: 0,
            confidence_label: confidenceLabel,
            insight: buildInsight(r),
            message: buildMessage('no_data', false, confidenceMeta, null, null),
            validation_hint: null,
            sample_size: null,
            improvement_display: null,
            monitor_steps: null,
            unlock_hint: buildUnlockHint(0, MIN_SAMPLES_HIGH_CONFIDENCE, 0),
            data_window: null,
            action_uncertainty: null,
            threshold_hint: thresholdHint,
            scope_label: scopeLabel,
        };
    }

    if (r.state === 'early_signal') {
        const b = r.best_action!;
        const w = r.worst_action!;
        const delta = b.success_rate - w.success_rate;
        const lastSeen = b.last_seen_at || w.last_seen_at || null;
        return {
            ...base,
            decision: {
                type: 'monitor',
                action_required: false,
            },
            problem: (() => {
                if (delta < 0.08) {
                    return (
                        `${b.action_name} and ${w.action_name} perform similarly ` +
                        `(${pct(b.success_rate)} vs ${pct(w.success_rate)}, ` +
                        `${b.total_count} and ${w.total_count} outcomes - monitoring)`
                    );
                }
                return (
                    `${w.action_name} is underperforming ` +
                    `(${pct(w.success_rate)} success rate, ` +
                    `${w.total_count} outcomes - early data)`
                );
            })(),
            risk_context: (r as any)._silent_failure_warning
                ? 'Silent failures detected in the last 24h: some outcomes marked success=true had low outcome scores. Signal direction is promising but uncertainty remains high.'
                : 'Signal direction is promising but uncertainty remains high; immediate full replacement may be premature.',
            expected_improvement: (() => {
                if (delta <= 0) return null;
                return {
                    baseline: pct(w.success_rate),
                    improved: pct(b.success_rate),
                    delta: `+${(delta * 100).toFixed(1)}% (early estimate)`,
                    delta_raw: Number(delta.toFixed(4)),
                    based_on_samples: r.min_sample_count,
                    caution: `Based on ${r.min_sample_count} outcomes per action at ` +
                        `${Math.round((r.confidence ?? 0) * 100)}% confidence. ` +
                        `Effective reliable gain: ~${((delta * (r.confidence ?? 0)) * 100).toFixed(1)}%.`,
                };
            })(),
            reason: buildReason(r, confidenceMeta),
            confidence: r.confidence ?? 0,
            confidence_label: confidenceLabel,
            insight: buildInsight(r),
            message: (() => {
                if (delta < 0.08) {
                    return (
                        `${b.action_name} and ${w.action_name} are performing ` +
                        `similarly (${pct(b.success_rate)} vs ${pct(w.success_rate)}). ` +
                        `Continue collecting data before making a switch.`
                    );
                }
                return buildMessage(
                    'early_signal',
                    false,
                    confidenceMeta,
                    r.best_action?.action_name ?? null,
                    r.worst_action?.action_name ?? null,
                );
            })(),
            validation_hint: null,
            sample_size: {
                best: b.total_count,
                worst: w.total_count,
                min: r.min_sample_count,
            },
            improvement_display: buildImprovementDisplay(
                delta,
                r.confidence,
                r.min_sample_count,
                true,
            ),
            monitor_steps: buildMonitorSteps(
                r.min_sample_count,
                MIN_SAMPLES_HIGH_CONFIDENCE,
                b.action_name,
                r.task,
            ),
            unlock_hint: buildUnlockHint(
                r.min_sample_count,
                MIN_SAMPLES_HIGH_CONFIDENCE,
                Math.round((r.confidence ?? 0) * 100),
            ),
            data_window: {
                first_seen_at: null,
                last_seen_at: lastSeen,
                last_updated_label: relativeTimeLabel(lastSeen),
            },
            action_uncertainty: buildActionUncertainty(b, w),
            threshold_hint: thresholdHint,
            scope_label: scopeLabel,
        };
    }

    const b = r.best_action!;
    const w = r.worst_action!;
    const imp = r.improvement!;
    const shouldAct =
        confidenceMeta.label === 'high' ||
        confidenceMeta.label === 'very_high';
    const lastSeen = b.last_seen_at || w.last_seen_at || null;

    return {
        ...base,
        decision: {
            type: shouldAct ? 'replace' : 'monitor',
            action_required: shouldAct,
        },
        problem: (
            `${w.action_name} is underperforming ` +
            `(${pct(imp.baseline_rate)} success rate, ` +
            `${w.total_count} outcomes)`
        ),
        risk_context: (r as any)._silent_failure_warning
            ? (shouldAct
                ? 'Silent failures detected in the last 24h. Verify outcome_score quality before fully committing to this switch.'
                : 'Silent failures detected in the last 24h. Confidence is insufficient AND outcome quality is degraded.')
            : (shouldAct
                ? null
                : 'Improvement exists, but confidence is not yet high enough for an immediate irreversible switch.'),
        expected_improvement: {
            baseline: pct(imp.baseline_rate),
            improved: pct(imp.improved_rate),
            delta: `+${pct(imp.absolute_delta)}`,
            delta_raw: Number(imp.absolute_delta.toFixed(4)),
            based_on_samples: r.min_sample_count,
            caution: (r.confidence ?? 0) < 0.50
                ? `Based on ${r.min_sample_count} outcomes per action. Result may shift with more data.`
                : null,
        },
        reason: buildReason(r, confidenceMeta),
        confidence: r.confidence ?? 0,
        confidence_label: confidenceLabel,
        insight: buildInsight(r),
        message: buildMessage(
            'stable',
            shouldAct,
            confidenceMeta,
            b.action_name,
            w.action_name,
        ),
        validation_hint: shouldAct
            ? `After switching to ${b.action_name}, log outcomes with ` +
            `task_name="${r.task}" for 7+ days. ` +
            `Then re-call GET /v1/recommendations?task=${encodeURIComponent(r.task)} ` +
            `to verify improvement_rate > ${pct(imp.improved_rate)}.`
            : null,
        sample_size: {
            best: b.total_count,
            worst: w.total_count,
            min: r.min_sample_count,
        },
        improvement_display: buildImprovementDisplay(
            imp.absolute_delta,
            r.confidence,
            r.min_sample_count,
            false,
        ),
        monitor_steps: shouldAct ? null : buildMonitorSteps(
            r.min_sample_count,
            MIN_SAMPLES_HIGH_CONFIDENCE,
            b.action_name,
            r.task,
        ),
        unlock_hint: shouldAct ? null : buildUnlockHint(
            r.min_sample_count,
            MIN_SAMPLES_HIGH_CONFIDENCE,
            Math.round((r.confidence ?? 0) * 100),
        ),
        data_window: {
            first_seen_at: null,
            last_seen_at: lastSeen,
            last_updated_label: relativeTimeLabel(lastSeen),
        },
        action_uncertainty: buildActionUncertainty(b, w),
        threshold_hint: thresholdHint,
        scope_label: scopeLabel,
    };
}
