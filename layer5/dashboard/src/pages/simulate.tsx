/**
 * Simulate Page (/simulate)
 * Centerpiece demo: 3-tier simulation engine UI.
 * POST /v1/simulate — predict outcomes before agents act.
 */
import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { API_BASE } from '../lib/config';

// ─── Design Tokens ──────────────────────────────────────────

const COLORS = {
    bg: '#080b12',
    panel: '#0e1320',
    border: '#1e2d45',
    textPrimary: '#f0f4ff',
    textSecondary: '#8892a4',
    accent: '#00FF85',
    tier1: { text: '#94a3b8', bg: 'rgba(100,116,139,0.15)', border: 'rgba(100,116,139,0.35)' },
    tier2: { text: '#60a5fa', bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.35)' },
    tier3: { text: '#fbbf24', bg: 'rgba(251,191,36,0.15)', border: 'rgba(251,191,36,0.35)' },
    warning: { text: '#fcd34d', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.30)' },
    error: { text: '#fca5a5', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.30)' },
    better: { text: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    similar: { text: '#94a3b8', bg: 'rgba(100,116,139,0.12)' },
};

const FONT_MONO = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const FONT_SANS = "'IBM Plex Sans', 'Inter', system-ui, sans-serif";


// ─── Types ──────────────────────────────────────────────────

interface Agent { agent_id: string; agent_name: string; }
interface Action { action_id: string; action_name: string; }

interface SequencePrediction {
    actions: string[];
    predicted_outcome: number;
    outcome_interval_low: number;
    outcome_interval_high: number;
    confidence_width?: number;
    confidence: number;
    predicted_resolution?: number;
    predicted_steps?: number;
    better_than_proposed?: boolean;
}

interface SimulateResponse {
    primary: SequencePrediction;
    alternatives: SequencePrediction[];
    simulation_tier: 1 | 2 | 3;
    tier_explanation: string;
    data_source: string;
    episode_count: number;
    simulation_warning: string | null;
}

interface HistoryEntry {
    id: string;
    agentName: string;
    contextSummary: string;
    sequence: string[];
    outcome: number;
    tier: number;
    timestamp: Date;
    request: SimRequest;
    response: SimulateResponse;
}

interface SimRequest {
    agent_id: string;
    context: Record<string, string>;
    proposed_sequence: string[];
    episode_history?: string[];
    simulate_alternatives: number;
    max_sequence_depth: number;
}

// ─── ContextBuilder ─────────────────────────────────────────

function ContextBuilder({
    pairs,
    onChange,
}: {
    pairs: { key: string; value: string }[];
    onChange: (pairs: { key: string; value: string }[]) => void;
}) {
    const [rawMode, setRawMode] = useState(false);
    const [rawJson, setRawJson] = useState('');
    const [rawError, setRawError] = useState('');

    function addPair() {
        onChange([...pairs, { key: '', value: '' }]);
    }

    function removePair(idx: number) {
        onChange(pairs.filter((_, i) => i !== idx));
    }

    function updatePair(idx: number, field: 'key' | 'value', val: string) {
        const next = pairs.map((p, i) => (i === idx ? { ...p, [field]: val } : p));
        onChange(next);
    }

    function switchToRaw() {
        const obj: Record<string, string> = {};
        for (const p of pairs) {
            if (p.key.trim()) obj[p.key.trim()] = p.value;
        }
        setRawJson(JSON.stringify(obj, null, 2));
        setRawError('');
        setRawMode(true);
    }

    function switchToBuilder() {
        try {
            const obj = JSON.parse(rawJson);
            if (typeof obj !== 'object' || Array.isArray(obj)) {
                setRawError('Must be a JSON object');
                return;
            }
            const newPairs = Object.entries(obj).map(([key, value]) => ({
                key,
                value: String(value),
            }));
            onChange(newPairs.length > 0 ? newPairs : [{ key: '', value: '' }]);
            setRawError('');
            setRawMode(false);
        } catch {
            setRawError('Invalid JSON');
        }
    }

    function applyRawJson() {
        try {
            const obj = JSON.parse(rawJson);
            if (typeof obj !== 'object' || Array.isArray(obj)) {
                setRawError('Must be a JSON object');
                return;
            }
            const newPairs = Object.entries(obj).map(([key, value]) => ({
                key,
                value: String(value),
            }));
            onChange(newPairs.length > 0 ? newPairs : [{ key: '', value: '' }]);
            setRawError('');
        } catch {
            setRawError('Invalid JSON');
        }
    }

    if (rawMode) {
        return (
            <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <label style={labelStyle}>Context (Raw JSON)</label>
                    <button onClick={switchToBuilder} style={toggleBtn}>Switch to Builder</button>
                </div>
                <textarea
                    value={rawJson}
                    onChange={(e) => { setRawJson(e.target.value); setRawError(''); }}
                    onBlur={applyRawJson}
                    rows={6}
                    style={{
                        ...inputStyle,
                        width: '100%',
                        resize: 'vertical',
                        fontFamily: FONT_MONO,
                        fontSize: '0.78rem',
                        lineHeight: 1.5,
                    }}
                    spellCheck={false}
                />
                {rawError && <div style={{ color: COLORS.error.text, fontSize: '0.75rem', marginTop: '0.25rem' }}>{rawError}</div>}
            </div>
        );
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <label style={labelStyle}>Context</label>
                <button onClick={switchToRaw} style={toggleBtn}>Raw JSON</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {pairs.map((p, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <input
                            value={p.key}
                            onChange={(e) => updatePair(idx, 'key', e.target.value)}
                            placeholder="key"
                            style={{ ...inputStyle, flex: 1, fontFamily: FONT_MONO, fontSize: '0.8rem' }}
                        />
                        <span style={{ color: COLORS.textSecondary, fontSize: '0.8rem' }}>:</span>
                        <input
                            value={p.value}
                            onChange={(e) => updatePair(idx, 'value', e.target.value)}
                            placeholder="value"
                            style={{ ...inputStyle, flex: 1.5, fontFamily: FONT_MONO, fontSize: '0.8rem' }}
                        />
                        <button
                            onClick={() => removePair(idx)}
                            style={removeBtnStyle}
                            title="Remove field"
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
            <button onClick={addPair} style={{ ...addBtnStyle, marginTop: '0.5rem' }}>
                + Add context field
            </button>
        </div>
    );
}

// ─── SequenceBuilder ────────────────────────────────────────

function SequenceBuilder({
    actions,
    availableActions,
    onChange,
    maxItems,
    label,
    subtext,
    emptyText,
}: {
    actions: string[];
    availableActions: Action[];
    onChange: (actions: string[]) => void;
    maxItems?: number;
    label: string;
    subtext: string;
    emptyText: string;
}) {
    const [pickerOpen, setPickerOpen] = useState(false);

    function addAction(name: string) {
        if (maxItems && actions.length >= maxItems) return;
        onChange([...actions, name]);
        setPickerOpen(false);
    }

    function removeAction(idx: number) {
        onChange(actions.filter((_, i) => i !== idx));
    }

    const atMax = maxItems ? actions.length >= maxItems : false;

    return (
        <div>
            <label style={labelStyle}>{label}</label>
            <div style={{ fontSize: '0.75rem', color: COLORS.textSecondary, marginBottom: '0.5rem' }}>{subtext}</div>

            {actions.length === 0 ? (
                <div style={{ fontSize: '0.78rem', color: COLORS.textSecondary, fontStyle: 'italic', padding: '0.5rem 0' }}>
                    {emptyText}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.5rem' }}>
                    {actions.map((a, idx) => (
                        <div key={idx} style={pillRow}>
                            <span style={pillIndex}>{idx + 1}</span>
                            <span style={pillLabel}>{a}</span>
                            <button onClick={() => removeAction(idx)} style={removeBtnStyle} title="Remove">×</button>
                        </div>
                    ))}
                </div>
            )}

            {!atMax && (
                <div style={{ position: 'relative' }}>
                    <button
                        onClick={() => setPickerOpen(!pickerOpen)}
                        style={addBtnStyle}
                        disabled={availableActions.length === 0}
                    >
                        + Add action {availableActions.length === 0 ? '(select an agent first)' : ''}
                    </button>
                    {pickerOpen && availableActions.length > 0 && (
                        <div style={dropdownStyle}>
                            {availableActions.map((ac) => (
                                <button
                                    key={ac.action_id}
                                    onClick={() => addAction(ac.action_name)}
                                    style={dropdownItem}
                                    onMouseEnter={(e) => { e.currentTarget.style.background = COLORS.border; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                >
                                    {ac.action_name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {atMax && (
                <div style={{ fontSize: '0.72rem', color: COLORS.textSecondary, marginTop: '0.25rem' }}>
                    Maximum {maxItems} actions reached
                </div>
            )}
        </div>
    );
}

// ─── ConfidenceIntervalBar ──────────────────────────────────

function ConfidenceIntervalBar({
    low,
    high,
    point,
}: {
    low: number;
    high: number;
    point: number;
}) {
    // Clamp all values to 0-1
    const lo = Math.max(0, Math.min(1, low));
    const hi = Math.max(0, Math.min(1, high));
    const pt = Math.max(0, Math.min(1, point));
    const width = hi - lo;
    const confidence = 1 - width / 2;

    return (
        <div style={{ marginTop: '0.75rem' }}>
            <div style={{ fontSize: '0.72rem', color: COLORS.textSecondary, marginBottom: '0.5rem', fontFamily: FONT_SANS }}>
                Confidence Interval
            </div>

            {/* Scale labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: COLORS.textSecondary, fontFamily: FONT_MONO, marginBottom: '0.2rem' }}>
                <span>0%</span>
                <span>25%</span>
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
            </div>

            {/* Bar container */}
            <div style={{
                position: 'relative',
                height: '28px',
                background: 'rgba(30,45,69,0.5)',
                borderRadius: '4px',
                border: `1px solid ${COLORS.border}`,
                overflow: 'visible',
            }}>
                {/* Tick marks */}
                {[0, 25, 50, 75, 100].map((pct) => (
                    <div key={pct} style={{
                        position: 'absolute',
                        left: `${pct}%`,
                        top: 0,
                        bottom: 0,
                        width: '1px',
                        background: 'rgba(136,146,164,0.15)',
                    }} />
                ))}

                {/* Confidence interval shaded region */}
                <div style={{
                    position: 'absolute',
                    left: `${lo * 100}%`,
                    width: `${(hi - lo) * 100}%`,
                    top: '4px',
                    bottom: '4px',
                    background: 'rgba(96, 165, 250, 0.25)',
                    borderRadius: '3px',
                    border: '1px solid rgba(96, 165, 250, 0.45)',
                }} />

                {/* Point estimate marker */}
                <div style={{
                    position: 'absolute',
                    left: `${pt * 100}%`,
                    top: '2px',
                    bottom: '2px',
                    width: '3px',
                    background: '#60a5fa',
                    borderRadius: '2px',
                    transform: 'translateX(-1.5px)',
                    boxShadow: '0 0 8px rgba(96,165,250,0.6)',
                }} />
            </div>

            {/* Bound labels */}
            <div style={{ position: 'relative', height: '32px', marginTop: '2px' }}>
                {/* Lower bound */}
                <div style={{
                    position: 'absolute',
                    left: `${lo * 100}%`,
                    transform: 'translateX(-50%)',
                    textAlign: 'center',
                    fontSize: '0.68rem',
                    fontFamily: FONT_MONO,
                    color: COLORS.textSecondary,
                    whiteSpace: 'nowrap',
                }}>
                    <div style={{ marginBottom: '1px' }}>│</div>
                    {(lo * 100).toFixed(0)}%
                </div>

                {/* Point estimate */}
                <div style={{
                    position: 'absolute',
                    left: `${pt * 100}%`,
                    transform: 'translateX(-50%)',
                    textAlign: 'center',
                    fontSize: '0.72rem',
                    fontFamily: FONT_MONO,
                    fontWeight: 600,
                    color: '#60a5fa',
                    whiteSpace: 'nowrap',
                }}>
                    <div style={{ marginBottom: '1px' }}>▲</div>
                    {(pt * 100).toFixed(0)}%
                </div>

                {/* Upper bound */}
                <div style={{
                    position: 'absolute',
                    left: `${hi * 100}%`,
                    transform: 'translateX(-50%)',
                    textAlign: 'center',
                    fontSize: '0.68rem',
                    fontFamily: FONT_MONO,
                    color: COLORS.textSecondary,
                    whiteSpace: 'nowrap',
                }}>
                    <div style={{ marginBottom: '1px' }}>│</div>
                    {(hi * 100).toFixed(0)}%
                </div>
            </div>

            {/* Summary line */}
            <div style={{
                fontSize: '0.72rem',
                color: COLORS.textSecondary,
                fontFamily: FONT_MONO,
                marginTop: '0.15rem',
            }}>
                Confidence: {(confidence * 100).toFixed(0)}% · Interval width: {(width * 100).toFixed(0)}%
            </div>
        </div>
    );
}

// ─── TierBadge ──────────────────────────────────────────────

const TIER_CONFIG: Record<number, { label: string; colors: typeof COLORS.tier1; icon: string }> = {
    1: { label: 'TIER 1 — HISTORICAL ANALYSIS', colors: COLORS.tier1, icon: '📊' },
    2: { label: 'TIER 2 — ML MODEL', colors: COLORS.tier2, icon: '🤖' },
    3: { label: 'TIER 3 — MCTS PLANNING', colors: COLORS.tier3, icon: '✦' },
};

function TierBadge({ tier }: { tier: number }) {
    const cfg = TIER_CONFIG[tier] ?? TIER_CONFIG[1];
    return (
        <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.5rem 1rem',
            borderRadius: '8px',
            background: cfg.colors.bg,
            border: `1px solid ${cfg.colors.border}`,
            fontFamily: FONT_MONO,
            fontSize: '0.82rem',
            fontWeight: 700,
            color: cfg.colors.text,
            letterSpacing: '0.08em',
        }}>
            <span>{cfg.icon}</span>
            {cfg.label}
        </div>
    );
}

// ─── AlternativeCard ────────────────────────────────────────

function AlternativeCard({
    alt,
    proposedOutcome,
}: {
    alt: SequencePrediction;
    proposedOutcome: number;
}) {
    const isBetter = alt.better_than_proposed === true;
    const badgeStyle = isBetter
        ? { color: COLORS.better.text, background: COLORS.better.bg }
        : { color: COLORS.similar.text, background: COLORS.similar.bg };
    const badgeText = isBetter ? '↑ Better' : '→ Similar';

    const altPct = alt.predicted_outcome * 100;
    const propPct = proposedOutcome * 100;

    return (
        <div style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            padding: '0.85rem 1rem',
            marginBottom: '0.5rem',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                {/* Action pills */}
                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    {alt.actions.map((a, i) => (
                        <React.Fragment key={i}>
                            {i > 0 && <span style={{ color: COLORS.textSecondary, fontSize: '0.7rem' }}>→</span>}
                            <span style={actionPillSmall}>{a}</span>
                        </React.Fragment>
                    ))}
                </div>

                {/* Badge */}
                <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: '9999px',
                    fontSize: '0.68rem',
                    fontWeight: 600,
                    fontFamily: FONT_SANS,
                    ...badgeStyle,
                    flexShrink: 0,
                }}>
                    {badgeText}
                </span>
            </div>

            {/* Comparison bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', fontFamily: FONT_MONO, color: COLORS.textPrimary, fontWeight: 600, minWidth: '36px' }}>
                    {altPct.toFixed(0)}%
                </span>
                <div style={{ flex: 1, position: 'relative', height: '8px', background: 'rgba(30,45,69,0.5)', borderRadius: '4px' }}>
                    {/* Proposed reference */}
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        height: '100%',
                        width: `${propPct}%`,
                        background: 'rgba(136,146,164,0.2)',
                        borderRadius: '4px',
                    }} />
                    {/* Alternative bar */}
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        height: '100%',
                        width: `${altPct}%`,
                        background: isBetter ? 'rgba(52,211,153,0.5)' : 'rgba(96,165,250,0.4)',
                        borderRadius: '4px',
                        transition: 'width 300ms ease',
                    }} />
                    {/* Proposed marker line */}
                    <div style={{
                        position: 'absolute',
                        left: `${propPct}%`,
                        top: '-2px',
                        bottom: '-2px',
                        width: '2px',
                        background: COLORS.textSecondary,
                        borderRadius: '1px',
                    }} />
                </div>
                <span style={{ fontSize: '0.68rem', fontFamily: FONT_MONO, color: COLORS.textSecondary, minWidth: '60px' }}>
                    vs {propPct.toFixed(0)}%
                </span>
            </div>

            <div style={{ fontSize: '0.7rem', fontFamily: FONT_MONO, color: COLORS.textSecondary, marginTop: '0.35rem' }}>
                Confidence: {(alt.confidence * 100).toFixed(0)}%
            </div>
        </div>
    );
}

// ─── Skeleton loader ────────────────────────────────────────

function ResultsSkeleton() {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.5rem' }}>
            <div style={{ ...shimmerBlock, width: '240px', height: '36px' }} />
            <div style={{ ...shimmerBlock, width: '100%', height: '14px' }} />
            <div style={{ ...shimmerBlock, width: '80%', height: '14px' }} />
            <div style={{ ...shimmerBlock, width: '60px', height: '48px', marginTop: '0.5rem' }} />
            <div style={{ ...shimmerBlock, width: '100%', height: '40px' }} />
            <div style={{ ...shimmerBlock, width: '100%', height: '28px' }} />
            <div style={{ ...shimmerBlock, width: '100%', height: '80px', marginTop: '1rem' }} />
            <style>{`
                @keyframes shimmer {
                    0% { opacity: 0.3; }
                    50% { opacity: 0.6; }
                    100% { opacity: 0.3; }
                }
            `}</style>
        </div>
    );
}

const shimmerBlock: React.CSSProperties = {
    background: '#1e2d45',
    borderRadius: '6px',
    animation: 'shimmer 1.5s ease-in-out infinite',
};

// ─── Main Page ──────────────────────────────────────────────

export default function SimulatePage() {
    // ── Agent + action data ─────────────────────────────────
    const [agents, setAgents] = useState<Agent[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState('');
    const [selectedAgentName, setSelectedAgentName] = useState('');
    const [availableActions, setAvailableActions] = useState<Action[]>([]);

    // ── Form state ──────────────────────────────────────────
    const [contextPairs, setContextPairs] = useState<{ key: string; value: string }[]>([]);
    const [sequence, setSequence] = useState<string[]>([]);
    const [episodeHistory, setEpisodeHistory] = useState<string[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [simulateAlternatives, setSimulateAlternatives] = useState(2);
    const [maxDepth, setMaxDepth] = useState(5);

    // ── API key ─────────────────────────────────────────────
    const [apiKey, setApiKey] = useState(() => {
        try { return sessionStorage.getItem('layerinfinite_sim_key') ?? ''; } catch { return ''; }
    });
    const [showApiKeyField, setShowApiKeyField] = useState(!apiKey);

    // ── Results ─────────────────────────────────────────────
    const [result, setResult] = useState<SimulateResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingText, setLoadingText] = useState('');
    const [error, setError] = useState('');
    const [validationErrors, setValidationErrors] = useState<string[]>([]);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [resultVisible, setResultVisible] = useState(false);

    const resultRef = useRef<HTMLDivElement>(null);

    // ── Fetch agents on mount ───────────────────────────────
    useEffect(() => {
        (async () => {
            const { data } = await supabase
                .from('dim_agents')
                .select('agent_id, agent_name')
                .eq('is_active', true)
                .order('agent_name');
            if (data) setAgents(data as Agent[]);
        })();
    }, []);

    // ── Fetch actions when agent changes ────────────────────
    useEffect(() => {
        if (!selectedAgentId) {
            setAvailableActions([]);
            return;
        }
        (async () => {
            const { data } = await supabase
                .from('dim_actions')
                .select('action_id, action_name')
                .eq('agent_id', selectedAgentId)
                .order('action_name');
            if (data) setAvailableActions(data as Action[]);
        })();
    }, [selectedAgentId]);

    // ── Validation ──────────────────────────────────────────
    function validate(): string[] {
        const errs: string[] = [];
        if (!selectedAgentId) errs.push('Select an agent first');
        if (!apiKey.trim()) errs.push('Enter your Layerinfinite API key');
        const filled = contextPairs.filter((p) => p.key.trim());
        if (filled.length === 0) errs.push('Add at least one context field');
        if (sequence.length === 0) errs.push('Proposed sequence must have 1–5 actions');
        if (sequence.length > 5) errs.push('Proposed sequence must have at most 5 actions');
        return errs;
    }

    // ── Run simulation ──────────────────────────────────────
    async function runSimulation() {
        if (!API_BASE) {
            setError('CONFIGURATION ERROR: VITE_LAYERINFINITE_API_URL is not set. Contact your administrator.');
            return;
        }
        const errs = validate();
        if (errs.length > 0) {
            setValidationErrors(errs);
            return;
        }
        setValidationErrors([]);
        setError('');
        setResult(null);
        setResultVisible(false);
        setLoading(true);
        setLoadingText('Searching through historical episodes...');

        // Build context object
        const context: Record<string, string> = {};
        for (const p of contextPairs) {
            if (p.key.trim()) context[p.key.trim()] = p.value;
        }

        const payload: SimRequest = {
            agent_id: selectedAgentId,
            context,
            proposed_sequence: sequence,
            simulate_alternatives: simulateAlternatives,
            max_sequence_depth: maxDepth,
        };
        if (episodeHistory.length > 0) {
            payload.episode_history = episodeHistory;
        }

        // Persist API key in session
        try { sessionStorage.setItem('layerinfinite_sim_key', apiKey); } catch { /* private mode */ }

        try {
            const res = await fetch(`${API_BASE}/v1/simulate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': apiKey,
                },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 400) {
                    setError(data.details ?? data.error ?? 'Invalid request — check your inputs.');
                } else if (res.status === 401) {
                    setError('Invalid API key. Check your key on the API Keys page.');
                } else if (res.status === 404) {
                    setError('Agent not found.');
                } else {
                    setError(data.error ?? 'Simulation failed. Our team has been notified.');
                }
                setLoading(false);
                return;
            }

            const data: SimulateResponse = await res.json();
            setResult(data);
            setLoadingText(`Analyzed ${data.episode_count.toLocaleString()} historical episodes`);
            setLoading(false);

            // Animate results in
            requestAnimationFrame(() => {
                setResultVisible(true);
                resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });

            // Add to history
            const contextSummary = Object.entries(context)
                .slice(0, 2)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            setHistory((prev) => [
                {
                    id: crypto.randomUUID(),
                    agentName: selectedAgentName,
                    contextSummary,
                    sequence: [...sequence],
                    outcome: data.primary.predicted_outcome,
                    tier: data.simulation_tier,
                    timestamp: new Date(),
                    request: payload,
                    response: data,
                },
                ...prev,
            ].slice(0, 5));
        } catch {
            setError('Cannot reach Layerinfinite. Check your connection.');
            setLoading(false);
        }
    }

    // ── Reload from history ─────────────────────────────────
    function reloadHistory(entry: HistoryEntry) {
        setSelectedAgentId(entry.request.agent_id);
        const agent = agents.find((a) => a.agent_id === entry.request.agent_id);
        setSelectedAgentName(agent?.agent_name ?? '');
        setContextPairs(
            Object.entries(entry.request.context).map(([key, value]) => ({ key, value })),
        );
        setSequence(entry.request.proposed_sequence);
        setEpisodeHistory(entry.request.episode_history ?? []);
        setSimulateAlternatives(entry.request.simulate_alternatives);
        setMaxDepth(entry.request.max_sequence_depth);
        setResult(entry.response);
        setResultVisible(true);
        setError('');
        setValidationErrors([]);
    }

    // ── Copy helpers ────────────────────────────────────────
    function copyJson() {
        if (result) navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    }

    function copyCurl() {
        if (!result) return;
        const context: Record<string, string> = {};
        for (const p of contextPairs) {
            if (p.key.trim()) context[p.key.trim()] = p.value;
        }
        const body = JSON.stringify({
            agent_id: selectedAgentId,
            context,
            proposed_sequence: sequence,
            episode_history: episodeHistory.length > 0 ? episodeHistory : undefined,
            simulate_alternatives: simulateAlternatives,
            max_sequence_depth: maxDepth,
        });
        const curl = `curl -X POST '${API_BASE}/v1/simulate' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-API-Key: YOUR_API_KEY' \\\n  -d '${body}'`;
        navigator.clipboard.writeText(curl);
    }

    // ── Render ──────────────────────────────────────────────
    return (
        <div style={{ fontFamily: FONT_SANS, color: COLORS.textPrimary }}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');
                @keyframes sim-fade-in {
                    from { transform: translateY(12px); opacity: 0; }
                    to   { transform: translateY(0); opacity: 1; }
                }
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to   { transform: rotate(360deg); }
                }
            `}</style>

            {/* Header */}
            <div style={{ marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 600, color: COLORS.textPrimary, margin: 0, fontFamily: FONT_SANS }}>
                        Simulation Engine
                    </h1>
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 8px',
                        borderRadius: '9999px',
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        fontFamily: FONT_MONO,
                        background: COLORS.tier3.bg,
                        color: COLORS.tier3.text,
                        border: `1px solid ${COLORS.tier3.border}`,
                        letterSpacing: '0.08em',
                    }}>
                        ✦ PREMIUM
                    </span>
                </div>
                <p style={{ fontSize: '0.82rem', color: COLORS.textSecondary, margin: '0.25rem 0 0', fontFamily: FONT_SANS }}>
                    Predict outcomes before your agent acts. Three-tier intelligence: historical analysis → ML model → MCTS planning.
                </p>
            </div>

            {/* Split layout */}
            <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>

                {/* ═══ LEFT PANEL — Configuration ═══ */}
                <div style={{ width: '40%', minWidth: '340px', flexShrink: 0 }}>

                    {/* API Key */}
                    <div style={sectionCard}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <label style={labelStyle}>Layerinfinite API Key</label>
                            {apiKey && !showApiKeyField && (
                                <button onClick={() => setShowApiKeyField(true)} style={toggleBtn}>Change</button>
                            )}
                        </div>
                        {showApiKeyField || !apiKey ? (
                            <>
                                <input
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    placeholder="l5_key_..."
                                    style={{ ...inputStyle, width: '100%', fontFamily: FONT_MONO, fontSize: '0.8rem', marginTop: '0.35rem' }}
                                    onBlur={() => { if (apiKey) setShowApiKeyField(false); }}
                                />
                                <div style={{ fontSize: '0.68rem', color: COLORS.textSecondary, marginTop: '0.25rem' }}>
                                    Your API key is only held in memory — it is not saved or logged.
                                </div>
                            </>
                        ) : (
                            <div style={{ fontFamily: FONT_MONO, fontSize: '0.78rem', color: COLORS.textSecondary, marginTop: '0.25rem' }}>
                                ••••••••{apiKey.slice(-6)}
                            </div>
                        )}
                    </div>

                    {/* Section 1: Agent + Context */}
                    <div style={sectionCard}>
                        <label style={labelStyle}>Agent</label>
                        <select
                            value={selectedAgentId}
                            onChange={(e) => {
                                setSelectedAgentId(e.target.value);
                                const agent = agents.find((a) => a.agent_id === e.target.value);
                                setSelectedAgentName(agent?.agent_name ?? '');
                                setSequence([]);
                            }}
                            style={{ ...inputStyle, width: '100%', marginBottom: '1rem' }}
                        >
                            <option value="">Select an agent...</option>
                            {agents.map((a) => (
                                <option key={a.agent_id} value={a.agent_id}>{a.agent_name}</option>
                            ))}
                        </select>

                        <ContextBuilder pairs={contextPairs} onChange={setContextPairs} />
                    </div>

                    {/* Section 2: Sequence Builder */}
                    <div style={sectionCard}>
                        <SequenceBuilder
                            actions={sequence}
                            availableActions={availableActions}
                            onChange={setSequence}
                            maxItems={5}
                            label="Proposed Action Sequence (1–5 steps)"
                            subtext="What sequence of actions should your agent try?"
                            emptyText="No actions added yet"
                        />
                    </div>

                    {/* Section 3: Episode History (collapsible) */}
                    <div style={sectionCard}>
                        <button
                            onClick={() => setShowHistory(!showHistory)}
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                                color: COLORS.textPrimary, fontFamily: FONT_SANS, fontSize: '0.85rem', fontWeight: 500,
                            }}
                        >
                            <span style={{ fontSize: '0.7rem', transform: showHistory ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>▶</span>
                            Already tried these actions? (optional)
                        </button>
                        {showHistory && (
                            <div style={{ marginTop: '0.75rem' }}>
                                <SequenceBuilder
                                    actions={episodeHistory}
                                    availableActions={availableActions}
                                    onChange={setEpisodeHistory}
                                    label="Actions already taken in this episode"
                                    subtext="Tell Layerinfinite what has been tried already."
                                    emptyText="No history added"
                                />
                            </div>
                        )}
                    </div>

                    {/* Section 4: Advanced options (collapsible) */}
                    <div style={sectionCard}>
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            style={{
                                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%',
                                color: COLORS.textPrimary, fontFamily: FONT_SANS, fontSize: '0.85rem', fontWeight: 500,
                            }}
                        >
                            <span style={{ fontSize: '0.7rem', transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>▶</span>
                            Show advanced options
                        </button>
                        {showAdvanced && (
                            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem' }}>
                                <div style={{ flex: 1 }}>
                                    <label style={{ ...labelStyle, fontSize: '0.75rem' }}>Alternatives to generate</label>
                                    <select
                                        value={simulateAlternatives}
                                        onChange={(e) => setSimulateAlternatives(Number(e.target.value))}
                                        style={{ ...inputStyle, width: '100%', marginTop: '0.25rem' }}
                                    >
                                        {[0, 1, 2, 3].map((n) => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                </div>
                                <div style={{ flex: 1 }}>
                                    <label style={{ ...labelStyle, fontSize: '0.75rem' }}>Max sequence depth</label>
                                    <select
                                        value={maxDepth}
                                        onChange={(e) => setMaxDepth(Number(e.target.value))}
                                        style={{ ...inputStyle, width: '100%', marginTop: '0.25rem' }}
                                    >
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Section 5: Validation errors + Run button */}
                    {validationErrors.length > 0 && (
                        <div style={{
                            background: COLORS.error.bg,
                            border: `1px solid ${COLORS.error.border}`,
                            borderRadius: '8px',
                            padding: '0.6rem 1rem',
                            marginBottom: '0.75rem',
                        }}>
                            {validationErrors.map((e, i) => (
                                <div key={i} style={{ fontSize: '0.78rem', color: COLORS.error.text, fontFamily: FONT_SANS }}>
                                    • {e}
                                </div>
                            ))}
                        </div>
                    )}

                    <button
                        onClick={runSimulation}
                        disabled={loading}
                        style={{
                            width: '100%',
                            padding: '0.75rem 1.5rem',
                            borderRadius: '8px',
                            border: 'none',
                            background: loading ? '#1e2d45' : 'linear-gradient(135deg, #3b82f6, #2563eb)',
                            color: '#fff',
                            fontSize: '0.95rem',
                            fontWeight: 600,
                            fontFamily: FONT_SANS,
                            cursor: loading ? 'default' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.5rem',
                            transition: 'background 200ms',
                        }}
                    >
                        {loading ? (
                            <>
                                <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                                Simulating...
                            </>
                        ) : (
                            <>▶ Run Simulation</>
                        )}
                    </button>

                    {loading && (
                        <div style={{ fontSize: '0.75rem', color: COLORS.textSecondary, textAlign: 'center', marginTop: '0.5rem', fontFamily: FONT_SANS }}>
                            {loadingText}
                        </div>
                    )}
                </div>

                {/* ═══ RIGHT PANEL — Results ═══ */}
                <div ref={resultRef} style={{ flex: 1, minWidth: 0 }}>

                    {/* Empty state */}
                    {!loading && !result && !error && (
                        <div style={{
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: '10px',
                            padding: '4rem 2rem',
                            textAlign: 'center',
                        }}>
                            <div style={{
                                fontSize: '1.15rem',
                                fontWeight: 600,
                                color: COLORS.textPrimary,
                                fontFamily: FONT_SANS,
                                marginBottom: '0.5rem',
                            }}>
                                Run a simulation to see predictions
                            </div>
                            <div style={{
                                fontSize: '0.85rem',
                                color: COLORS.textSecondary,
                                fontFamily: FONT_SANS,
                                lineHeight: 1.6,
                                maxWidth: '380px',
                                margin: '0 auto 1.5rem',
                            }}>
                                Layerinfinite will predict the outcome of your proposed action sequence before your agent runs it in the real environment.
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                {[
                                    { icon: '📊', label: 'Wilson CI baseline' },
                                    { icon: '🤖', label: 'LightGBM model' },
                                    { icon: '🌲', label: 'MCTS planning' },
                                ].map((cap) => (
                                    <span key={cap.label} style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        padding: '0.35rem 0.75rem',
                                        borderRadius: '9999px',
                                        fontSize: '0.75rem',
                                        fontFamily: FONT_SANS,
                                        background: 'rgba(30,45,69,0.6)',
                                        color: COLORS.textSecondary,
                                        border: `1px solid ${COLORS.border}`,
                                    }}>
                                        {cap.icon} {cap.label}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Loading state */}
                    {loading && (
                        <div style={{
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: '10px',
                        }}>
                            <ResultsSkeleton />
                        </div>
                    )}

                    {/* Error state */}
                    {!loading && error && (
                        <div style={{
                            background: COLORS.error.bg,
                            border: `1px solid ${COLORS.error.border}`,
                            borderRadius: '10px',
                            padding: '2rem',
                            textAlign: 'center',
                        }}>
                            <div style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: COLORS.error.text }}>
                                Simulation Failed
                            </div>
                            <div style={{ fontSize: '0.85rem', color: COLORS.error.text, fontFamily: FONT_SANS, lineHeight: 1.5 }}>
                                {typeof error === 'string' ? error : JSON.stringify(error)}
                            </div>
                        </div>
                    )}

                    {/* Results state */}
                    {!loading && result && (
                        <div style={{
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: '10px',
                            padding: '1.5rem',
                            opacity: resultVisible ? 1 : 0,
                            transform: resultVisible ? 'translateY(0)' : 'translateY(12px)',
                            transition: 'opacity 300ms ease, transform 300ms ease',
                        }}>

                            {/* Tier Badge */}
                            <div style={{ marginBottom: '0.75rem' }}>
                                <TierBadge tier={result.simulation_tier} />
                            </div>
                            <div style={{ fontSize: '0.82rem', color: COLORS.textSecondary, fontFamily: FONT_SANS, marginBottom: '0.25rem' }}>
                                {result.tier_explanation}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: COLORS.textSecondary, fontFamily: FONT_MONO, marginBottom: '0.75rem' }}>
                                {result.data_source} · {result.episode_count.toLocaleString()} episodes analyzed
                            </div>

                            {/* Warning */}
                            {result.simulation_warning && (
                                <div style={{
                                    background: COLORS.warning.bg,
                                    border: `1px solid ${COLORS.warning.border}`,
                                    borderRadius: '8px',
                                    padding: '0.6rem 1rem',
                                    marginBottom: '1rem',
                                    display: 'flex',
                                    gap: '0.5rem',
                                    alignItems: 'flex-start',
                                }}>
                                    <span style={{ fontSize: '0.9rem' }}>⚠</span>
                                    <span style={{ fontSize: '0.8rem', color: COLORS.warning.text, fontFamily: FONT_SANS, lineHeight: 1.4 }}>
                                        {result.simulation_warning}
                                    </span>
                                </div>
                            )}

                            {/* Divider */}
                            <div style={{ height: '1px', background: COLORS.border, margin: '1rem 0' }} />

                            {/* Primary Prediction */}
                            <div style={{ marginBottom: '1rem' }}>
                                <div style={{ fontSize: '0.72rem', color: COLORS.textSecondary, fontFamily: FONT_MONO, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>
                                    Primary Prediction
                                </div>

                                {/* Sequence pills */}
                                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                                    <span style={{ fontSize: '0.72rem', color: COLORS.textSecondary, marginRight: '0.25rem' }}>Sequence:</span>
                                    {result.primary.actions.map((a, i) => (
                                        <React.Fragment key={i}>
                                            {i > 0 && <span style={{ color: COLORS.textSecondary, fontSize: '0.75rem' }}>→</span>}
                                            <span style={actionPill}>{a}</span>
                                        </React.Fragment>
                                    ))}
                                </div>

                                {/* Big outcome number */}
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                    <span style={{ fontSize: '0.72rem', color: COLORS.textSecondary, fontFamily: FONT_SANS }}>Predicted Outcome:</span>
                                    <span style={{
                                        fontSize: '2.2rem',
                                        fontWeight: 700,
                                        fontFamily: FONT_MONO,
                                        color: COLORS.textPrimary,
                                        lineHeight: 1,
                                    }}>
                                        {(result.primary.predicted_outcome * 100).toFixed(0)}%
                                    </span>
                                </div>

                                {/* Confidence interval bar */}
                                <ConfidenceIntervalBar
                                    low={result.primary.outcome_interval_low}
                                    high={result.primary.outcome_interval_high}
                                    point={result.primary.predicted_outcome}
                                />

                                {/* Resolution + Steps */}
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr',
                                    gap: '0.75rem',
                                    marginTop: '1rem',
                                }}>
                                    {result.primary.predicted_resolution != null && (
                                        <div style={metricBox}>
                                            <div style={metricLabel}>Predicted Resolution</div>
                                            <div style={metricValue}>{(result.primary.predicted_resolution * 100).toFixed(0)}%</div>
                                        </div>
                                    )}
                                    {result.primary.predicted_steps != null && (
                                        <div style={metricBox}>
                                            <div style={metricLabel}>Predicted Steps</div>
                                            <div style={metricValue}>{result.primary.predicted_steps.toFixed(1)}</div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Alternatives */}
                            {result.alternatives.length > 0 && (
                                <>
                                    <div style={{ height: '1px', background: COLORS.border, margin: '1rem 0' }} />
                                    <div style={{ fontSize: '0.72rem', color: COLORS.textSecondary, fontFamily: FONT_MONO, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>
                                        Alternative Sequences
                                    </div>
                                    {result.alternatives.map((alt, i) => (
                                        <AlternativeCard
                                            key={i}
                                            alt={alt}
                                            proposedOutcome={result.primary.predicted_outcome}
                                        />
                                    ))}
                                </>
                            )}

                            {/* Export buttons */}
                            <div style={{ height: '1px', background: COLORS.border, margin: '1rem 0' }} />
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button onClick={copyJson} style={exportBtn}>Copy as JSON</button>
                                <button onClick={copyCurl} style={exportBtn}>Copy API call</button>
                            </div>
                        </div>
                    )}

                    {/* Simulation History */}
                    {history.length > 0 && (
                        <div style={{
                            marginTop: '1rem',
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: '10px',
                            padding: '1rem',
                        }}>
                            <div style={{
                                fontSize: '0.72rem',
                                color: COLORS.textSecondary,
                                fontFamily: FONT_MONO,
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em',
                                marginBottom: '0.75rem',
                            }}>
                                Session History
                            </div>
                            {history.map((entry) => (
                                <div key={entry.id} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.75rem',
                                    padding: '0.5rem 0',
                                    borderBottom: `1px solid ${COLORS.border}`,
                                    fontSize: '0.78rem',
                                    fontFamily: FONT_SANS,
                                }}>
                                    <span style={{ color: COLORS.textSecondary, fontFamily: FONT_MONO, fontSize: '0.7rem', flexShrink: 0 }}>
                                        {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    <span style={{ color: COLORS.textPrimary, fontWeight: 500, flexShrink: 0 }}>
                                        {entry.agentName}
                                    </span>
                                    <span style={{ color: COLORS.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {entry.contextSummary}
                                    </span>
                                    <span style={{ fontFamily: FONT_MONO, color: COLORS.textPrimary, flexShrink: 0 }}>
                                        {entry.sequence.join(' → ')}
                                    </span>
                                    <span style={{ fontFamily: FONT_MONO, fontWeight: 600, color: COLORS.textPrimary, flexShrink: 0, minWidth: '36px', textAlign: 'right' }}>
                                        {(entry.outcome * 100).toFixed(0)}%
                                    </span>
                                    <span style={{
                                        fontSize: '0.65rem',
                                        fontFamily: FONT_MONO,
                                        color: (TIER_CONFIG[entry.tier] ?? TIER_CONFIG[1]).colors.text,
                                        flexShrink: 0,
                                    }}>
                                        T{entry.tier}
                                    </span>
                                    <button
                                        onClick={() => reloadHistory(entry)}
                                        style={{
                                            background: 'none',
                                            border: `1px solid ${COLORS.border}`,
                                            borderRadius: '4px',
                                            color: COLORS.textSecondary,
                                            fontSize: '0.68rem',
                                            fontFamily: FONT_SANS,
                                            padding: '2px 6px',
                                            cursor: 'pointer',
                                            flexShrink: 0,
                                        }}
                                    >
                                        Reload
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Shared Styles ──────────────────────────────────────────

const labelStyle: React.CSSProperties = {
    fontSize: '0.82rem',
    fontWeight: 600,
    color: COLORS.textPrimary,
    fontFamily: FONT_SANS,
    display: 'block',
    marginBottom: '0.25rem',
};

const inputStyle: React.CSSProperties = {
    padding: '0.45rem 0.7rem',
    borderRadius: '6px',
    border: `1px solid ${COLORS.border}`,
    background: COLORS.bg,
    color: COLORS.textPrimary,
    fontSize: '0.82rem',
    fontFamily: FONT_SANS,
    outline: 'none',
    boxSizing: 'border-box',
};

const sectionCard: React.CSSProperties = {
    background: COLORS.panel,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '10px',
    padding: '1rem',
    marginBottom: '0.75rem',
};

const toggleBtn: React.CSSProperties = {
    background: 'none',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '4px',
    color: COLORS.textSecondary,
    fontSize: '0.7rem',
    fontFamily: FONT_MONO,
    padding: '2px 8px',
    cursor: 'pointer',
};

const addBtnStyle: React.CSSProperties = {
    background: 'none',
    border: `1px dashed ${COLORS.border}`,
    borderRadius: '6px',
    color: COLORS.textSecondary,
    fontSize: '0.78rem',
    fontFamily: FONT_SANS,
    padding: '0.35rem 0.75rem',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
};

const removeBtnStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: COLORS.textSecondary,
    fontSize: '1rem',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
    flexShrink: 0,
};

const pillRow: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.35rem 0.6rem',
    background: 'rgba(30,45,69,0.4)',
    border: `1px solid ${COLORS.border}`,
    borderRadius: '6px',
};

const pillIndex: React.CSSProperties = {
    fontSize: '0.68rem',
    fontFamily: FONT_MONO,
    color: COLORS.textSecondary,
    width: '16px',
    flexShrink: 0,
};

const pillLabel: React.CSSProperties = {
    fontSize: '0.82rem',
    fontFamily: FONT_MONO,
    color: COLORS.textPrimary,
    fontWeight: 500,
    flex: 1,
};

const actionPill: React.CSSProperties = {
    display: 'inline-flex',
    padding: '3px 10px',
    borderRadius: '9999px',
    background: 'rgba(59,130,246,0.15)',
    border: '1px solid rgba(59,130,246,0.3)',
    color: '#93c5fd',
    fontSize: '0.78rem',
    fontFamily: FONT_MONO,
    fontWeight: 500,
};

const actionPillSmall: React.CSSProperties = {
    ...actionPill,
    padding: '2px 8px',
    fontSize: '0.72rem',
};

const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    background: COLORS.panel,
    border: `1px solid ${COLORS.border}`,
    borderRadius: '6px',
    maxHeight: '180px',
    overflowY: 'auto',
    zIndex: 10,
    marginTop: '4px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
};

const dropdownItem: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '0.45rem 0.75rem',
    background: 'transparent',
    border: 'none',
    color: COLORS.textPrimary,
    fontSize: '0.8rem',
    fontFamily: FONT_MONO,
    textAlign: 'left',
    cursor: 'pointer',
};

const metricBox: React.CSSProperties = {
    background: 'rgba(30,45,69,0.4)',
    borderRadius: '6px',
    padding: '0.6rem 0.75rem',
    border: `1px solid ${COLORS.border}`,
};

const metricLabel: React.CSSProperties = {
    fontSize: '0.68rem',
    color: COLORS.textSecondary,
    fontFamily: FONT_SANS,
    marginBottom: '0.2rem',
};

const metricValue: React.CSSProperties = {
    fontSize: '1.2rem',
    fontWeight: 700,
    fontFamily: FONT_MONO,
    color: COLORS.textPrimary,
};

const exportBtn: React.CSSProperties = {
    padding: '0.4rem 0.85rem',
    borderRadius: '6px',
    border: `1px solid ${COLORS.border}`,
    background: 'transparent',
    color: COLORS.textSecondary,
    fontSize: '0.75rem',
    fontFamily: FONT_SANS,
    cursor: 'pointer',
};
