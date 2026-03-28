// REQUIRES: Realtime enabled on agent_trust_scores in Supabase Dashboard
// → Table Editor → agent_trust_scores → Realtime toggle → ON

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface TrustRow {
    trust_id: string;
    agent_id: string;
    trust_score: number;
    trust_status: 'trusted' | 'probation' | 'sandbox' | 'suspended' | 'new' | 'degraded';
    consecutive_failures: number;
    total_decisions: number;
    correct_decisions: number;
}

export function useRealtimeTrust(
    onTrustChange: (trust: TrustRow) => void,
): { isConnected: boolean } {
    const [isConnected, setIsConnected] = useState(false);
    const channelId = useRef(crypto.randomUUID());
    const onTrustChangeRef = useRef(onTrustChange);
    onTrustChangeRef.current = onTrustChange;

    useEffect(() => {
        const channel = supabase
            .channel(`realtime-trust-${channelId.current}`)
            .on<TrustRow>(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'agent_trust_scores' },
                (payload) => { onTrustChangeRef.current(payload.new); },
            )
            .on<TrustRow>(
                'postgres_changes',
                { event: 'UPDATE', schema: 'public', table: 'agent_trust_scores' },
                (payload) => { onTrustChangeRef.current(payload.new); },
            )
            .subscribe((status) => {
                setIsConnected(status === 'SUBSCRIBED');
            });

        return () => { void supabase.removeChannel(channel); };
    }, []); // subscribe once

    return { isConnected };
}
