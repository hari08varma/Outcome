import React from 'react';

interface TrendBadgeProps {
    trendDelta: number | null;
    size?: 'sm' | 'md';
}

export default function TrendBadge({ trendDelta, size = 'md' }: TrendBadgeProps) {
    const label = getLabel(trendDelta);
    const { bg, fg } = getColors(trendDelta);
    const fontSize = size === 'sm' ? '0.7rem' : '0.8rem';
    const padding = size === 'sm' ? '1px 6px' : '2px 10px';

    return (
        <span style={{
            display: 'inline-block', fontSize, padding, borderRadius: '9999px',
            background: bg, color: fg, fontWeight: 600,
        }}>
            {label}
        </span>
    );
}

function getLabel(delta: number | null): string {
    if (delta === null) return 'stable';
    if (delta < -0.15) return 'critical';
    if (delta < -0.05) return 'degrading';
    if (delta > 0.05) return 'improving';
    return 'stable';
}

function getColors(delta: number | null): { bg: string; fg: string } {
    if (delta === null) return { bg: '#f1f5f9', fg: '#64748b' };
    if (delta < -0.15) return { bg: '#fef2f2', fg: '#dc2626' };
    if (delta < -0.05) return { bg: '#fff7ed', fg: '#ea580c' };
    if (delta > 0.05) return { bg: '#f0fdf4', fg: '#16a34a' };
    return { bg: '#f1f5f9', fg: '#64748b' };
}
