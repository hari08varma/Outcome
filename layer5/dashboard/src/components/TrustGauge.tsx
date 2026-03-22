import React from 'react';

interface TrustGaugeProps {
    agentName: string;
    trustScore: number;
    trustStatus: 'trusted' | 'probation' | 'sandbox' | 'suspended' | 'new' | 'degraded';
    consecutiveFailures: number;
    totalDecisions: number;
    correctDecisions: number;
}

const statusConfig: Record<string, { bg: string; fg: string; label: string }> = {
    trusted:   { bg: '#f0fdf4', fg: '#16a34a', label: 'TRUSTED' },
    probation: { bg: '#fff7ed', fg: '#ea580c', label: 'PROBATION' },
    sandbox:   { bg: '#fefce8', fg: '#ca8a04', label: 'SANDBOX' },
    suspended: { bg: '#fef2f2', fg: '#dc2626', label: 'SUSPENDED' },
    new:       { bg: '#eff6ff', fg: '#3b82f6', label: 'NEW' },
    degraded:  { bg: '#fdf4ff', fg: '#a855f7', label: 'DEGRADED' },
};

export default function TrustGauge({
    agentName, trustScore, trustStatus, consecutiveFailures, totalDecisions, correctDecisions,
}: TrustGaugeProps) {
    const config = statusConfig[trustStatus] ?? statusConfig.probation;
    const pct = Math.round(trustScore * 100);
    const accuracyPct = totalDecisions > 0 ? Math.round((correctDecisions / totalDecisions) * 100) : 0;

    // SVG gauge arc
    const radius = 45;
    const circumference = Math.PI * radius; // half-circle
    const offset = circumference - (trustScore * circumference);

    return (
        <div style={{
            border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem',
            background: '#fff', minWidth: '260px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            textAlign: 'center',
        }}>
            {/* Agent name + status badge */}
            <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontWeight: 600, fontSize: '1rem', color: '#1e293b', marginBottom: '0.25rem' }}>{agentName}</div>
                <span style={{
                    display: 'inline-block', fontSize: '0.7rem', padding: '2px 10px', borderRadius: '9999px',
                    background: config.bg, color: config.fg, fontWeight: 700,
                }}>{config.label}</span>
            </div>

            {/* Trust gauge (half-circle SVG) */}
            <svg width="120" height="70" viewBox="0 0 120 70" style={{ margin: '0 auto', display: 'block' }}>
                {/* Background arc */}
                <path
                    d="M 10 65 A 45 45 0 0 1 110 65"
                    fill="none" stroke="#e2e8f0" strokeWidth="8" strokeLinecap="round"
                />
                {/* Foreground arc */}
                <path
                    d="M 10 65 A 45 45 0 0 1 110 65"
                    fill="none" stroke={config.fg} strokeWidth="8" strokeLinecap="round"
                    strokeDasharray={`${circumference}`}
                    strokeDashoffset={`${offset}`}
                    style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                />
                {/* Score text */}
                <text x="60" y="58" textAnchor="middle" fontSize="18" fontWeight="700" fill={config.fg}>
                    {pct}%
                </text>
            </svg>

            {/* Stats grid */}
            <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem',
                fontSize: '0.78rem', color: '#64748b', marginTop: '0.75rem', textAlign: 'left',
                padding: '0 0.5rem',
            }}>
                <div>Decisions: <strong style={{ color: '#1e293b' }}>{totalDecisions}</strong></div>
                <div>Accuracy: <strong style={{ color: '#1e293b' }}>{accuracyPct}%</strong></div>
                <div>Failures: <strong style={{ color: consecutiveFailures >= 3 ? '#dc2626' : '#1e293b' }}>{consecutiveFailures}</strong></div>
                <div>Score: <strong style={{ color: config.fg }}>{trustScore.toFixed(3)}</strong></div>
            </div>
        </div>
    );
}
