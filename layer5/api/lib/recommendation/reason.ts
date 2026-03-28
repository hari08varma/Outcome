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
    value: number | null;
    percent: number | null;
    label: ConfidenceLabel;
    ui_hint: UiHint;
}

function toConfidenceMeta(confidence: number | null): ConfidenceMeta {
    if (confidence === null) {
        return {
            value: null,
            percent: null,
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
    const uncertaintyNote = (r.confidence ?? 0) < 0.6
        ? ' There is still uncertainty, so a phased rollout with monitoring is safer than a hard cutover.'
        : '';
    return (
        `${w.action_name} succeeds ${pct(w.success_rate)} of the time ` +
        `for "${r.task}" (${w.total_count} outcomes). ` +
        `${b.action_name} succeeds ${pct(b.success_rate)} ` +
        `(${b.total_count} outcomes). ` +
        `Switching is expected to improve success by +${pct(delta)} ` +
        `with ${confidenceText} confidence.` +
        uncertaintyNote
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

export interface ActionableOutput {
    task: string;
    state: RecommendationState;
    problem: string | null;
    recommendation: string | null;
    suggested_action: SuggestedAction;
    action_required: boolean;
    ui_hint: UiHint;
    risk_context: string | null;
    expected_improvement: {
        baseline: string;
        improved: string;
        delta: string;
    } | null;
    reason: string;
    confidence: number | null;
    confidence_meta: ConfidenceMeta;
    sample_size: {
        best: number;
        worst: number;
        min: number;
    } | null;
    generated_at: string;
}

export function buildActionableOutput(
    r: RecommendationResult,
): ActionableOutput {
    const confidenceMeta = toConfidenceMeta(r.confidence);

    const base = {
        task: r.task,
        state: r.state,
        confidence_meta: confidenceMeta,
        ui_hint: confidenceMeta.ui_hint,
        generated_at: r.generated_at,
    };

    if (r.state === 'no_data') {
        const totalOutcomes = r.all_actions.reduce(
            (sum, a) => sum + a.total_count,
            0
        );
        return {
            ...base,
            problem: null,
            recommendation: 'Do not change behavior yet. Continue collecting outcomes.',
            suggested_action: 'collect_more_data',
            action_required: false,
            ui_hint: 'wait',
            risk_context: 'Evidence is insufficient. Acting now may cause regressions without measurable upside.',
            expected_improvement: null,
            reason: templateNoData(r.task, totalOutcomes, r._qualification_context),
            confidence: null,
            sample_size: null,
        };
    }

    if (r.state === 'close') {
        return {
            ...base,
            problem: null,
            recommendation: 'Do not switch actions yet. Monitor both actions while collecting more data.',
            suggested_action: 'monitor',
            action_required: false,
            ui_hint: 'monitor',
            risk_context: 'Observed performance is too close; switching now risks churn with little expected gain.',
            expected_improvement: null,
            reason: templateClose(r),
            confidence: null,
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
            problem: (
                `${w.action_name} is underperforming ` +
                `(${pct(w.success_rate)} success rate, ` +
                `${w.total_count} outcomes - early data)`
            ),
            recommendation: (
                `Monitor ${b.action_name} vs ${w.action_name} before a full replacement.`
            ),
            suggested_action: 'monitor',
            action_required: false,
            ui_hint: 'monitor',
            risk_context: 'Signal direction is promising but uncertainty remains high; immediate full replacement may be premature.',
            expected_improvement: null,
            reason: templateEarlySignal(r),
            confidence: r.confidence,
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
        problem: (
            `${w.action_name} is underperforming ` +
            `(${pct(imp.baseline_rate)} success rate, ` +
            `${w.total_count} outcomes)`
        ),
        recommendation: shouldAct
            ? `Replace ${w.action_name} with ${b.action_name}`
            : `Pilot ${b.action_name} while monitoring before a full replacement of ${w.action_name}`,
        suggested_action: shouldAct ? 'replace' : 'monitor',
        action_required: shouldAct,
        ui_hint: shouldAct ? 'act_now' : 'monitor',
        risk_context: shouldAct
            ? null
            : 'Improvement exists, but confidence is not yet high enough for an immediate irreversible switch.',
        expected_improvement: {
            baseline: pct(imp.baseline_rate),
            improved: pct(imp.improved_rate),
            delta: `+${pct(imp.absolute_delta)}`,
        },
        reason: templateStable(r),
        confidence: r.confidence,
        sample_size: {
            best: b.total_count,
            worst: w.total_count,
            min: r.min_sample_count,
        },
    };
}
