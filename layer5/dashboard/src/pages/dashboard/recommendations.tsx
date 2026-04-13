import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    Bot,
    ChevronDown,
    CheckCircle,
    Database,
    RefreshCw,
    Shield,
    TrendingUp,
    Zap,
    XCircle,
    Activity,
    BarChart2,
    Clock,
    Target,
} from 'lucide-react';
import { createAgentFetch } from '../../lib/api';
import { API_BASE } from '../../lib/config';
import { useAgentApiKey } from '../../hooks/useAgentApiKey';
import { supabase } from '../../supabaseClient';

// ── Types ─────────────────────────────────────────────────────────

interface AgentSummary {
    agent_id: string;
    agent_name: string;
    agent_type: string | null;
    llm_model: string | null;
    trust_score: number | null;
    trust_status: string | null;
    total_outcomes: number;
    tasks: TaskSummary[];
}

interface TaskSummary {
    task_name: string;
    total: number;
}

type ConfidenceLabel = 'none' | 'low' | 'medium' | 'high' | 'very_high';

interface ActionPerformance {
    action_id: string;
    action_name: string;
    total_count: number;
    effective_sample_count: number;
    success_count: number;
    success_rate: number;
    resolution_rate: number;
    semantic_cluster_convergence: number;
    ml_score: number | null;
    last_seen_at: string | null;
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
    confidence_meta: {
        value: number;
        percent: number;
        label: ConfidenceLabel;
    };
    message: string;
    reason: {
        summary: string;
        evidence: string;
        confidence_note: string;
    };
    expected_improvement: {
        baseline: string;
        improved: string;
        delta: string;
        delta_raw: number;
        based_on_samples: number;
        caution: string | null;
    } | null;
    sample_size: { best: number; worst: number; min: number } | null;
    action_uncertainty: {
        best: { action: string; rate_pct: string; margin_pct: string };
        worst: { action: string; rate_pct: string; margin_pct: string };
    } | null;
    data_window: {
        first_seen_at: string | null;
        last_seen_at: string | null;
        last_updated_label: string;
    } | null;
    agent_id: string | null;
    agent_scope: 'agent_scoped' | 'customer_blended';
    customer_id: string;
    generated_at: string;
    unlock_hint: string | null;
    threshold_hint: string;
    scope_label: string;
    scope_transition?: {
        fallback_applied: boolean;
        reason: string | null;
        switch_back_rule: string | null;
    };
    data_freshness?: {
        is_stale: boolean;
        age_hours: number | null;
        stale_threshold_hours: number;
        last_seen_at: string | null;
        source: string;
    };
    cohort_reliability?: {
        anomaly_score: number;
        reliability_score: number;
        band: 'stable' | 'watch' | 'anomalous';
        reasons: string[];
    };
    action_registry?: {
        registered_actions: string[];
        action_mismatch: boolean;
        warning: string | null;
    };
    data_sources?: {
        uploaded_outcomes: number;
        sdk_outcomes: number;
        total: number;
        upload_share: number;
        quality_score: number | null;
    } | null;
    llm_narrative?: {
        headline: string | null;
        generated: boolean;
    };
    all_actions?: ActionPerformance[];
    // Authoritative total for this task from the recommendation engine (deduplicated by action_name)
    task_total_outcomes?: number;
    improvement_display?: {
        raw_delta_pct: string;
        qualified_delta_pct: string;
        is_estimate: boolean;
        samples_basis: number;
    } | null;
    monitor_steps?: string[] | null;
    risk_context?: string | null;
    problem?: string | null;
    validation_hint?: string | null;
}

// ── Constants ─────────────────────────────────────────────────────
const MIN_OUTCOMES_FOR_RECOMMENDATION = 30;
const ACCENT = '#b8ff00';

