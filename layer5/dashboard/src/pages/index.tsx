/**
 * Score Leaderboard Page (/)
 * Data Source: mv_action_scores
 * Shows ScoreCard per action, grouped by context, with TrendBadge.
 */
import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import ScoreCard from '../components/ScoreCard';
import TrendBadge from '../components/TrendBadge';

interface ActionScore {
    action_id: string;
    context_id: string;
    customer_id: string;
    action_name: string;
    action_category: string;
    raw_success_rate: number;
    weighted_success_rate: number;
    confidence: number;
    total_attempts: number;
    trend_delta: number | null;
}

export default function ScoreLeaderboard() {
    const [scores, setScores] = useState<ActionScore[]>([]);
    const [loading, setLoading] = useState(true);
    const [contextFilter, setContextFilter] = useState<string>('all');

    useEffect(() => {
        fetchScores();
    }, []);

    async function fetchScores() {
        setLoading(true);
        const { data, error } = await supabase
            .from('mv_action_scores')
            .select('*')
            .order('weighted_success_rate', { ascending: false });

        if (!error && data) setScores(data as ActionScore[]);
        setLoading(false);
    }

    // Group by context_id
    const contextIds = [...new Set(scores.map(s => s.context_id))];
    const filtered = contextFilter === 'all' ? scores : scores.filter(s => s.context_id === contextFilter);

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                    Score Leaderboard
                </h1>
                <select
                    value={contextFilter}
                    onChange={e => setContextFilter(e.target.value)}
                    style={{ padding: '0.4rem 0.8rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                >
                    <option value="all">All Contexts</option>
                    {contextIds.map(id => (
                        <option key={id} value={id}>{id.slice(0, 8)}...</option>
                    ))}
                </select>
            </div>

            {loading ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '3rem' }}>Loading scores...</div>
            ) : filtered.length === 0 ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '3rem' }}>
                    No scores available. Log at least one outcome to populate the materialized view.
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
                    {filtered.map(s => (
                        <ScoreCard
                            key={`${s.action_id}-${s.context_id}`}
                            actionName={s.action_name}
                            actionCategory={s.action_category}
                            compositeScore={s.weighted_success_rate}
                            successRate={s.raw_success_rate}
                            confidence={s.confidence}
                            totalAttempts={s.total_attempts}
                            trendDelta={s.trend_delta}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
