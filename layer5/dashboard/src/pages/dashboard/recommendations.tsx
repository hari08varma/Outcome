import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    CheckCircle,
    RefreshCw,
    TrendingUp,
    XCircle,
    Zap,
} from 'lucide-react';
import { createAgentFetch } from '../../lib/api';
import { API_BASE } from '../../lib/config';
import { useAgentApiKey } from '../../hooks/useAgentApiKey';
import { supabase } from '../../supabaseClient';

type RecommendationState =
    | 'no_data'
    | 'early_signal'
    | 'stable';

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high' | 'very_high';

interface ConfidenceMeta {
    value: number;
    percent: number;
    label: ConfidenceLabel;
}

interface ExpectedImprovement {
    baseline: string;
    improved: string;
    delta: string;
    delta_raw: number;
    based_on_samples: number;
    caution: string | null;
}

interface SampleSize {
    best: number;
    worst: number;
    min: number;
}

interface RecommendationResponse {
    task: string;
    state: string;
    ui_label: string;
    explanation: string;
    decision: {
        type: 'collect_more_data' | 'monitor' | 'replace';
        action_required: boolean;
    };
    insight: {
        best_action: string | null;
        best_rate: number | null;
        worst_action: string | null;
        worst_rate: number | null;
        delta: number | null;
        sample_size: { best: number; worst: number } | null;
    };
    confidence: number;
    confidence_label: ConfidenceLabel;
    progress: {
        current_samples: number;
        target_samples: number;
        percent_complete: number;
    };
    confidence_meta: ConfidenceMeta;
    message: string;
    reason: {
        summary: string;
        evidence: string;
        confidence_note: string;
    };
    problem: string | null;
    risk_context: string | null;
    expected_improvement: ExpectedImprovement | null;
    sample_size: SampleSize | null;
    validation_hint: string | null;
    agent_id: string | null;
    agent_scope: 'agent_scoped' | 'customer_blended';
    customer_id: string;
    generated_at: string;
    improvement_display: {
        raw_delta_pct: string;
        qualified_delta_pct: string;
        is_estimate: boolean;
        samples_basis: number;
    } | null;
    monitor_steps: string[] | null;
    unlock_hint: string | null;
    data_window: {
        first_seen_at: string | null;
        last_seen_at: string | null;
        last_updated_label: string;
    } | null;
    action_uncertainty: {
        best: { action: string; rate_pct: string; margin_pct: string };
        worst: { action: string; rate_pct: string; margin_pct: string };
    } | null;
    threshold_hint: string;
    scope_label: string;
}

const CONFIDENCE_CONFIG: Record<
    ConfidenceLabel,
    {
        label: string;
        textClass: string;
        chipClass: string;
        barColor: string;
    }
> = {
    very_high: {
        label: 'Very High Confidence',
        textClass: 'text-[#b8ff00]',
        chipClass: 'bg-[#b8ff00]/20 text-[#b8ff00] border border-[#b8ff00]/50',
        barColor: '#b8ff00',
    },
    high: {
        label: 'High Confidence',
        textClass: 'text-[#b8ff00]',
        chipClass: 'bg-[#b8ff00]/10 text-[#b8ff00] border border-[#b8ff00]/30',
        barColor: '#b8ff00',
    },
    medium: {
        label: 'Medium Confidence',
        textClass: 'text-yellow-400',
        chipClass: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
        barColor: '#facc15',
    },
    low: {
        label: 'Low Confidence',
        textClass: 'text-[#ff4444]',
        chipClass: 'bg-red-500/10 text-[#ff4444] border border-red-500/30',
        barColor: '#ff4444',
    },
    none: {
        label: 'No Confidence Estimate',
        textClass: 'text-[#a1a1aa]',
        chipClass: 'bg-[#1a1a24] text-[#a1a1aa] border border-[#1a1a24]',
        barColor: '#52525b',
    },
};


function stateBadge(state: RecommendationState): React.ReactElement {
    const map: Record<
        RecommendationState,
        { label: string; cls: string; icon: React.ReactElement }
    > = {
        stable: {
            label: 'Stable Signal',
            cls: 'bg-[#b8ff00]/10 text-[#b8ff00] border border-[#b8ff00]/30',
            icon: <CheckCircle size={12} />,
        },
        early_signal: {
            label: 'Early Signal',
            cls: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30',
            icon: <Zap size={12} />,
        },
        no_data: {
            label: 'No Data',
            cls: 'bg-[#1a1a24] text-[#a1a1aa] border border-[#1a1a24]',
            icon: <XCircle size={12} />,
        },
    };

    const { label, cls, icon } = map[state];

    return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
            {icon}
            {label}
        </span>
    );
}

