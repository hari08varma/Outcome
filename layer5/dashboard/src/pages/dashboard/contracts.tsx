import React, { useEffect, useMemo, useState } from 'react';
import { Eye, FileText, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { supabase } from '../../supabaseClient';
import { useToast } from '../../hooks/useToast';

type ContractRow = {
    id?: string;
    contract_id?: string;
    action_name?: string;
    source?: string;
    platform?: string;
    success_condition?: string;
    score_expression?: string | null;
    timeout_hours?: number | null;
    timeout_fallback?: string | null;
    fallback_strategy?: string | null;
    created_at?: string;
};

type FormState = {
    action_name: string;
    source: 'webhook' | 'http' | 'crm' | 'database' | 'custom';
    success_condition: string;
    score_expression: string;
    timeout_hours: string;
    timeout_fallback: '' | 'use_primary' | 'explicit_only' | 'ignore';
};

type FormErrors = {
    action_name?: string;
    source?: string;
    success_condition?: string;
};

const INITIAL_FORM: FormState = {
    action_name: '',
    source: 'webhook',
    success_condition: '',
    score_expression: '',
    timeout_hours: '',
    timeout_fallback: '',
};

function mapTimeoutFallbackToApi(value: FormState['timeout_fallback']): 'use_http_status' | 'explicit_only' | 'always_pending' {
    if (value === 'explicit_only') return 'explicit_only';
    if (value === 'ignore') return 'always_pending';
    return 'use_http_status';
}

function mapApiFallbackToLabel(value?: string | null): string {
    if (!value) return 'use_primary';
    if (value === 'use_http_status') return 'use_primary';
    if (value === 'explicit_only') return 'explicit_only';
    if (value === 'always_pending') return 'ignore';
    return value;
}

export default function ContractsPage(): React.ReactElement {
    const [contracts, setContracts] = useState<ContractRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(INITIAL_FORM);
    const [formErrors, setFormErrors] = useState<FormErrors>({});
    const [submitting, setSubmitting] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const createFormRef = React.useRef<HTMLDivElement | null>(null);

    const { showToast, toasts, dismissToast } = useToast();

    const apiBaseUrl = import.meta.env.VITE_API_URL as string | undefined;

    const loadContracts = async (): Promise<void> => {
        setLoading(true);
        setError(null);

        try {
            if (!apiBaseUrl) {
                throw new Error('VITE_API_URL is not configured');
            }

            const { data: { session } } = await supabase.auth.getSession();

            const res = await fetch(`${apiBaseUrl}/v1/contracts`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!res.ok) {
                throw new Error(await res.text());
            }

            const data = await res.json();
            setContracts(Array.isArray(data) ? data : []);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load contracts';
            setError(message);
            setContracts([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadContracts();
    }, []);

    const validateForm = (): FormErrors => {
        const nextErrors: FormErrors = {};
        if (!form.action_name.trim()) nextErrors.action_name = 'Action name is required';
        if (!form.source.trim()) nextErrors.source = 'Source is required';
        if (!form.success_condition.trim()) nextErrors.success_condition = 'Success condition is required';
        return nextErrors;
    };

    const onSubmit = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault();

        const nextErrors = validateForm();
        setFormErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;

        setSubmitting(true);

        try {
            if (!apiBaseUrl) {
                throw new Error('VITE_API_URL is not configured');
            }

            const { data: { session } } = await supabase.auth.getSession();

            const payload = {
                action_name: form.action_name.trim(),
                success_condition: form.success_condition.trim(),
                score_expression: form.score_expression.trim(),
                timeout_hours: form.timeout_hours ? Number(form.timeout_hours) : 24,
                fallback_strategy: mapTimeoutFallbackToApi(form.timeout_fallback),
            };

            const res = await fetch(`${apiBaseUrl}/v1/contracts`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                throw new Error(await res.text());
            }

            showToast('Contract created', 'success');
            setForm(INITIAL_FORM);
            await loadContracts();
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            showToast(`Failed to create contract: ${message}`, 'critical');
        } finally {
            setSubmitting(false);
        }
    };

    const onDelete = async (id: string): Promise<void> => {
        setDeletingId(id);
        try {
            if (!apiBaseUrl) {
                throw new Error('VITE_API_URL is not configured');
            }

            const { data: { session } } = await supabase.auth.getSession();

            const res = await fetch(`${apiBaseUrl}/v1/contracts/${id}`, {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${session?.access_token}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!res.ok) {
                throw new Error(await res.text());
            }

            showToast('Contract deleted', 'success');
            setConfirmDeleteId(null);
            await loadContracts();
        } catch {
            showToast('Failed to delete', 'critical');
        } finally {
            setDeletingId(null);
        }
    };

    const sortedContracts = useMemo(
        () => [...contracts].sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()),
        [contracts],
    );

    return (
        <div className="space-y-8">
            <section>
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-lg font-semibold text-white">Signal Contracts</h2>
                        <p className="text-sm text-[#a1a1aa] mt-1">Define what success means for each action — override HTTP inference</p>
                    </div>
                    <button
                        className="inline-flex items-center gap-2 text-xs border border-[#1a1a24] rounded-lg px-3 py-1.5 text-[#a1a1aa] hover:text-white"
                        onClick={() => void loadContracts()}
                    >
                        <RefreshCw size={14} />
                        Refresh
                    </button>
                </div>

                {error && (
                    <div className="mb-4 bg-red-500/10 border border-red-500/30 text-[#ff4444] rounded-xl px-4 py-3 text-sm">
                        Failed to load contracts: {error}
                    </div>
                )}

                {loading ? (
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 animate-pulse space-y-3">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="h-10 bg-[#1a1a24] rounded-lg" />
                        ))}
                    </div>
                ) : sortedContracts.length === 0 ? (
                    <div className="bg-[#111118] border border-[#1a1a24] rounded-xl p-8 text-center">
                        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#1a1a24] mb-4">
                            <FileText size={22} className="text-[#a1a1aa]" />
                        </div>
                        <h3 className="text-white font-semibold text-lg">No signal contracts defined</h3>
                        <p className="text-[#a1a1aa] text-sm mt-2 mb-5">Contracts override HTTP status inference for specific actions.</p>
                        <button
                            className="inline-flex items-center gap-2 bg-[#b8ff00] text-black font-semibold px-4 py-2 rounded-lg hover:bg-[#a3e600] transition-colors"
                            onClick={() => createFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                        >
                            <Plus size={16} />
                            Define First Contract
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {sortedContracts.map((contract) => {
                            const id = contract.id ?? contract.contract_id ?? '';
                            const isConfirming = confirmDeleteId === id;
                            const timeout = contract.timeout_hours;
                            const fallback = contract.timeout_fallback ?? mapApiFallbackToLabel(contract.fallback_strategy);
                            return (
                                <div key={id || `${contract.action_name}-${contract.created_at}`} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                                    <div className="space-y-2 min-w-0">
                                        <p className="text-[#b8ff00] font-mono text-lg truncate">{contract.action_name ?? 'unknown_action'}</p>
                                        <div className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-[#1a1a24] bg-[#111118] text-[#a1a1aa]">
                                            {contract.source ?? contract.platform ?? 'custom'}
                                        </div>
                                        <p className="text-xs text-[#a1a1aa] font-mono break-all">{contract.success_condition ?? '—'}</p>
                                    </div>

                                    <div className="space-y-2 md:text-right">
                                        {typeof timeout === 'number' && (
                                            <p className="text-sm text-white">⏱ {timeout}h timeout</p>
                                        )}
                                        {fallback && (
                                            <p className="text-xs text-[#a1a1aa]">{fallback}</p>
                                        )}

                                        {!id ? (
                                            <div className="text-xs text-[#a1a1aa] inline-flex items-center gap-1">
                                                <Eye size={12} />
                                                Missing id
                                            </div>
                                        ) : !isConfirming ? (
                                            <button
                                                className="inline-flex items-center gap-1 text-sm text-[#a1a1aa] hover:text-[#ff4444]"
                                                onClick={() => setConfirmDeleteId(id)}
                                            >
                                                <Trash2 size={14} />
                                                Delete
                                            </button>
                                        ) : (
                                            <div className="inline-flex items-center gap-2 text-sm">
                                                <span className="text-[#ff4444]">Delete?</span>
                                                <button
                                                    className="px-2 py-1 rounded border border-red-500/30 text-[#ff4444] hover:bg-red-500/10"
                                                    disabled={deletingId === id}
                                                    onClick={() => void onDelete(id)}
                                                >
                                                    Yes
                                                </button>
                                                <button
                                                    className="px-2 py-1 rounded border border-[#1a1a24] text-[#a1a1aa] hover:text-white"
                                                    onClick={() => setConfirmDeleteId(null)}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <section>
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold text-white">Define New Contract</h2>
                </div>

                <div ref={createFormRef} className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5">
                    <form className="space-y-4" onSubmit={onSubmit}>
                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">action_name*</label>
                            <input
                                value={form.action_name}
                                onChange={(e) => setForm((prev) => ({ ...prev, action_name: e.target.value }))}
                                placeholder="e.g. issue_refund"
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors"
                            />
                            {formErrors.action_name && <p className="text-xs text-[#ff4444] mt-1">{formErrors.action_name}</p>}
                        </div>

                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">source*</label>
                            <select
                                value={form.source}
                                onChange={(e) => setForm((prev) => ({ ...prev, source: e.target.value as FormState['source'] }))}
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors"
                            >
                                <option value="webhook">webhook</option>
                                <option value="http">http</option>
                                <option value="crm">crm</option>
                                <option value="database">database</option>
                                <option value="custom">custom</option>
                            </select>
                            {formErrors.source && <p className="text-xs text-[#ff4444] mt-1">{formErrors.source}</p>}
                        </div>

                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">success_condition*</label>
                            <textarea
                                rows={3}
                                value={form.success_condition}
                                onChange={(e) => setForm((prev) => ({ ...prev, success_condition: e.target.value }))}
                                placeholder="e.g. payload.status === 'succeeded'"
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors font-mono"
                            />
                            {formErrors.success_condition && <p className="text-xs text-[#ff4444] mt-1">{formErrors.success_condition}</p>}
                        </div>

                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">score_expression</label>
                            <input
                                value={form.score_expression}
                                onChange={(e) => setForm((prev) => ({ ...prev, score_expression: e.target.value }))}
                                placeholder="e.g. payload.score / 1000"
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors"
                            />
                        </div>

                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">timeout_hours</label>
                            <input
                                type="number"
                                min={1}
                                max={8760}
                                value={form.timeout_hours}
                                onChange={(e) => setForm((prev) => ({ ...prev, timeout_hours: e.target.value }))}
                                placeholder="e.g. 24"
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors"
                            />
                        </div>

                        <div>
                            <label className="block text-sm text-[#a1a1aa] mb-1">timeout_fallback</label>
                            <select
                                value={form.timeout_fallback}
                                onChange={(e) => setForm((prev) => ({ ...prev, timeout_fallback: e.target.value as FormState['timeout_fallback'] }))}
                                className="w-full bg-[#111118] border border-[#1a1a24] rounded-lg px-3 py-2 text-white text-sm placeholder-[#52525b] focus:outline-none focus:border-[#b8ff00] transition-colors"
                            >
                                <option value="">(blank)</option>
                                <option value="use_primary">use_primary</option>
                                <option value="explicit_only">explicit_only</option>
                                <option value="ignore">ignore</option>
                            </select>
                        </div>

                        <button
                            type="submit"
                            disabled={submitting}
                            className="w-full bg-[#b8ff00] text-black font-semibold py-2.5 rounded-lg hover:bg-[#a3e600] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {submitting ? 'Creating...' : 'Create Contract'}
                        </button>
                    </form>
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
