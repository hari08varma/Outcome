import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowDown,
    ArrowRight,
    ArrowUp,
    Bot,
    ChevronDown,
    Database,
    Minus,
    RefreshCw,
    Shield,
    TrendingDown,
    TrendingUp,
    Zap,
} from 'lucide-react';
import { createAgentFetch } from '../../lib/api';
import { API_BASE } from '../../lib/config';
import { useAgentApiKey } from '../../hooks/useAgentApiKey';
import { supabase } from '../../supabaseClient';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_OUTCOMES_FOR_RECOMMENDATION = 30;
const ACCENT = '#b8ff00';

// ─── Types ────────────────────────────────────────────────────────────────────

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high' | 'very_high';
type TrendDirection = 'improving' | 'stable' | 'degrading' | 'unknown';

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
    win_rate?: number | null;
    tasks: TaskSummary[];
}

interface ActionPerformance {
    action_id: string;
    action_name: string;
    total_count: number;
    effective_sample_count?: number;
    resolution_rate: number;
    ml_score?: number | null;
    semantic_cluster_convergence?: number;
    last_seen_at: string | null;
}

interface RecommendationResponse {
    task: string;
    state: string;
    confidence: number;
    confidence_meta: { value: number; percent: number; label: ConfidenceLabel };
    confidence_source?: string;
    confidence_source_reason?: string;
    decision: { type: 'collect_more_data' | 'monitor' | 'replace'; action_required: boolean };
    message: string;
    reason: { summary: string; evidence: string; confidence_note: string };
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
        summary: string | null;
        narrative: string | null;
        evidence: string | null;
        confidence_note: string | null;
        next_steps: string[] | null;
        risk_factors: string[] | null;
        trend_direction: TrendDirection | null;
        generated: boolean;
        model: string | null;
    };
    all_actions?: ActionPerformance[];
    task_total_outcomes?: number;
    trust_blocked?: boolean;
    trust_status?: string | null;
    agent_scope: 'agent_scoped' | 'customer_blended';
    scope_transition?: {
        fallback_applied: boolean;
        reason: string | null;
        threshold_bucket: string | null;
        current_samples: number | null;
        next_threshold: number | null;
        remaining_samples_to_next_bucket: number | null;
    };
    generated_at: string;
    data_window?: { last_seen_at: string | null } | null;
    data_freshness?: { is_stale: boolean; age_hours: number | null; label: string };
    cohort_reliability?: { band: 'stable' | 'watch' | 'anomalous' | null; reasons: string[] };
    data_sources?: {
        uploaded_outcomes: number;
        sdk_outcomes: number;
        total: number;
        upload_share: number;
        quality_score: number | null;
    } | null;
    context_filter?: {
        context_id: string | null;
        label: string | null;
        issue_type: string | null;
        environment: string | null;
        customer_tier: string | null;
    } | null;
    noise_gate?: { is_noisy_task: boolean; task_noise_score: number } | null;
    _silent_failure_warning?: boolean;
    policy_gate?: {
        trust_blocked: boolean;
        trust_status: string | null;
    } | null;
    debug_scope?: {
        requested_agent_id: string | null;
        requested_task_name: string;
        effective_task_name: string;
        evidence_task_name: string;
        strict_agent_scope: boolean;
        evidence_source: string;
        evidence_action_count: number;
        trust_gate_blocked: boolean;
    } | null;
}

