import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import { useToast } from '../../hooks/useToast';

type DiscrepancyRow = {
    discrepancy_id: string;
    customer_id: string;
    outcome_id?: string | null;
    registration_id?: string | null;
    contract_id?: string | null;
    action_name: string;
    discrepancy_type: 'outcome_mismatch' | 'expired_no_signal' |
                      'confidence_below_threshold' | 'contract_violation' | string;
    expected_outcome?: boolean | null;
    actual_outcome?: boolean | null;
    signal_confidence?: number | null;
    threshold_used?: number | null;
    detail?: string | null;
    resolved: boolean;
    resolved_at?: string | null;
    created_at: string;
};

type SummaryData = {
    total: number;
    by_type: Record<string, number>;
};

function getTypeBadgeClass(type: string): string {
    const base = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium';
    switch (type) {
        case 'outcome_mismatch':
            return `${base} bg-yellow-500/10 text-yellow-400 border border-yellow-500/20`;
        case 'expired_no_signal':
            return `${base} bg-red-500/10 text-red-400 border border-red-500/30`;
        case 'confidence_below_threshold':
            return `${base} bg-orange-500/10 text-orange-400 border border-orange-500/20`;
        case 'contract_violation':
            return `${base} bg-purple-500/10 text-purple-400 border border-purple-500/20`;
        default:
            return `${base} bg-[#1a1a24] text-[#a1a1aa]`;
    }
}

function getConfidenceClass(value: number | null | undefined): string {
    if (value == null) return 'text-[#a1a1aa]';
    if (value >= 0.7) return 'text-[#b8ff00]';
    if (value >= 0.4) return 'text-[#facc15]';
    return 'text-[#ff4444]';
}

function formatConfidence(value: number | null | undefined): string {
    if (value == null) return '—';
    return `${(value * 100).toFixed(1)}%`;
}

