import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock, RefreshCw, Webhook, XCircle } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import LiveIndicator from '../../components/LiveIndicator';

type SignalRow = {
    id?: string;
    registration_id?: string;
    action_id?: string | null;
    action_name?: string | null;
    outcome_id?: string | null;
    customer_id?: string;
    http_status?: number | null;
    queued_at?: string | null;
    registered_at?: string | null;
    created_at?: string | null;
    resolved_at?: string | null;
    outcome_derived?: boolean | null;
    confidence?: number | null;
    contract_id?: string | null;
};

type FilterTab = 'all' | 'pending' | 'resolved';

function isPending(row: SignalRow): boolean {
    return !row.resolved_at;
}

function getQueuedTimestamp(row: SignalRow): string | null {
    return row.queued_at ?? row.registered_at ?? row.created_at ?? null;
}

function getActionLabel(row: SignalRow): string {
    if (row.action_name && row.action_name.trim().length > 0) return row.action_name;
    if (row.outcome_id) return `outcome:${row.outcome_id.slice(-8)}`;
    return 'unknown_action';
}

function getConfidence(row: SignalRow): number | null {
    if (typeof row.confidence === 'number' && Number.isFinite(row.confidence)) {
        return Math.max(0, Math.min(1, row.confidence));
    }
    return null;
}

function getResolvedOutcome(row: SignalRow): 'SUCCESS' | 'FAILURE' {
    if (row.outcome_derived === true) return 'SUCCESS';
    if (row.outcome_derived === false) return 'FAILURE';
    const confidence = getConfidence(row);
    return confidence !== null && confidence >= 0.5 ? 'SUCCESS' : 'FAILURE';
}

function getHttpStatusBadgeClass(status: number | null | undefined): string {
    if (typeof status !== 'number') {
        return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    }
    if (status >= 200 && status < 300) {
        return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20';
    }
    if (status >= 300 && status < 400) {
        return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    }
    return 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20';
}

function getConfidenceClass(value: number | null): string {
    if (value === null) return 'text-[#a1a1aa]';
    if (value >= 0.7) return 'text-[#b8ff00]';
    if (value >= 0.4) return 'text-[#facc15]';
    return 'text-[#ff4444]';
}

