/**
 * Alerts Page (/alerts)
 * Data Source: degradation_alert_events (migrations 008 + 017)
 * Gap detection dashboard — surfaces all anomalies Layer5 detects.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';
import AlertTypeSummary from '../components/AlertTypeSummary';
import LiveIndicator from '../components/LiveIndicator';
import { useRealtimeAlerts } from '../hooks/useRealtimeAlerts';
import { useToastContext } from '../components/Toast';

// ─── Types ──────────────────────────────────────────────────

interface AlertEvent {
    alert_id: string;
    action_id: string | null;
    context_id: string | null;
    customer_id: string;
    action_name: string | null;
    context_type: string | null;
    trend_delta: number | null;
    current_success_rate: number | null;
    previous_success_rate: number | null;
    total_attempts: number | null;
    detected_at: string;
    acknowledged: boolean;
    acknowledged_at: string | null;
    acknowledged_by: string | null;
    alert_type: string;
    severity: string;
    current_value: number | null;
    baseline_value: number | null;
    spike_ratio: number | null;
    affected_agent_count: number | null;
    message: string | null;
}

type Severity = 'critical' | 'warning' | 'info';
type TimeRange = '24h' | '7d' | '30d';

// ─── Design Tokens ──────────────────────────────────────────

const COLORS = {
    bg: '#080b12',
    panel: '#0e1320',
    border: '#1e2d45',
    textPrimary: '#f0f4ff',
    textSecondary: '#8892a4',
    live: '#10b981',
    severity: {
        critical: { text: '#fca5a5', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.25)' },
        warning: { text: '#fcd34d', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)' },
        info: { text: '#93c5fd', bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)' },
    } as Record<string, { text: string; bg: string; border: string }>,
};

const FONT_MONO = "'IBM Plex Mono', 'JetBrains Mono', monospace";
const FONT_SANS = "'IBM Plex Sans', 'Inter', system-ui, sans-serif";

// ─── Alert Type Mapping ─────────────────────────────────────

const ALERT_TYPE_MAP: Record<string, { icon: string; label: string }> = {
    latency_spike: { icon: '⚡', label: 'Latency Spike' },
    context_drift: { icon: '🌀', label: 'Context Drift' },
    coordinated_failure: { icon: '⛔', label: 'Coordinated Failure' },
    degradation: { icon: '📉', label: 'Degradation' },
    score_flip: { icon: '🔄', label: 'Score Flip' },
};

// ─── Helpers ────────────────────────────────────────────────

function getStartDate(range: TimeRange): Date {
    const now = new Date();
    switch (range) {
        case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
        case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
}

function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
}

function formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAbsolute(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
}

function getDateGroup(dateStr: string): string {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── SeverityBadge ──────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
    const config = COLORS.severity[severity] ?? COLORS.severity.info;
    const icons: Record<string, string> = { critical: '⚠', warning: '●', info: 'ℹ' };
    const icon = icons[severity] ?? 'ℹ';

    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.3rem',
            padding: '2px 8px',
            borderRadius: '9999px',
            fontSize: '0.7rem',
            fontWeight: 600,
            fontFamily: FONT_SANS,
            background: config.bg,
            color: config.text,
            border: `1px solid ${config.border}`,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        }}>
            {icon} {severity}
        </span>
    );
}

// ─── AlertTypeLabel ─────────────────────────────────────────

function AlertTypeLabel({ alertType }: { alertType: string }) {
    const config = ALERT_TYPE_MAP[alertType] ?? { icon: '❓', label: alertType };
    return (
        <span style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            fontFamily: FONT_SANS,
            color: COLORS.textPrimary,
        }}>
            {config.icon} {config.label}
        </span>
    );
}

// ─── SummaryCard ────────────────────────────────────────────

function SummaryCard({ label, count, severity }: { label: string; count: number; severity: string }) {
    const config = COLORS.severity[severity] ?? COLORS.severity.info;
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.6rem 1rem',
            borderRadius: '8px',
            background: config.bg,
            border: `1px solid ${config.border}`,
            minWidth: '100px',
        }}>
            <span style={{
                fontSize: '1.4rem',
                fontWeight: 700,
                fontFamily: FONT_MONO,
                color: config.text,
            }}>
                {count}
            </span>
            <span style={{
                fontSize: '0.75rem',
                fontWeight: 500,
                fontFamily: FONT_SANS,
                color: config.text,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
            }}>
                {label}
            </span>
        </div>
    );
}

// ─── AlertCard ──────────────────────────────────────────────

function AlertCard({ alert, onAcknowledge, isNew }: { alert: AlertEvent; onAcknowledge: (id: string) => void; isNew?: boolean }) {
    const [expanded, setExpanded] = useState(false);

    const sevConfig = COLORS.severity[alert.severity] ?? COLORS.severity.info;

    // Build metadata key-value pairs from typed columns
    const details: { label: string; value: string }[] = [];
    if (alert.action_name) details.push({ label: 'Action', value: alert.action_name });
    if (alert.context_type) details.push({ label: 'Context', value: alert.context_type });
    if (alert.trend_delta != null) details.push({ label: 'Trend Δ', value: `${(alert.trend_delta * 100).toFixed(1)}%` });
    if (alert.current_success_rate != null) details.push({ label: 'Current Rate', value: `${(alert.current_success_rate * 100).toFixed(1)}%` });
    if (alert.previous_success_rate != null) details.push({ label: 'Previous Rate', value: `${(alert.previous_success_rate * 100).toFixed(1)}%` });
    if (alert.current_value != null) details.push({ label: 'Current Value', value: `${alert.current_value.toLocaleString()}` });
    if (alert.baseline_value != null) details.push({ label: 'Baseline', value: `${alert.baseline_value.toLocaleString()}` });
    if (alert.spike_ratio != null) details.push({ label: 'Spike Ratio', value: `${alert.spike_ratio.toFixed(1)}×` });
    if (alert.affected_agent_count != null) details.push({ label: 'Affected Agents', value: `${alert.affected_agent_count}` });
    if (alert.total_attempts != null) details.push({ label: 'Attempts', value: `${alert.total_attempts}` });

    return (
        <div
            style={{
                background: isNew ? 'rgba(16,185,129,0.08)' : COLORS.panel,
                border: `1px solid ${sevConfig.border}`,
                borderRadius: '8px',
                overflow: 'hidden',
                transition: 'background 2s ease-out, border-color 150ms',
            }}
        >
            {/* Collapsed header — always visible */}
            <button
                onClick={() => setExpanded(!expanded)}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.85rem 1rem',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: COLORS.textPrimary,
                    fontFamily: FONT_SANS,
                }}
            >
                <span style={{
                    fontSize: '0.75rem',
                    color: COLORS.textSecondary,
                    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 150ms',
                    flexShrink: 0,
                }}>
                    ▶
                </span>

                <SeverityBadge severity={alert.severity} />
                <AlertTypeLabel alertType={alert.alert_type} />

                <span style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    color: COLORS.textSecondary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: FONT_SANS,
                }}>
                    {alert.message ?? ''}
                </span>

                {alert.acknowledged && (
                    <span style={{
                        fontSize: '0.7rem',
                        color: '#4a5568',
                        fontFamily: FONT_SANS,
                        flexShrink: 0,
                    }}>
                        ✓ ACK
                    </span>
                )}

                <span
                    title={formatAbsolute(alert.detected_at)}
                    style={{
                        fontSize: '0.75rem',
                        color: COLORS.textSecondary,
                        fontFamily: FONT_MONO,
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                    }}
                >
                    {formatTime(alert.detected_at)}
                </span>
            </button>

            {/* Expanded details */}
            {expanded && (
                <div style={{
                    padding: '0 1rem 1rem 2.75rem',
                    borderTop: `1px solid ${COLORS.border}`,
                }}>
                    {/* Message */}
                    {alert.message && (
                        <p style={{
                            fontSize: '0.82rem',
                            lineHeight: 1.5,
                            color: COLORS.textPrimary,
                            fontFamily: FONT_SANS,
                            margin: '0.75rem 0 0.5rem',
                        }}>
                            {alert.message}
                        </p>
                    )}

                    {/* Detail key-value pairs */}
                    {details.length > 0 && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'auto 1fr',
                            gap: '0.25rem 1rem',
                            fontSize: '0.78rem',
                            fontFamily: FONT_MONO,
                            marginTop: '0.5rem',
                        }}>
                            {details.map(({ label, value }) => (
                                <React.Fragment key={label}>
                                    <span style={{ color: COLORS.textSecondary }}>{label}</span>
                                    <span style={{ color: COLORS.textPrimary }}>{value}</span>
                                </React.Fragment>
                            ))}
                        </div>
                    )}

                    {/* Timestamp + Acknowledge */}
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: '0.75rem',
                        paddingTop: '0.5rem',
                        borderTop: `1px solid ${COLORS.border}`,
                    }}>
                        <span style={{
                            fontSize: '0.72rem',
                            color: COLORS.textSecondary,
                            fontFamily: FONT_MONO,
                        }}>
                            {formatRelativeTime(alert.detected_at)} · {formatAbsolute(alert.detected_at)}
                        </span>

                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (!alert.acknowledged) onAcknowledge(alert.alert_id);
                            }}
                            disabled={alert.acknowledged}
                            style={{
                                padding: '0.3rem 0.75rem',
                                borderRadius: '6px',
                                border: alert.acknowledged
                                    ? '1px solid #2a3441'
                                    : `1px solid ${COLORS.border}`,
                                background: alert.acknowledged
                                    ? '#0e1320'
                                    : 'rgba(59,130,246,0.12)',
                                color: alert.acknowledged ? '#4a5568' : '#93c5fd',
                                fontSize: '0.75rem',
                                fontFamily: FONT_SANS,
                                fontWeight: 500,
                                cursor: alert.acknowledged ? 'default' : 'pointer',
                                transition: 'background 150ms',
                            }}
                        >
                            {alert.acknowledged ? '✓ Acknowledged' : 'Acknowledge'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── AlertFeed ──────────────────────────────────────────────

function AlertFeed({
    alerts,
    onAcknowledge,
    newAlertIds,
}: {
    alerts: AlertEvent[];
    onAcknowledge: (id: string) => void;
    newAlertIds?: Set<string>;
}) {
    if (alerts.length === 0) {
        return (
            <div style={{
                textAlign: 'center',
                padding: '4rem 2rem',
                color: COLORS.textSecondary,
                fontFamily: FONT_SANS,
            }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 500, marginBottom: '0.5rem', color: COLORS.textPrimary }}>
                    No alerts detected.
                </div>
                <div style={{ fontSize: '0.85rem' }}>
                    Layer5 is monitoring your agents. Alerts appear here when anomalies are detected.
                </div>
            </div>
        );
    }

    // Group by date
    const groups: { label: string; items: AlertEvent[] }[] = [];
    let currentLabel = '';
    for (const alert of alerts) {
        const label = getDateGroup(alert.detected_at);
        if (label !== currentLabel) {
            groups.push({ label, items: [] });
            currentLabel = label;
        }
        groups[groups.length - 1].items.push(alert);
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {groups.map((group) => (
                <React.Fragment key={group.label}>
                    {/* Date divider */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        margin: '0.75rem 0 0.25rem',
                    }}>
                        <span style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            fontFamily: FONT_MONO,
                            color: COLORS.textSecondary,
                            textTransform: 'uppercase',
                            letterSpacing: '0.1em',
                            whiteSpace: 'nowrap',
                        }}>
                            {group.label}
                        </span>
                        <div style={{
                            flex: 1,
                            height: '1px',
                            background: COLORS.border,
                        }} />
                    </div>

                    {/* Alert cards */}
                    {group.items.map((alert) => (
                        <AlertCard
                            key={alert.alert_id}
                            alert={alert}
                            onAcknowledge={onAcknowledge}
                            isNew={newAlertIds?.has(alert.alert_id)}
                        />
                    ))}
                </React.Fragment>
            ))}
        </div>
    );
}

