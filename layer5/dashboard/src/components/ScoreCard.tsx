import React from 'react';

interface ScoreCardProps {
    actionName: string;
    actionCategory: string;
    compositeScore: number;
    successRate: number;
    confidence: number;
    totalAttempts: number;
    trendDelta: number | null;
}

const categoryColors: Record<string, string> = {
    recovery: '#3b82f6',
    escalation: '#ef4444',
    automation: '#10b981',
};

export default function ScoreCard({
    actionName, actionCategory, compositeScore, successRate, confidence, totalAttempts, trendDelta,
}: ScoreCardProps) {
    const scoreColor = compositeScore >= 0.65 ? '#16a34a' : compositeScore >= 0.4 ? '#ca8a04' : '#dc2626';
    const catColor = categoryColors[actionCategory] ?? '#6b7280';

    return (
        <div style={{
            border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.25rem',
            background: '#fff', minWidth: '240px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.95rem', color: '#1e293b' }}>{actionName}</span>
                <span style={{
                    fontSize: '0.7rem', padding: '2px 8px', borderRadius: '9999px',
                    background: catColor + '15', color: catColor, fontWeight: 500,
                }}>{actionCategory}</span>
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: scoreColor, marginBottom: '0.5rem' }}>
                {(compositeScore * 100).toFixed(1)}%
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.8rem', color: '#64748b' }}>
                <div>Success: <strong>{(successRate * 100).toFixed(1)}%</strong></div>
                <div>Confidence: <strong>{(confidence * 100).toFixed(0)}%</strong></div>
                <div>Attempts: <strong>{totalAttempts}</strong></div>
                <div>Trend: <TrendDelta delta={trendDelta} /></div>
            </div>
        </div>
    );
}

function TrendDelta({ delta }: { delta: number | null }) {
    if (delta === null) return <span style={{ color: '#94a3b8' }}>—</span>;
    const color = delta > 0.05 ? '#16a34a' : delta < -0.05 ? '#dc2626' : '#64748b';
    const arrow = delta > 0.05 ? '↑' : delta < -0.05 ? '↓' : '→';
    return <strong style={{ color }}>{arrow} {(delta * 100).toFixed(1)}%</strong>;
}