export default function SignalsPage(): React.ReactElement {
    const [rows, setRows] = useState<SignalRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<FilterTab>('all');
    const fetchRef = useRef<(() => Promise<void>) | null>(null);

    useEffect(() => {
        let mounted = true;

        const fetchSignals = async (showLoading = false): Promise<void> => {
            if (mounted && showLoading) {
                setLoading(true);
            }

            try {
                setError(null);

                const {
                    data: { user },
                    error: userError,
                } = await supabase.auth.getUser();

                if (userError || !user) {
                    throw new Error(userError?.message ?? 'Unable to resolve user');
                }

                let customerId: string | null = null;

                const primaryProfile = await supabase
                    .from('userprofiles')
                    .select('customer_id')
                    .eq('id', user.id)
                    .maybeSingle();

                customerId = primaryProfile.data?.customer_id ?? null;

                if (!customerId) {
                    const fallbackProfile = await supabase
                        .from('user_profiles')
                        .select('customer_id')
                        .eq('id', user.id)
                        .maybeSingle();
                    customerId = fallbackProfile.data?.customer_id ?? null;
                }

                if (!customerId) {
                    throw new Error('Missing customer context');
                }

                const query = await supabase
                    .from('dim_pending_signal_registrations')
                    .select('*')
                    .eq('customer_id', customerId)
                    .order('queued_at', { ascending: false, nullsFirst: false });

                if (query.error) {
                    throw new Error(query.error.message);
                }

                const payload = (query.data ?? []) as SignalRow[];

                if (mounted) {
                    setRows(payload);
                }
            } catch (_err) {
                if (mounted) {
                    setError('Failed to load signals. Check your connection.');
                    setRows([]);
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };

        fetchRef.current = () => fetchSignals(true);

        void fetchSignals(true);

        const interval = window.setInterval(() => {
            void fetchSignals();
        }, 10000);

        return () => {
            mounted = false;
            fetchRef.current = null;
            window.clearInterval(interval);
        };
    }, []);

    const pendingRows = useMemo(() => rows.filter((row) => isPending(row)), [rows]);
    const resolvedRows = useMemo(
        () => rows
            .filter((row) => !isPending(row))
            .sort((a, b) => {
                const at = new Date(a.resolved_at ?? 0).getTime();
                const bt = new Date(b.resolved_at ?? 0).getTime();
                return bt - at;
            }),
        [rows],
    );

    const filteredRows = useMemo(() => {
        if (filter === 'pending') return pendingRows;
        if (filter === 'resolved') return resolvedRows;
        return rows;
    }, [filter, pendingRows, resolvedRows, rows]);

    const summary = useMemo(() => {
        const now = Date.now();
        const dayAgo = now - 24 * 60 * 60 * 1000;
        const resolvedToday = resolvedRows.filter((row) => {
            const resolvedAt = row.resolved_at ? new Date(row.resolved_at).getTime() : 0;
            return resolvedAt >= dayAgo;
        }).length;

        const confidenceValues = resolvedRows
            .map((row) => getConfidence(row))
            .filter((value): value is number => value !== null);

        const avgConfidence = confidenceValues.length === 0
            ? null
            : confidenceValues.reduce((acc, curr) => acc + curr, 0) / confidenceValues.length;

        return {
            totalPending: pendingRows.length,
            resolvedToday,
            avgConfidence,
        };
    }, [pendingRows.length, resolvedRows]);

    return (
        <div className="space-y-8">
            {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-[#ff4444] rounded-xl px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    <span>{error}</span>
                </div>
            )}

            <section>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Total Pending</p>
                        <p className="text-3xl font-bold text-white mt-2">{summary.totalPending}</p>
                    </div>
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Resolved Today</p>
                        <p className="text-3xl font-bold text-white mt-2">{summary.resolvedToday}</p>
                    </div>
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Avg Confidence</p>
                        <p className="text-3xl font-bold text-white mt-2">
                            {summary.avgConfidence === null ? '—' : `${(summary.avgConfidence * 100).toFixed(1)}%`}
                        </p>
                    </div>
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm mb-3">Live</p>
                        <LiveIndicator isConnected label="Watching" />
                    </div>
                </div>
            </section>

            <section>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        Pending Signals
                        <LiveIndicator isConnected label="LIVE" />
                    </h2>
                    <button
                        className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5 text-[#a1a1aa] hover:text-white"
                        onClick={() => {
                            void fetchRef.current?.();
                        }}
                    >
                        <RefreshCw size={14} />
                        Refresh
                    </button>
                </div>

                <div className="flex items-center gap-6 mb-4 text-sm border-b border-[#1a1a24]">
                    {(['all', 'pending', 'resolved'] as FilterTab[]).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => setFilter(tab)}
                            className={filter === tab
                                ? 'pb-2 border-b-2 border-[#b8ff00] text-[#b8ff00]'
                                : 'pb-2 border-b-2 border-transparent text-[#a1a1aa] hover:text-white'}
                        >
                            {tab === 'all' ? 'All' : tab === 'pending' ? 'Pending' : 'Resolved'}
                        </button>
                    ))}
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
                    {loading ? (
                        <div className="p-4 animate-pulse space-y-3">
                            {[...Array(3)].map((_, i) => (
                                <div key={i} className="h-10 bg-[#1a1a24] rounded-lg" />
                            ))}
                        </div>
                    ) : filteredRows.length === 0 ? (
                        <div className="p-8 text-center text-[#a1a1aa] text-sm">
                            No pending signals. Instrument your agent to start.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full">
                                <thead>
                                    <tr className="border-b border-[#1a1a24]">
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Action Name</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Queued At</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">HTTP Status</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Contract</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredRows.map((row, index) => {
                                        const status = typeof row.http_status === 'number' ? row.http_status : null;
                                        const queuedAt = getQueuedTimestamp(row);
                                        const pending = isPending(row);
                                        const key = row.id ?? row.registration_id ?? `${index}`;
                                        return (
                                            <tr key={key} className="border-b border-[#1a1a24] hover:bg-[#16161f] transition-colors">
                                                <td className="px-4 py-3 text-sm text-[#b8ff00] font-mono">{getActionLabel(row)}</td>
                                                <td className="px-4 py-3 text-sm text-white">{queuedAt ? new Date(queuedAt).toLocaleString() : '—'}</td>
                                                <td className="px-4 py-3 text-sm text-white">
                                                    <span className={getHttpStatusBadgeClass(status)}>{status ?? 'unknown'}</span>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-white">
                                                    {row.contract_id ? (
                                                        <span className="text-white font-mono">...{row.contract_id.slice(-8)}</span>
                                                    ) : (
                                                        <span className="text-[#a1a1aa]">none</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-white">
                                                    {pending ? (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                                                            <Clock size={12} className="animate-pulse" />
                                                            PENDING
                                                        </span>
                                                    ) : (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                                                            <CheckCircle size={12} />
                                                            RESOLVED
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>

            <section>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                        <Webhook size={18} className="text-[#b8ff00]" />
                        Resolved via Webhook
                    </h2>
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
                    {loading ? (
                        <div className="p-4 animate-pulse space-y-3">
                            {[...Array(3)].map((_, i) => (
                                <div key={i} className="h-10 bg-[#1a1a24] rounded-lg" />
                            ))}
                        </div>
                    ) : resolvedRows.length === 0 ? (
                        <div className="p-8 text-center text-[#a1a1aa] text-sm">
                            No webhook resolutions yet.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full">
                                <thead>
                                    <tr className="border-b border-[#1a1a24]">
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Action Name</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Resolved At</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Outcome</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Confidence</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {resolvedRows.map((row, index) => {
                                        const key = row.id ?? row.registration_id ?? `${index}`;
                                        const outcome = getResolvedOutcome(row);
                                        const confidence = getConfidence(row);
                                        return (
                                            <tr key={key} className="border-b border-[#1a1a24] hover:bg-[#16161f] transition-colors">
                                                <td className="px-4 py-3 text-sm text-white">{getActionLabel(row)}</td>
                                                <td className="px-4 py-3 text-sm text-white">{row.resolved_at ? new Date(row.resolved_at).toLocaleString() : '—'}</td>
                                                <td className="px-4 py-3 text-sm text-white">
                                                    {outcome === 'SUCCESS' ? (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                                                            <CheckCircle size={12} />
                                                            SUCCESS
                                                        </span>
                                                    ) : (
                                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                                                            <XCircle size={12} />
                                                            FAILURE
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-sm">
                                                    <span className={getConfidenceClass(confidence)}>
                                                        {confidence === null ? '—' : `${(confidence * 100).toFixed(1)}%`}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
