// REQUIRES: Realtime enabled on degradation_alert_events in Supabase Dashboard
// → Table Editor → degradation_alert_events → Realtime toggle → ON

import { useEffect, useState } from 'react';
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

    useEffect(() => {
        const channel = supabase
            .channel('realtime-alerts')
            .on(
                'postgres_changes' as any,
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'degradation_alert_events',
                },
                (payload: any) => {
                    onNewAlert(payload.new as AlertRow);
                },
            )
            .subscribe((status: string) => {
                setIsConnected(status === 'SUBSCRIBED');
            });

        return () => {
            supabase.removeChannel(channel);
        };
    }, []); // subscribe once

    return { isConnected };
}