// ── Deterministic task colour ─────────────────────────────────────
const TASK_COLOURS = [
    { bg: 'bg-[#b8ff00]/10', text: 'text-[#b8ff00]', border: 'border-[#b8ff00]/25' },
    { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/25' },
    { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/25' },
    { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/25' },
    { bg: 'bg-pink-500/10', text: 'text-pink-400', border: 'border-pink-500/25' },
    { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/25' },
];

function taskColour(task: string) {
    let hash = 0;
    for (let i = 0; i < task.length; i++) hash = (hash * 31 + task.charCodeAt(i)) | 0;
    return TASK_COLOURS[Math.abs(hash) % TASK_COLOURS.length]!;
}

function taskInitial(task: string): string {
    return task.replace(/_/g, ' ').trim().slice(0, 2).toUpperCase();
}

// ── Confidence config ─────────────────────────────────────────────
const CONF_CONFIG: Record<ConfidenceLabel, { label: string; text: string; bar: string; chip: string }> = {
    very_high: { label: 'Very High', text: 'text-[#b8ff00]', bar: '#b8ff00', chip: 'bg-[#b8ff00]/15 text-[#b8ff00] border-[#b8ff00]/40' },
    high:      { label: 'High',      text: 'text-[#b8ff00]', bar: '#b8ff00', chip: 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30' },
    medium:    { label: 'Medium',    text: 'text-yellow-400', bar: '#facc15', chip: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30' },
    low:       { label: 'Low',       text: 'text-red-400',    bar: '#f87171', chip: 'bg-red-500/10 text-red-400 border-red-500/30' },
    none:      { label: 'No Signal', text: 'text-[#a1a1aa]',  bar: '#3f3f46', chip: 'bg-[#1a1a24] text-[#a1a1aa] border-[#1a1a24]' },
};

// ── SDK Mode config ───────────────────────────────────────────────
const MODE_CONFIG: Record<string, { label: string; desc: string; colour: string; bg: string; border: string }> = {
    recommend: {
        label: 'Recommend',
        desc: 'Observe and log — LI learns from every outcome.',
        colour: 'text-blue-400',
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/25',
    },
    assist: {
        label: 'Assist',
        desc: 'LI suggests the best action — human confirms before executing.',
        colour: 'text-yellow-400',
        bg: 'bg-yellow-500/10',
        border: 'border-yellow-500/25',
    },
    auto: {
        label: 'Auto',
        desc: 'LI executes the best action automatically at ≥70% confidence.',
        colour: 'text-[#b8ff00]',
        bg: 'bg-[#b8ff00]/10',
        border: 'border-[#b8ff00]/25',
    },
};

// ── Helpers ───────────────────────────────────────────────────────
function pct(n: number | null, decimals = 1): string {
    if (n === null || !Number.isFinite(n)) return '—';
    return `${(n * 100).toFixed(decimals)}%`;
}

function relativeTime(iso: string | null): string {
    if (!iso) return '—';
    const diffMs = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diffMs / 3_600_000);
    if (h < 1) return 'just now';
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return `${Math.floor(d / 30)}mo ago`;
}

// ── Small components ──────────────────────────────────────────────

function StatChip({ label, value, sub, accent }: {
    label: string; value: string | number; sub?: string; accent?: boolean;
}): React.ReactElement {
    return (
        <div className="bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-4 py-3 min-w-[110px]">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b] mb-1">{label}</p>
            <p className={`text-xl font-bold font-mono ${accent ? 'text-[#b8ff00]' : 'text-white'}`}>{value}</p>
            {sub && <p className="text-[10px] text-[#52525b] mt-0.5">{sub}</p>}
        </div>
    );
}

function TrustBadge({ status, score }: { status: string | null; score: number | null }): React.ReactElement {
    const cls = status === 'trusted'
        ? 'bg-[#b8ff00]/10 text-[#b8ff00] border-[#b8ff00]/30'
        : status === 'probation'
        ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
        : status === 'suspended'
        ? 'bg-red-500/10 text-red-400 border-red-500/30'
        : 'bg-[#1a1a24] text-[#a1a1aa] border-[#1a1a24]';

    return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${cls}`}>
            <Shield size={10} />
            {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
            {score !== null && <span className="opacity-60">· {Math.round(score * 100)}%</span>}
        </span>
    );
}

function StateBadge({ state }: { state: string }): React.ReactElement {
    if (state === 'stable') return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#b8ff00]/10 text-[#b8ff00] border border-[#b8ff00]/30">
            <CheckCircle size={10} /> Stable
        </span>
    );
    if (state === 'early_signal') return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/30">
            <Zap size={10} /> Early Signal
        </span>
    );
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#1a1a24] text-[#a1a1aa] border border-[#1a1a24]">
            <XCircle size={10} /> No Data
        </span>
    );
}

function ConfidenceBar({ pct: percent, label }: { pct: number; label: ConfidenceLabel }): React.ReactElement {
    const cfg = CONF_CONFIG[label];
    return (
        <div className="flex items-center gap-2.5">
            <div className="flex-1 bg-[#1a1a24] rounded-full h-1.5 overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${percent}%`, backgroundColor: cfg.bar }}
                />
            </div>
            <span className={`text-xs font-mono font-semibold tabular-nums ${cfg.text}`}>{percent}%</span>
        </div>
    );
}

function SufficiencyMeter({ total }: { total: number }): React.ReactElement {
    const pctFill = Math.min(100, Math.round((total / MIN_OUTCOMES_FOR_RECOMMENDATION) * 100));
    const ready = total >= MIN_OUTCOMES_FOR_RECOMMENDATION;
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 bg-[#1a1a24] rounded-full h-1 overflow-hidden">
                <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                        width: `${pctFill}%`,
                        backgroundColor: ready ? ACCENT : '#facc15',
                    }}
                />
            </div>
            {ready ? (
                <span className="text-[10px] text-[#b8ff00] font-medium whitespace-nowrap">ready</span>
            ) : (
                <span className="text-[10px] text-[#52525b] whitespace-nowrap">
                    {MIN_OUTCOMES_FOR_RECOMMENDATION - total} to go
                </span>
            )}
        </div>
    );
}

// ── Agent Overview ────────────────────────────────────────────────