export default function DiscrepanciesPage(): React.ReactElement {
    const [rows, setRows] = useState<DiscrepancyRow[]>([]);
    const [summary, setSummary] = useState<SummaryData>({ total: 0, by_type: {} });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [confirmResolveId, setConfirmResolveId] = useState<string | null>(null);
    const [resolvingId, setResolvingId] = useState<string | null>(null);
    const [detecting, setDetecting] = useState(false);

    const { showToast, toasts, dismissToast } = useToast();

    const apiBaseUrl = import.meta.env.VITE_API_URL as string | undefined;

    const loadDiscrepancies = async (): Promise<void> => {
        if (!apiBaseUrl) return;
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${apiBaseUrl}/v1/discrepancies`, {
            headers: {
                Authorization: `Bearer ${session?.access_token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setRows(Array.isArray(data) ? data : []);
    };

    const loadSummary = async (): Promise<void> => {
        if (!apiBaseUrl) return;
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${apiBaseUrl}/v1/discrepancies/summary`, {
            headers: {
                Authorization: `Bearer ${session?.access_token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setSummary(data as SummaryData);
    };

    useEffect(() => {
        if (!apiBaseUrl) {
            setError('API URL not configured');
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);

        Promise.all([loadDiscrepancies(), loadSummary()])
            .catch((err) => {
                const message = err instanceof Error ? err.message : 'Failed to load discrepancies';
                setError(message);
            })
            .finally(() => {
                setLoading(false);
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onDetect = async (): Promise<void> => {
        if (!apiBaseUrl) return;
        setDetecting(true);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch(`${apiBaseUrl}/v1/discrepancies/detect`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                    'Content-Type': 'application/json',
                },
            });
            if (!res.ok) throw new Error(await res.text());
            const body = await res.json() as { detected?: number };
            showToast(`Detected ${body.detected ?? 0} discrepancy(s)`, 'success');
            await Promise.all([loadDiscrepancies(), loadSummary()]);
        } catch {
            showToast('Detection failed', 'critical');
        } finally {
            setDetecting(false);
        }
    };

    const onResolve = async (id: string): Promise<void> => {
        if (!apiBaseUrl) return;
        setResolvingId(id);
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const res = await fetch(`${apiBaseUrl}/v1/discrepancies/${id}/resolve`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                    'Content-Type': 'application/json',
                },
            });
            if (!res.ok) throw new Error(await res.text());
            showToast('Discrepancy resolved', 'success');
            setConfirmResolveId(null);
            await Promise.all([loadDiscrepancies(), loadSummary()]);
        } catch {
            showToast('Failed to resolve', 'critical');
        } finally {
            setResolvingId(null);
        }
    };

    return (
        <div className="space-y-8">
            {error && (
                <div className="bg-red-500/10 border border-red-500/30 text-[#ff4444] rounded-xl px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    <span>{error}</span>
                </div>
            )}

            {/* Section A — Summary Bar */}
            <section>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Total Unresolved</p>
                        <p className="text-3xl font-bold text-white mt-2">{summary.total}</p>
                    </div>
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Outcome Mismatches</p>
                        <p className="text-3xl font-bold text-white mt-2">
                            {summary.by_type['outcome_mismatch'] ?? 0}
                        </p>
                    </div>
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                        <p className="text-[#a1a1aa] text-sm">Expired Signals</p>
                        <p className="text-3xl font-bold text-white mt-2">
                            {summary.by_type['expired_no_signal'] ?? 0}
                        </p>
                    </div>
                </div>
            </section>

            {/* Section B — Discrepancies Table */}
            <section>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white">Discrepancies</h2>
                    <button
                        className="bg-[#b8ff00] text-black font-semibold px-4 py-2 rounded-lg hover:bg-[#a3e600] disabled:opacity-50 transition-colors text-sm"
                        disabled={detecting}
                        onClick={() => void onDetect()}
                    >
                        {detecting ? 'Detecting...' : 'Run Detection'}
                    </button>
                </div>

                <div className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
                    {loading ? (
                        <div className="p-4 animate-pulse space-y-3">
                            {[...Array(3)].map((_, i) => (
                                <div key={i} className="h-10 bg-[#1a1a24] rounded-lg" />
                            ))}
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="p-8 text-center text-[#a1a1aa] text-sm">
                            No unresolved discrepancies.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full">
                                <thead>
                                    <tr className="border-b border-[#1a1a24]">
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Action Name</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Type</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Detail</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Confidence</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Created</th>
                                        <th className="px-4 py-3 text-left text-xs font-medium text-[#a1a1aa] uppercase tracking-wider">Resolve</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row) => (
                                        <tr key={row.discrepancy_id} className="border-b border-[#1a1a24] hover:bg-[#16161f] transition-colors">
                                            <td className="px-4 py-3 text-sm text-[#b8ff00] font-mono">{row.action_name}</td>
                                            <td className="px-4 py-3 text-sm">
                                                <span className={getTypeBadgeClass(row.discrepancy_type)}>
                                                    {row.discrepancy_type}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-[#a1a1aa] max-w-[240px] truncate">
                                                {row.detail ?? '—'}
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <span className={getConfidenceClass(row.signal_confidence)}>
                                                    {formatConfidence(row.signal_confidence)}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-white">
                                                {new Date(row.created_at).toLocaleString()}
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                {confirmResolveId !== row.discrepancy_id ? (
                                                    <button
                                                        className="text-sm text-[#a1a1aa] hover:text-[#b8ff00] transition-colors"
                                                        onClick={() => setConfirmResolveId(row.discrepancy_id)}
                                                    >
                                                        Resolve
                                                    </button>
                                                ) : (
                                                    <div className="inline-flex items-center gap-2 text-sm">
                                                        <span className="text-[#b8ff00]">Resolve?</span>
                                                        <button
                                                            className="px-2 py-1 rounded border border-[#b8ff00]/30 text-[#b8ff00] hover:bg-[#b8ff00]/10 transition-colors"
                                                            disabled={resolvingId === row.discrepancy_id}
                                                            onClick={() => void onResolve(row.discrepancy_id)}
                                                        >
                                                            Yes
                                                        </button>
                                                        <button
                                                            className="px-2 py-1 rounded border border-[#1a1a24] text-[#a1a1aa] hover:text-white transition-colors"
                                                            onClick={() => setConfirmResolveId(null)}
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>

            {toasts.length > 0 && (
                <div className="fixed right-4 top-4 z-50 space-y-2">
                    {toasts.map((toast) => (
                        <button
                            key={toast.id}
                            className={toast.type === 'success'
                                ? 'block text-left bg-green-500/10 border border-green-500/30 text-green-400 px-3 py-2 rounded-lg text-sm'
                                : 'block text-left bg-red-500/10 border border-red-500/30 text-red-400 px-3 py-2 rounded-lg text-sm'}
                            onClick={() => dismissToast(toast.id)}
                        >
                            {toast.message}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
