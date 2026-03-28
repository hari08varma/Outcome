import type {
    RecommendationResult,
    RecommendationState,
} from './engine.js';
import { MIN_SAMPLES } from './engine.js';

function pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function confPct(confidence: number): string {
    return `${Math.round(confidence * 100)}%`;
}

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high';
type UiHint = 'wait' | 'monitor' | 'act_now';
type SuggestedAction = 'collect_more_data' | 'monitor' | 'replace';

export interface ConfidenceMeta {
    value: number;
    percent: number;
    label: ConfidenceLabel;
    ui_hint: UiHint;
}

function toConfidenceMeta(confidence: number | null): ConfidenceMeta {
    if (confidence === null) {
        return {
            value: 0,
            percent: 0,
            label: 'none',
            ui_hint: 'wait',
        };
    }

    const rounded = Math.max(0, Math.min(1, confidence));
    if (rounded < 0.2) {
        return {
            value: rounded,
            percent: Math.round(rounded * 100),
            label: 'low',
            ui_hint: 'monitor',
        };
    }
    if (rounded < 0.6) {
        return {
            value: rounded,
            percent: Math.round(rounded * 100),
            label: 'medium',
            ui_hint: 'monitor',
        };
    }
    return {
        value: rounded,
        percent: Math.round(rounded * 100),
        label: 'high',
        ui_hint: 'act_now',
    };
}

function templateStable(r: RecommendationResult): string {
    const b = r.best_action!;
    const w = r.worst_action!;
    const delta = r.improvement!.absolute_delta;
    const confidenceText = r.confidence !== null
        ? confPct(r.confidence)
        : 'unknown';
    return (
        `${w.action_name} succeeds ${pct(w.success_rate)} of the time ` +
        `for "${r.task}" (${w.total_count} outcomes). ` +
        `${b.action_name} succeeds ${pct(b.success_rate)} ` +
        `(${b.total_count} outcomes). ` +
        `Switching is expected to improve success by +${pct(delta)} ` +
        `with ${confidenceText} confidence.`
    );
}

function templateEarlySignal(r: RecommendationResult): string {
    const b = r.best_action!;
    const w = r.worst_action!;
    const confidenceText = r.confidence !== null
        ? confPct(r.confidence)
        : 'unknown';
    return (
        `Early data (${b.total_count} outcomes) suggests ` +
        `${b.action_name} outperforms ${w.action_name} ` +
        `for "${r.task}" ` +
        `(${pct(b.success_rate)} vs ${pct(w.success_rate)}). ` +
        `Current confidence is ${confidenceText}; treat this as provisional and monitor before acting.`
    );
}

