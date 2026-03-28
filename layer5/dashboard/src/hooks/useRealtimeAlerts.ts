// REQUIRES: Realtime enabled on degradation_alert_events in Supabase Dashboard
// → Table Editor → degradation_alert_events → Realtime toggle → ON

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface AlertRow {
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

export function useRealtimeAlerts(
    onNewAlert: (alert: AlertRow) => void,
): { isConnected: boolean } {
    const [isConnected, setIsConnected] = useState(false);
    const channelId = useRef(crypto.randomUUID());
    const onNewAlertRef = useRef(onNewAlert);
    onNewAlertRef.current = onNewAlert;

    useEffect(() => {
        const channel = supabase
            .channel(`realtime-alerts-${channelId.current}`)
            .on<AlertRow>(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'degradation_alert_events' },
                (payload) => {
                    onNewAlertRef.current(payload.new);
                },
            )
            .subscribe((status) => {
                setIsConnected(status === 'SUBSCRIBED');
            });

        return () => {
            void supabase.removeChannel(channel);
        };
    }, []); // subscribe once

    return { isConnected };
}