function ConfidenceBar({ meta }: { meta: ConfidenceMeta | null }): React.ReactElement {
    if (!meta) {
        return <span className="text-[#a1a1aa] text-sm">No estimate</span>;
    }

    const cfg = CONFIDENCE_CONFIG[meta.label];

    return (
        <div className="flex items-center gap-3">
            <div className="flex-1 bg-[#1a1a24] rounded-full h-2 overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${meta.percent}%`, backgroundColor: cfg.barColor }}
                />
            </div>
            <span className={`text-sm font-medium ${cfg.textClass}`}>{meta.percent}%</span>
        </div>
    );
}

function LoadingSkeleton(): React.ReactElement {
    return (
        <div className="animate-pulse space-y-4">
            <div className="h-6 bg-[#1a1a24] rounded-lg w-1/3" />
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-6 space-y-4">
                <div className="h-5 bg-[#1a1a24] rounded w-1/2" />
                <div className="h-4 bg-[#1a1a24] rounded w-3/4" />
                <div className="h-4 bg-[#1a1a24] rounded w-2/3" />
                <div className="h-10 bg-[#1a1a24] rounded-lg" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <div className="h-3 bg-[#1a1a24] rounded w-1/2 mb-3" />
                        <div className="h-7 bg-[#1a1a24] rounded w-2/3" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function ResultCard({ data }: { data: RecommendationResponse }): React.ReactElement {
    const state = data.state as RecommendationState;
    const confidenceMeta = data.confidence_meta ?? null;
    const confidenceCfg = CONFIDENCE_CONFIG[confidenceMeta?.label ?? 'none'];

    const borderAccent =
        state === 'stable' ? 'border-[#b8ff00]/40' :
        state === 'early_signal' ? 'border-yellow-500/40' :
        'border-[#1a1a24]';

    const recommendationTone =
        data.decision.type === 'replace' ? 'text-[#b8ff00]' :
        data.decision.type === 'monitor' ? 'text-yellow-400' :
        'text-[#a1a1aa]';

    const recommendationTitle =
        data.decision.type === 'replace' ? 'Recommended Action' :
        data.decision.type === 'monitor' ? 'Recommended Action (Monitor)' :
        'Recommended Action (Wait)';

    return (
        <div className="space-y-6">
            {/* ── Header row ── */}
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-lg font-semibold text-white font-mono">{data.task}</span>
                    {stateBadge(state)}
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${confidenceCfg.chipClass}`}>
                        {confidenceCfg.label}
                    </span>
                    {/* Issue 8: Descriptive scope label */}
                    <span
                        title={data.scope_label}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium cursor-help ${
                            data.agent_scope === 'agent_scoped'
                                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                                : 'bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'
                        }`}
                    >
                        {data.agent_scope === 'agent_scoped' ? '⬡ Agent data only' : '⬡ All agents blended'}
                    </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <p className="text-xs text-[#a1a1aa]">{data.explanation}</p>
                    {/* Issue 5: Last updated label from API */}
                    <p className="text-xs text-[#52525b]">
                        {data.data_window?.last_updated_label ?? `Updated ${new Date(data.generated_at).toLocaleString()}`}
                    </p>
                </div>
            </div>

            {/* ── Main card ── */}
            <div className={`bg-[#111118] border ${borderAccent} rounded-xl p-6 space-y-5`}>

                {data.problem && (
                    <div>
                        <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">Problem</p>
                        <p className="text-white text-sm flex items-start gap-2">
                            <AlertTriangle size={15} className="text-[#ff4444] mt-0.5 shrink-0" />
                            {data.problem}
                        </p>
                    </div>
                )}

                {data.message && (
                    <div>
                        <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">
                            {recommendationTitle}
                        </p>
                        <p className={`text-sm font-semibold flex items-center gap-2 ${recommendationTone}`}>
                            <ArrowRight size={15} className="shrink-0" />
                            {data.message}
                        </p>
                    </div>
                )}

                {/* Issue 3: Actionable monitor steps */}
                {data.monitor_steps && data.monitor_steps.length > 0 && (
                    <div className="rounded-lg bg-yellow-500/5 border border-yellow-500/20 px-4 py-3">
                        <p className="text-xs font-medium uppercase tracking-wider text-yellow-500 mb-2">
                            How to Monitor
                        </p>
                        <ul className="space-y-1">
                            {data.monitor_steps.map((step, i) => (
                                <li key={i} className="text-xs text-[#a1a1aa] flex items-start gap-2">
                                    <span className="text-yellow-500 shrink-0">{i + 1}.</span>
                                    <span>{step}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {data.risk_context && (
                    <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-[#ffb4b4]">
                        <p className="text-xs font-medium uppercase tracking-wider text-[#ff6b6b] mb-1">Risk Context</p>
                        <p>{data.risk_context}</p>
                    </div>
                )}

                {/* Issue 1+2: Confidence-qualified improvement block */}
                {data.improvement_display && (
                    <div>
                        <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-2">
                            Expected Impact
                        </p>
                        <div className="flex items-start gap-6 flex-wrap">
                            {/* Raw delta with estimate label */}
                            <div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-2xl font-bold text-white">
                                        {data.expected_improvement?.baseline ?? '-'}
                                    </span>
                                    <ArrowRight size={16} className="text-[#a1a1aa]" />
                                    <span className="text-2xl font-bold text-[#b8ff00]">
                                        {data.expected_improvement?.improved ?? '-'}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-full text-sm font-bold bg-[#b8ff00]/10 text-[#b8ff00] border border-[#b8ff00]/30">
                                        {data.improvement_display.raw_delta_pct}
                                        {data.improvement_display.is_estimate && (
                                            <span className="text-[10px] font-normal text-yellow-400 ml-1">
                                                early estimate
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <p className="text-xs text-[#a1a1aa] mt-1">
                                    potential improvement (based on {data.improvement_display.samples_basis} samples)
                                </p>
                            </div>
                            {/* Issue 2: Confidence-weighted reliable gain */}
                            {data.improvement_display.is_estimate && (
                                <div className="bg-[#1a1a24] rounded-lg px-3 py-2">
                                    <p className="text-xs text-[#a1a1aa] mb-0.5">Reliable gain estimate</p>
                                    <p className="text-lg font-bold text-yellow-400">
                                        {data.improvement_display.qualified_delta_pct}
                                    </p>
                                    <p className="text-[10px] text-[#52525b]">
                                        = raw delta × {data.confidence_meta?.percent ?? 0}% confidence
                                    </p>
                                </div>
                            )}
                        </div>
                        {data.expected_improvement?.caution && (
                            <p className="text-xs text-[#ffaa00] mt-2 flex items-center gap-1">
                                <span>⚠</span>
                                <span>{data.expected_improvement.caution}</span>
                            </p>
                        )}
                    </div>
                )}

                <div>
                    <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">Why</p>
                    <div className="space-y-1">
                        <p className="text-sm text-white font-medium">{data.reason.summary}</p>
                        <p className="text-sm text-[#a1a1aa]">{data.reason.evidence}</p>
                        <p className="text-xs text-[#a1a1aa] italic">{data.reason.confidence_note}</p>
                    </div>
                </div>
            </div>

            {/* ── Metric cards row ── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* Confidence card */}
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 space-y-3">
                    <p className="text-xs text-[#a1a1aa]">Confidence</p>
                    <ConfidenceBar meta={confidenceMeta} />

                    {data.progress && (
                        <div>
                            <div className="flex items-center justify-between text-xs text-[#a1a1aa] mb-1">
                                <span>Data progress</span>
                                <span>{data.progress.current_samples} / {data.progress.target_samples}</span>
                            </div>
                            <div className="bg-[#1a1a24] rounded-full h-1.5 overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-[#b8ff00]/60 transition-all duration-500"
                                    style={{ width: `${data.progress.percent_complete}%` }}
                                />
                            </div>
                            <p className="text-xs text-[#a1a1aa] mt-1">
                                {data.progress.percent_complete}% toward stable signal
                            </p>
                        </div>
                    )}

                    {/* Issue 4: Unlock hint */}
                    {data.unlock_hint && (
                        <p className="text-xs text-[#52525b] border-t border-[#1a1a24] pt-2">
                            {data.unlock_hint}
                        </p>
                    )}

                    {/* Issue 7: Decision threshold hint */}
                    <p className="text-xs text-[#52525b] border-t border-[#1a1a24] pt-2">
                        {data.threshold_hint}
                    </p>

                    {/* Current signal row */}
                    {data.insight.best_action && (
                        <div className="bg-[#111118] border border-[#1a1a24] rounded-lg p-3">
                            <p className="text-xs text-[#a1a1aa] uppercase tracking-wider mb-2">
                                Current Signal
                            </p>
                            <div className="flex items-center justify-between text-sm">
                                <div>
                                    <p className="text-white font-medium">{data.insight.best_action}</p>
                                    <p className="text-xs text-[#a1a1aa]">
                                        {data.insight.best_rate !== null
                                            ? `${(data.insight.best_rate * 100).toFixed(1)}% success`
                                            : '-'}
                                        {data.insight.sample_size
                                            ? ` · ${data.insight.sample_size.best} outcomes`
                                            : ''}
                                    </p>
                                </div>
                                {data.insight.delta !== null && (
                                    <div className="text-right">
                                        <p className="text-[#b8ff00] font-bold">
                                            +{(data.insight.delta * 100).toFixed(1)}%
                                        </p>
                                        <p className="text-xs text-[#a1a1aa]">vs {data.insight.worst_action}</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Sample size card with Issue 6: uncertainty bands */}
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 space-y-3">
                    <p className="text-xs text-[#a1a1aa] mb-2">Sample Size</p>
                    {data.sample_size ? (
                        <div className="space-y-2">
                            {data.action_uncertainty ? (
                                <>
                                    <div className="space-y-1">
                                        <p className="text-[#a1a1aa] text-xs uppercase tracking-wider">Best</p>
                                        <p className="text-white text-sm font-mono">
                                            {data.action_uncertainty.best.rate_pct}
                                            <span className="text-[#52525b] ml-1 text-xs">
                                                {data.action_uncertainty.best.margin_pct}
                                            </span>
                                        </p>
                                        <p className="text-[#52525b] text-xs">
                                            {data.action_uncertainty.best.action} · {data.sample_size.best} outcomes
                                        </p>
                                    </div>
                                    <div className="space-y-1 border-t border-[#1a1a24] pt-2">
                                        <p className="text-[#a1a1aa] text-xs uppercase tracking-wider">Baseline</p>
                                        <p className="text-white text-sm font-mono">
                                            {data.action_uncertainty.worst.rate_pct}
                                            <span className="text-[#52525b] ml-1 text-xs">
                                                {data.action_uncertainty.worst.margin_pct}
                                            </span>
                                        </p>
                                        <p className="text-[#52525b] text-xs">
                                            {data.action_uncertainty.worst.action} · {data.sample_size.worst} outcomes
                                        </p>
                                    </div>
                                    <p className="text-[#52525b] text-xs border-t border-[#1a1a24] pt-2">
                                        ± margin is 95% confidence interval
                                    </p>
                                </>
                            ) : (
                                <>
                                    <p className="text-white text-sm">Best: <span className="font-bold">{data.sample_size.best}</span></p>
                                    <p className="text-white text-sm">Worst: <span className="font-bold">{data.sample_size.worst}</span></p>
                                    <p className="text-[#a1a1aa] text-xs">Gate value (min): {data.sample_size.min}</p>
                                </>
                            )}
                        </div>
                    ) : (
                        <p className="text-[#a1a1aa] text-sm">-</p>
                    )}
                </div>

                {/* Task + scope card */}
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 space-y-3">
                    <p className="text-xs text-[#a1a1aa] mb-2">Task</p>
                    <p className="text-white text-sm font-mono break-all">{data.task}</p>
                    {data.customer_id && (
                        <p className="text-[#a1a1aa] text-xs mt-1 font-mono">{data.customer_id.slice(-8)}</p>
                    )}
                    {/* Issue 8: Full scope explanation */}
                    {data.scope_label && (
                        <p className="text-xs text-[#52525b] border-t border-[#1a1a24] pt-2">
                            {data.scope_label}
                        </p>
                    )}
                    {/* Issue 5: Time dimension */}
                    {data.data_window?.last_seen_at && (
                        <p className="text-xs text-[#52525b]">
                            Last outcome: {new Date(data.data_window.last_seen_at).toLocaleString()}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function RecommendationsPage(): React.ReactElement {
    const { apiKey, isValid, error: keyError, handleAuthFailure } = useAgentApiKey();

    const [taskInput, setTaskInput] = useState('payment_failed');
    const [activeTask, setActiveTask] = useState('payment_failed');
    const [data, setData] = useState<RecommendationResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Agent list for scoping recommendations
    const [agents, setAgents] = useState<Array<{ agent_id: string; agent_name: string }>>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [agentsLoading, setAgentsLoading] = useState(false);
    // Dynamic task list — scoped to selected agent (or all agents if null)
    const [agentTasks, setAgentTasks] = useState<string[]>([]);
    const [agentTasksLoading, setAgentTasksLoading] = useState(false);
    const fetchRef = useRef<(() => Promise<void>) | null>(null);

    useEffect(() => {
        if (!isValid) return;
        void (async () => {
            setAgentsLoading(true);
            try {
                const { data } = await supabase
                    .from('dim_agents')
                    .select('agent_id, agent_name')
                    .order('agent_name', { ascending: true });
                setAgents(data ?? []);
                // Auto-select first agent if only one exists
                if (data && data.length === 1) {
                    setSelectedAgentId(data[0]!.agent_id);
                }
            } finally {
                setAgentsLoading(false);
            }
        })();
    }, [isValid]);

    // Fetch distinct task_names from the MV scoped to the selected agent.
    // RLS on mv_task_action_performance enforces customer_id via JWT automatically.
    // Fetch tasks via the authenticated API endpoint — avoids silent RLS failures
    // that occur when querying MVs directly via the Supabase anon client.
    useEffect(() => {
        if (!isValid || !apiKey || !API_BASE) {
            setAgentTasks([]);
            return;
        }
        setAgentTasksLoading(true);
        const controller = new AbortController();
        void (async () => {
            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const qs = selectedAgentId
                    ? `?agent_id=${encodeURIComponent(selectedAgentId)}`
                    : '';
                const res = await agentFetch(`${API_BASE}/v1/recommendations/tasks${qs}`);
                if (res.ok) {
                    const json = await res.json() as { tasks: string[] };
                    setAgentTasks(json.tasks ?? []);
                } else {
                    setAgentTasks([]);
                }
            } catch {
                setAgentTasks([]);
            } finally {
                setAgentTasksLoading(false);
            }
        })();
        return () => controller.abort();
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId]);

    const fetchRecommendation = useCallback(
        async (task: string, showLoading = true): Promise<void> => {
            if (!isValid || !apiKey || !API_BASE) return;

            if (showLoading) setLoading(true);
            setError(null);

            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const agentParam = selectedAgentId
                    ? `&agent_id=${encodeURIComponent(selectedAgentId)}`
                    : '';
                const res = await agentFetch(
                    `${API_BASE}/v1/recommendations?task=${encodeURIComponent(task)}${agentParam}`
                );

                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
                }

                const json = (await res.json()) as RecommendationResponse;
                setData(json);
            } catch (err: any) {
                setError(err.message ?? 'Failed to load recommendation.');
                setData(null);
            } finally {
                setLoading(false);
            }
        },
        [apiKey, isValid, handleAuthFailure, selectedAgentId],
    );

    useEffect(() => {
        if (!isValid) return;
        // Clear stale result immediately so user never sees another agent's data while loading
        setData(null);
        setError(null);

        fetchRef.current = () => fetchRecommendation(activeTask, false);
        void fetchRecommendation(activeTask, true);

        const interval = window.setInterval(() => {
            void fetchRecommendation(activeTask, false);
        }, 30_000);

        return () => {
            window.clearInterval(interval);
            fetchRef.current = null;
        };
    }, [activeTask, isValid, fetchRecommendation, selectedAgentId]);

    const handleSubmit = (e: React.FormEvent): void => {
        e.preventDefault();
        const normalized = taskInput.trim().toLowerCase().replace(/\s+/g, '_');
        if (!normalized) return;
        setActiveTask(normalized);
        setTaskInput(normalized);
    };

    if (!isValid) {
        return (
            <div className="space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Recommendations</h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">Decision Recommendation Engine</p>
                </div>
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-8 text-center space-y-3">
                    <TrendingUp size={32} className="mx-auto text-[#a1a1aa]" />
                    <p className="text-white font-medium">API Key Required</p>
                    <p className="text-[#a1a1aa] text-sm max-w-md mx-auto">
                        {keyError ?? 'Configure your agent API key in Settings to view recommendations.'}
                    </p>
                    <a
                        href="/dashboard/settings/api-keys"
                        className="inline-block mt-2 px-4 py-2 rounded-lg bg-[#b8ff00] text-black text-sm font-semibold hover:bg-[#a0e600] transition-colors"
                    >
                        Go to Settings
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <TrendingUp size={22} className="text-[#b8ff00]" />
                        Recommendations
                    </h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">
                        AI-powered decision recommendations for your agent actions
                    </p>
                </div>
                <button
                    className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5 text-[#a1a1aa] hover:text-white transition-colors"
                    onClick={() => void fetchRef.current?.()}
                    disabled={loading}
                >
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-[#ff4444] rounded-xl px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    <span>{error}</span>
                </div>
            )}

            {agents.length > 1 && (
                <div>
                    <p className="text-xs text-[#a1a1aa] uppercase tracking-wider mb-3">
                        Agent Scope
                    </p>
                    <div className="flex flex-wrap gap-2 items-center">
                        <button
                            onClick={() => setSelectedAgentId(null)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${selectedAgentId === null
                                ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/40'
                                : 'bg-[#111118] text-[#a1a1aa] border-[#1a1a24] hover:text-white'
                                }`}
                        >
                            All Agents
                        </button>
                        {agentsLoading ? (
                            <span className="text-xs text-[#a1a1aa]">Loading agents…</span>
                        ) : (
                            agents.map((agent) => (
                                <button
                                    key={agent.agent_id}
                                    onClick={() => setSelectedAgentId(agent.agent_id)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors font-mono ${selectedAgentId === agent.agent_id
                                        ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/40'
                                        : 'bg-[#111118] text-[#a1a1aa] border-[#1a1a24] hover:text-white'
                                        }`}
                                >
                                    {agent.agent_name}
                                </button>
                            ))
                        )}
                    </div>
                    {selectedAgentId && (
                        <p className="text-xs text-[#a1a1aa] mt-2">
                            Showing recommendations scoped to this agent only.
                            <button
                                className="ml-2 text-[#b8ff00] hover:underline"
                                onClick={() => setSelectedAgentId(null)}
                            >
                                Clear
                            </button>
                        </p>
                    )}
                </div>
            )}

            <div>
                <p className="text-xs text-[#a1a1aa] uppercase tracking-wider mb-3">
                    Quick Select
                    {selectedAgentId && agentTasks.length > 0 && (
                        <span className="ml-2 text-[#52525b] normal-case font-normal">
                            — tasks logged by this agent
                        </span>
                    )}
                </p>
                {agentTasksLoading ? (
                    <div className="flex gap-2">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-7 w-24 bg-[#1a1a24] rounded-lg animate-pulse" />
                        ))}
                    </div>
                ) : agentTasks.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {agentTasks.map((task) => (
                            <button
                                key={task}
                                onClick={() => {
                                    setTaskInput(task);
                                    setActiveTask(task);
                                }}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors font-mono ${activeTask === task
                                    ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/40'
                                    : 'bg-[#111118] text-[#a1a1aa] border-[#1a1a24] hover:text-white'
                                    }`}
                            >
                                {task}
                            </button>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-[#52525b]">
                        {selectedAgentId
                            ? 'No tasks logged for this agent yet.'
                            : 'No tasks found. Log outcomes to see tasks here.'}
                    </p>
                )}
            </div>

            <form onSubmit={handleSubmit} className="flex items-center gap-3">
                <div className="flex-1 relative">
                    <input
                        type="text"
                        value={taskInput}
                        onChange={(e) => setTaskInput(e.target.value)}
                        placeholder="Enter task name e.g. subscription_cancel"
                        className="w-full bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-3 text-sm text-white placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00]/50 font-mono transition-colors"
                    />
                </div>
                <button
                    type="submit"
                    disabled={loading || !taskInput.trim()}
                    className="px-5 py-3 rounded-xl bg-[#b8ff00] text-black text-sm font-semibold hover:bg-[#a0e600] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    Analyse
                </button>
            </form>

            {loading ? (
                <LoadingSkeleton />
            ) : data ? (
                <ResultCard data={data} />
            ) : (
                !error && (
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-10 text-center text-[#a1a1aa] text-sm space-y-2">
                        <TrendingUp size={28} className="mx-auto text-[#a1a1aa]" />
                        <p>Select a task above or type one to see recommendations.</p>
                    </div>
                )
            )}
        </div>
    );
}
