import type {
    RecommendationResult,
    RecommendationState,
} from './engine.js';

function pct(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function confPct(confidence: number): string {
    return `${Math.round(confidence * 100)}%`;
}

function templateStable(r: RecommendationResult): string {
    const b = r.best_action!;
    const w = r.worst_action!;
    const delta = r.improvement!.absolute_delta;
    return (
        `${w.action_name} succeeds ${pct(w.success_rate)} of the time ` +
        `for "${r.task}" (${w.total_count} outcomes). ` +
        `${b.action_name} succeeds ${pct(b.success_rate)} ` +
        `(${b.total_count} outcomes). ` +
        `Switching is expected to improve success by +${pct(delta)}.`
    );
}

function templateEarlySignal(r: RecommendationResult): string {
    const b = r.best_action!;
    const w = r.worst_action!;
    return (
        `Early data (${b.total_count} outcomes) suggests ` +
        `${b.action_name} outperforms ${w.action_name} ` +
        `for "${r.task}" ` +
        `(${pct(b.success_rate)} vs ${pct(w.success_rate)}). ` +
        `Confidence is low - monitor before acting.`
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
        `No strong recommendation yet - continue collecting data.`
    );
}

function templateNoData(taskName: string, totalOutcomes: number): string {
    if (totalOutcomes === 0) {
        return (
            `No outcome data found for task "${taskName}". ` +
            `Ensure task_name is included when calling log_outcome, ` +
            `or that issue_type maps correctly to this task.`
        );
    }
    return (
        `Collecting data for "${taskName}" ` +
        `(${totalOutcomes} outcome${totalOutcomes === 1 ? '' : 's'} ` +
        `logged so far, ` +
        `need 10+ per action across 2+ distinct actions).`
    );
}

export interface ActionableOutput {
    task: string;
    state: RecommendationState;
    problem: string | null;
    recommendation: string | null;
    expected_improvement: {
        baseline: string;
        improved: string;
        delta: string;
    } | null;
    reason: string;
    confidence: number | null;
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
    const base = {
        task: r.task,
        state: r.state,
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
            recommendation: null,
            expected_improvement: null,
            reason: templateNoData(r.task, totalOutcomes),
            confidence: null,
            sample_size: null,
        };
    }

    if (r.state === 'close') {
        return {
            ...base,
            problem: null,
            recommendation: null,
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
                `Consider replacing ${w.action_name} ` +
                `with ${b.action_name}`
            ),
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

    return {
        ...base,
        problem: (
            `${w.action_name} is underperforming ` +
            `(${pct(imp.baseline_rate)} success rate, ` +
            `${w.total_count} outcomes)`
        ),
        recommendation: `Replace ${w.action_name} with ${b.action_name}`,
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
