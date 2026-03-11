import React from 'react';

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

interface OutcomeTableProps {
    outcomes: OutcomeRow[];
    loading?: boolean;
}

export default function OutcomeTable({ outcomes, loading }: OutcomeTableProps) {
    if (loading) {
        return <div style={{ padding: '2rem', color: '#94a3b8', textAlign: 'center' }}>Loading outcomes...</div>;
    }

    if (outcomes.length === 0) {
        return <div style={{ padding: '2rem', color: '#94a3b8', textAlign: 'center' }}>No outcomes recorded yet.</div>;
    }

    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                        <th style={th}>Timestamp</th>
                        <th style={th}>Agent</th>
                        <th style={th}>Action</th>
                        <th style={th}>Issue Type</th>
                        <th style={th}>Result</th>
                        <th style={th}>Response</th>
                        <th style={th}>Error</th>
                    </tr>
                </thead>
                <tbody>
                    {outcomes.map((o) => (
                        <tr key={o.outcome_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={td}>{new Date(o.timestamp).toLocaleString()}</td>
                            <td style={td}>{o.agent_name}</td>
                            <td style={td}><code style={{ fontSize: '0.8rem' }}>{o.action_name}</code></td>
                            <td style={td}>{o.issue_type}</td>
                            <td style={td}>
                                <span style={{
                                    display: 'inline-block', padding: '1px 8px', borderRadius: '9999px',
                                    fontSize: '0.75rem', fontWeight: 600,
                                    background: o.success ? '#f0fdf4' : '#fef2f2',
                                    color: o.success ? '#16a34a' : '#dc2626',
                                }}>
                                    {o.success ? 'SUCCESS' : 'FAILURE'}
                                </span>
                            </td>
                            <td style={td}>{o.response_time_ms ? `${o.response_time_ms}ms` : '—'}</td>
                            <td style={{ ...td, color: '#94a3b8' }}>{o.error_code ?? '—'}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '0.6rem 0.8rem', color: '#475569', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.5rem 0.8rem', color: '#1e293b' };
