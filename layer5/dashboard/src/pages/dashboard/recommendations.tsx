import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Bot,
    ChevronDown,
    Database,
    RefreshCw,
    Shield,
    Target,
    TrendingUp,
    Zap,
} from 'lucide-react';
import { createAgentFetch } from '../../lib/api';
import { API_BASE } from '../../lib/config';
import { useAgentApiKey } from '../../hooks/useAgentApiKey';
import { supabase } from '../../supabaseClient';

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high' | 'very_high';

const MIN_OUTCOMES_FOR_RECOMMENDATION = 30;

interface AgentListItem {
    agent_id: string;
    agent_name: string;
    agent_type: string | null;
    llm_model: string | null;
    total_outcomes: number;
}

interface TaskSummary {
    task_name: string;
    total: number;
}

interface AgentSummary {
    agent_id: string;
    agent_name: string;
    agent_type: string | null;
    llm_model: string | null;
    trust_score: number | null;
    trust_status: string | null;
    total_outcomes: number;
    tasks: TaskSummary[];
    window_days?: number;
    counts_source?: 'mv' | 'fact_fallback' | 'fact_outcomes';
}

interface ActionPerformance {
    action_id: string;
    action_name: string;
    total_count: number;
    effective_sample_count?: number;
    resolution_rate: number;
    last_seen_at: string | null;
}

interface RecommendationResponse {
    task: string;
    state: string;
    confidence: number;
    confidence_meta: {
        value: number;
        percent: number;
        label: ConfidenceLabel;
    };
    decision: {
        type: 'collect_more_data' | 'monitor' | 'replace';
        action_required: boolean;
    };
    message: string;
    reason: {
        summary: string;
        evidence: string;
        confidence_note: string;
    };
    insight: {
        best_action: string | null;
        best_rate: number | null;
        worst_action: string | null;
        worst_rate: number | null;
        delta: number | null;
        sample_size: { best: number; worst: number } | null;
    };
    llm_narrative?: {
        headline: string | null;
        narrative: string | null;
        generated: boolean;
        model: string | null;
    };
    all_actions?: ActionPerformance[];
    task_total_outcomes?: number;
    agent_scope: 'agent_scoped' | 'customer_blended';
    generated_at: string;
    data_window?: {
        last_seen_at: string | null;
    } | null;
}

function pct(value: number | null, decimals = 1): string {
    if (value === null || !Number.isFinite(value)) return '-';
    return `${(value * 100).toFixed(decimals)}%`;
}

