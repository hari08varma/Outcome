import React, { createContext, useContext } from 'react';
import type { Toast, ToastType } from '../hooks/useToast';

interface ToastContextValue {
    toasts: Toast[];
    showToast: (message: string, type?: ToastType, duration?: number) => string;
    dismissToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue>({
    toasts: [],
    showToast: () => '',
    dismissToast: () => {},
});

export function useToastContext() {
    return useContext(ToastContext);
}

// ─── Toast Renderer ─────────────────────────────────────────

const TYPE_STYLES: Record<ToastType, { bg: string; border: string; icon: string }> = {
    critical: { bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.4)', icon: '⚠' },
    warning: { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', icon: '●' },
    info: { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.4)', icon: 'ℹ' },
    success: { bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.4)', icon: '✓' },
};

const TYPE_TEXT: Record<ToastType, string> = {
    critical: '#fca5a5',
    warning: '#fcd34d',
    info: '#93c5fd',
    success: '#6ee7b7',
};

export function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
    if (toasts.length === 0) return null;

    return (
        <div style={{
            position: 'fixed',
            top: '1rem',
            right: '1rem',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            maxWidth: '380px',
            pointerEvents: 'none',
        }}>
            <style>{`
                @keyframes toast-slide-in {
                    from { transform: translateX(100%); opacity: 0; }
                    to   { transform: translateX(0); opacity: 1; }
                }
            `}</style>
            {toasts.map((toast) => {
                const s = TYPE_STYLES[toast.type] ?? TYPE_STYLES.info;
                const textColor = TYPE_TEXT[toast.type] ?? '#93c5fd';
                return (
                    <div
                        key={toast.id}
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.5rem',
                            padding: '0.65rem 0.85rem',
                            borderRadius: '8px',
                            background: s.bg,
                            border: `1px solid ${s.border}`,
                            backdropFilter: 'blur(8px)',
                            fontSize: '0.8rem',
                            fontFamily: "'IBM Plex Sans', 'Inter', system-ui, sans-serif",
                            color: textColor,
                            animation: 'toast-slide-in 200ms ease-out',
                            pointerEvents: 'auto',
                        }}
                    >
                        <span style={{ flexShrink: 0, fontSize: '0.9rem' }}>{s.icon}</span>
                        <span style={{ flex: 1, lineHeight: 1.4 }}>{toast.message}</span>
                        <button
                            onClick={() => onDismiss(toast.id)}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: textColor,
                                cursor: 'pointer',
                                fontSize: '1rem',
                                lineHeight: 1,
                                padding: 0,
                                flexShrink: 0,
                                opacity: 0.7,
                            }}
                            aria-label="Dismiss"
                        >
                            ×
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
