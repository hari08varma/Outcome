import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    BarChart2,
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
    | 'close'
    | 'stable';

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high';
type UiHint = 'wait' | 'monitor' | 'act_now';

interface ConfidenceMeta {
    value: number;
    percent: number;
    label: ConfidenceLabel;
    ui_hint: UiHint;
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
        action_required: boolean;
        suggested_action: 'collect_more_data' | 'monitor' | 'replace';
        level: 'none' | 'low' | 'medium' | 'high';
        ui_hint: 'wait' | 'monitor' | 'act_now';
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
    confidence_meta: {
        value: number;
        percent: number;
        label: 'none' | 'low' | 'medium' | 'high';
        ui_hint: 'wait' | 'monitor' | 'act_now';
    };
    message: string;
    reason: string;
    problem: string | null;
    recommendation: string | null;
    risk_context: string | null;
    expected_improvement: ExpectedImprovement | null;
    sample_size: SampleSize | null;
    validation_hint: string | null;
    agent_id: string | null;
    agent_scope: 'agent_scoped' | 'customer_blended';
    customer_id: string;
    generated_at: string;
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

const QUICK_TASKS = [
    'payment_failed',
    'ticket_resolution',
    'auth_recovery',
    'order_recovery',
    'onboarding',
    'refund_processing',
] as const;

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
        close: {
            label: 'Too Close',
            cls: 'bg-[#a1a1aa]/10 text-[#a1a1aa] border border-[#a1a1aa]/20',
            icon: <BarChart2 size={12} />,
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
        data.decision.ui_hint === 'act_now' ? 'text-[#b8ff00]' :
            data.decision.ui_hint === 'monitor' ? 'text-yellow-400' :
                'text-[#a1a1aa]';

    const recommendationTitle =
        data.decision.ui_hint === 'act_now' ? 'Recommended Action' :
            data.decision.ui_hint === 'monitor' ? 'Recommended Action (Monitor)' :
                'Recommended Action (Wait)';

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold text-white font-mono">{data.task}</span>
                    {stateBadge(state)}
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${confidenceCfg.chipClass}`}>
                        {confidenceCfg.label}
                    </span>
                    {data.agent_scope === 'customer_blended' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30">
                            All Agents
                        </span>
                    )}
                    {data.agent_scope === 'agent_scoped' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/30">
                            Agent Scoped
                        </span>
                    )}
                </div>
                <p className="text-xs text-[#a1a1aa] mt-1">{data.explanation}</p>
                <span className="text-xs text-[#a1a1aa]">
                    Updated {new Date(data.generated_at).toLocaleString()}
                </span>
            </div>

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

                {data.recommendation && (
                    <div>
                        <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">{recommendationTitle}</p>
                        <p className={`text-sm font-semibold flex items-center gap-2 ${recommendationTone}`}>
                            <ArrowRight size={15} className="shrink-0" />
                            {data.recommendation}
                        </p>
                    </div>
                )}

                {data.risk_context && (
                    <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-[#ffb4b4]">
                        <p className="text-xs font-medium uppercase tracking-wider text-[#ff6b6b] mb-1">Risk Context</p>
                        <p>{data.risk_context}</p>
                    </div>
                )}

                {data.expected_improvement && (
                    <div>
                        <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-2">Expected Impact</p>
                        <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-2xl font-bold text-white">{data.expected_improvement.baseline}</span>
                            <ArrowRight size={18} className="text-[#a1a1aa]" />
                            <span className="text-2xl font-bold text-[#b8ff00]">{data.expected_improvement.improved}</span>
                            <span className="ml-1 px-2 py-0.5 rounded-full text-sm font-bold bg-[#b8ff00]/10 text-[#b8ff00] border border-[#b8ff00]/30">
                                {data.expected_improvement.delta}
                            </span>
                        </div>
                        <p className="text-xs text-[#a1a1aa] mt-1">success rate improvement (success_rate)</p>
                    </div>
                )}

                <div>
                    <p className="text-xs font-medium text-[#a1a1aa] uppercase tracking-wider mb-1">Why</p>
                    <p className="text-sm text-[#a1a1aa] leading-relaxed">{data.reason}</p>
                </div>

                {!data.decision.action_required && (
                    <div className="mt-3 flex items-start gap-2 bg-[#1a1a24] border border-[#2a2a34] rounded-lg px-3 py-2 text-xs text-[#a1a1aa]">
                        <span className="mt-0.5 shrink-0">[wait]</span>
                        <span>{data.message}</span>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                    <p className="text-xs text-[#a1a1aa] mb-3">Confidence</p>
                    <ConfidenceBar meta={confidenceMeta} />
                    {confidenceMeta && (
                        <p className="text-xs text-[#a1a1aa] mt-2">
                            Confidence tier: <span className={confidenceCfg.textClass}>{confidenceCfg.label}</span>
                        </p>
                    )}

                    {data.insight.best_action && (
                        <div className="mt-4 bg-[#111118] border border-[#1a1a24] rounded-lg p-3">
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
                            {data.expected_improvement?.caution && (
                                <p className="text-xs text-[#ffaa00] mt-2 flex items-center gap-1">
                                    <span>!</span>
                                    <span>{data.expected_improvement.caution}</span>
                                </p>
                            )}
                        </div>
                    )}
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                    <p className="text-xs text-[#a1a1aa] mb-2">Sample Size</p>
                    {data.sample_size ? (
                        <div className="space-y-1">
                            <p className="text-white text-sm">
                                Best:&nbsp;<span className="font-bold">{data.sample_size.best}</span>
                            </p>
                            <p className="text-white text-sm">
                                Worst:&nbsp;<span className="font-bold">{data.sample_size.worst}</span>
                            </p>
                            <p className="text-[#a1a1aa] text-xs">Gate value (min): {data.sample_size.min}</p>
                        </div>
                    ) : (
                        <p className="text-[#a1a1aa] text-sm">-</p>
                    )}
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                    <p className="text-xs text-[#a1a1aa] mb-2">Task</p>
                    <p className="text-white text-sm font-mono break-all">{data.task}</p>
                    {data.customer_id && (
                        <p className="text-[#a1a1aa] text-xs mt-1 font-mono">{data.customer_id.slice(-8)}</p>
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
                <p className="text-xs text-[#a1a1aa] uppercase tracking-wider mb-3">Quick Select</p>
                <div className="flex flex-wrap gap-2">
                    {QUICK_TASKS.map((task) => (
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
