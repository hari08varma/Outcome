import { useState, useCallback, useRef } from 'react';

export type ToastType = 'critical' | 'warning' | 'info' | 'success';

export interface Toast {
    id: string;
    message: string;
    type: ToastType;
    duration: number;
}

let _idCounter = 0;

export function useToast() {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    const dismissToast = useCallback((id: string) => {
        const timer = timersRef.current.get(id);
        if (timer) {
            clearTimeout(timer);
            timersRef.current.delete(id);
        }
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const showToast = useCallback(
        (message: string, type: ToastType = 'info', duration = 5000) => {
            const id = `toast-${++_idCounter}-${Date.now()}`;
            const toast: Toast = { id, message, type, duration };

            setToasts((prev) => [...prev, toast]);

            if (duration > 0) {
                const timer = setTimeout(() => {
                    timersRef.current.delete(id);
                    setToasts((prev) => prev.filter((t) => t.id !== id));
                }, duration);
                timersRef.current.set(id, timer);
            }

            return id;
        },
        [],
    );

    return { toasts, showToast, dismissToast };
}