// ─── Skeleton Loader ────────────────────────────────────────

function SkeletonCards() {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} style={{
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: '8px',
                    padding: '0.85rem 1rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                }}>
                    <div style={{ ...skeletonBlock, width: '70px', height: '20px' }} />
                    <div style={{ ...skeletonBlock, width: '120px', height: '16px' }} />
                    <div style={{ ...skeletonBlock, flex: 1, height: '14px' }} />
                    <div style={{ ...skeletonBlock, width: '50px', height: '14px' }} />
                </div>
            ))}
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

const skeletonBlock: React.CSSProperties = {
    background: '#1e2d45',
    borderRadius: '4px',
    animation: 'shimmer 1.5s ease-in-out infinite',
};

// ─── Main Page ──────────────────────────────────────────────

export default function AlertsPage() {
    const [alerts, setAlerts] = useState<AlertEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [timeRange, setTimeRange] = useState<TimeRange>('7d');
    const [typeFilter, setTypeFilter] = useState('all');
    const [severityFilter, setSeverityFilter] = useState('all');
    const [actionFilter, setActionFilter] = useState('all');
    const [newAlertIds, setNewAlertIds] = useState<Set<string>>(new Set());
    const newAlertTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const { showToast } = useToastContext();

    // ── Fetch ───────────────────────────────────────────────

    const fetchAlerts = useCallback(async () => {
        setLoading(true);
        setError(null);

        const start = getStartDate(timeRange);
        const { data, error: fetchErr } = await supabase
            .from('degradation_alert_events')
            .select('*')
            .gte('detected_at', start.toISOString())
            .order('detected_at', { ascending: false })
            .limit(200);

        if (fetchErr) {
            setError(fetchErr.message);
            setLoading(false);
            return;
        }

        setAlerts((data ?? []) as AlertEvent[]);
        setLoading(false);
    }, [timeRange]);

    useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

    // ── Realtime subscription via hook ──────────────────────

    const handleNewAlert = useCallback((newAlert: AlertEvent) => {
        setAlerts((prev) => [newAlert, ...prev].slice(0, 200));

        // Highlight for 2 seconds
        setNewAlertIds((prev) => new Set(prev).add(newAlert.alert_id));
        const timer = setTimeout(() => {
            setNewAlertIds((prev) => {
                const next = new Set(prev);
                next.delete(newAlert.alert_id);
                return next;
            });
        }, 2000);
        newAlertTimers.current.set(newAlert.alert_id, timer);

        // Toast for critical alerts
        if (newAlert.severity === 'critical') {
            showToast(
                newAlert.message ?? `Critical alert: ${newAlert.alert_type}`,
                'critical',
                8000,
            );
        }
    }, [showToast]);

    const { isConnected: realtimeConnected } = useRealtimeAlerts(
        handleNewAlert as any,
    );

    // Clean up highlight timers
    useEffect(() => {
        const timers = newAlertTimers.current;
        return () => {
            timers.forEach((t) => clearTimeout(t));
            timers.clear();
        };
    }, []);

    // ── Acknowledge ─────────────────────────────────────────

    async function acknowledgeAlert(alertId: string) {
        // Optimistic update
        setAlerts((prev) =>
            prev.map((a) =>
                a.alert_id === alertId ? { ...a, acknowledged: true } : a
            )
        );

        const { error: ackErr } = await supabase
            .from('degradation_alert_events')
            .update({ acknowledged: true })
            .eq('alert_id', alertId);

        // Revert on failure
        if (ackErr) {
            setAlerts((prev) =>
                prev.map((a) =>
                    a.alert_id === alertId ? { ...a, acknowledged: false } : a
                )
            );
        }
    }

    // ── Filtering ───────────────────────────────────────────

    const filtered = alerts.filter((a) => {
        if (typeFilter !== 'all' && a.alert_type !== typeFilter) return false;
        if (severityFilter !== 'all' && a.severity !== severityFilter) return false;
        if (actionFilter !== 'all' && a.action_name !== actionFilter) return false;
        return true;
    });

    // Unique action names for filter dropdown
    const actionNames = [...new Set(alerts.map((a) => a.action_name).filter(Boolean))] as string[];

    // Summary counts
    const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
    const warningCount = alerts.filter((a) => a.severity === 'warning').length;
    const infoCount = alerts.filter((a) => a.severity === 'info').length;

    // ── Render ──────────────────────────────────────────────

    return (
        <div style={{ fontFamily: FONT_SANS, color: COLORS.textPrimary }}>
            {/* Font import */}
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
                @keyframes pulse-live {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.4; }
                }
            `}</style>

            {/* Header */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '0.5rem',
            }}>
                <div>
                    <h1 style={{
                        fontSize: '1.5rem',
                        fontWeight: 600,
                        color: COLORS.textPrimary,
                        margin: 0,
                        fontFamily: FONT_SANS,
                    }}>
                        Gap Detection
                    </h1>
                    <p style={{
                        fontSize: '0.82rem',
                        color: COLORS.textSecondary,
                        margin: '0.25rem 0 0',
                        fontFamily: FONT_SANS,
                    }}>
                        Layer5 is monitoring your agents continuously
                    </p>
                </div>
                <LiveIndicator isConnected={realtimeConnected} />
            </div>

            {/* Summary cards */}
            <div style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                marginBottom: '1rem',
            }}>
                <SummaryCard label="Critical" count={criticalCount} severity="critical" />
                <SummaryCard label="Warning" count={warningCount} severity="warning" />
                <SummaryCard label="Info" count={infoCount} severity="info" />
                <span style={{
                    fontSize: '0.78rem',
                    color: COLORS.textSecondary,
                    fontFamily: FONT_SANS,
                    marginLeft: '0.5rem',
                }}>
                    {alerts.length} alert{alerts.length !== 1 ? 's' : ''} last {timeRange === '24h' ? '24 hours' : timeRange === '7d' ? '7 days' : '30 days'}
                </span>
            </div>

            {/* Alert type breakdown */}
            <div style={{ marginBottom: '1rem' }}>
                <AlertTypeSummary
                    alerts={alerts}
                    activeType={typeFilter}
                    onTypeSelect={setTypeFilter}
                />
            </div>

            {/* Filters */}
            <div style={{
                display: 'flex',
                gap: '0.75rem',
                flexWrap: 'wrap',
                alignItems: 'center',
                padding: '0.75rem 1rem',
                background: COLORS.panel,
                border: `1px solid ${COLORS.border}`,
                borderRadius: '8px',
                marginBottom: '1rem',
            }}>
                <span style={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    fontFamily: FONT_MONO,
                    color: COLORS.textSecondary,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                }}>
                    Filters
                </span>

                <select
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                    style={selectStyle}
                >
                    <option value="all">All Severity</option>
                    <option value="critical">Critical</option>
                    <option value="warning">Warning</option>
                    <option value="info">Info</option>
                </select>

                <select
                    value={timeRange}
                    onChange={(e) => setTimeRange(e.target.value as TimeRange)}
                    style={selectStyle}
                >
                    <option value="24h">Last 24h</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                </select>

                <select
                    value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    style={selectStyle}
                >
                    <option value="all">All Actions</option>
                    {actionNames.map((name) => (
                        <option key={name} value={name}>{name}</option>
                    ))}
                </select>

                {filtered.length !== alerts.length && (
                    <span style={{
                        fontSize: '0.75rem',
                        color: COLORS.textSecondary,
                        fontFamily: FONT_SANS,
                        marginLeft: 'auto',
                    }}>
                        Showing {filtered.length} of {alerts.length} alerts
                    </span>
                )}
            </div>

            {/* Content: loading / error / feed */}
            {loading ? (
                <SkeletonCards />
            ) : error ? (
                <div style={{
                    textAlign: 'center',
                    padding: '3rem',
                    color: COLORS.severity.critical.text,
                    fontFamily: FONT_SANS,
                }}>
                    <div style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                        Failed to load alerts: {error}
                    </div>
                    <button
                        onClick={fetchAlerts}
                        style={{
                            padding: '0.4rem 1rem',
                            borderRadius: '6px',
                            border: `1px solid ${COLORS.border}`,
                            background: COLORS.panel,
                            color: COLORS.textPrimary,
                            fontSize: '0.82rem',
                            fontFamily: FONT_SANS,
                            cursor: 'pointer',
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : (
                <AlertFeed alerts={filtered} onAcknowledge={acknowledgeAlert} newAlertIds={newAlertIds} />
            )}
        </div>
    );
}

// ─── Shared Styles ──────────────────────────────────────────

const selectStyle: React.CSSProperties = {
    padding: '0.35rem 0.6rem',
    borderRadius: '6px',
    border: `1px solid ${COLORS.border}`,
    background: COLORS.bg,
    color: COLORS.textPrimary,
    fontSize: '0.78rem',
    fontFamily: FONT_SANS,
    cursor: 'pointer',
    outline: 'none',
};
