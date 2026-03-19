/**
 * Outcome History Page (/outcomes)
 * Data Source: fact_outcomes + joins to dim_actions, dim_agents, dim_contexts
 * Paginated, filterable by date/agent/context.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import OutcomeTable from '../components/OutcomeTable';
import LiveIndicator from '../components/LiveIndicator';
import { useRealtimeOutcomes } from '../hooks/useRealtimeOutcomes';

interface OutcomeRow {
    outcome_id: string;
    action_name: string;
    issue_type: string;
    success: boolean;
    timestamp: string;
    response_time_ms: number | null;
    agent_name: string;
    error_code: string | null;
}

const PAGE_SIZE = 25;

export default function OutcomeHistory() {
    const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(true);
    const [filterSuccess, setFilterSuccess] = useState<'all' | 'true' | 'false'>('all');

    const fetchOutcomes = useCallback(async () => {
        setLoading(true);
        setError(null);

        let query = supabase
            .from('fact_outcomes')
            .select(`
                outcome_id, success, timestamp, response_time_ms, error_code,
                dim_actions!inner(action_name),
                dim_agents!inner(agent_name),
                dim_contexts!inner(issue_type)
            `)
            .eq('is_deleted', false)
            .eq('is_synthetic', false)
            .order('timestamp', { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        if (filterSuccess !== 'all') {
            query = query.eq('success', filterSuccess === 'true');
        }

        const { data, error: queryError } = await query;

        if (queryError) {
            setError(queryError.message);
            setOutcomes([]);
            setHasMore(false);
            setLoading(false);
            return;
        }

        const mapped: OutcomeRow[] = (data ?? []).map((r: any) => ({
            outcome_id: r.outcome_id,
            action_name: r.dim_actions?.action_name ?? '',
            issue_type: r.dim_contexts?.issue_type ?? '',
            success: r.success,
            timestamp: r.timestamp,
            response_time_ms: r.response_time_ms,
            agent_name: r.dim_agents?.agent_name ?? '',
            error_code: r.error_code,
        }));
        setOutcomes(mapped);
        setHasMore(mapped.length === PAGE_SIZE);
        setLoading(false);
    }, [page, filterSuccess]);

    useEffect(() => { void fetchOutcomes(); }, [fetchOutcomes]);

    // ── Realtime ──────────────────────────────────────

    const handleNewOutcome = useCallback(() => {
        // Only prepend on first page to avoid confusion
        if (page !== 0) return;
        void fetchOutcomes();
    }, [page, fetchOutcomes]);

    const { isConnected } = useRealtimeOutcomes(handleNewOutcome);

    return (
        <div>
            <style>{`
                @keyframes outcome-slide-in {
                    from { transform: translateY(-12px); opacity: 0; }
                    to   { transform: translateY(0); opacity: 1; }
                }
            `}</style>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                        Outcome History
                    </h1>
                    <LiveIndicator isConnected={isConnected} />
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <select
                        value={filterSuccess}
                        onChange={e => { setFilterSuccess(e.target.value as any); setPage(0); }}
                        style={{ padding: '0.4rem 0.8rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                    >
                        <option value="all">All Results</option>
                        <option value="true">Successes Only</option>
                        <option value="false">Failures Only</option>
                    </select>
                </div>
            </div>

            <OutcomeTable outcomes={outcomes} loading={loading} />

            {!loading && error && (
                <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.30)', background: 'rgba(239,68,68,0.10)', color: '#fca5a5' }}>
                    <span>{error}</span>
                    <button onClick={fetchOutcomes} style={{ ...btnStyle, color: '#fff', borderColor: '#334155', background: '#0f172a' }}>Retry</button>
                </div>
            )}

            {!loading && !error && outcomes.length === 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '4rem 1rem' }}>
                    <div style={{ fontSize: '2.5rem', opacity: 0.2, marginBottom: '0.75rem' }}>📋</div>
                    <h3 style={{ color: '#1e293b', margin: 0, fontSize: '1.1rem' }}>No outcomes logged yet</h3>
                    <p style={{ color: '#64748b', marginTop: '0.5rem', maxWidth: 420, lineHeight: 1.5 }}>
                        Every decision your agent makes is recorded here. Start logging outcomes to build your audit trail.
                    </p>
                </div>
            )}

            {/* Pagination */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '1.5rem' }}>
                <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    style={btnStyle}
                >
                    ← Previous
                </button>
                <span style={{ color: '#64748b', fontSize: '0.85rem', lineHeight: '2.2' }}>Page {page + 1}</span>
                <button
                    onClick={() => setPage(p => p + 1)}
                    disabled={!hasMore}
                    style={btnStyle}
                >
                    Next →
                </button>
            </div>
        </div>
    );
}

const btnStyle: React.CSSProperties = {
    padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid #cbd5e1',
    background: '#fff', cursor: 'pointer', fontSize: '0.85rem', color: '#475569',
};
