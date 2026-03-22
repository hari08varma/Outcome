// REQUIRES: Realtime enabled on fact_outcomes in Supabase Dashboard
// → Table Editor → fact_outcomes → Realtime toggle → ON

import { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabaseClient';

export interface OutcomeRow {
    outcome_id: string;
    agent_id: string;
    action_id: string | null;
    context_id: string | null;
    success: boolean;
    timestamp: string;
    response_time_ms: number | null;
    error_code: string | null;
}

export function useRealtimeOutcomes(
    onNewOutcome: (outcome: OutcomeRow) => void,
    agentId?: string,
): { isConnected: boolean } {
    const [isConnected, setIsConnected] = useState(false);
    const fallbackRef = useRef(false);
    const onNewOutcomeRef = useRef(onNewOutcome);
    onNewOutcomeRef.current = onNewOutcome;

    useEffect(() => {
        const channelName = agentId
            ? `realtime-outcomes-${agentId}`
            : 'realtime-outcomes';

        const opts: Record<string, any> = {
            event: 'INSERT',
            schema: 'public',
            table: 'fact_outcomes',
        };

        // Try server-side filter if agentId is provided
        if (agentId) {
            opts.filter = `agent_id=eq.${agentId}`;
        }

        const channel = supabase
            .channel(channelName)
            .on(
                'postgres_changes' as any,
                opts,
                (payload: any) => {
                    const row = payload.new as OutcomeRow;
                    // Client-side filter as fallback
                    if (agentId && fallbackRef.current && row.agent_id !== agentId) {
                        return;
                    }
                    onNewOutcomeRef.current(row);
                },
            )
            .subscribe((status: string) => {
                setIsConnected(status === 'SUBSCRIBED');
            });

        return () => {
            void supabase.removeChannel(channel);
        };
    }, [agentId]); // re-subscribe if agentId changes

    return { isConnected };
}
