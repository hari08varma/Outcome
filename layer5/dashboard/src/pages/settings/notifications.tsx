/**
 * Notification Settings Page — /settings/notifications
 * Configure alert delivery channels (email, Slack webhook, HTTP webhook).
 * Each channel has severity threshold and alert type filters.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../supabaseClient';
import { useToastContext } from '../../components/Toast';
import { API_BASE } from '../../lib/config';

// ─── Types ──────────────────────────────────────────────────

type ChannelType = 'email' | 'slack_webhook' | 'webhook';
type MinSeverity = 'info' | 'warning' | 'critical';

interface Channel {
    id: string;
    customer_id: string;
    channel_type: ChannelType;
    destination: string;
    label: string;
    min_severity: MinSeverity;
    alert_type_filter: string[];
    is_active: boolean;
    last_delivery_at: string | null;
    last_delivery_ok: boolean | null;
    last_delivery_error: string | null;
    created_at: string;
    updated_at: string;
}

const ALERT_TYPES = [
    { key: 'latency_spike', label: 'Latency Spike' },
    { key: 'context_drift', label: 'Context Drift' },
    { key: 'coordinated_failure', label: 'Coordinated Failure' },
    { key: 'silent_failure', label: 'Silent Failure' },
    { key: 'degradation', label: 'Degradation' },
    { key: 'score_flip', label: 'Score Flip' },
];

const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
    email: 'Email',
    slack_webhook: 'Slack',
    webhook: 'Webhook',
};

const CHANNEL_TYPE_ICONS: Record<ChannelType, string> = {
    email: '✉',
    slack_webhook: '#',
    webhook: '⚡',
};

const SEVERITY_LABELS: Record<MinSeverity, string> = {
    info: 'All (Info + Warning + Critical)',
    warning: 'Warning + Critical',
    critical: 'Critical only',
};

// ─── Validation helpers ─────────────────────────────────────

function validateDestination(type: ChannelType, value: string): string | null {
    if (!value.trim()) return 'Required';
    if (type === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address';
    }
    if (type === 'slack_webhook') {
        if (!value.startsWith('https://hooks.slack.com/')) return 'Must start with https://hooks.slack.com/';
    }
    if (type === 'webhook') {
        if (!value.startsWith('https://')) return 'Must start with https://';
    }
    return null;
}

function validateLabel(value: string): string | null {
    if (!value.trim()) return 'Label is required';
    if (value.length > 100) return 'Max 100 characters';
    return null;
}

// ─── Styles ─────────────────────────────────────────────────

const card: React.CSSProperties = {
    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px',
    padding: '1rem 1.25rem', marginBottom: '0.75rem',
};
const cardFailed: React.CSSProperties = {
    ...card, borderColor: '#fca5a5', background: '#fef2f2',
};
const btnPrimary: React.CSSProperties = {
    padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid #3b82f6',
    background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
    padding: '0.35rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1',
    background: '#fff', color: '#475569', cursor: 'pointer', fontSize: '0.8rem',
};
const btnDanger: React.CSSProperties = {
    ...btnSecondary, color: '#dc2626', borderColor: '#fca5a5',
};
const inputStyle: React.CSSProperties = {
    padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1',
    fontSize: '0.85rem', width: '100%', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
    fontSize: '0.8rem', fontWeight: 600, color: '#475569', display: 'block', marginBottom: '0.25rem',
};
const errorText: React.CSSProperties = {
    fontSize: '0.75rem', color: '#dc2626', marginTop: '0.2rem',
};
const helperText: React.CSSProperties = {
    fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem',
};

// ─── Component ──────────────────────────────────────────────

export default function NotificationSettings() {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [loading, setLoading] = useState(true);
    const [customerId, setCustomerId] = useState<string | null>(null);
    const { showToast } = useToastContext();

    // Form state
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [formType, setFormType] = useState<ChannelType>('slack_webhook');
    const [formLabel, setFormLabel] = useState('');
    const [formDest, setFormDest] = useState('');
    const [formSeverity, setFormSeverity] = useState<MinSeverity>('warning');
    const [formTypeFilter, setFormTypeFilter] = useState<string[]>([]);
    const [formTouched, setFormTouched] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);

    // Test button loading state per channel
    const [testingId, setTestingId] = useState<string | null>(null);

    // ── Load customer_id and channels ───────────────────────

    useEffect(() => {
        loadData();
    }, []);

    async function loadData() {
        setLoading(true);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { setLoading(false); return; }

        // Get customer_id from user_profiles
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('customer_id')
            .eq('id', session.user.id)
            .single();

        if (!profile) { setLoading(false); return; }
        setCustomerId(profile.customer_id);

        // Fetch channels
        const { data: chs } = await supabase
            .from('alert_notification_channels')
            .select('*')
            .eq('customer_id', profile.customer_id)
            .order('created_at', { ascending: true });

        setChannels((chs ?? []) as Channel[]);
        setLoading(false);
    }

    // ── Auth headers for API calls ──────────────────────────

    async function getAuthHeaders(): Promise<Record<string, string>> {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return {};
        return { Authorization: `Bearer ${session.access_token}` };
    }

    // ── Form helpers ────────────────────────────────────────

    function resetForm() {
        setShowForm(false);
        setEditingId(null);
        setFormType('slack_webhook');
        setFormLabel('');
        setFormDest('');
        setFormSeverity('warning');
        setFormTypeFilter([]);
        setFormTouched({});
    }

    function openEdit(ch: Channel) {
        setEditingId(ch.id);
        setFormType(ch.channel_type);
        setFormLabel(ch.label);
        setFormDest(ch.destination);
        setFormSeverity(ch.min_severity);
        setFormTypeFilter(ch.alert_type_filter ?? []);
        setFormTouched({});
        setShowForm(true);
    }

    function toggleTypeFilter(key: string) {
        setFormTypeFilter(prev =>
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        );
    }

    const labelErr = formTouched.label ? validateLabel(formLabel) : null;
    const destErr = formTouched.dest ? validateDestination(formType, formDest) : null;

    // ── Save channel ────────────────────────────────────────

    async function handleSave(e: React.FormEvent) {
        e.preventDefault();

        // Force touch all fields
        setFormTouched({ label: true, dest: true });
        const lErr = validateLabel(formLabel);
        const dErr = validateDestination(formType, formDest);
        if (lErr || dErr) return;
        if (!customerId) return;

        setSaving(true);
        const payload = {
            customer_id: customerId,
            channel_type: formType,
            destination: formDest.trim(),
            label: formLabel.trim(),
            min_severity: formSeverity,
            alert_type_filter: formTypeFilter,
        };

        if (editingId) {
            const { error } = await supabase
                .from('alert_notification_channels')
                .update(payload)
                .eq('id', editingId);

            if (error) {
                showToast(`Failed to update: ${error.message}`, 'critical');
            } else {
                showToast('Channel updated', 'success', 3000);
            }
        } else {
            const { error } = await supabase
                .from('alert_notification_channels')
                .insert(payload);

            if (error) {
                showToast(`Failed to create: ${error.message}`, 'critical');
            } else {
                showToast('Channel created', 'success', 3000);
            }
        }

        setSaving(false);
        resetForm();
        await loadData();
    }

    // ── Toggle active ───────────────────────────────────────

    async function toggleActive(ch: Channel) {
        const { error } = await supabase
            .from('alert_notification_channels')
            .update({ is_active: !ch.is_active })
            .eq('id', ch.id);

        if (error) {
            showToast(`Failed: ${error.message}`, 'critical');
        } else {
            showToast(ch.is_active ? 'Channel disabled' : 'Channel enabled', 'info', 3000);
            await loadData();
        }
    }

    // ── Delete ──────────────────────────────────────────────

    async function handleDelete(ch: Channel) {
        if (!confirm(`Delete "${ch.label || ch.destination}"? This cannot be undone.`)) return;

        const { error } = await supabase
            .from('alert_notification_channels')
            .delete()
            .eq('id', ch.id);

        if (error) {
            showToast(`Delete failed: ${error.message}`, 'critical');
        } else {
            showToast('Channel deleted', 'info', 3000);
            await loadData();
        }
    }

    // ── Test ────────────────────────────────────────────────

    async function handleTest(ch: Channel) {
        if (!API_BASE) {
            showToast('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL.', 'critical', 6000);
            return;
        }

        setTestingId(ch.id);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API_BASE}/v1/admin/test-notification`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel_id: ch.id }),
            });
            const data = await res.json();

            if (data.success) {
                showToast('Test alert sent successfully', 'success', 4000);
            } else {
                showToast(`Test failed: ${data.error ?? 'Unknown error'}`, 'critical', 8000);
            }
        } catch (err: any) {
            showToast(`Test failed: ${err.message}`, 'critical', 8000);
        }
        setTestingId(null);
        await loadData();
    }

    // ── Render ──────────────────────────────────────────────

    if (loading) {
        return <div style={{ color: '#94a3b8', textAlign: 'center', padding: '3rem' }}>Loading notification settings...</div>;
    }

    return (
        <div>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1e293b', margin: 0 }}>
                        Settings → Notifications
                    </h1>
                    <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: '0.25rem 0 0' }}>
                        Configure where Layerinfinite sends alert notifications.
                    </p>
                </div>
                {!showForm && (
                    <button
                        onClick={() => { resetForm(); setShowForm(true); }}
                        style={btnPrimary}
                    >
                        + Add Channel
                    </button>
                )}
            </div>

            {/* Add / Edit form */}
            {showForm && (
                <form onSubmit={handleSave} style={{
                    ...card, border: '1px solid #3b82f6', background: '#f0f9ff', marginBottom: '1.5rem',
                }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 600, color: '#1e293b', margin: '0 0 1rem' }}>
                        {editingId ? 'Edit Channel' : 'Add Channel'}
                    </h2>

                    {/* Channel type */}
                    <div style={{ marginBottom: '0.75rem' }}>
                        <label style={labelStyle}>Channel Type</label>
                        <select
                            value={formType}
                            onChange={e => setFormType(e.target.value as ChannelType)}
                            disabled={!!editingId}
                            style={{ ...inputStyle, width: 'auto', minWidth: '200px' }}
                        >
                            <option value="slack_webhook">Slack Webhook</option>
                            <option value="webhook">HTTP Webhook</option>
                            <option value="email">Email</option>
                        </select>
                    </div>

                    {/* Label */}
                    <div style={{ marginBottom: '0.75rem' }}>
                        <label style={labelStyle}>Label</label>
                        <input
                            type="text"
                            value={formLabel}
                            onChange={e => setFormLabel(e.target.value)}
                            onBlur={() => setFormTouched(p => ({ ...p, label: true }))}
                            placeholder={formType === 'slack_webhook' ? 'Engineering Alerts' : formType === 'webhook' ? 'PagerDuty Integration' : 'Engineering Team'}
                            style={inputStyle}
                            maxLength={100}
                        />
                        {labelErr && <div style={errorText}>{labelErr}</div>}
                    </div>

                    {/* Destination */}
                    <div style={{ marginBottom: '0.75rem' }}>
                        <label style={labelStyle}>
                            {formType === 'email' ? 'Email Address' : formType === 'slack_webhook' ? 'Slack Webhook URL' : 'Webhook URL'}
                        </label>
                        <input
                            type={formType === 'email' ? 'email' : 'url'}
                            value={formDest}
                            onChange={e => setFormDest(e.target.value)}
                            onBlur={() => setFormTouched(p => ({ ...p, dest: true }))}
                            placeholder={
                                formType === 'email' ? 'team@company.com'
                                : formType === 'slack_webhook' ? 'https://hooks.slack.com/services/...'
                                : 'https://events.pagerduty.com/...'
                            }
                            style={inputStyle}
                        />
                        {destErr && <div style={errorText}>{destErr}</div>}
                        {formType === 'email' && (
                            <div style={helperText}>
                                Email delivery requires RESEND_API_KEY to be set in your Supabase Edge Function secrets.
                            </div>
                        )}
                    </div>

                    {/* Min severity */}
                    <div style={{ marginBottom: '0.75rem' }}>
                        <label style={labelStyle}>Minimum Severity</label>
                        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                            {(['info', 'warning', 'critical'] as MinSeverity[]).map(sev => (
                                <label key={sev} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: '#1e293b', cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="min_severity"
                                        value={sev}
                                        checked={formSeverity === sev}
                                        onChange={() => setFormSeverity(sev)}
                                    />
                                    {SEVERITY_LABELS[sev]}
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Alert type filter */}
                    <div style={{ marginBottom: '1rem' }}>
                        <label style={labelStyle}>Alert Types (empty = all)</label>
                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                            {ALERT_TYPES.map(at => (
                                <label key={at.key} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.82rem', color: '#1e293b', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={formTypeFilter.includes(at.key)}
                                        onChange={() => toggleTypeFilter(at.key)}
                                    />
                                    {at.label}
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Buttons */}
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button type="submit" disabled={saving} style={btnPrimary}>
                            {saving ? 'Saving...' : editingId ? 'Update Channel' : 'Save Channel'}
                        </button>
                        <button type="button" onClick={resetForm} style={btnSecondary}>
                            Cancel
                        </button>
                    </div>
                </form>
            )}

            {/* Channel list */}
            {channels.length === 0 && !showForm ? (
                <div style={{ textAlign: 'center', padding: '3rem 2rem', color: '#94a3b8' }}>
                    <div style={{ fontSize: '1rem', fontWeight: 500, color: '#475569', marginBottom: '0.5rem' }}>
                        No notification channels configured
                    </div>
                    <div style={{ fontSize: '0.85rem' }}>
                        Click "+ Add Channel" to set up Slack, webhook, or email notifications for alerts.
                    </div>
                </div>
            ) : (
                channels.map(ch => {
                    const isFailed = ch.last_delivery_ok === false;
                    return (
                        <div key={ch.id} style={isFailed ? cardFailed : card}>
                            {/* Card header */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <span style={{
                                        fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase',
                                        padding: '2px 8px', borderRadius: '4px',
                                        background: ch.channel_type === 'slack_webhook' ? '#e8d5f5' : ch.channel_type === 'webhook' ? '#dbeafe' : '#fef3c7',
                                        color: ch.channel_type === 'slack_webhook' ? '#7c3aed' : ch.channel_type === 'webhook' ? '#2563eb' : '#d97706',
                                    }}>
                                        {CHANNEL_TYPE_ICONS[ch.channel_type]} {CHANNEL_TYPE_LABELS[ch.channel_type]}
                                    </span>
                                    <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#1e293b' }}>
                                        {ch.label || ch.destination}
                                    </span>
                                </div>
                                <span style={{
                                    fontSize: '0.72rem', fontWeight: 600,
                                    color: ch.is_active ? '#16a34a' : '#94a3b8',
                                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                                }}>
                                    <span style={{
                                        width: '6px', height: '6px', borderRadius: '50%',
                                        background: ch.is_active ? '#16a34a' : '#94a3b8',
                                        display: 'inline-block',
                                    }} />
                                    {ch.is_active ? 'Active' : 'Disabled'}
                                </span>
                            </div>

                            {/* Destination */}
                            {ch.label && (
                                <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: '0.25rem', fontFamily: 'monospace' }}>
                                    {ch.channel_type === 'email' ? ch.destination : ch.destination.length > 60 ? ch.destination.slice(0, 60) + '...' : ch.destination}
                                </div>
                            )}

                            {/* Details */}
                            <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                                Threshold: {SEVERITY_LABELS[ch.min_severity]}
                                {ch.alert_type_filter && ch.alert_type_filter.length > 0 && (
                                    <> · Types: {ch.alert_type_filter.map(t => ALERT_TYPES.find(a => a.key === t)?.label ?? t).join(', ')}</>
                                )}
                            </div>

                            {/* Delivery status */}
                            <div style={{ fontSize: '0.78rem', color: isFailed ? '#dc2626' : '#94a3b8', marginBottom: '0.75rem' }}>
                                {ch.last_delivery_at ? (
                                    <>
                                        Last sent: {formatRelative(ch.last_delivery_at)}{' '}
                                        {ch.last_delivery_ok ? '✓' : '✗'}
                                    </>
                                ) : (
                                    'Last sent: Never'
                                )}
                                {ch.last_delivery_error && !ch.last_delivery_ok && (
                                    <div style={{ marginTop: '0.2rem', fontSize: '0.75rem' }}>
                                        Error: {ch.last_delivery_error}
                                    </div>
                                )}
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <button onClick={() => openEdit(ch)} style={btnSecondary}>
                                    Edit
                                </button>
                                <button
                                    onClick={() => handleTest(ch)}
                                    disabled={testingId === ch.id}
                                    style={{ ...btnSecondary, color: '#3b82f6', borderColor: '#93c5fd' }}
                                >
                                    {testingId === ch.id ? 'Sending...' : 'Test'}
                                </button>
                                <button onClick={() => toggleActive(ch)} style={btnSecondary}>
                                    {ch.is_active ? 'Disable' : 'Enable'}
                                </button>
                                <button onClick={() => handleDelete(ch)} style={btnDanger}>
                                    Delete
                                </button>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
    );
}

// ── Relative time helper ────────────────────────────────────

function formatRelative(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
}