function AgentOverview({ agent, sdkMode }: { agent: AgentSummary; sdkMode: string }): React.ReactElement {
    const modeCfg = MODE_CONFIG[sdkMode] ?? MODE_CONFIG['recommend']!;

    return (
        <div className="space-y-4">
            {/* Agent header */}
            <div className="flex items-start justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#1a1a24] border border-[#252530] flex items-center justify-center shrink-0">
                        <Bot size={18} className="text-[#a1a1aa]" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-white">{agent.agent_name}</h2>
                        <p className="text-xs text-[#52525b] font-mono">{agent.agent_id.slice(-12)}</p>
                    </div>
                </div>
                <TrustBadge status={agent.trust_status} score={agent.trust_score} />
            </div>

            {/* Mode — current only, no progression widget */}
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${modeCfg.bg} ${modeCfg.border}`}>
                <Activity size={14} className={`${modeCfg.colour} mt-0.5 shrink-0`} />
                <div>
                    <p className={`text-xs font-semibold ${modeCfg.colour}`}>{modeCfg.label} mode</p>
                    <p className="text-[11px] text-[#a1a1aa] mt-0.5">{modeCfg.desc}</p>
                </div>
            </div>

            {/* Stats row — total outcomes + task count only */}
            <div className="grid grid-cols-2 gap-2">
                <StatChip
                    label="Total Outcomes"
                    value={agent.total_outcomes.toLocaleString()}
                    sub="all tasks combined"
                    accent
                />
                <StatChip
                    label="Tasks"
                    value={agent.tasks.length}
                    sub="with logged outcomes"
                />
            </div>
            {agent.llm_model && (
                <p className="text-[10px] text-[#52525b] font-mono px-1">model: {agent.llm_model}</p>
            )}
        </div>
    );
}

// ── Task List Item ─────────────────────────────────────────────────

function TaskListItem({
    task,
    active,
    onClick,
}: {
    task: TaskSummary;
    active: boolean;
    onClick: () => void;
}): React.ReactElement {
    const col = taskColour(task.task_name);
    const ready = task.total >= MIN_OUTCOMES_FOR_RECOMMENDATION;

    return (
        <button
            onClick={onClick}
            className={`w-full text-left px-3 py-3 rounded-xl border transition-all duration-150 ${
                active
                    ? 'bg-[#111118] border-[#b8ff00]/30 shadow-[0_0_0_1px_rgba(184,255,0,0.08)]'
                    : 'bg-[#0a0a0f] border-[#1a1a24] hover:bg-[#0f0f18] hover:border-[#252530]'
            }`}
        >
            <div className="flex items-start gap-2.5">
                {/* Icon */}
                <div className={`w-7 h-7 rounded-lg ${col.bg} border ${col.border} flex items-center justify-center shrink-0 mt-0.5`}>
                    <span className={`text-[9px] font-bold ${col.text}`}>{taskInitial(task.task_name)}</span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-white truncate leading-tight">{task.task_name}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-[10px] text-[#52525b]">{task.total.toLocaleString()} outcomes</span>
                        {!ready && (
                            <span className="text-[10px] text-yellow-500/80">·</span>
                        )}
                    </div>
                    <div className="mt-1.5">
                        <SufficiencyMeter total={task.total} />
                    </div>
                </div>

                {/* State chip */}
                {ready && active && (
                    <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-[#b8ff00] mt-1" />
                )}
            </div>
        </button>
    );
}

// ── Action Battle Card ─────────────────────────────────────────────

function ActionBattleCard({ data }: { data: RecommendationResponse }): React.ReactElement | null {
    if (!data.insight.best_action && !data.insight.worst_action) return null;
    if (data.state === 'no_data') return null;

    const allActions = data.all_actions ?? [];

    return (
        <div className="space-y-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Action Battle</p>
            <div className="grid grid-cols-2 gap-2">
                {/* Best */}
                <div className="bg-[#b8ff00]/5 border border-[#b8ff00]/20 rounded-xl p-3.5">
                    <div className="flex items-center gap-1.5 mb-2">
                        <Target size={10} className="text-[#b8ff00]" />
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[#b8ff00]/70">Best</span>
                    </div>
                    <p className="text-sm font-semibold text-white font-mono leading-tight break-all">
                        {data.insight.best_action ?? '—'}
                    </p>
                    <div className="flex items-baseline gap-1.5 mt-2">
                        <span className="text-xl font-bold text-[#b8ff00]">
                            {pct(data.insight.best_rate)}
                        </span>
                        <span className="text-[10px] text-[#a1a1aa]">success</span>
                    </div>
                    {data.action_uncertainty?.best && (
                        <p className="text-[10px] text-[#52525b] mt-0.5">
                            {data.action_uncertainty.best.margin_pct} margin
                        </p>
                    )}
                    {data.insight.sample_size && (
                        <p className="text-[10px] text-[#52525b] mt-1">
                            {data.insight.sample_size.best} samples
                        </p>
                    )}
                </div>

                {/* Worst */}
                <div className="bg-[#1a1a24]/60 border border-[#252530] rounded-xl p-3.5">
                    <div className="flex items-center gap-1.5 mb-2">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Baseline</span>
                    </div>
                    <p className="text-sm font-semibold text-[#a1a1aa] font-mono leading-tight break-all">
                        {data.insight.worst_action ?? '—'}
                    </p>
                    <div className="flex items-baseline gap-1.5 mt-2">
                        <span className="text-xl font-bold text-[#a1a1aa]">
                            {pct(data.insight.worst_rate)}
                        </span>
                        <span className="text-[10px] text-[#52525b]">success</span>
                    </div>
                    {data.action_uncertainty?.worst && (
                        <p className="text-[10px] text-[#52525b] mt-0.5">
                            {data.action_uncertainty.worst.margin_pct} margin
                        </p>
                    )}
                    {data.insight.sample_size && (
                        <p className="text-[10px] text-[#52525b] mt-1">
                            {data.insight.sample_size.worst} samples
                        </p>
                    )}
                </div>
            </div>

            {/* Delta bar */}
            {data.insight.delta !== null && data.insight.delta > 0 && (
                <div className="flex items-center gap-3 bg-[#0d0d14] border border-[#1a1a24] rounded-xl px-4 py-2.5">
                    <TrendingUp size={13} className="text-[#b8ff00] shrink-0" />
                    <span className="text-xs text-[#a1a1aa]">Performance gap</span>
                    <span className="text-sm font-bold text-[#b8ff00] ml-auto font-mono">
                        +{(data.insight.delta * 100).toFixed(1)}%
                    </span>
                </div>
            )}

            {/* All actions table when we have the data */}
            {allActions.length > 2 && (
                <div className="bg-[#0a0a0f] border border-[#1a1a24] rounded-xl overflow-hidden mt-1">
                    <div className="px-3 py-2 border-b border-[#1a1a24]">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">
                            All Actions ({allActions.length})
                        </p>
                    </div>
                    <div className="divide-y divide-[#1a1a24]">
                        {allActions
                            .slice()
                            .sort((a, b) => (b.resolution_rate ?? 0) - (a.resolution_rate ?? 0))
                            .slice(0, 6)
                            .map((action) => (
                                <div key={action.action_name} className="flex items-center px-3 py-2 gap-3">
                                    <p className="flex-1 text-xs font-mono text-[#a1a1aa] truncate">
                                        {action.action_name}
                                    </p>
                                    <span className="text-xs font-mono font-semibold text-white tabular-nums">
                                        {pct(action.resolution_rate)}
                                    </span>
                                    <span className="text-[10px] text-[#52525b] tabular-nums w-14 text-right">
                                        {action.total_count} outcomes
                                    </span>
                                </div>
                            ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Evidence Meter ─────────────────────────────────────────────────

function EvidenceMeter({ data, taskTotal }: { data: RecommendationResponse; taskTotal: number }): React.ReactElement {
    // taskTotal = raw fact_outcomes count (authoritative total for this task)
    // minPerAction = engine's min sample count across actions (threshold gate)
    const minPerAction = data.progress?.current_samples ?? 0;
    // Use taskTotal for the bar fill — it's the real number of logged outcomes
    const samples = taskTotal > 0 ? taskTotal : minPerAction;
    const milestones = [
        { at: 10, label: 'Warmup' },
        { at: 30, label: 'Unlock' },
        { at: 50, label: 'Stable' },
        { at: 100, label: 'High conf.' },
    ];
    const maxMilestone = 100;
    const fillPct = Math.min(100, (samples / maxMilestone) * 100);
    const barColour = samples >= 50 ? ACCENT : samples >= 30 ? '#facc15' : '#3f3f46';

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Evidence</p>
                <span className="text-xs font-mono font-semibold text-white tabular-nums">{samples.toLocaleString()} outcomes</span>
            </div>

            {/* Track */}
            <div className="relative h-2 bg-[#1a1a24] rounded-full overflow-visible">
                <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
                    style={{ width: `${fillPct}%`, backgroundColor: barColour }}
                />
                {milestones.map((m) => {
                    const pos = (m.at / maxMilestone) * 100;
                    const reached = samples >= m.at;
                    return (
                        <div
                            key={m.at}
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full border-2 border-[#0a0a0f] transition-colors duration-500"
                            style={{ left: `${pos}%`, backgroundColor: reached ? barColour : '#3f3f46' }}
                            title={`${m.label}: ${m.at} outcomes`}
                        />
                    );
                })}
            </div>

            {/* Milestone labels */}
            <div className="flex justify-between text-[10px] text-[#52525b]">
                {milestones.map((m) => (
                    <div key={m.at} className="flex flex-col items-center gap-0.5">
                        <span className={samples >= m.at ? 'text-[#a1a1aa]' : ''}>{m.label}</span>
                        <span className="text-[9px] opacity-60">{m.at}</span>
                    </div>
                ))}
            </div>

            {/* Min-per-action note — only shown when it differs from total (helps devs understand the threshold gate) */}
            {minPerAction > 0 && minPerAction < samples && (
                <p className="text-[10px] text-[#52525b]">
                    Threshold gate: <span className="text-[#a1a1aa] font-mono">{minPerAction}</span> outcomes on weakest action
                    {minPerAction < 30 && <span className="text-yellow-500/70"> · needs {30 - minPerAction} more to unlock</span>}
                </p>
            )}

            {data.unlock_hint && (
                <p className="text-[10px] text-[#52525b] bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2">
                    {data.unlock_hint}
                </p>
            )}
        </div>
    );
}

// ── Signal Integrity (collapsed) ──────────────────────────────────

function SignalIntegrity({ data }: { data: RecommendationResponse }): React.ReactElement {
    const [open, setOpen] = useState(false);
    const band = data.cohort_reliability?.band ?? null;
    const bandColour = band === 'anomalous' ? 'text-red-400' : band === 'watch' ? 'text-yellow-400' : 'text-[#b8ff00]';

    return (
        <div className="bg-[#0a0a0f] border border-[#1a1a24] rounded-xl overflow-hidden">
            <button
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#0d0d14] transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Activity size={12} className={bandColour} />
                    <span className="text-xs font-medium text-[#a1a1aa]">Signal Integrity</span>
                    {band && band !== 'stable' && (
                        <span className={`text-[10px] font-medium uppercase ${bandColour}`}>{band}</span>
                    )}
                </div>
                <ChevronDown size={12} className={`text-[#52525b] transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>

            {open && (
                <div className="px-4 pb-4 space-y-3 border-t border-[#1a1a24]">
                    {data.cohort_reliability && (
                        <div className="space-y-2 pt-3">
                            <div className="flex justify-between text-xs">
                                <span className="text-[#52525b]">Reliability score</span>
                                <span className="text-white font-mono">
                                    {Math.round(data.cohort_reliability.reliability_score * 100)}%
                                </span>
                            </div>
                            <div className="flex justify-between text-xs">
                                <span className="text-[#52525b]">Anomaly score</span>
                                <span className="text-white font-mono">
                                    {Math.round(data.cohort_reliability.anomaly_score * 100)}%
                                </span>
                            </div>
                            {data.cohort_reliability.reasons.length > 0 && (
                                <ul className="space-y-1 pt-1">
                                    {data.cohort_reliability.reasons.map((r, i) => (
                                        <li key={i} className="text-[10px] text-[#52525b] flex gap-1.5">
                                            <span className="text-[#3f3f46]">·</span>
                                            {r}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {data.action_registry?.action_mismatch && (
                        <div className="flex items-start gap-2 bg-orange-500/8 border border-orange-500/20 rounded-lg px-3 py-2">
                            <AlertTriangle size={11} className="text-orange-400 mt-0.5 shrink-0" />
                            <p className="text-[10px] text-orange-300/80">{data.action_registry.warning}</p>
                        </div>
                    )}

                    {data.data_freshness?.is_stale && (
                        <div className="flex items-start gap-2 bg-yellow-500/8 border border-yellow-500/20 rounded-lg px-3 py-2">
                            <Clock size={11} className="text-yellow-400 mt-0.5 shrink-0" />
                            <p className="text-[10px] text-yellow-300/80">
                                Data is {data.data_freshness.age_hours?.toFixed(1)}h old
                                (threshold: {data.data_freshness.stale_threshold_hours}h)
                            </p>
                        </div>
                    )}

                    {data.scope_transition?.fallback_applied && (
                        <div className="bg-blue-500/8 border border-blue-500/20 rounded-lg px-3 py-2">
                            <p className="text-[10px] text-blue-300/80">
                                Scope fallback active: {data.scope_transition.reason}
                            </p>
                        </div>
                    )}

                    <div className="text-[10px] text-[#52525b]">
                        Confidence source: <span className="font-mono text-[#3f3f46]">{(data as any).confidence_source ?? '—'}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Task Detail Panel ─────────────────────────────────────────────

function TaskDetail({
    taskName,
    taskTotal,
    loading,
    data,
    error,
}: {
    taskName: string;
    taskTotal: number;
    loading: boolean;
    data: RecommendationResponse | null;
    error: string | null;
}): React.ReactElement {
    const col = taskColour(taskName);
    // Use task_total_outcomes from rec engine (deduplicated, same window used for recommendations)
    // when available. Fall back to taskTotal from /agent-summary (raw fact_outcomes count).
    const displayTotal = data?.task_total_outcomes ?? taskTotal;
    const ready = taskTotal >= MIN_OUTCOMES_FOR_RECOMMENDATION;

    if (loading) {
        return (
            <div className="space-y-4 animate-pulse">
                <div className="h-14 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                <div className="h-24 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                <div className="h-32 bg-[#111118] border border-[#1a1a24] rounded-xl" />
                <div className="h-24 bg-[#111118] border border-[#1a1a24] rounded-xl" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Task header */}
            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl ${col.bg} border ${col.border} flex items-center justify-center shrink-0`}>
                            <span className={`text-[10px] font-bold ${col.text}`}>{taskInitial(taskName)}</span>
                        </div>
                        <div>
                            <p className="text-sm font-semibold font-mono text-white">{taskName}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <span className="text-[11px] text-[#52525b]">
                                    {displayTotal.toLocaleString()} outcomes
                                </span>
                                {data && <StateBadge state={data.state} />}
                                {data && (
                                    <span className={`text-[11px] font-medium border px-2 py-0.5 rounded-full ${CONF_CONFIG[data.confidence_meta?.label ?? 'none'].chip}`}>
                                        {data.confidence_meta?.percent ?? 0}% confidence
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    {data?.data_window?.last_seen_at && (
                        <div className="text-right shrink-0">
                            <p className="text-[10px] text-[#52525b]">Last outcome</p>
                            <p className="text-xs text-[#a1a1aa]">{relativeTime(data.data_window.last_seen_at)}</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Not enough data gate */}
            {!ready && (
                <div className="bg-[#111118] border border-yellow-500/20 rounded-xl px-4 py-4 space-y-2">
                    <div className="flex items-center gap-2">
                        <Database size={13} className="text-yellow-400" />
                        <p className="text-xs font-medium text-yellow-400">Building evidence</p>
                    </div>
                    <p className="text-xs text-[#a1a1aa]">
                        {MIN_OUTCOMES_FOR_RECOMMENDATION - taskTotal} more outcomes needed before recommendations unlock for this task.
                        Every SDK call with <span className="font-mono text-white">log_outcome()</span> counts.
                    </p>
                    <SufficiencyMeter total={taskTotal} />
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-500/8 border border-red-500/25 rounded-xl px-4 py-3 flex items-center gap-2 text-xs text-red-400">
                    <AlertTriangle size={13} />
                    {error}
                </div>
            )}

            {data && (
                <>
                    {/* LLM headline */}
                    {data.llm_narrative?.headline && (
                        <div className="bg-[#b8ff00]/5 border border-[#b8ff00]/20 rounded-xl px-4 py-3.5 flex items-start gap-3">
                            <Zap size={14} className="text-[#b8ff00] mt-0.5 shrink-0" />
                            <div>
                                <p className="text-[10px] font-medium uppercase tracking-wider text-[#b8ff00]/50 mb-1">AI Analysis</p>
                                <p className="text-sm font-medium text-white leading-snug">{data.llm_narrative.headline}</p>
                            </div>
                        </div>
                    )}

                    {/* Decision + LLM summary */}
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4 space-y-3">
                        {data.message && (
                            <div className="flex items-start gap-2">
                                <ArrowRight size={13} className={
                                    data.decision.type === 'replace' ? 'text-[#b8ff00] mt-0.5 shrink-0' :
                                    data.decision.type === 'monitor' ? 'text-yellow-400 mt-0.5 shrink-0' :
                                    'text-[#52525b] mt-0.5 shrink-0'
                                } />
                                <p className={`text-sm font-semibold ${
                                    data.decision.type === 'replace' ? 'text-[#b8ff00]' :
                                    data.decision.type === 'monitor' ? 'text-yellow-400' :
                                    'text-[#a1a1aa]'
                                }`}>{data.message}</p>
                            </div>
                        )}

                        {/* LLM summary block */}
                        {(data.reason.summary || data.reason.evidence) && (
                            <div className="border-l-2 border-[#252530] pl-3 space-y-1">
                                {data.reason.summary && (
                                    <p className="text-xs text-white leading-relaxed">{data.reason.summary}</p>
                                )}
                                {data.reason.evidence && (
                                    <p className="text-xs text-[#a1a1aa] leading-relaxed">{data.reason.evidence}</p>
                                )}
                                {data.reason.confidence_note && (
                                    <p className="text-[11px] text-[#52525b] italic leading-relaxed">{data.reason.confidence_note}</p>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Action Battle */}
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4">
                        <ActionBattleCard data={data} />
                        {!data.insight.best_action && (
                            <p className="text-xs text-[#52525b]">No action comparison available yet.</p>
                        )}
                    </div>

                    {/* Evidence Meter */}
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4">
                        <EvidenceMeter data={data} taskTotal={displayTotal} />
                    </div>

                    {/* Confidence detail */}
                    {data.confidence_meta && (
                        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4 space-y-2.5">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Confidence</p>
                            <ConfidenceBar pct={data.confidence_meta.percent} label={data.confidence_meta.label} />
                            {data.threshold_hint && (
                                <p className="text-[10px] text-[#52525b]">{data.threshold_hint}</p>
                            )}
                            {data.improvement_display && (
                                <div className="flex items-center gap-3 pt-1">
                                    <span className="text-xs text-[#52525b]">Potential improvement</span>
                                    <span className="text-sm font-bold text-[#b8ff00] font-mono ml-auto">
                                        {data.improvement_display.raw_delta_pct}
                                    </span>
                                    {data.improvement_display.is_estimate && (
                                        <span className="text-[10px] text-yellow-400">est.</span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Signal Integrity (collapsed) */}
                    <SignalIntegrity data={data} />
                </>
            )}

            {/* No data state when ready threshold met but no API data yet */}
            {ready && !data && !error && !loading && (
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-8 text-center space-y-2">
                    <BarChart2 size={24} className="mx-auto text-[#52525b]" />
                    <p className="text-xs text-[#52525b]">Loading recommendation…</p>
                </div>
            )}
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function RecommendationsPage(): React.ReactElement {
    const { apiKey, isValid, error: keyError, handleAuthFailure } = useAgentApiKey();

    // Agent list + selection
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
    const [agentsLoading, setAgentsLoading] = useState(false);
    const [summaryLoading, setSummaryLoading] = useState(false);

    // Task selection
    const [selectedTask, setSelectedTask] = useState<string | null>(null);

    // Recommendation fetch
    const [recData, setRecData] = useState<RecommendationResponse | null>(null);
    const [recLoading, setRecLoading] = useState(false);
    const [recError, setRecError] = useState<string | null>(null);

    // SDK mode — derive from agent name/type heuristic or trust status
    // In a real system this would come from an API field; for now we derive
    // a sensible default from trust status.
    const sdkMode = agentSummary?.trust_status === 'suspended' ? 'recommend'
        : (agentSummary?.total_outcomes ?? 0) >= 100 ? 'auto'
        : (agentSummary?.total_outcomes ?? 0) >= 50 ? 'assist'
        : 'recommend';

    const fetchRef = useRef<(() => void) | null>(null);
    const latestRecToken = useRef(0);

    // ── Load agents list ──────────────────────────────────────────
    useEffect(() => {
        if (!isValid || !apiKey || !API_BASE) return;
        setAgentsLoading(true);
        const controller = new AbortController();

        void (async () => {
            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const res = await agentFetch(`${API_BASE}/v1/recommendations/agent-summary`, { signal: controller.signal });
                if (res.ok) {
                    const json = await res.json() as { agents: AgentSummary[] };
                    const list = json.agents ?? [];
                    setAgents(list);
                    // Auto-select first agent if none selected
                    setSelectedAgentId((cur) => {
                        if (cur && list.some((a) => a.agent_id === cur)) return cur;
                        return list[0]?.agent_id ?? null;
                    });
                    return; // success — skip supabase fallback
                }
                console.warn('[recommendations] agent-summary list returned', res.status);
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
                console.warn('[recommendations] agent-summary list fetch failed:', e.message);
            } finally {
                // Always clear loading — whether success or falling through to supabase
                setAgentsLoading(false);
            }

            // Fallback: load agent names directly from supabase (no auth key needed)
            try {
                const { data } = await supabase
                    .from('dim_agents')
                    .select('agent_id, agent_name, agent_type, llm_model')
                    .order('agent_name');
                const fallback: AgentSummary[] = (data ?? []).map((a) => ({
                    agent_id: a.agent_id,
                    agent_name: a.agent_name,
                    agent_type: a.agent_type ?? null,
                    llm_model: a.llm_model ?? null,
                    trust_score: null,
                    trust_status: null,
                    total_outcomes: 0,
                    tasks: [],
                }));
                setAgents(fallback);
                setSelectedAgentId((cur) => {
                    if (cur && fallback.some((a) => a.agent_id === cur)) return cur;
                    return fallback[0]?.agent_id ?? null;
                });
            } catch (e: any) {
                console.warn('[recommendations] supabase fallback failed:', e.message);
            }
        })();

        return () => controller.abort();
    }, [isValid, apiKey, handleAuthFailure]);

    // ── Load per-agent summary when agent changes ─────────────────
    useEffect(() => {
        // Always reset stale data immediately when agent changes
        setAgentSummary(null);
        setSelectedTask(null);
        setRecData(null);
        setRecError(null);

        if (!isValid || !apiKey || !API_BASE || !selectedAgentId) {
            setSummaryLoading(false);
            return;
        }
        setSummaryLoading(true);
        const controller = new AbortController();

        void (async () => {
            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const res = await agentFetch(
                    `${API_BASE}/v1/recommendations/agent-summary?agent_id=${encodeURIComponent(selectedAgentId)}`,
                    { signal: controller.signal },
                );
                if (res.ok) {
                    const json = await res.json() as AgentSummary;
                    setAgentSummary(json);
                    // Auto-select first task after loading
                    if (json.tasks.length > 0) {
                        setSelectedTask(json.tasks[0]!.task_name);
                    }
                } else {
                    console.warn('[recommendations] agent-summary returned', res.status);
                }
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
                console.warn('[recommendations] agent-summary fetch failed:', e.message);
            } finally {
                setSummaryLoading(false);
            }
        })();

        return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isValid, apiKey, handleAuthFailure, selectedAgentId]);

    // ── Fetch recommendation for selected task ────────────────────
    const fetchRec = useCallback(
        async (task: string, showLoading = true) => {
            if (!isValid || !apiKey || !API_BASE || !selectedAgentId) return;
            const token = ++latestRecToken.current;
            if (showLoading) setRecLoading(true);
            setRecError(null);

            try {
                const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
                const res = await agentFetch(
                    `${API_BASE}/v1/recommendations?task=${encodeURIComponent(task)}&agent_id=${encodeURIComponent(selectedAgentId)}`,
                );
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
                }
                const json = await res.json() as RecommendationResponse;
                if (token !== latestRecToken.current) return;
                setRecData(json);
            } catch (err: any) {
                if (token !== latestRecToken.current) return;
                setRecError(err.message ?? 'Failed to load recommendation.');
                setRecData(null);
            } finally {
                if (token === latestRecToken.current) setRecLoading(false);
            }
        },
        [isValid, apiKey, handleAuthFailure, selectedAgentId],
    );

    useEffect(() => {
        if (!selectedTask || !selectedAgentId) {
            setRecData(null);
            setRecError(null);
            fetchRef.current = null;
            return;
        }
        setRecData(null);
        setRecError(null);
        fetchRef.current = () => void fetchRec(selectedTask, false);
        void fetchRec(selectedTask, true);

        const interval = window.setInterval(() => void fetchRec(selectedTask, false), 30_000);
        return () => {
            window.clearInterval(interval);
            fetchRef.current = null;
        };
    }, [selectedTask, selectedAgentId, fetchRec]);

    // ── Not valid ─────────────────────────────────────────────────
    if (!isValid) {
        return (
            <div className="space-y-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Recommendations</h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">AI-powered decision recommendations for your agent actions</p>
                </div>
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-10 text-center space-y-3">
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

    const selectedTaskSummary = agentSummary?.tasks.find((t) => t.task_name === selectedTask) ?? null;

    return (
        <div className="space-y-6">
            {/* ── Page header ── */}
            <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        <TrendingUp size={20} className="text-[#b8ff00]" />
                        Recommendations
                    </h1>
                    <p className="text-[#a1a1aa] text-sm mt-1">AI-powered decision recommendations for your agent actions</p>
                </div>
                <button
                    className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5 text-[#a1a1aa] hover:text-white transition-colors"
                    onClick={() => fetchRef.current?.()}
                    disabled={recLoading}
                >
                    <RefreshCw size={13} className={recLoading ? 'animate-spin' : ''} />
                    Refresh
                </button>
            </div>

            {/* ── Agent dropdown ── */}
            <div className="max-w-sm">
                <label className="block text-[10px] font-medium uppercase tracking-wider text-[#52525b] mb-2">
                    Agent
                </label>
                {agentsLoading ? (
                    <div className="h-10 bg-[#111118] border border-[#1a1a24] rounded-xl animate-pulse" />
                ) : agents.length === 0 ? (
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-2.5 text-xs text-[#52525b]">
                        No agents found
                    </div>
                ) : (
                    <div className="relative">
                        <select
                            value={selectedAgentId ?? ''}
                            onChange={(e) => setSelectedAgentId(e.target.value || null)}
                            className="w-full appearance-none bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#b8ff00]/40 cursor-pointer pr-9 transition-colors"
                        >
                            {agents.map((a) => (
                                <option key={a.agent_id} value={a.agent_id}>
                                    {a.agent_name}
                                    {a.total_outcomes > 0 ? ` · ${a.total_outcomes.toLocaleString()} outcomes` : ''}
                                </option>
                            ))}
                        </select>
                        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#52525b] pointer-events-none" />
                    </div>
                )}
            </div>

            {/* ── Two-pane layout ── */}
            {selectedAgentId && (
                <div className="grid grid-cols-12 gap-5 items-start">

                    {/* ── Left pane: agent overview + task list ── */}
                    <div className="col-span-12 lg:col-span-4 space-y-4">

                        {/* Agent overview card */}
                        <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-4">
                            {summaryLoading || !agentSummary ? (
                                <div className="space-y-3 animate-pulse">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-[#1a1a24]" />
                                        <div className="space-y-1.5">
                                            <div className="h-4 w-28 bg-[#1a1a24] rounded" />
                                            <div className="h-3 w-20 bg-[#1a1a24] rounded" />
                                        </div>
                                    </div>
                                    <div className="h-12 bg-[#1a1a24] rounded-xl" />
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="h-16 bg-[#1a1a24] rounded-xl" />
                                        <div className="h-16 bg-[#1a1a24] rounded-xl" />
                                    </div>
                                </div>
                            ) : (
                                <AgentOverview agent={agentSummary} sdkMode={sdkMode} />
                            )}
                        </div>

                        {/* Task list */}
                        <div>
                            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b] mb-2 px-1">
                                Tasks
                                {agentSummary && (
                                    <span className="ml-1.5 text-[#3f3f46] normal-case font-normal">
                                        ({agentSummary.tasks.length})
                                    </span>
                                )}
                            </p>

                            {summaryLoading ? (
                                <div className="space-y-2">
                                    {[0, 1, 2].map((i) => (
                                        <div key={i} className="h-16 bg-[#111118] border border-[#1a1a24] rounded-xl animate-pulse" />
                                    ))}
                                </div>
                            ) : agentSummary && agentSummary.tasks.length > 0 ? (
                                <div className="space-y-1.5">
                                    {agentSummary.tasks.map((task) => (
                                        <TaskListItem
                                            key={task.task_name}
                                            task={task}
                                            active={selectedTask === task.task_name}
                                            onClick={() => setSelectedTask(task.task_name)}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-6 text-center space-y-2">
                                    <Database size={20} className="mx-auto text-[#3f3f46]" />
                                    <p className="text-xs text-[#52525b]">No tasks logged for this agent yet.</p>
                                    <p className="text-[10px] text-[#3f3f46]">
                                        Use <span className="font-mono">log_outcome()</span> in your SDK integration.
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ── Right pane: task detail ── */}
                    <div className="col-span-12 lg:col-span-8">
                        {selectedTask ? (
                            <TaskDetail
                                taskName={selectedTask}
                                taskTotal={selectedTaskSummary?.total ?? 0}
                                loading={recLoading}
                                data={recData}
                                error={recError}
                            />
                        ) : (
                            <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-16 text-center space-y-3">
                                <BarChart2 size={28} className="mx-auto text-[#3f3f46]" />
                                <p className="text-sm text-[#52525b]">Select a task to see its recommendation</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── No agents state ── */}
            {!agentsLoading && agents.length === 0 && (
                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl px-4 py-12 text-center space-y-3">
                    <Bot size={28} className="mx-auto text-[#3f3f46]" />
                    <p className="text-sm text-white">No agents registered yet</p>
                    <p className="text-xs text-[#52525b] max-w-sm mx-auto">
                        Install the Layerinfinite SDK and call <span className="font-mono text-[#a1a1aa]">Layerinfinite(agent_id=...)</span> to register your first agent.
                    </p>
                </div>
            )}
        </div>
    );
}