function relativeTime(iso: string | null): string {
    if (!iso) return '-';

    const deltaMs = Date.now() - new Date(iso).getTime();
    const hours = Math.floor(deltaMs / 3600000);

    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

function splitSentences(input: string): string[] {
    return input
        .trim()
        .split(/(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

function buildTwoSentenceSummary(data: RecommendationResponse): string {
    const narrative = data.llm_narrative?.narrative?.trim() ?? '';
    const summary = data.reason.summary?.trim() ?? '';
    const evidence = data.reason.evidence?.trim() ?? '';
    const confidenceNote = data.reason.confidence_note?.trim() ?? '';

    const primaryText = narrative.length > 0
        ? narrative
        : `${summary} ${evidence}`.trim();

    const primarySentences = splitSentences(primaryText);
    if (primarySentences.length >= 2) {
        return `${primarySentences[0]} ${primarySentences[1]}`;
    }

    if (primarySentences.length === 1) {
        const backupSentences = splitSentences(confidenceNote);
        if (backupSentences.length > 0) {
            return `${primarySentences[0]} ${backupSentences[0]}`;
        }
        return primarySentences[0];
    }

    const fallback = splitSentences(`${summary} ${evidence} ${confidenceNote}`.trim());
    if (fallback.length >= 2) {
        return `${fallback[0]} ${fallback[1]}`;
    }

    if (fallback.length === 1) {
        return fallback[0];
    }

    return 'Recommendation is being computed from your latest outcomes.';
}

function deriveAgentMode(agent: AgentSummary | null): 'recommend' | 'assist' | 'auto' {
    if (!agent) return 'recommend';
    if (agent.trust_status === 'suspended') return 'recommend';
    if (agent.total_outcomes >= 100) return 'auto';
    if (agent.total_outcomes >= 50) return 'assist';
    return 'recommend';
}

function modeDescription(mode: 'recommend' | 'assist' | 'auto'): string {
    if (mode === 'auto') {
        return 'Auto mode: highest-confidence action can execute automatically.';
    }
    if (mode === 'assist') {
        return 'Assist mode: recommendation is shown, developer confirms execution.';
    }
    return 'Recommend mode: collect outcomes and review recommendations manually.';
}

function actionConfidencePercent(actionOutcomes: number, taskOutcomes: number, taskConfidence: number): number {
    if (taskOutcomes <= 0) return 0;

    const coverage = Math.sqrt(Math.min(1, Math.max(0, actionOutcomes / taskOutcomes)));
    const confidence = Math.round(Math.max(0, Math.min(100, taskConfidence * coverage)));

    return confidence;
}

function deriveTaskConfidenceFromActions(actions: ActionPerformance[], taskOutcomes: number): number {
    if (!Array.isArray(actions) || actions.length === 0 || taskOutcomes <= 0) {
        return 0;
    }

    const ranked = [...actions]
        .filter((action) => Number.isFinite(action.total_count) && action.total_count > 0)
        .sort((a, b) => b.resolution_rate - a.resolution_rate);

    if (ranked.length === 0) return 0;

    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;

    const minArm = ranked.length >= 2
        ? Math.min(best.total_count, worst.total_count)
        : best.total_count;

    const sampleStrength = Math.min(1, minArm / 30);
    const outcomeStrength = Math.min(1, taskOutcomes / 100);
    const separation = ranked.length >= 2
        ? Math.min(1, Math.max(0, (best.resolution_rate - worst.resolution_rate) / 0.25))
        : 0.25;

    const blended = sampleStrength * 0.55 + outcomeStrength * 0.25 + separation * 0.20;
    return Math.round(Math.max(0, Math.min(95, blended * 100)));
}

function confidenceChipClass(label: ConfidenceLabel): string {
    if (label === 'very_high' || label === 'high') {
        return 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30';
    }
    if (label === 'medium') {
        return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
    }
    if (label === 'low') {
        return 'bg-red-500/10 text-red-400 border-red-500/30';
    }
    return 'bg-[#1a1a24] text-[#a1a1aa] border-[#1a1a24]';
}

function stateChipClass(state: string): string {
    if (state === 'stable') {
        return 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30';
    }
    if (state === 'early_signal') {
        return 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30';
    }
    return 'bg-[#1a1a24] text-[#a1a1aa] border-[#1a1a24]';
}

function AgentMetricsCard({ agent }: { agent: AgentSummary }): React.ReactElement {
    const mode = deriveAgentMode(agent);

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4 space-y-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#1a1a24] border border-[#252530] flex items-center justify-center shrink-0">
                        <Bot size={16} className="text-[#a1a1aa]" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{agent.agent_name}</p>
                        <p className="text-[10px] text-[#52525b] font-mono truncate">{agent.agent_id}</p>
                    </div>
                </div>
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs bg-[#0d0d14] border-[#1a1a24] text-[#a1a1aa] shrink-0">
                    <Shield size={11} />
                    {agent.trust_status ?? 'unknown'}
                </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Outcomes</p>
                    <p className="text-lg font-bold text-[#b8ff00] font-mono">{agent.total_outcomes.toLocaleString()}</p>
                </div>
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Tasks</p>
                    <p className="text-lg font-bold text-white font-mono">{agent.tasks.length}</p>
                </div>
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Mode</p>
                    <p className="text-lg font-bold text-white capitalize">{mode}</p>
                </div>
            </div>

            <p className="text-[11px] text-[#52525b]">{modeDescription(mode)}</p>

            <div className="text-[10px] text-[#3f3f46] flex flex-wrap gap-3">
                {agent.llm_model && <span className="font-mono">model: {agent.llm_model}</span>}
                {agent.window_days && <span>window: {agent.window_days}d</span>}
                {agent.counts_source && <span>source: {agent.counts_source}</span>}
            </div>
        </div>
    );
}

function TaskList({
    tasks,
    selectedTask,
    onSelect,
}: {
    tasks: TaskSummary[];
    selectedTask: string | null;
    onSelect: (taskName: string) => void;
}): React.ReactElement {
    if (tasks.length === 0) {
        return (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4 text-center space-y-2">
                <Database size={18} className="mx-auto text-[#3f3f46]" />
                <p className="text-xs text-[#52525b]">No tasks logged for this agent yet.</p>
            </div>
        );
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-3 space-y-1.5">
            <p className="px-1 text-[10px] uppercase tracking-wider text-[#52525b]">Tasks</p>
            {tasks.map((task) => {
                const active = selectedTask === task.task_name;
                const ready = task.total >= MIN_OUTCOMES_FOR_RECOMMENDATION;

                return (
                    <button
                        key={task.task_name}
                        onClick={() => onSelect(task.task_name)}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${active
                            ? 'bg-[#0f0f18] border-[#b8ff00]/30'
                            : 'bg-[#0a0a0f] border-[#1a1a24] hover:bg-[#0f0f18]'
                            }`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-xs text-white font-mono truncate">{task.task_name}</p>
                            <span className="text-[10px] text-[#52525b] font-mono shrink-0">{task.total.toLocaleString()}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                            <div className="flex-1 h-1 rounded-full bg-[#1a1a24] overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${ready ? 'bg-[#b8ff00]' : 'bg-yellow-400'}`}
                                    style={{ width: `${Math.min(100, (task.total / 100) * 100)}%` }}
                                />
                            </div>
                            <span className={`text-[10px] ${ready ? 'text-[#b8ff00]' : 'text-yellow-400'}`}>
                                {ready ? 'ready' : `${Math.max(0, MIN_OUTCOMES_FOR_RECOMMENDATION - task.total)} to go`}
                            </span>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

function ActionsTable({
    actions,
    taskOutcomes,
    taskConfidence,
}: {
    actions: ActionPerformance[];
    taskOutcomes: number;
    taskConfidence: number;
}): React.ReactElement {
    const ordered = [...actions].sort((a, b) => b.total_count - a.total_count);

    if (ordered.length === 0) {
        return (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4 space-y-2">
                <p className="text-xs font-medium text-white">Actions Logged For This Agent And Task</p>
                <p className="text-xs text-[#52525b]">
                    No action-level outcomes were found for this agent and task yet.
                </p>
            </div>
        );
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1a1a24] flex items-center justify-between gap-2 flex-wrap">
                <p className="text-xs font-medium text-white">Actions Logged For This Agent And Task</p>
                <span className="text-[10px] text-[#52525b]">Agent-scoped database data only</span>
            </div>

            <div className="divide-y divide-[#1a1a24]">
                {ordered.map((action) => {
                    const confidence = actionConfidencePercent(action.total_count, taskOutcomes, taskConfidence);
                    return (
                        <div key={action.action_id} className="px-4 py-3">
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-xs font-mono text-white truncate">{action.action_name}</p>
                                <span className="text-xs text-[#a1a1aa] font-mono shrink-0">{action.total_count.toLocaleString()} outcomes</span>
                            </div>
                            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-lg px-2.5 py-1.5">
                                    <span className="text-[#52525b]">Resolution score</span>
                                    <p className="text-white font-mono">{pct(action.resolution_rate)}</p>
                                </div>
                                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-lg px-2.5 py-1.5">
                                    <span className="text-[#52525b]">Action confidence</span>
                                    <p className="text-white font-mono">{confidence}%</p>
                                </div>
                                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-lg px-2.5 py-1.5">
                                    <span className="text-[#52525b]">Last outcome</span>
                                    <p className="text-white font-mono">{relativeTime(action.last_seen_at)}</p>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function TaskConfidenceCard({
    confidencePercent,
    outcomes,
}: {
    confidencePercent: number;
    outcomes: number;
}): React.ReactElement {
    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4 space-y-3">
            <p className="text-xs font-medium text-white">Task Confidence</p>
            <div className="flex items-center justify-between">
                <p className="text-2xl font-bold text-[#b8ff00] font-mono">{confidencePercent}%</p>
                <p className="text-xs text-[#52525b]">{outcomes.toLocaleString()} outcomes</p>
            </div>
            <div className="h-2 rounded-full bg-[#1a1a24] overflow-hidden">
                <div className="h-full rounded-full bg-[#b8ff00]" style={{ width: `${Math.max(0, Math.min(100, confidencePercent))}%` }} />
            </div>
            <p className="text-[11px] text-[#52525b]">
                Confidence is computed from database outcomes and action score signals for this task.
            </p>
        </div>
    );
}

function RecommendationCard({
    recommendation,
    summary,
    taskOutcomes,
    displayConfidence,
}: {
    recommendation: RecommendationResponse;
    summary: string;
    taskOutcomes: number;
    displayConfidence: number;
}): React.ReactElement {
    const rankedActions = [...(recommendation.all_actions ?? [])]
        .filter((action) => action.total_count > 0)
        .sort((a, b) => b.resolution_rate - a.resolution_rate);

    const fallbackBest = rankedActions[0] ?? null;
    const fallbackWorst = rankedActions.length > 1 ? rankedActions[rankedActions.length - 1] : null;
    const canShowFallbackRecommendation = recommendation.state === 'no_data'
        && taskOutcomes >= MIN_OUTCOMES_FOR_RECOMMENDATION
        && !!fallbackBest
        && !!fallbackWorst
        && fallbackBest.action_name !== fallbackWorst.action_name;

    const fallbackDelta = canShowFallbackRecommendation
        ? (fallbackBest!.resolution_rate - fallbackWorst!.resolution_rate)
        : null;

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <Zap size={14} className="text-[#b8ff00]" />
                    <p className="text-xs font-medium text-white">Recommendation</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full border text-[11px] capitalize ${stateChipClass(recommendation.state)}`}>
                        {recommendation.state}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full border text-[11px] ${confidenceChipClass(recommendation.confidence_meta.label)}`}>
                        {displayConfidence}% confidence
                    </span>
                </div>
            </div>

            {recommendation.llm_narrative?.headline && (
                <p className="text-sm font-semibold text-white">{recommendation.llm_narrative.headline}</p>
            )}

            <p className="text-sm text-[#a1a1aa] leading-relaxed">{summary}</p>

            {recommendation.insight.best_action && (
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-lg px-3 py-2.5 space-y-1">
                    <p className="text-[11px] text-[#52525b]">Best action</p>
                    <p className="text-sm text-white font-mono">{recommendation.insight.best_action}</p>
                    <p className="text-[11px] text-[#a1a1aa]">
                        Score: {pct(recommendation.insight.best_rate)}
                        {recommendation.insight.delta !== null && recommendation.insight.delta > 0 && (
                            <span className="text-[#b8ff00] ml-2">(+{(recommendation.insight.delta * 100).toFixed(1)}pp vs baseline)</span>
                        )}
                    </p>
                </div>
            )}

            {canShowFallbackRecommendation && (
                <div className="bg-[#0d0d14] border border-[#b8ff00]/20 rounded-lg px-3 py-2.5 space-y-1">
                    <p className="text-[11px] text-[#52525b]">Observed best action from this agent's outcomes</p>
                    <p className="text-sm text-white font-mono">{fallbackBest!.action_name}</p>
                    <p className="text-[11px] text-[#a1a1aa]">
                        {pct(fallbackBest!.resolution_rate)} vs {pct(fallbackWorst!.resolution_rate)}
                        {fallbackDelta !== null && (
                            <span className="text-[#b8ff00] ml-2">(+{(fallbackDelta * 100).toFixed(1)}pp)</span>
                        )}
                    </p>
                </div>
            )}

            <div className="text-[11px] text-[#52525b] space-y-1">
                <p>{recommendation.reason.evidence}</p>
                <p>{recommendation.reason.confidence_note}</p>
            </div>

            <p className="text-xs text-white">{recommendation.message}</p>

            {recommendation.agent_scope !== 'agent_scoped' && (
                <div className="flex items-start gap-2 text-[11px] text-blue-300/80 bg-blue-500/8 border border-blue-500/20 rounded-lg px-3 py-2">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    Strict agent scope was requested, but response scope is blended. Verify API fallback settings.
                </div>
            )}

            <p className="text-[10px] text-[#3f3f46]">
                Generated {relativeTime(recommendation.generated_at)}
                {recommendation.llm_narrative?.generated && recommendation.llm_narrative.model
                    ? ` by ${recommendation.llm_narrative.model}`
                    : ''}
            </p>
        </div>
    );
}

export default function RecommendationsPage(): React.ReactElement {
    const { apiKey, isValid, error: keyError, handleAuthFailure } = useAgentApiKey();

    const [agents, setAgents] = useState<AgentListItem[]>([]);
    const [agentsLoading, setAgentsLoading] = useState(false);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

    const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(false);

    const [selectedTask, setSelectedTask] = useState<string | null>(null);

    const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null);
    const [recommendationLoading, setRecommendationLoading] = useState(false);
    const [recommendationError, setRecommendationError] = useState<string | null>(null);

    const refreshRef = useRef<(() => void) | null>(null);
    const latestRecommendationToken = useRef(0);
    const latestSummaryToken = useRef(0);

    useEffect(() => {
        if (!isValid || !apiKey || !API_BASE) return;

        setAgentsLoading(true);
        const controller = new AbortController();

        void (async () => {
            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const response = await agentFetch(`${API_BASE}/v1/recommendations/agent-summary`, { signal: controller.signal });

                if (response.ok) {
                    const json = await response.json() as { agents: AgentListItem[] };
                    const list = json.agents ?? [];
                    setAgents(list);

                    setSelectedAgentId((current) => {
                        if (current && list.some((agent) => agent.agent_id === current)) return current;
                        return list[0]?.agent_id ?? null;
                    });

                    return;
                }
            } catch (error: any) {
                if (error?.name === 'AbortError') return;
                console.warn('[recommendations] failed to fetch agents list:', error.message);
            } finally {
                setAgentsLoading(false);
            }

            try {
                const { data } = await supabase
                    .from('dim_agents')
                    .select('agent_id, agent_name, agent_type, llm_model')
                    .order('agent_name');

                const fallback = (data ?? []).map((row) => ({
                    agent_id: row.agent_id,
                    agent_name: row.agent_name,
                    agent_type: row.agent_type ?? null,
                    llm_model: row.llm_model ?? null,
                    total_outcomes: 0,
                }));

                setAgents(fallback);
                setSelectedAgentId((current) => {
                    if (current && fallback.some((agent) => agent.agent_id === current)) return current;
                    return fallback[0]?.agent_id ?? null;
                });
            } catch (error: any) {
                console.warn('[recommendations] supabase fallback failed:', error.message);
            }
        })();

        return () => controller.abort();
    }, [isValid, apiKey, handleAuthFailure]);

    useEffect(() => {
        setAgentSummary(null);
        setSelectedTask(null);
        setRecommendation(null);
        setRecommendationError(null);

        if (!isValid || !apiKey || !API_BASE || !selectedAgentId) {
            setSummaryLoading(false);
            return;
        }

        setSummaryLoading(true);
        const controller = new AbortController();
        const token = ++latestSummaryToken.current;

        void (async () => {
            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const response = await agentFetch(
                    `${API_BASE}/v1/recommendations/agent-summary?agent_id=${encodeURIComponent(selectedAgentId)}`,
                    { signal: controller.signal },
                );

                if (response.ok) {
                    const json = await response.json() as AgentSummary;
                    if (token !== latestSummaryToken.current) return;
                    setAgentSummary(json);
                    if (json.tasks.length > 0) {
                        setSelectedTask(json.tasks[0]?.task_name ?? null);
                    }
                }
            } catch (error: any) {
                if (error?.name === 'AbortError') return;
                console.warn('[recommendations] failed to fetch agent summary:', error.message);
            } finally {
                if (token === latestSummaryToken.current) {
                    setSummaryLoading(false);
                }
            }
        })();

        return () => controller.abort();
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId]);

    const fetchRecommendation = useCallback(async (taskName: string, showLoading = true) => {
        if (!isValid || !apiKey || !API_BASE || !selectedAgentId) return;

        const token = ++latestRecommendationToken.current;
        if (showLoading) setRecommendationLoading(true);
        setRecommendationError(null);

        try {
            const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
            const response = await agentFetch(
                `${API_BASE}/v1/recommendations?task=${encodeURIComponent(taskName)}&agent_id=${encodeURIComponent(selectedAgentId)}&strict_agent_scope=1`,
            );

            if (!response.ok) {
                const body = await response.json().catch(() => ({}));
                throw new Error((body as any)?.error ?? `HTTP ${response.status}`);
            }

            const json = await response.json() as RecommendationResponse;
            if (token !== latestRecommendationToken.current) return;

            setRecommendation(json);
        } catch (error: any) {
            if (token !== latestRecommendationToken.current) return;
            setRecommendation(null);
            setRecommendationError(error.message ?? 'Failed to load recommendation.');
        } finally {
            if (token === latestRecommendationToken.current) {
                setRecommendationLoading(false);
            }
        }
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId]);

    useEffect(() => {
        if (!selectedTask) {
            setRecommendation(null);
            setRecommendationError(null);
            refreshRef.current = null;
            return;
        }

        setRecommendation(null);
        setRecommendationError(null);

        refreshRef.current = () => {
            void fetchRecommendation(selectedTask, false);
        };

        void fetchRecommendation(selectedTask, true);

        const interval = window.setInterval(() => {
            void fetchRecommendation(selectedTask, false);
        }, 30000);

        return () => {
            window.clearInterval(interval);
            refreshRef.current = null;
        };
    }, [selectedTask, fetchRecommendation]);

    const currentTaskSummary = useMemo(() => {
        if (!agentSummary || !selectedTask) return null;
        return agentSummary.tasks.find((task) => task.task_name === selectedTask) ?? null;
    }, [agentSummary, selectedTask]);

    const taskOutcomesFromSummary = currentTaskSummary?.total ?? 0;
    const taskOutcomesFromRecommendation = recommendation?.task_total_outcomes ?? 0;
    const taskOutcomes = Math.max(taskOutcomesFromSummary, taskOutcomesFromRecommendation);
    const taskConfidence = recommendation
        ? (recommendation.confidence_meta?.percent ?? 0) > 0
            ? (recommendation.confidence_meta?.percent ?? 0)
            : deriveTaskConfidenceFromActions(recommendation.all_actions ?? [], taskOutcomes)
        : 0;
    const minimumOutcomesMissing = Math.max(0, MIN_OUTCOMES_FOR_RECOMMENDATION - taskOutcomes);
    const summaryText = recommendation ? buildTwoSentenceSummary(recommendation) : '';

    if (!isValid) {
        return (
            <div className="space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <TrendingUp size={20} className="text-[#b8ff00]" />
                        Recommendations
                    </h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">Agent-scoped recommendation intelligence</p>
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-10 text-center space-y-3">
                    <Target size={28} className="mx-auto text-[#3f3f46]" />
                    <p className="text-white font-medium">API key required</p>
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
        <div className="space-y-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <TrendingUp size={20} className="text-[#b8ff00]" />
                        Recommendations
                    </h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">Agent-scoped outcomes, actions, and recommendation confidence.</p>
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                    <div className="relative min-w-[260px]">
                        <select
                            value={selectedAgentId ?? ''}
                            onChange={(event) => setSelectedAgentId(event.target.value || null)}
                            className="w-full appearance-none bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#b8ff00]/40 cursor-pointer pr-9 transition-colors"
                            disabled={agentsLoading}
                        >
                            {agents.length === 0 && <option value="">No agents</option>}
                            {agents.map((agent) => (
                                <option key={agent.agent_id} value={agent.agent_id}>
                                    {agent.agent_name} · {agent.total_outcomes.toLocaleString()} outcomes
                                </option>
                            ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none" />
                    </div>

                    <button
                        className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-2 text-[#a1a1aa] hover:text-white transition-colors"
                        onClick={() => refreshRef.current?.()}
                        disabled={recommendationLoading || !selectedTask}
                    >
                        <RefreshCw size={13} className={recommendationLoading ? 'animate-spin' : ''} />
                        Refresh
                    </button>
                </div>
            </div>

            {!agentsLoading && agents.length === 0 && (
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-12 text-center space-y-3">
                    <Bot size={28} className="mx-auto text-[#3f3f46]" />
                    <p className="text-sm text-white">No agents found</p>
                    <p className="text-xs text-[#52525b] max-w-sm mx-auto">
                        Install the SDK and log outcomes to register your first agent.
                    </p>
                </div>
            )}

            {selectedAgentId && (
                <div className="grid grid-cols-12 gap-5 items-start">
                    <div className="col-span-12 lg:col-span-4 space-y-4">
                        {summaryLoading || !agentSummary ? (
                            <div className="space-y-3 animate-pulse">
                                <div className="h-40 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                                <div className="h-64 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                            </div>
                        ) : (
                            <>
                                <AgentMetricsCard agent={agentSummary} />
                                <TaskList
                                    tasks={agentSummary.tasks}
                                    selectedTask={selectedTask}
                                    onSelect={setSelectedTask}
                                />
                            </>
                        )}
                    </div>

                    <div className="col-span-12 lg:col-span-8 space-y-4">
                        {!selectedTask && (
                            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-16 text-center space-y-3">
                                <Database size={24} className="mx-auto text-[#52525b]" />
                                <p className="text-sm text-[#52525b]">Select a task to view actions and recommendation details.</p>
                            </div>
                        )}

                        {selectedTask && (
                            <>
                                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-4">
                                    <div className="flex items-start justify-between gap-3 flex-wrap">
                                        <div>
                                            <p className="text-sm font-semibold text-white font-mono">{selectedTask}</p>
                                            <p className="text-xs text-[#52525b] mt-1">
                                                {taskOutcomes.toLocaleString()} outcomes logged for this task by this agent.
                                            </p>
                                        </div>
                                        {recommendation && (
                                            <div className="flex items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded-full border text-xs capitalize ${stateChipClass(recommendation.state)}`}>
                                                    {recommendation.state}
                                                </span>
                                                <span className={`px-2 py-0.5 rounded-full border text-xs ${confidenceChipClass(recommendation.confidence_meta.label)}`}>
                                                    {recommendation.confidence_meta.percent}% confidence
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {recommendationError && (
                                    <div className="bg-red-500/8 border border-red-500/25 rounded-xl px-4 py-3 flex items-center gap-2 text-xs text-red-400">
                                        <AlertTriangle size={13} />
                                        {recommendationError}
                                    </div>
                                )}

                                {recommendationLoading && !recommendation && (
                                    <div className="space-y-3 animate-pulse">
                                        <div className="h-40 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                                        <div className="h-24 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                                        <div className="h-44 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                                    </div>
                                )}

                                {recommendation && (
                                    <>
                                        <ActionsTable
                                            actions={recommendation.all_actions ?? []}
                                            taskOutcomes={Math.max(1, taskOutcomes)}
                                            taskConfidence={taskConfidence}
                                        />

                                        {taskOutcomes < MIN_OUTCOMES_FOR_RECOMMENDATION && (
                                            <div className="bg-yellow-500/8 border border-yellow-500/25 rounded-xl p-4 flex items-start gap-2.5">
                                                <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                                                <div className="space-y-1">
                                                    <p className="text-sm font-medium text-yellow-400">Minimum outcomes required</p>
                                                    <p className="text-xs text-yellow-200/80">
                                                        To get the recommendation agent should log at least 30 outcomes.
                                                    </p>
                                                    <p className="text-[11px] text-yellow-300/80">
                                                        {minimumOutcomesMissing.toLocaleString()} more outcomes needed for this task.
                                                    </p>
                                                </div>
                                            </div>
                                        )}

                                        <TaskConfidenceCard
                                            confidencePercent={taskConfidence}
                                            outcomes={taskOutcomes}
                                        />

                                        <RecommendationCard
                                            recommendation={recommendation}
                                            summary={summaryText}
                                            taskOutcomes={taskOutcomes}
                                            displayConfidence={taskConfidence}
                                        />

                                        <div className="text-[11px] text-[#52525b] flex items-center justify-between flex-wrap gap-2">
                                            <span>
                                                Last outcome: {relativeTime(recommendation.data_window?.last_seen_at ?? null)}
                                            </span>
                                            <span>
                                                Scope: {recommendation.agent_scope === 'agent_scoped' ? 'agent only' : 'blended'}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
