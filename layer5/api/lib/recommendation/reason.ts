import type {
    RecommendationResult,
    RecommendationState,
} from './engine.js';
import { MIN_SAMPLES, MIN_SAMPLES_HIGH_CONFIDENCE } from './engine.js';

function pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function confPct(confidence: number): string {
    return `${Math.round(confidence * 100)}%`;
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

    const base = {
        task: r.task,
        state: r.state,
        ui_label: stateMeta.ui_label,
        explanation: stateMeta.explanation,
        confidence_meta: {
            value: confidenceMeta.value,
            percent: confidenceMeta.percent,
        },
        progress: buildProgress(r.min_sample_count),
        generated_at: r.generated_at,
    };

    if (r.state === 'no_data') {
        const trustBlocked = (r as any)._trust_gate_blocked === true;
        const totalOutcomes = r.all_actions.reduce(
            (sum, a) => sum + a.total_count,
            0
        );
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
        };
    }

    if (r.state === 'early_signal') {
        const b = r.best_action!;
        const w = r.worst_action!;
        return {
            ...base,
            decision: {
                type: 'monitor',
                action_required: false,
            },
            problem: (() => {
                const delta = b.success_rate - w.success_rate;
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
            expected_improvement: null,
            reason: buildReason(r, confidenceMeta),
            confidence: r.confidence ?? 0,
            confidence_label: confidenceLabel,
            insight: buildInsight(r),
            message: (() => {
                const delta = b.success_rate - w.success_rate;
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
        };
    }

    const b = r.best_action!;
    const w = r.worst_action!;
    const imp = r.improvement!;
    const shouldAct =
        confidenceMeta.label === 'high' ||
        confidenceMeta.label === 'very_high';

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
    };
}
