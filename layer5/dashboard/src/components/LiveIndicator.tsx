import React from 'react';

interface LiveIndicatorProps {
    isConnected: boolean;
    label?: string;
}

export default function LiveIndicator({ isConnected, label }: LiveIndicatorProps) {
    return (
        <>
            <style>{`
                @keyframes pulse-dot {
                    0%   { opacity: 1; transform: scale(1); }
                    50%  { opacity: 0.4; transform: scale(0.85); }
                    100% { opacity: 1; transform: scale(1); }
                }
            `}</style>
            <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                fontSize: '0.75rem',
                fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
                color: isConnected ? '#10b981' : '#4a5568',
            }}>
                <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: isConnected ? '#10b981' : '#4a5568',
                    animation: isConnected ? 'pulse-dot 1.8s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                }} />
                {label ?? (isConnected ? 'LIVE' : '—')}
            </div>
        </>
    );
}
