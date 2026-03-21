/**
 * Audit Trail Page (/audit)
 * Data Source: fact_outcomes full join with dimensions
 * Human-readable log, CSV export button, date range filter.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AGENT_API_KEY_STORAGE_KEY } from '../hooks/useAgentApiKey';

interface AuditRow {
    outcome_id: string;
    agent_name: string;
    action_name: string;
    issue_type: string;
    success: boolean;
    timestamp: string;
    response_time_ms: number | null;
    error_code: string | null;
    error_message: string | null;
    session_id: string;
}

export default function AuditTrail() {
    const navigate = useNavigate();
    const [rows, setRows] = useState<AuditRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');

    let hasStoredApiKey = false;
    try {
        hasStoredApiKey = Boolean(localStorage.getItem(AGENT_API_KEY_STORAGE_KEY));
    } catch {
        hasStoredApiKey = false;
    }

    useEffect(() => { fetchAudit(); }, [startDate, endDate]);

    async function fetchAudit() {
        setLoading(true);
        setError(null);

        try {
            let query = supabase
                .from('fact_outcomes')
                .select(`
                    outcome_id, success, timestamp, response_time_ms, error_code, error_message, session_id,
                    dim_actions!inner(action_name),
                    dim_agents!inner(agent_name),
                    dim_contexts!inner(issue_type)
                `)
                .eq('is_deleted', false)
                .order('timestamp', { ascending: false })
                .limit(100);

            if (startDate) query = query.gte('timestamp', startDate);
            if (endDate) query = query.lte('timestamp', endDate + 'T23:59:59Z');

            const { data, error: queryError } = await query;

            if (queryError) {
                throw new Error(queryError.message);
            }

            setRows(data.map((r: any) => ({
                outcome_id: r.outcome_id,
                agent_name: r.dim_agents?.agent_name ?? '',
                action_name: r.dim_actions?.action_name ?? '',
                issue_type: r.dim_contexts?.issue_type ?? '',
                success: r.success,
                timestamp: r.timestamp,
                response_time_ms: r.response_time_ms,
                error_code: r.error_code,
                error_message: r.error_message,
                session_id: r.session_id,
            })));
        } catch (err) {
            setRows([]);
            setError(err instanceof Error ? err.message : 'Failed to load audit trail');
        } finally {
            setLoading(false);
        }
    }

    function exportCSV() {
        const header = 'outcome_id,timestamp,agent,action,issue_type,success,response_ms,error_code,error_message,session_id\n';
        const csv = rows.map(r =>
            `${r.outcome_id},${r.timestamp},${r.agent_name},${r.action_name},${r.issue_type},${r.success},${r.response_time_ms ?? ''},${r.error_code ?? ''},${(r.error_message ?? '').replace(/,/g, ';')},${r.session_id}`
        ).join('\n');

        const blob = new Blob([header + csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `layerinfinite-audit-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div>
            <style>{`@keyframes audit-spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                    Audit Trail
                </h1>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <label style={{ fontSize: '0.8rem', color: '#64748b' }}>
                        From: <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={dateInput} />
                    </label>
                    <label style={{ fontSize: '0.8rem', color: '#64748b' }}>
                        To: <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={dateInput} />
                    </label>
                    <button onClick={exportCSV} style={{
                        padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid #3b82f6',
                        background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
                    }}>
                        Export CSV
                    </button>
                </div>
            </div>

            {!hasStoredApiKey && (
                <div style={{
                    marginBottom: '1rem',
                    color: '#854d0e',
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(245,158,11,0.3)',
                    borderRadius: '10px',
                    padding: '0.9rem 1rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem',
                    flexWrap: 'wrap',
                }}>
                    <span>To view your audit trail, go to Settings {'->'} API Keys and create an API key first. Your key is used to authenticate the audit export.</span>
                    <button
                        onClick={() => navigate('/dashboard/settings/api-keys')}
                        style={{
                            padding: '0.35rem 0.8rem',
                            borderRadius: '6px',
                            border: '1px solid #b45309',
                            background: '#f59e0b',
                            color: '#111827',
                            cursor: 'pointer',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                        }}
                    >
                        Go to API Keys
                    </button>
                </div>
            )}

            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid #334155', borderTopColor: '#94a3b8', animation: 'audit-spin 0.8s linear infinite' }} />
                </div>
            ) : error ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', color: '#f87171', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', padding: '0.9rem 1rem' }}>
                    <span>{error}</span>
                    <button onClick={fetchAudit} style={{ padding: '0.35rem 0.8rem', borderRadius: '6px', border: '1px solid #334155', background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: '0.8rem' }}>Retry</button>
                </div>
            ) : rows.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '5rem 1rem' }}>
                    <div style={{ fontSize: '2.5rem', opacity: 0.2, marginBottom: '0.75rem' }}>📋</div>
                    <h3 style={{ color: '#0f172a', margin: 0, fontSize: '1.1rem' }}>No outcomes logged yet</h3>
                    <p style={{ color: '#64748b', marginTop: '0.6rem', maxWidth: 380, lineHeight: 1.5 }}>
                        Every decision your agent makes is recorded here. Start logging outcomes to build your audit trail.
                    </p>
                </div>
            ) : (
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                        <thead>
                            <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                                <th style={th}>Time</th>
                                <th style={th}>Agent</th>
                                <th style={th}>Action</th>
                                <th style={th}>Context</th>
                                <th style={th}>Result</th>
                                <th style={th}>Response</th>
                                <th style={th}>Error</th>
                                <th style={th}>Session</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.outcome_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                    <td style={td}>{new Date(r.timestamp).toLocaleString()}</td>
                                    <td style={td}>{r.agent_name}</td>
                                    <td style={td}><code style={{ fontSize: '0.78rem' }}>{r.action_name}</code></td>
                                    <td style={td}>{r.issue_type}</td>
                                    <td style={td}>
                                        <span style={{
                                            padding: '1px 6px', borderRadius: '9999px', fontSize: '0.72rem', fontWeight: 600,
                                            background: r.success ? '#f0fdf4' : '#fef2f2',
                                            color: r.success ? '#16a34a' : '#dc2626',
                                        }}>{r.success ? 'OK' : 'FAIL'}</span>
                                    </td>
                                    <td style={td}>{r.response_time_ms ? `${r.response_time_ms}ms` : '—'}</td>
                                    <td style={{ ...td, color: '#94a3b8', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {r.error_message ?? r.error_code ?? '—'}
                                    </td>
                                    <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.72rem', color: '#94a3b8' }}>
                                        {r.session_id.slice(0, 8)}
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

const th: React.CSSProperties = { textAlign: 'left', padding: '0.5rem 0.6rem', color: '#475569', fontWeight: 600 };
const td: React.CSSProperties = { padding: '0.4rem 0.6rem', color: '#1e293b', whiteSpace: 'nowrap' };
const dateInput: React.CSSProperties = { padding: '0.3rem 0.5rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem', marginLeft: '0.25rem' };
