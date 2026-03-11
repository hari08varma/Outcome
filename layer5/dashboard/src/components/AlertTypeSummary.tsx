/**
 * AlertTypeSummary — Horizontal row of alert-type count cards.
 * Clickable to set type filter. Zero-count cards are dimmed.
 */
import React from 'react';

interface AlertEvent {
    alert_type: string;
}

interface AlertTypeSummaryProps {
    alerts: AlertEvent[];
    activeType: string;
    onTypeSelect: (type: string) => void;
}

const ALERT_TYPES: { key: string; icon: string; label: string }[] = [
    { key: 'coordinated_failure', icon: '⛔', label: 'Coordinated' },
    { key: 'degradation', icon: '📉', label: 'Degradation' },
    { key: 'latency_spike', icon: '⚡', label: 'Latency' },
    { key: 'context_drift', icon: '🌀', label: 'Drift' },
    { key: 'score_flip', icon: '🔄', label: 'Score Flip' },
];

export default function AlertTypeSummary({ alerts, activeType, onTypeSelect }: AlertTypeSummaryProps) {
    const counts: Record<string, number> = {};
    for (const a of alerts) {
        counts[a.alert_type] = (counts[a.alert_type] ?? 0) + 1;
    }

    return (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {ALERT_TYPES.map(({ key, icon, label }) => {
                const count = counts[key] ?? 0;
                const isActive = activeType === key;
                const dimmed = count === 0 && !isActive;

                return (
                    <button
                        key={key}
                        onClick={() => onTypeSelect(isActive ? 'all' : key)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            padding: '0.35rem 0.65rem',
                            borderRadius: '6px',
                            border: isActive ? '1px solid #93c5fd' : '1px solid #1e2d45',
                            background: isActive ? 'rgba(59,130,246,0.12)' : '#0e1320',
                            color: dimmed ? '#4a5568' : '#f0f4ff',
                            fontSize: '0.78rem',
                            fontFamily: "'IBM Plex Sans', 'Inter', system-ui, sans-serif",
                            fontWeight: 500,
                            cursor: 'pointer',
                            opacity: dimmed ? 0.5 : 1,
                            transition: 'border-color 150ms, opacity 150ms',
                        }}
                    >
                        <span>{icon}</span>
                        <span>{label}</span>
                        <span style={{
                            fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
                            fontWeight: 600,
                            fontSize: '0.75rem',
                            color: dimmed ? '#4a5568' : '#93c5fd',
                        }}>
                            {count}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
