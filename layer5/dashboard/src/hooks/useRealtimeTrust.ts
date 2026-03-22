// REQUIRES: Realtime enabled on agent_trust_scores in Supabase Dashboard
// → Table Editor → agent_trust_scores → Realtime toggle → ON

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

export interface TrustRow {
    trust_id: string;
    agent_id: string;
    trust_score: number;
    trust_status: 'trusted' | 'probation' | 'suspended';
    consecutive_failures: number;
    total_decisions: number;
    correct_decisions: number;
}

export function useRealtimeTrust(
    onTrustChange: (trust: TrustRow) => void,
): { isConnected: boolean } {
    const [isConnected, setIsConnected] = useState(false);
    const channelId = useRef(crypto.randomUUID());

    useEffect(() => {
        const channel = supabase
            .channel(`realtime-trust-${channelId.current}`)
            .on(
                'postgres_changes' as any,
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'agent_trust_scores',
                },
                (payload: any) => {
                    onTrustChange(payload.new as TrustRow);
                },
            )
            .on(
                'postgres_changes' as any,
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'agent_trust_scores',
                },
                (payload: any) => {
                    onTrustChange(payload.new as TrustRow);
                },
            )
            .subscribe((status: string) => {
                setIsConnected(status === 'SUBSCRIBED');
            });

        return () => {
            void channel.unsubscribe();
        };
    }, []); // subscribe once

    return { isConnected };
}
