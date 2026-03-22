/**
 * Trust Status Page (/trust)
 * Data Source: agent_trust_scores + agent_trust_audit
 * Shows TrustGauge per agent, suspension log, reinstate button.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import TrustGauge from '../components/TrustGauge';
import LiveIndicator from '../components/LiveIndicator';
import { useRealtimeTrust } from '../hooks/useRealtimeTrust';
import type { TrustRow as RealtimeTrustRow } from '../hooks/useRealtimeTrust';
import { useToastContext } from '../components/Toast';

interface TrustRow {
    trust_id: string;
    agent_id: string;
    trust_score: number;
    trust_status: 'trusted' | 'probation' | 'sandbox' | 'suspended' | 'new' | 'degraded';
    consecutive_failures: number;
    total_decisions: number;
    correct_decisions: number;
    agent_name?: string;
}

interface AuditEvent {
    audit_id: string;
    agent_id: string;
    event_type: string;
    old_score: number | null;
    new_score: number | null;
    old_status: string | null;
    new_status: string | null;
    performed_by: string | null;
    reason: string | null;
    performed_at: string;
}

export default function TrustStatus() {
    const [agents, setAgents] = useState<TrustRow[]>([]);
    const [auditLog, setAuditLog] = useState<AuditEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [flashAgentId, setFlashAgentId] = useState<string | null>(null);
    const { showToast } = useToastContext();

    useEffect(() => { fetchData(); }, []);

    // ── Realtime trust updates ──────────────────────

    const handleTrustChange = useCallback((incoming: RealtimeTrustRow) => {
        setAgents((prev) => {
            const idx = prev.findIndex((a) => a.agent_id === incoming.agent_id);
            if (idx >= 0) {
                // UPDATE: replace in-place
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...incoming };
                return updated;
            }
            // INSERT: new agent
            return [...prev, { ...incoming, agent_name: incoming.agent_id.slice(0, 8) }];
        });

        // Flash the gauge
        setFlashAgentId(incoming.agent_id);
        setTimeout(() => setFlashAgentId(null), 1500);

        // Suspension warning
        if (incoming.trust_score < 0.3) {
            showToast(
                `Agent ${incoming.agent_id.slice(0, 8)} trust dropped to ${(incoming.trust_score * 100).toFixed(1)}% — suspended`,
                'critical',
                8000,
            );
        }
    }, [showToast]);

    const { isConnected } = useRealtimeTrust(handleTrustChange);

    async function fetchData() {
        setLoading(true);

        // Fetch trust scores with agent names
        const { data: trustData } = await supabase
            .from('agent_trust_scores')
            .select(`
                trust_id, agent_id, trust_score, trust_status, consecutive_failures,
                total_decisions, correct_decisions,
                dim_agents!inner(agent_name)
            `)
            .order('trust_score', { ascending: true });

        if (trustData) {
            setAgents(trustData.map((r: any) => ({
                ...r,
                agent_name: r.dim_agents?.agent_name ?? r.agent_id.slice(0, 8),
            })));
        }

        // Fetch recent audit events
        const { data: auditData } = await supabase
            .from('agent_trust_audit')
            .select('*')
            .order('performed_at', { ascending: false })
            .limit(50);

        if (auditData) setAuditLog(auditData as AuditEvent[]);

        setLoading(false);
    }

    if (loading) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', padding: '3rem' }}>Loading trust data...</div>;
    }

    return (
        <div>
            <style>{`
                @keyframes trust-flash {
                    0%   { box-shadow: 0 0 0 0 rgba(59,130,246,0.4); }
                    50%  { box-shadow: 0 0 12px 4px rgba(59,130,246,0.3); }
                    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
                }
            `}</style>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                    Agent Trust Status
                </h1>
                <LiveIndicator isConnected={isConnected} />
            </div>

            {/* Trust gauges */}
            {agents.length === 0 ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '2rem' }}>No agents found.</div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
                    {agents.map(a => (
                        <div
                            key={a.trust_id}
                            style={{
                                animation: flashAgentId === a.agent_id ? 'trust-flash 1.5s ease-out' : 'none',
                                borderRadius: '8px',
                            }}
                        >
                            <TrustGauge
                                agentName={a.agent_name ?? a.agent_id.slice(0, 8)}
                                trustScore={a.trust_score}
                                trustStatus={a.trust_status}
                                consecutiveFailures={a.consecutive_failures}
                                totalDecisions={a.total_decisions}
                                correctDecisions={a.correct_decisions}
                            />
                        </div>
                    ))}
                </div>
            )}

            {/* Trust audit log */}
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#1e293b', marginBottom: '1rem', borderTop: '1px solid #e2e8f0', paddingTop: '1.5rem' }}>
                Trust Audit Log
            </h2>

            {auditLog.length === 0 ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '1rem' }}>No audit events recorded.</div>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                        <thead>
                            <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                                <th style={th}>Time</th>
                                <th style={th}>Event</th>
                                <th style={th}>Agent</th>
                                <th style={th}>Score Δ</th>
                                <th style={th}>Status Δ</th>
                                <th style={th}>Performed By</th>
                                <th style={th}>Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {auditLog.map(e => (
                                <tr key={e.audit_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                    <td style={td}>{new Date(e.performed_at).toLocaleString()}</td>
                                    <td style={td}>
                                        <span style={{
                                            padding: '1px 6px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 600,
                                            background: eventColor(e.event_type).bg,
                                            color: eventColor(e.event_type).fg,
                                        }}>{e.event_type}</span>
                                    </td>
                                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.75rem' }}>{e.agent_id.slice(0, 8)}</td>
                                    <td style={td}>
                                        {e.old_score !== null && e.new_score !== null
                                            ? `${(e.old_score * 100).toFixed(1)}% → ${(e.new_score * 100).toFixed(1)}%`
                                            : '—'}
                                    </td>
                                    <td style={td}>
                                        {e.old_status && e.new_status ? `${e.old_status} → ${e.new_status}` : e.new_status ?? '—'}
                                    </td>
                                    <td style={{ ...td, color: '#64748b' }}>{e.performed_by ?? '—'}</td>
                                    <td style={{ ...td, color: '#94a3b8', maxWidth: '250px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {e.reason ?? '—'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function eventColor(type: string): { bg: string; fg: string } {
    switch (type) {
        case 'suspended': return { bg: '#fef2f2', fg: '#dc2626' };
        case 'reinstated': return { bg: '#f0fdf4', fg: '#16a34a' };
        case 'recalibrated': return { bg: '#fff7ed', fg: '#ea580c' };
        case 'created': return { bg: '#eff6ff', fg: '#3b82f6' };
        default: return { bg: '#f1f5f9', fg: '#64748b' };
    }
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.5rem 0.6rem', color: '#475569', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.4rem 0.6rem', color: '#1e293b', whiteSpace: 'nowrap' };