interface TaskAnalytics {
    drift: {
        slope: number | null;
        confidence: number | null;
        window_size: number;
        direction: TrendDirection;
        points: Array<{ index: number; rate: number; timestamp: string }>;
    };
    explore_exploit: {
        explore_count: number;
        exploit_count: number;
        total: number;
        explore_ratio: number | null;
    };
    trust_blocks: { blocked_count: number; total: number };
    action_aggregates?: ActionPerformance[];
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function pct(value: number | null | undefined, decimals = 1): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(decimals)}%`;
}

function relTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const deltaMs = Date.now() - new Date(iso).getTime();
    const hours = Math.floor(deltaMs / 3_600_000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

function confidenceLabel(label: ConfidenceLabel): { text: string; cls: string } {
    if (label === 'very_high') return { text: 'Very high', cls: `bg-[${ACCENT}]/10 text-[${ACCENT}] border-[${ACCENT}]/30` };
    if (label === 'high') return { text: 'High', cls: `bg-[${ACCENT}]/10 text-[${ACCENT}] border-[${ACCENT}]/30` };
    if (label === 'medium') return { text: 'Medium', cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' };
    if (label === 'low') return { text: 'Low', cls: 'bg-red-500/10 text-red-400 border-red-500/30' };
    return { text: 'None', cls: 'bg-[#1a1a24] text-[#52525b] border-[#1a1a24]' };
}

function confidenceTier(effectiveSamples: number): { label: string; cls: string } {
    if (effectiveSamples >= 100) return { label: 'Tier 1 — Stable', cls: 'text-[#b8ff00]' };
    if (effectiveSamples >= 50) return { label: 'Tier 2 — Warming', cls: 'text-yellow-400' };
    if (effectiveSamples >= 10) return { label: 'Tier 3 — Early', cls: 'text-orange-400' };
    return { label: 'Cold Start', cls: 'text-[#52525b]' };
}

// ─── Micro sparkline ─────────────────────────────────────────────────────────

function Sparkline({ points, direction }: { points: Array<{ rate: number }>; direction: TrendDirection }): React.ReactElement | null {
    if (points.length < 2) return null;

    const W = 120;
    const H = 36;
    const pad = 4;
    const rates = points.map((p) => p.rate);
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const range = max - min || 0.01;

    const toX = (i: number) => pad + (i / (points.length - 1)) * (W - pad * 2);
    const toY = (r: number) => H - pad - ((r - min) / range) * (H - pad * 2);

    const d = rates.map((r, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(r).toFixed(1)}`).join(' ');
    const fillD = `${d} L ${toX(rates.length - 1).toFixed(1)} ${H} L ${toX(0).toFixed(1)} ${H} Z`;

    const stroke =
        direction === 'improving' ? ACCENT :
            direction === 'degrading' ? '#f87171' :
                '#52525b';

    return (
        <svg width={W} height={H} className="overflow-visible">
            <defs>
                <linearGradient id="grad-degrade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#f87171" stopOpacity="0" />
                </linearGradient>
            </defs>
            {direction === 'degrading' && (
                <path d={fillD} fill="url(#grad-degrade)" stroke="none" />
            )}
            <line x1={0} y1={H} x2={W} y2={H} stroke="#52525b" strokeWidth="1" strokeDasharray="3 3" opacity={0.5} />
            <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// ─── Agent picker ─────────────────────────────────────────────────────────────

function AgentPicker({
    agents,
    selectedId,
    loading,
    onChange,
}: {
    agents: AgentListItem[];
    selectedId: string | null;
    loading: boolean;
    onChange: (id: string) => void;
}): React.ReactElement {
    return (
        <div className="relative">
            <select
                value={selectedId ?? ''}
                onChange={(e) => e.target.value && onChange(e.target.value)}
                disabled={loading}
                className="appearance-none w-full bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#b8ff00]/40 cursor-pointer pr-9 transition-colors min-w-[260px]"
            >
                {agents.length === 0 && <option value="">No agents</option>}
                {agents.map((a) => (
                    <option key={a.agent_id} value={a.agent_id}>
                        {a.agent_name} · {a.total_outcomes.toLocaleString()} outcomes
                    </option>
                ))}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none" />
        </div>
    );
}

// ─── Agent overview card ──────────────────────────────────────────────────────

function AgentOverviewCard({ agent }: { agent: AgentSummary }): React.ReactElement {
    const trustCls =
        agent.trust_status === 'active' ? 'text-[#b8ff00]' :
            agent.trust_status === 'suspended' ? 'text-red-400' :
                'text-[#52525b]';

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-4">
            {/* Header */}
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#1a1a24] border border-[#252530] flex items-center justify-center shrink-0">
                    <Bot size={16} className="text-[#a1a1aa]" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{agent.agent_name}</p>
                    <p className="text-[10px] text-[#52525b] font-mono truncate">{agent.agent_id}</p>
                </div>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-2">
                <Stat label="Outcomes" value={agent.total_outcomes.toLocaleString()} accent />
                <Stat label="Tasks" value={String(agent.tasks.length)} />
                <Stat label="Trust" value={agent.trust_score !== null ? `${Math.round((agent.trust_score ?? 0) * 100)}%` : '—'} />
                <Stat label="Win Rate" value={agent.win_rate !== null && agent.win_rate !== undefined ? `${(agent.win_rate * 100).toFixed(1)}%` : '—'} />
            </div>

            {/* Trust badge */}
            <div className="flex items-center gap-2">
                <Shield size={11} className={trustCls} />
                <span className={`text-xs capitalize ${trustCls}`}>{agent.trust_status ?? 'unknown'}</span>
                {agent.llm_model && (
                    <span className="ml-auto text-[10px] text-[#3f3f46] font-mono">{agent.llm_model}</span>
                )}
            </div>

            {/* Performance split bar */}
            {agent.win_rate !== null && agent.win_rate !== undefined ? (
                <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10px]">
                        <span className="text-[#52525b]">Agent Performance</span>
                        <span className="font-mono text-white/80">
                            {((1 - agent.win_rate) * 100).toFixed(1)}% failure
                        </span>
                    </div>
                    <div className="flex h-1.5 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-[#b8ff00] transition-all"
                            style={{ width: `${agent.win_rate * 100}%` }}
                            title={`Success Rate: ${(agent.win_rate * 100).toFixed(1)}%`}
                        />
                        <div
                            className="h-full bg-red-500/80 transition-all"
                            style={{ width: `${(1 - agent.win_rate) * 100}%` }}
                            title={`Failure Rate: ${((1 - agent.win_rate) * 100).toFixed(1)}%`}
                        />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }): React.ReactElement {
    return (
        <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-2.5">
            <p className="text-[10px] text-[#52525b] uppercase tracking-wider">{label}</p>
            <p className={`text-lg font-bold font-mono ${accent ? 'text-[#b8ff00]' : 'text-white'}`}>{value}</p>
        </div>
    );
}

// ─── Task list (left sidebar) ─────────────────────────────────────────────────

function TaskList({
    tasks,
    selectedTask,
    onSelect,
}: {
    tasks: TaskSummary[];
    selectedTask: string | null;
    onSelect: (name: string) => void;
}): React.ReactElement {
    if (tasks.length === 0) {
        return (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-6 text-center space-y-2">
                <Database size={18} className="mx-auto text-[#3f3f46]" />
                <p className="text-xs text-[#52525b]">No tasks logged yet.</p>
            </div>
        );
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1a1a24]">
                <p className="text-[10px] uppercase tracking-wider text-[#52525b]">Tasks · {tasks.length}</p>
            </div>
            <div className="divide-y divide-[#1a1a24] max-h-[calc(100vh-420px)] overflow-y-auto">
                {tasks.map((t) => {
                    const active = t.task_name === selectedTask;
                    return (
                        <button
                            key={t.task_name}
                            onClick={() => onSelect(t.task_name)}
                            className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-[#0f1a00]' : 'hover:bg-[#0f0f18]'}`}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <p className={`text-xs font-mono truncate ${active ? 'text-[#b8ff00]' : 'text-white'}`}>
                                    {t.task_name}
                                </p>
                                <span className="text-[10px] text-[#52525b] font-mono shrink-0">
                                    {t.total.toLocaleString()}
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Task health header ───────────────────────────────────────────────────────

function TaskHealthHeader({
    taskName,
    totalOutcomes,
    rec,
    analytics,
}: {
    taskName: string;
    totalOutcomes: number;
    rec: RecommendationResponse | null;
    analytics: TaskAnalytics | null;
}): React.ReactElement {
    const hasSufficient = totalOutcomes >= MIN_OUTCOMES_FOR_RECOMMENDATION;
    const confidenceMeta = rec?.confidence_meta;
    const cl = confidenceMeta && !rec?.policy_gate?.trust_blocked
        ? confidenceLabel(confidenceMeta.label)
        : null;
    const drift = analytics?.drift ?? null;
    const fallbackBest = rec?.all_actions && rec.all_actions.length > 0
        ? [...rec.all_actions].sort((a, b) => b.resolution_rate - a.resolution_rate)[0]
        : null;
    const bestRate = rec?.insight?.best_rate ?? fallbackBest?.resolution_rate ?? null;
    const bestAction = rec?.insight?.best_action ?? fallbackBest?.action_name ?? 'no data';
    const confidenceValue = rec?.policy_gate?.trust_blocked
        ? 'Blocked'
        : rec?.confidence_meta?.percent != null
            ? `${rec.confidence_meta.percent}%`
            : '—';
    const confidenceSub = rec?.policy_gate?.trust_blocked
        ? `trust: ${rec.policy_gate.trust_status ?? 'blocked'}`
        : rec?.confidence_source?.replace('_', ' ') ?? '—';

    // Calculate Suboptimal Usage
    const actionsByUsage = [...(rec?.all_actions || [])].sort((a, b) => b.total_count - a.total_count);
    const mostUsedAction = actionsByUsage.length > 0 ? actionsByUsage[0] : null;
    const isMostUsedSuboptimal = mostUsedAction 
        && fallbackBest 
        && mostUsedAction.action_id !== fallbackBest.action_id
        && mostUsedAction.resolution_rate < fallbackBest.resolution_rate;

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-4">
            {/* Task name + badges */}
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <p className="text-base font-bold text-white font-mono">{taskName}</p>
                    <p className="text-xs text-[#52525b] mt-0.5">
                        {totalOutcomes.toLocaleString()} outcomes logged for this task by this agent
                    </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    {rec?.policy_gate?.trust_blocked ? (
                        <span className="px-2.5 py-1 rounded-full border text-xs capitalize bg-orange-500/10 border-orange-500/30 text-orange-400">
                            Trust Suspended
                        </span>
                    ) : rec?.state && (
                        <span className="px-2.5 py-1 rounded-full border text-xs capitalize bg-[#1a1a24] border-[#252530] text-[#a1a1aa]">
                            {rec.state.replace('_', ' ')}
                        </span>
                    )}
                    {cl && (
                        <span className={`px-2.5 py-1 rounded-full border text-xs ${cl.cls}`}>
                            {cl.text} confidence
                        </span>
                    )}
                    {drift && drift.direction !== 'unknown' && (
                        <span className={`px-2.5 py-1 rounded-full border text-xs flex items-center gap-1 ${drift.direction === 'degrading' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                            drift.direction === 'improving' ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30' :
                                'bg-[#1a1a24] text-[#52525b] border-[#1a1a24]'
                            }`}>
                            {drift.direction === 'degrading' ? <TrendingDown size={10} /> :
                                drift.direction === 'improving' ? <TrendingUp size={10} /> :
                                    <Minus size={10} />}
                            {drift.direction}
                        </span>
                    )}
                </div>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCell
                    label="Total Attempts"
                    value={totalOutcomes.toLocaleString()}
                    sub={hasSufficient ? 'Recommendation ready' : `${Math.max(0, MIN_OUTCOMES_FOR_RECOMMENDATION - totalOutcomes)} more needed`}
                    accent={hasSufficient}
                />
                <KpiCell
                    label="Best Win Rate"
                    value={bestRate != null ? pct(bestRate) : '—'}
                    sub={bestAction}
                />
                <KpiCell
                    label="Confidence"
                    value={confidenceValue}
                    sub={confidenceSub}
                />
                <KpiCell
                    label="Drift Slope"
                    value={drift?.slope != null ? (drift.slope > 0 ? `+${(drift.slope * 100).toFixed(2)}pp` : `${(drift.slope * 100).toFixed(2)}pp`) : '—'}
                    sub={`per outcome (${drift?.window_size ?? 0} sampled)`}
                    danger={drift?.direction === 'degrading'}
                    good={drift?.direction === 'improving'}
                />
            </div>

            {/* AHA! Insight Alert for Suboptimal Hardcoding */}
            {isMostUsedSuboptimal && mostUsedAction && fallbackBest && (
                <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/30 rounded-xl p-4">
                    <Zap size={16} className="text-red-400 mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-bold text-red-400">Action Switch Recommended</p>
                        <p className="text-xs text-red-200/80 mt-1">
                            Your agent is currently heavily routing to <code className="font-mono bg-red-500/20 px-1 rounded">{mostUsedAction.action_name}</code> which has a win rate of <strong className="text-red-400">{pct(mostUsedAction.resolution_rate)}</strong>. 
                            Switching to <code className="font-mono bg-red-500/20 px-1 rounded">{fallbackBest.action_name}</code> would improve success by <strong className="text-red-400">{pct(fallbackBest.resolution_rate - mostUsedAction.resolution_rate)}</strong>.
                        </p>
                    </div>
                </div>
            )}

            {/* Insufficient data gate */}
            {!hasSufficient && (
                <div className="flex items-start gap-3 bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-4">
                    <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium text-yellow-400">Not enough outcomes for a recommendation</p>
                        <p className="text-xs text-yellow-200/70 mt-1">
                            Log at least {MIN_OUTCOMES_FOR_RECOMMENDATION} outcomes for this task. Currently at {totalOutcomes}.
                            Each <code className="font-mono bg-yellow-500/10 px-1 rounded">log_outcome</code> call with{' '}
                            <code className="font-mono bg-yellow-500/10 px-1 rounded">task=&quot;{taskName}&quot;</code> counts toward this threshold.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

function KpiCell({ label, value, sub, accent, danger, good }: {
    label: string;
    value: string;
    sub?: string;
    accent?: boolean;
    danger?: boolean;
    good?: boolean;
}): React.ReactElement {
    const valueColor = danger ? 'text-red-400' : good ? 'text-[#b8ff00]' : accent ? 'text-[#b8ff00]' : 'text-white';
    return (
        <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-3">
            <p className="text-[10px] text-[#52525b] uppercase tracking-wider">{label}</p>
            <p className={`text-xl font-bold font-mono mt-1 ${valueColor}`}>{value}</p>
            {sub && <p className="text-[10px] text-[#3f3f46] mt-1 truncate">{sub}</p>}
        </div>
    );
}

// ─── Drift alert ──────────────────────────────────────────────────────────────

function DriftAlert({ analytics }: { analytics: TaskAnalytics }): React.ReactElement | null {
    const { drift } = analytics;
    
    // Noise Gate: Hide alert if statistical confidence in the trend is too weak (R² < 0.25)
    if (drift.direction !== 'degrading' || drift.slope === null || drift.confidence === null || drift.confidence < 0.25) {
        return null;
    }

    // Explode the pain point: Show total drop across window, not drop per outcome
    const totalDropPct = Math.abs(drift.slope * drift.window_size * 100).toFixed(1);

    return (
        <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/30 rounded-2xl p-4">
            <TrendingDown size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="space-y-1 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold text-red-500">Critical Context Drift</p>
                    <span className="px-2 py-0.5 bg-red-500/20 rounded-md text-[10px] font-bold text-red-300 border border-red-500/20 uppercase tracking-widest">
                        {totalDropPct}% Plunge
                    </span>
                </div>
                <p className="text-xs text-red-200/80 leading-relaxed">
                    The success rate for this task has cumulatively plunged by <strong className="text-red-400">{totalDropPct}%</strong> over the last {drift.window_size} executions (R² = {drift.confidence.toFixed(2)}). 
                    The environment has fundamentally changed. If your agent is hardcoded to a single action, it is rapidly failing.
                </p>
                {drift.points.length >= 2 && (
                    <div className="pt-3 pb-1">
                        <Sparkline points={drift.points} direction="degrading" />
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── LLM Insight panel ────────────────────────────────────────────────────────

function LLMInsightPanel({ rec }: { rec: RecommendationResponse }): React.ReactElement | null {
    // When the agent is trust blocked, the LLM insight is irrelevant and static fallbacks contradict the trust banner.
    if (rec.trust_blocked) return null;

    const n = rec.llm_narrative;
    if (!n?.generated) {
        // Static fallback
        const headline = rec.reason.summary;
        if (!headline) return null;
        return (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-3">
                <div className="flex items-center gap-2">
                    <Zap size={14} className="text-[#b8ff00]" />
                    <p className="text-xs font-semibold text-white uppercase tracking-wider">Engine Insight</p>
                </div>
                <p className="text-sm text-[#a1a1aa]">{headline}</p>
                {rec.reason.evidence && <p className="text-xs text-[#52525b]">{rec.reason.evidence}</p>}
                {rec.message && (
                    <div className="flex items-start gap-2 pt-2 border-t border-[#1a1a24]">
                        <ArrowRight size={13} className="text-[#b8ff00] mt-0.5 shrink-0" />
                        <p className="text-xs text-white">{rec.message}</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Zap size={14} className="text-[#b8ff00]" />
                    <p className="text-xs font-semibold text-white uppercase tracking-wider">AI Analysis</p>
                    <span className="text-[10px] text-[#3f3f46] font-mono">{n.model ?? 'gpt-4o-mini'}</span>
                </div>
                {n.trend_direction && n.trend_direction !== 'unknown' && (
                    <span className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${n.trend_direction === 'improving' ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30' :
                        n.trend_direction === 'degrading' ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                            'bg-[#1a1a24] text-[#52525b] border-[#1a1a24]'
                        }`}>
                        {n.trend_direction === 'improving' ? <ArrowUp size={9} /> :
                            n.trend_direction === 'degrading' ? <ArrowDown size={9} /> :
                                <Minus size={9} />}
                        {n.trend_direction}
                    </span>
                )}
            </div>

            {/* Headline */}
            {n.headline && (
                <p className="text-sm font-semibold text-white leading-snug">{n.headline}</p>
            )}

            {/* Narrative */}
            {n.narrative && (
                <p className="text-sm text-[#a1a1aa] leading-relaxed">{n.narrative}</p>
            )}

            {/* Evidence */}
            {n.evidence && (
                <p className="text-xs text-[#52525b] border-l-2 border-[#1a1a24] pl-3">{n.evidence}</p>
            )}

            {/* Next steps */}
            {n.next_steps && n.next_steps.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-[#1a1a24]">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">What to do</p>
                    {n.next_steps.map((step, i) => (
                        <div key={i} className="flex items-start gap-2">
                            <ArrowRight size={12} className="text-[#b8ff00] mt-0.5 shrink-0" />
                            <p className="text-xs text-white">{step}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Risk factors */}
            {n.risk_factors && n.risk_factors.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-[#1a1a24]">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Risk factors</p>
                    {n.risk_factors.map((r, i) => (
                        <div key={i} className="flex items-start gap-2">
                            <AlertTriangle size={11} className="text-yellow-400 mt-0.5 shrink-0" />
                            <p className="text-xs text-yellow-200/80">{r}</p>
                        </div>
                    ))}
                </div>
            )}

            {/* Confidence note */}
            {n.confidence_note && (
                <p className="text-[10px] text-[#3f3f46] pt-2 border-t border-[#1a1a24]">{n.confidence_note}</p>
            )}
        </div>
    );
}

// ─── Action leaderboard ───────────────────────────────────────────────────────

function ActionLeaderboard({
    actions,
    bestActionName,
    totalOutcomes,
}: {
    actions: ActionPerformance[];
    bestActionName: string | null;
    totalOutcomes: number;
}): React.ReactElement {
    // Deduplicate by action_id (server already deduplicates, this is a safety net).
    // If two entries share the same action_name but different IDs (normalization lag),
    // keep the one with the higher total_count as it has more evidence.
    const seenIds = new Set<string>();
    const seenNames = new Map<string, ActionPerformance>();
    const deduped: ActionPerformance[] = [];
    for (const a of actions) {
        if (seenIds.has(a.action_id)) continue;
        seenIds.add(a.action_id);
        const existing = seenNames.get(a.action_name);
        if (existing) {
            if (a.total_count > existing.total_count) {
                deduped.splice(deduped.indexOf(existing), 1, a);
                seenNames.set(a.action_name, a);
            }
        } else {
            seenNames.set(a.action_name, a);
            deduped.push(a);
        }
    }
    const sorted = deduped.sort((a, b) => b.resolution_rate - a.resolution_rate);

    if (sorted.length === 0) {
        return (
            <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-2">
                <p className="text-xs font-semibold text-white">Action Leaderboard</p>
                <p className="text-xs text-[#52525b]">No action-level outcomes logged for this task yet.</p>
            </div>
        );
    }

    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    const delta = sorted.length >= 2 ? best.resolution_rate - worst.resolution_rate : null;

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[#1a1a24] space-y-1">
                <p className="text-xs font-semibold text-white">Action Leaderboard — What Works</p>
                <p className="text-[10px] text-[#52525b]">
                    Ranked by resolution rate (weighted outcome score). Confidence tier shows statistical reliability of each score.
                </p>
                {delta !== null && (
                    <p className="text-[10px] text-[#a1a1aa]">
                        Performance gap: <span className="text-[#b8ff00] font-mono">{pct(delta)}</span> between best and worst action.
                        {delta >= 0.1 && ' Switching to the top action can meaningfully improve resolution.'}
                    </p>
                )}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="border-b border-[#1a1a24] text-[#52525b] text-[10px] uppercase tracking-wider">
                            <th className="text-left px-5 py-2.5 font-medium">Action</th>
                            <th className="text-left px-4 py-2.5 font-medium min-w-[120px]">Win Rate</th>
                            <th className="text-right px-4 py-2.5 font-medium">Attempts</th>
                            <th className="text-right px-4 py-2.5 font-medium">Confidence Tier</th>
                            <th className="text-right px-5 py-2.5 font-medium">Last Seen</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1a1a24]">
                        {sorted.map((action, rank) => {
                            const isRecommended = action.action_name === bestActionName;
                            const tier = confidenceTier(action.effective_sample_count ?? action.total_count);
                            const share = totalOutcomes > 0 ? action.total_count / totalOutcomes : 0;
                            const conv = action.semantic_cluster_convergence ?? null;

                            return (
                                <tr
                                    key={action.action_id}
                                    className={`transition-colors ${isRecommended ? 'bg-[#0f1a00]' : 'hover:bg-[#0f0f18]'}`}
                                >
                                    {/* Action name */}
                                    <td className="px-5 py-3">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-[#3f3f46] font-mono w-4 shrink-0">
                                                #{rank + 1}
                                            </span>
                                            <span className={`font-mono font-medium truncate max-w-[160px] ${isRecommended ? 'text-[#b8ff00]' : 'text-white'}`}>
                                                {action.action_name}
                                            </span>
                                            {isRecommended && (
                                                <span className="text-[9px] px-1.5 py-0.5 bg-[#b8ff00]/15 text-[#b8ff00] border border-[#b8ff00]/30 rounded-full shrink-0">
                                                    BEST
                                                </span>
                                            )}
                                        </div>
                                        {/* Share bar */}
                                        <div className="mt-1.5 ml-6 h-1 rounded-full bg-[#1a1a24] overflow-hidden w-32">
                                            <div
                                                className={`h-full rounded-full ${isRecommended ? 'bg-[#b8ff00]' : 'bg-[#3f3f46]'}`}
                                                style={{ width: `${(share * 100).toFixed(1)}%` }}
                                            />
                                        </div>
                                    </td>

                                    {/* Win rate */}
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-3">
                                            <span className={`font-mono font-semibold w-10 ${isRecommended ? 'text-[#b8ff00]' : 'text-white'}`}>
                                                {pct(action.resolution_rate)}
                                            </span>
                                            <div className="flex-1 h-1.5 bg-[#1a1a24] rounded-full overflow-hidden min-w-[50px]">
                                                <div 
                                                    className={`h-full rounded-full transition-all ${isRecommended ? 'bg-[#b8ff00]' : 'bg-[#52525b]'}`}
                                                    style={{ width: `${action.resolution_rate * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                    </td>

                                    {/* Attempts */}
                                    <td className="px-4 py-3 text-right text-[#a1a1aa] font-mono">
                                        {action.total_count.toLocaleString()}
                                    </td>

                                    {/* Confidence tier */}
                                    <td className="px-4 py-3 text-right">
                                        <span className={`text-[10px] ${tier.cls}`}>{tier.label}</span>
                                    </td>

                                    {/* Last seen */}
                                    <td className="px-5 py-3 text-right text-[10px] text-[#52525b]">
                                        {relTime(action.last_seen_at)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ─── Engine interventions ─────────────────────────────────────────────────────

function EngineInterventions({
    analytics,
    rec,
}: {
    analytics: TaskAnalytics;
    rec: RecommendationResponse;
}): React.ReactElement | null {
    const { explore_exploit, trust_blocks } = analytics;
    const exploreRatio = explore_exploit.explore_ratio;
    const trustBlockRate = trust_blocks.total > 0 ? trust_blocks.blocked_count / trust_blocks.total : 0;

    const noiseGate = rec.noise_gate;
    const silentWarning = rec._silent_failure_warning ?? false;
    const cohortBand = rec.cohort_reliability?.band ?? null;
    const bandCls = cohortBand === 'stable' ? 'text-[#b8ff00]' : cohortBand === 'anomalous' ? 'text-red-400' : 'text-yellow-400';

    // Exception-based UI: Hide this entire panel if the engine is operating cleanly with 0 interventions
    const hasExplore = exploreRatio !== null && exploreRatio > 0;
    const hasBlocks = trust_blocks.blocked_count > 0;
    const isAnomalous = cohortBand !== 'stable' && cohortBand !== null;
    const hasWarnings = silentWarning || noiseGate?.is_noisy_task;

    if (!hasExplore && !hasBlocks && !isAnomalous && !hasWarnings) {
        return null;
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-4">
            <p className="text-xs font-semibold text-white">Engine Interventions & Policy Map</p>
            <p className="text-[10px] text-[#52525b]">
                Visibility into when Layerinfinite overrode your agent, tested new actions, or blocked execution.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* Explore ratio */}
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-3 space-y-1">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Exploration Rate</p>
                    <p className={`text-lg font-bold font-mono ${exploreRatio === null ? 'text-[#3f3f46]' :
                        exploreRatio > 0.25 ? 'text-yellow-400' : 'text-white'
                        }`}>
                        {exploreRatio !== null ? pct(exploreRatio) : '—'}
                    </p>
                    <p className="text-[10px] text-[#3f3f46]">
                        {explore_exploit.explore_count} explore / {explore_exploit.exploit_count} exploit
                    </p>
                </div>

                {/* Trust blocks */}
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-3 space-y-1">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Trust Blocks</p>
                    <p className={`text-lg font-bold font-mono ${trust_blocks.blocked_count > 0 ? 'text-red-400' : 'text-[#3f3f46]'}`}>
                        {trust_blocks.blocked_count}
                    </p>
                    <p className="text-[10px] text-[#3f3f46]">
                        {trust_blocks.total > 0 ? `${(trustBlockRate * 100).toFixed(1)}% of outcomes` : 'no blocks'}
                    </p>
                </div>

                {/* Signal reliability */}
                <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-3 space-y-1">
                    <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Signal Reliability</p>
                    <p className={`text-lg font-bold capitalize ${bandCls}`}>
                        {cohortBand ?? '—'}
                    </p>
                    {rec.cohort_reliability?.reasons?.slice(0, 1).map((r, i) => (
                        <p key={i} className="text-[10px] text-[#3f3f46] truncate">{r}</p>
                    ))}
                </div>
            </div>

            {/* Warnings */}
            <div className="space-y-2">
                {silentWarning && (
                    <div className="flex items-start gap-2 text-xs text-yellow-300/80 bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-3 py-2">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5 text-yellow-400" />
                        <span>
                            Silent failure warning: some outcomes were marked <code className="font-mono">success=true</code> but
                            had low outcome scores. The engine has discounted these — your success signals may be over-reporting.
                        </span>
                    </div>
                )}
                {noiseGate?.is_noisy_task && (
                    <div className="flex items-start gap-2 text-xs text-[#a1a1aa] bg-[#1a1a24] border border-[#252530] rounded-lg px-3 py-2">
                        <Shield size={12} className="shrink-0 mt-0.5 text-[#52525b]" />
                        <span>
                            Noise gate active: this task has high variance (noise score {(noiseGate.task_noise_score * 100).toFixed(0)}%).
                            The engine requires more samples before acting on a performance gap.
                        </span>
                    </div>
                )}
                {exploreRatio !== null && exploreRatio > 0.3 && (
                    <div className="flex items-start gap-2 text-xs text-[#a1a1aa] bg-[#1a1a24] border border-[#252530] rounded-lg px-3 py-2">
                        <Zap size={12} className="shrink-0 mt-0.5 text-[#b8ff00]" />
                        <span>
                            High exploration rate ({pct(exploreRatio)}). The engine is still testing alternative actions.
                            Win rates will stabilise as exploitation increases.
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Data sources panel ───────────────────────────────────────────────────────

function DataSourcesPanel({ rec }: { rec: RecommendationResponse }): React.ReactElement | null {
    const ds = rec.data_sources;
    const freshness = rec.data_freshness;
    const scope = rec.scope_transition;

    if (!ds && !freshness && !scope) return null;

    // Exception-based UI: Only show this panel if there is something interesting to report
    const hasUploads = ds && ds.uploaded_outcomes > 0;
    const hasQualityIssues = ds && ds.quality_score !== null && ds.quality_score < 0.8;
    const isStale = freshness?.is_stale === true;
    const hasFallback = scope?.fallback_applied === true;

    if (!hasUploads && !hasQualityIssues && !isStale && !hasFallback) {
        return null;
    }

    return (
        <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-5 space-y-3">
            <p className="text-xs font-semibold text-white">Data Sources & Scope</p>

            <div className="grid grid-cols-2 gap-3 text-xs">
                {ds && (
                    <>
                        <div className="space-y-1">
                            <p className="text-[10px] text-[#52525b] uppercase tracking-wider">SDK Outcomes</p>
                            <p className="text-sm font-mono text-white">{ds.sdk_outcomes.toLocaleString()}</p>
                        </div>
                        <div className="space-y-1">
                            <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Imported</p>
                            <p className="text-sm font-mono text-white">{ds.uploaded_outcomes.toLocaleString()}</p>
                        </div>
                        {ds.quality_score !== null && (
                            <div className="space-y-1">
                                <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Data Quality</p>
                                <p className={`text-sm font-mono ${ds.quality_score >= 0.7 ? 'text-[#b8ff00]' : ds.quality_score >= 0.5 ? 'text-yellow-400' : 'text-red-400'}`}>
                                    {(ds.quality_score * 100).toFixed(0)}%
                                </p>
                            </div>
                        )}
                    </>
                )}
                {freshness && (
                    <div className="space-y-1">
                        <p className="text-[10px] text-[#52525b] uppercase tracking-wider">Data Freshness</p>
                        <p className={`text-sm font-mono ${freshness.is_stale ? 'text-red-400' : 'text-[#b8ff00]'}`}>
                            {freshness.label}
                        </p>
                    </div>
                )}
            </div>

            {scope?.fallback_applied && (
                <div className="text-[10px] text-yellow-400/80 bg-yellow-500/5 border border-yellow-500/15 rounded-lg px-3 py-2">
                    Scope fallback active: agent-specific evidence is insufficient. Using blended cohort signal.
                    {scope.remaining_samples_to_next_bucket !== null && (
                        <> {scope.remaining_samples_to_next_bucket} more outcomes needed to switch to agent-scoped.</>
                    )}
                </div>
            )}
        </div>
    );
}

function TrustGateBanner({ rec }: { rec: RecommendationResponse }): React.ReactElement | null {
    if (!rec.trust_blocked) return null;

    return (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-2xl p-4">
            <Shield size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="space-y-2 flex-1">
                <p className="text-sm font-bold text-red-400">Recommendation Engine Suspended</p>
                <div className="text-xs text-red-200/80 leading-relaxed space-y-1">
                    <p>
                        <strong>Trust Status: <span className="font-mono text-red-300 uppercase">{rec.trust_status ?? 'suspended'}</span></strong>
                    </p>
                    <p>
                        Your agent has triggered the Layerinfinite security boundary. The ML engine has forcefully severed live recommendation logic to the SDK to protect your application from toxic routing or high variance hallucinations.
                    </p>
                    <p className="pt-1">
                        <strong>Action required:</strong> Review the Action Leaderboard below to inspect the historical evidence. Fix the violating actions in your codebase to automatically reinstate engine trust.
                    </p>
                </div>
            </div>
        </div>
    );
}

function ScopeDebugStrip({ rec }: { rec: RecommendationResponse }): React.ReactElement | null {
    const scope = rec.scope_transition;
    if (!scope?.fallback_applied) return null;

    return (
        <div className="text-[10px] text-[#52525b] bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-3 py-2">
            Scope fallback active — {scope.reason ?? 'agent scope insufficient'}
            {scope.remaining_samples_to_next_bucket !== null && ` · ${scope.remaining_samples_to_next_bucket} outcomes to agent scope`}
        </div>
    );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RecommendationsPage(): React.ReactElement {
    const { apiKey, isValid, error: keyError, handleAuthFailure } = useAgentApiKey();

    const [agents, setAgents] = useState<AgentListItem[]>([]);
    const [agentsLoading, setAgentsLoading] = useState(false);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

    const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(false);

    const [selectedTask, setSelectedTask] = useState<string | null>(null);

    const [rec, setRec] = useState<RecommendationResponse | null>(null);
    const [recLoading, setRecLoading] = useState(false);
    const [recError, setRecError] = useState<string | null>(null);

    const [analytics, setAnalytics] = useState<TaskAnalytics | null>(null);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);

    // Context filter — narrows recommendations to a specific issue_type + environment
    const [ctxIssueType, setCtxIssueType] = useState<string>('');
    const [ctxEnvironment, setCtxEnvironment] = useState<string>('');

    const refreshRef = useRef<(() => void) | null>(null);
    const recToken = useRef(0);
    const summaryToken = useRef(0);

    // ── Load agent list ──────────────────────────────────────
    useEffect(() => {
        if (!isValid || !apiKey || !API_BASE) return;
        setAgentsLoading(true);
        const ctrl = new AbortController();

        void (async () => {
            try {
                const fetch_ = createAgentFetch(apiKey, handleAuthFailure);
                const res = await fetch_(`${API_BASE}/v1/recommendations/agent-summary?t=${Date.now()}`, {
                    signal: ctrl.signal,
                    cache: 'no-store',
                });
                if (res.ok) {
                    const json = await res.json() as { agents: AgentListItem[] };
                    const list = json.agents ?? [];
                    setAgents(list);
                    setSelectedAgentId((cur) => (cur && list.some((a) => a.agent_id === cur) ? cur : list[0]?.agent_id ?? null));
                    return;
                }
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
            } finally {
                setAgentsLoading(false);
            }

            // Supabase fallback
            try {
                const { data } = await supabase
                    .from('dim_agents')
                    .select('agent_id, agent_name, agent_type, llm_model')
                    .order('agent_name');
                const list = (data ?? []).map((r) => ({
                    agent_id: r.agent_id,
                    agent_name: r.agent_name,
                    agent_type: r.agent_type ?? null,
                    llm_model: r.llm_model ?? null,
                    total_outcomes: 0,
                }));
                setAgents(list);
                setSelectedAgentId((cur) => (cur && list.some((a) => a.agent_id === cur) ? cur : list[0]?.agent_id ?? null));
            } catch { /* ignore */ }
        })();

        return () => ctrl.abort();
    }, [isValid, apiKey, handleAuthFailure]);

    // ── Load agent summary (tasks list) when agent changes ───
    useEffect(() => {
        setAgentSummary(null);
        setSelectedTask(null);
        setRec(null);
        setRecError(null);
        setAnalytics(null);

        if (!isValid || !apiKey || !API_BASE || !selectedAgentId) {
            setSummaryLoading(false);
            return;
        }

        setSummaryLoading(true);
        const ctrl = new AbortController();
        const tok = ++summaryToken.current;

        void (async () => {
            try {
                const fetch_ = createAgentFetch(apiKey, handleAuthFailure);
                const res = await fetch_(
                    `${API_BASE}/v1/recommendations/agent-summary?agent_id=${encodeURIComponent(selectedAgentId)}&t=${Date.now()}`,
                    { signal: ctrl.signal, cache: 'no-store' },
                );
                if (res.ok) {
                    const json = await res.json() as AgentSummary;
                    if (tok !== summaryToken.current) return;
                    setAgentSummary(json);
                    if (json.tasks.length > 0) setSelectedTask(json.tasks[0]?.task_name ?? null);
                }
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
            } finally {
                if (tok === summaryToken.current) setSummaryLoading(false);
            }
        })();

        return () => ctrl.abort();
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId]);

    // ── Fetch recommendation + analytics when task changes ───
    const fetchData = useCallback(async (taskName: string, showLoading: boolean) => {
        if (!isValid || !apiKey || !API_BASE || !selectedAgentId) return;

        const tok = ++recToken.current;
        if (showLoading) {
            setRecLoading(true);
            setAnalyticsLoading(true);
        }
        setRecError(null);

        const fetch_ = createAgentFetch(apiKey, handleAuthFailure);

        // Build context params when issue_type is set
        const ctxParams = ctxIssueType.trim()
            ? `&issue_type=${encodeURIComponent(ctxIssueType.trim())}${ctxEnvironment.trim() ? `&environment=${encodeURIComponent(ctxEnvironment.trim())}` : ''}`
            : '';

        // Fetch recommendation and analytics in parallel
        const [recRes, analyticsRes] = await Promise.allSettled([
            fetch_(
                `${API_BASE}/v1/recommendations?task=${encodeURIComponent(taskName)}&agent_id=${encodeURIComponent(selectedAgentId)}&strict_agent_scope=1${ctxParams}&t=${Date.now()}`,
                { cache: 'no-store' },
            ),
            fetch_(
                `${API_BASE}/v1/recommendations/task-analytics?task=${encodeURIComponent(taskName)}&agent_id=${encodeURIComponent(selectedAgentId)}&t=${Date.now()}`,
                { cache: 'no-store' },
            ),
        ]);

        if (tok !== recToken.current) return;

        // Recommendation
        if (recRes.status === 'fulfilled' && recRes.value.ok) {
            try {
                const json = await recRes.value.json() as RecommendationResponse;
                if (tok !== recToken.current) return;
                if (json.debug_scope?.requested_agent_id && json.debug_scope.requested_agent_id !== selectedAgentId) {
                    return;
                }
                if (json.debug_scope?.requested_task_name && json.debug_scope.requested_task_name !== taskName) {
                    return;
                }
                setRec(json);
            } catch {
                setRec(null);
                setRecError('Failed to parse recommendation response.');
            }
        } else {
            setRec(null);
            if (recRes.status === 'fulfilled') {
                const body = await recRes.value.json().catch(() => ({})) as Record<string, unknown>;
                setRecError((body['error'] as string) ?? `HTTP ${recRes.value.status}`);
            } else {
                setRecError(recRes.reason?.message ?? 'Network error');
            }
        }

        // Analytics (non-fatal — page still works without it)
        if (analyticsRes.status === 'fulfilled' && analyticsRes.value.ok) {
            try {
                const json = await analyticsRes.value.json() as TaskAnalytics;
                if (tok === recToken.current) setAnalytics(json);
            } catch { /* ignore */ }
        }

        if (tok === recToken.current) {
            setRecLoading(false);
            setAnalyticsLoading(false);
        }
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId, ctxIssueType, ctxEnvironment]);

    useEffect(() => {
        if (!selectedTask) {
            setRec(null);
            setRecError(null);
            setAnalytics(null);
            refreshRef.current = null;
            return;
        }

        setRec(null);
        setRecError(null);
        setAnalytics(null);

        refreshRef.current = () => void fetchData(selectedTask, false);
        void fetchData(selectedTask, true);

        const interval = window.setInterval(() => void fetchData(selectedTask, false), 30_000);
        return () => {
            window.clearInterval(interval);
            refreshRef.current = null;
        };
    }, [selectedTask, fetchData]);

    // Prefer the sidebar count (always agent-scoped from fact_outcomes) over
    // rec.task_total_outcomes which may be derived from a blended scope fallback
    // containing cross-agent totals. Fall back to rec value only when sidebar has 0.
    const sidebarTaskTotal = agentSummary?.tasks.find((t) => t.task_name === selectedTask)?.total ?? 0;
    const taskOutcomes = sidebarTaskTotal > 0 ? sidebarTaskTotal : (rec?.task_total_outcomes ?? 0);

    // ── Auth gate ────────────────────────────────────────────
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
                <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl p-12 text-center space-y-3">
                    <Database size={28} className="mx-auto text-[#3f3f46]" />
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
            {/* ── Top bar ── */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <TrendingUp size={20} className="text-[#b8ff00]" />
                        Recommendations
                    </h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">
                        Which action your agent should take — and why — backed by outcome evidence.
                    </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                    <AgentPicker
                        agents={agents}
                        selectedId={selectedAgentId}
                        loading={agentsLoading}
                        onChange={setSelectedAgentId}
                    />
                    {/* Context filter controls */}
                    <input
                        type="text"
                        placeholder="Issue type (e.g. payment_failed)"
                        value={ctxIssueType}
                        onChange={(e) => setCtxIssueType(e.target.value)}
                        className="bg-[#111118] border border-[#1a1a24] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-[#3f3f46] focus:outline-none focus:border-[#b8ff00]/40 transition-colors w-52"
                    />
                    <div className="relative">
                        <select
                            value={ctxEnvironment}
                            onChange={(e) => setCtxEnvironment(e.target.value)}
                            className="appearance-none bg-[#111118] border border-[#1a1a24] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#b8ff00]/40 cursor-pointer pr-7 transition-colors"
                        >
                            <option value="">All environments</option>
                            <option value="production">Production</option>
                            <option value="staging">Staging</option>
                            <option value="development">Development</option>
                        </select>
                        <ChevronDown size={13} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none" />
                    </div>
                    <button
                        onClick={() => refreshRef.current?.()}
                        disabled={recLoading || !selectedTask}
                        className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-2.5 text-[#a1a1aa] hover:text-white transition-colors disabled:opacity-40"
                    >
                        <RefreshCw size={13} className={recLoading ? 'animate-spin' : ''} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* ── No agents ── */}
            {!agentsLoading && agents.length === 0 && (
                <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl px-4 py-14 text-center space-y-3">
                    <Bot size={28} className="mx-auto text-[#3f3f46]" />
                    <p className="text-sm text-white">No agents found</p>
                    <p className="text-xs text-[#52525b] max-w-sm mx-auto">
                        Install the SDK and log your first outcome to register an agent.
                    </p>
                </div>
            )}

            {selectedAgentId && (
                <div className="grid grid-cols-12 gap-5 items-start">
                    {/* ── Left sidebar ── */}
                    <div className="col-span-12 lg:col-span-4 space-y-4">
                        {summaryLoading || !agentSummary ? (
                            <div className="space-y-3 animate-pulse">
                                <div className="h-44 bg-[#111118] border border-[#1a1a24] rounded-2xl" />
                                <div className="h-64 bg-[#111118] border border-[#1a1a24] rounded-2xl" />
                            </div>
                        ) : (
                            <>
                                <AgentOverviewCard agent={agentSummary} />
                                <TaskList
                                    tasks={agentSummary.tasks}
                                    selectedTask={selectedTask}
                                    onSelect={setSelectedTask}
                                />
                            </>
                        )}
                    </div>

                    {/* ── Right panel ── */}
                    <div className="col-span-12 lg:col-span-8 space-y-4">
                        {!selectedTask && (
                            <div className="bg-[#111118] border border-[#1a1a24] rounded-2xl px-4 py-16 text-center space-y-3">
                                <Database size={24} className="mx-auto text-[#52525b]" />
                                <p className="text-sm text-[#52525b]">Select a task from the left to see its recommendation.</p>
                            </div>
                        )}

                        {selectedTask && (
                            <>
                                {/* Task health header — always show */}
                                <TaskHealthHeader
                                    taskName={selectedTask}
                                    totalOutcomes={taskOutcomes}
                                    rec={rec}
                                    analytics={analyticsLoading ? null : analytics}
                                />

                                {/* Drift alert */}
                                {analytics?.drift?.direction === 'degrading' && (
                                    <DriftAlert analytics={analytics} />
                                )}

                                {/* Error */}
                                {recError && (
                                    <div className="flex items-center gap-2 bg-red-500/8 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
                                        <AlertTriangle size={13} />
                                        {recError}
                                    </div>
                                )}

                                {/* Loading skeleton */}
                                {recLoading && !rec && (
                                    <div className="space-y-4 animate-pulse">
                                        <div className="h-36 bg-[#111118] border border-[#1a1a24] rounded-2xl" />
                                        <div className="h-56 bg-[#111118] border border-[#1a1a24] rounded-2xl" />
                                        <div className="h-44 bg-[#111118] border border-[#1a1a24] rounded-2xl" />
                                    </div>
                                )}

                                {rec && (
                                    <>
                                        {/* Context-aware badge — shown when a context filter is active */}
                                        {rec.context_filter?.issue_type && (
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border"
                                                    style={{ background: `${ACCENT}10`, color: ACCENT, borderColor: `${ACCENT}30` }}>
                                                    <Zap size={10} />
                                                    Context: {rec.context_filter.label ?? rec.context_filter.issue_type}
                                                </span>
                                                {!rec.context_filter.context_id && (
                                                    <span className="text-[10px] text-[#52525b]">
                                                        No context data yet — showing global signal
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        <TrustGateBanner rec={rec} />

                                        <ScopeDebugStrip rec={rec} />

                                        {/* LLM insight */}
                                        <LLMInsightPanel rec={rec} />

                                        {/* Action leaderboard — use engine actions normally;
                                            fall back to analytics aggregates when trust gate blocks the engine */}
                                        <ActionLeaderboard
                                            actions={
                                                (rec.all_actions && rec.all_actions.length > 0)
                                                    ? rec.all_actions
                                                    : (analytics?.action_aggregates ?? [])
                                            }
                                            bestActionName={rec.trust_blocked ? null : rec.insight?.best_action ?? null}
                                            totalOutcomes={taskOutcomes}
                                        />

                                        {/* Engine interventions */}
                                        {analytics && !analyticsLoading && (
                                            <EngineInterventions analytics={analytics} rec={rec} />
                                        )}

                                        {/* Data sources */}
                                        <DataSourcesPanel rec={rec} />

                                        {/* Footer meta */}
                                        <div className="text-[11px] text-[#3f3f46] flex items-center justify-between flex-wrap gap-2 pb-2">
                                            <span>Last outcome: {relTime(rec.data_window?.last_seen_at)}</span>
                                            <span>Scope: {rec.agent_scope === 'agent_scoped' ? 'agent only' : 'blended'}</span>
                                            <span>Generated: {relTime(rec.generated_at)}</span>
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