function templateClose(r: RecommendationResult): string {
    const b = r.best_action!;
    const w = r.worst_action!;
    return (
        `${b.action_name} and ${w.action_name} perform similarly ` +
        `for "${r.task}" ` +
        `(${pct(b.success_rate)} vs ${pct(w.success_rate)}, ` +
        `${b.total_count} and ${w.total_count} outcomes). ` +
        `No strong recommendation yet - continue collecting data and monitor for a clearer separation.`
    );
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
    close: {
        ui_label: 'Too Close to Call',
        explanation: 'Actions perform similarly - no clear winner yet.',
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
        action_required: boolean;
        suggested_action: SuggestedAction;
        level: ConfidenceLabel;
        ui_hint: UiHint;
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

    // Confidence block
    confidence: number;
    confidence_meta: ConfidenceMeta;

    // Human text
    message: string;
    reason: string;
    problem: string | null;
    recommendation: string | null;
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
    confidenceMeta: ConfidenceMeta,
    best: string | null,
    worst: string | null,
): string {
    if (state === 'no_data') {
        return 'We are observing this task. No action recommended yet. ' +
            'Log more outcomes to unlock a recommendation.';
    }
    if (state === 'close') {
        return 'Both actions are performing too similarly to call a winner. ' +
            'Continue running both and check back when more data is collected.';
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

export function buildActionableOutput(
    r: RecommendationResult,
): ActionableOutput {
    const confidenceMeta = toConfidenceMeta(r.confidence);
    const stateMeta = STATE_META[r.state];

    const base = {
        task: r.task,
        state: r.state,
        ui_label: stateMeta.ui_label,
        explanation: stateMeta.explanation,
        confidence_meta: confidenceMeta,
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
                action_required: false,
                suggested_action: 'collect_more_data',
                level: confidenceMeta.label,
                ui_hint: confidenceMeta.ui_hint,
            },
            problem: null,
            recommendation: trustBlocked
                ? 'Agent is suspended. Restore trust before acting.'
                : 'Do not change behavior yet. Continue collecting outcomes.',
            risk_context: trustBlocked
                ? 'This agent has critically low trust. Acting on its history may cause regressions.'
                : 'Evidence is insufficient. Acting now may cause regressions without measurable upside.',
            expected_improvement: null,
            reason: trustBlocked
                ? `Recommendations are suspended for this agent ` +
                `(trust_status: ${(r as any)._trust_status ?? 'suspended'}). ` +
                `Trust must be restored before recommendations resume.`
                : templateNoData(r.task, totalOutcomes, r._qualification_context),
            confidence: 0,
            insight: buildInsight(r),
            message: buildMessage('no_data', false, confidenceMeta, null, null),
            validation_hint: null,
            sample_size: null,
        };
    }

    if (r.state === 'close') {
        return {
            ...base,
            decision: {
                action_required: false,
                suggested_action: 'monitor',
                level: confidenceMeta.label,
                ui_hint: confidenceMeta.ui_hint,
            },
            problem: null,
            recommendation: 'Do not switch actions yet. Monitor both actions while collecting more data.',
            risk_context: 'Observed performance is too close; switching now risks churn with little expected gain.',
            expected_improvement: null,
            reason: templateClose(r),
            confidence: 0,
            insight: buildInsight(r),
            message: buildMessage(
                'close',
                false,
                confidenceMeta,
                r.best_action?.action_name ?? null,
                r.worst_action?.action_name ?? null,
            ),
            validation_hint: null,
            sample_size: {
                best: r.best_action!.total_count,
                worst: r.worst_action!.total_count,
                min: r.min_sample_count,
            },
        };
    }

    if (r.state === 'early_signal') {
        const b = r.best_action!;
        const w = r.worst_action!;
        return {
            ...base,
            decision: {
                action_required: false,
                suggested_action: 'monitor',
                level: confidenceMeta.label,
                ui_hint: confidenceMeta.ui_hint,
            },
            problem: (
                `${w.action_name} is underperforming ` +
                `(${pct(w.success_rate)} success rate, ` +
                `${w.total_count} outcomes - early data)`
            ),
            recommendation: (
                `Monitor ${b.action_name} vs ${w.action_name} before a full replacement.`
            ),
            risk_context: (r as any)._silent_failure_warning
                ? 'Silent failures detected in the last 24h: some outcomes marked success=true had low outcome scores. Signal direction is promising but uncertainty remains high.'
                : 'Signal direction is promising but uncertainty remains high; immediate full replacement may be premature.',
            expected_improvement: null,
            reason: templateEarlySignal(r),
            confidence: r.confidence ?? 0,
            insight: buildInsight(r),
            message: buildMessage(
                'early_signal',
                false,
                confidenceMeta,
                r.best_action?.action_name ?? null,
                r.worst_action?.action_name ?? null,
            ),
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
    const shouldAct = confidenceMeta.ui_hint === 'act_now';

    return {
        ...base,
        decision: {
            action_required: shouldAct,
            suggested_action: shouldAct ? 'replace' : 'monitor',
            level: confidenceMeta.label,
            ui_hint: confidenceMeta.ui_hint,
        },
        problem: (
            `${w.action_name} is underperforming ` +
            `(${pct(imp.baseline_rate)} success rate, ` +
            `${w.total_count} outcomes)`
        ),
        recommendation: shouldAct
            ? `Replace ${w.action_name} with ${b.action_name}`
            : `Pilot ${b.action_name} while monitoring before a full replacement of ${w.action_name}`,
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
        reason: templateStable(r),
        confidence: r.confidence ?? 0,
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
