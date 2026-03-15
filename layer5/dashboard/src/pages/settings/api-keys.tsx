/**
 * API Keys Settings Page — /settings/api-keys
 * Lists, creates, and deactivates API keys.
 * Full key shown ONCE after creation in a copy-to-clipboard modal.
 */
import React, { useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';

const API_BASE = import.meta.env.VITE_LAYERINFINITE_API_URL ?? import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

interface ApiKey {
    key_id: string;
    name: string;
    prefix: string | null;
    is_active: boolean;
    created_at: string;
}

export default function ApiKeysPage() {
    const [keys, setKeys] = useState<ApiKey[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [profileMissing, setProfileMissing] = useState(false);

    // Create modal state
    const [showCreate, setShowCreate] = useState(false);
    const [newKeyName, setNewKeyName] = useState('');
    const [creating, setCreating] = useState(false);

    // Reveal modal state (shows full key once)
    const [revealedKey, setRevealedKey] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        fetchKeys();
    }, []);

    async function getAuthHeaders(): Promise<Record<string, string>> {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return {};
        return { Authorization: `Bearer ${session.access_token}` };
    }

    async function fetchKeys() {
        setLoading(true);
        setError('');
        setProfileMissing(false);
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API_BASE}/v1/auth/api-keys`, { headers });
            let data: any = {};
            try {
                data = await res.json();
            } catch {
                data = {};
            }

            if (!res.ok) {
                // Detect account-setup-incomplete separately — show a friendly banner
                if (res.status === 403 && data.code === 'PROFILE_MISSING') {
                    setProfileMissing(true);
                    setKeys([]);
                } else {
                    throw new Error(data.error ?? 'Failed to fetch keys');
                }
                return;
            }
            setKeys(data.keys);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleSignOut() {
        await supabase.auth.signOut();
        window.location.href = '/';
    }

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        setCreating(true);
        setError('');
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API_BASE}/v1/auth/api-keys`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newKeyName }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? 'Failed to create key');

            // Show the full key ONCE
            setRevealedKey(data.key);
            setCopied(false);
            setShowCreate(false);
            setNewKeyName('');
            await fetchKeys();
        } catch (err: any) {
            setError(err.message);
        }
        setCreating(false);
    }

    async function handleDelete(keyId: string) {
        if (!confirm('Deactivate this API key? Agents using it will lose access.')) return;
        setError('');
        try {
            const headers = await getAuthHeaders();
            const res = await fetch(`${API_BASE}/v1/auth/api-keys/${keyId}`, {
                method: 'DELETE',
                headers,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? 'Failed to deactivate key');
            await fetchKeys();
        } catch (err: any) {
            setError(err.message);
        }
    }

    function handleCopy() {
        if (revealedKey) {
            navigator.clipboard.writeText(revealedKey);
            setCopied(true);
        }
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h2 style={{ margin: 0, color: '#FFFFFF' }}>API Keys</h2>
                <button onClick={() => setShowCreate(true)} style={primaryBtn}>Create New Key</button>
            </div>

            {profileMissing && (
                <div style={setupBanner}>
                    <span style={{ fontWeight: 600 }}>⚠️ Your account is still being set up.</span>{' '}
                    Please sign out and sign back in to complete account provisioning.
                    <button
                        onClick={handleSignOut}
                        style={signOutBtn}
                    >
                        Sign Out
                    </button>
                </div>
            )}
            {error && <div style={errorBox}>{error}</div>}

            {/* ── Revealed key modal ── */}
            {revealedKey && (
                <div style={modalOverlay}>
                    <div style={modalCard}>
                        <h3 style={{ margin: '0 0 0.5rem', color: '#FFFFFF' }}>Your New API Key</h3>
                        <p style={warningText}>⚠️ Save this key now — it cannot be shown again.</p>
                        <div style={keyDisplay}>{revealedKey}</div>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                            <button onClick={handleCopy} style={primaryBtn}>
                                {copied ? '✓ Copied' : 'Copy to Clipboard'}
                            </button>
                            <button onClick={() => setRevealedKey(null)} style={secondaryBtn}>Done</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Create key modal ── */}
            {showCreate && (
                <div style={modalOverlay}>
                    <div style={modalCard}>
                        <h3 style={{ margin: '0 0 1rem', color: '#FFFFFF' }}>Create API Key</h3>
                        <form onSubmit={handleCreate}>
                            <label style={label}>Key Name</label>
                            <input
                                type="text"
                                value={newKeyName}
                                onChange={e => setNewKeyName(e.target.value)}
                                required
                                style={input}
                                placeholder="e.g. Production Agent"
                            />
                            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                                <button type="submit" disabled={creating} style={primaryBtn}>
                                    {creating ? 'Creating…' : 'Create'}
                                </button>
                                <button type="button" onClick={() => setShowCreate(false)} style={secondaryBtn}>Cancel</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ── Keys table ── */}
            {loading ? (
                <p style={{ color: '#888888' }}>Loading…</p>
            ) : keys.length === 0 ? (
                <p style={{ color: '#888888' }}>No API keys yet. Create one to get started.</p>
            ) : (
                <table style={table}>
                    <thead>
                        <tr>
                            <th style={th}>Name</th>
                            <th style={th}>Prefix</th>
                            <th style={th}>Status</th>
                            <th style={th}>Created</th>
                            <th style={th}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {keys.map(k => (
                            <tr key={k.key_id}>
                                <td style={td}>{k.name}</td>
                                <td style={{ ...td, fontFamily: 'monospace', fontSize: '0.8rem' }}>{k.prefix ?? '—'}</td>
                                <td style={td}>
                                    <span style={{
                                        padding: '0.125rem 0.5rem', borderRadius: '9999px', fontSize: '0.75rem', fontWeight: 600,
                                        background: k.is_active ? 'rgba(0,255,133,0.15)' : 'rgba(220,38,38,0.15)',
                                        color: k.is_active ? '#00FF85' : '#f87171',
                                    }}>
                                        {k.is_active ? 'Active' : 'Deactivated'}
                                    </span>
                                </td>
                                <td style={td}>{new Date(k.created_at).toLocaleDateString()}</td>
                                <td style={td}>
                                    {k.is_active && (
                                        <button onClick={() => handleDelete(k.key_id)} style={dangerBtn}>Deactivate</button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

// ── Styles ────────────────────────────────────────────────────
const primaryBtn: React.CSSProperties = {
    padding: '0.5rem 1rem', borderRadius: '0.375rem', background: '#00FF85',
    color: '#000000', border: 'none', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
};
const secondaryBtn: React.CSSProperties = {
    padding: '0.5rem 1rem', borderRadius: '0.375rem', background: '#1A1A1A',
    color: '#FFFFFF', border: '1px solid #333', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
};
const dangerBtn: React.CSSProperties = {
    padding: '0.25rem 0.75rem', borderRadius: '0.375rem', background: 'rgba(220,38,38,0.1)',
    color: '#f87171', border: '1px solid rgba(220,38,38,0.3)', cursor: 'pointer', fontSize: '0.8rem',
};
const modalOverlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex',
    justifyContent: 'center', alignItems: 'center', zIndex: 50,
};
const modalCard: React.CSSProperties = {
    background: '#111111', borderRadius: '0.75rem', padding: '1.5rem',
    width: '100%', maxWidth: '480px', boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    border: '1px solid #1A1A1A',
};
const warningText: React.CSSProperties = {
    color: '#fbbf24', fontSize: '0.875rem', fontWeight: 500, margin: '0 0 0.75rem',
};
const keyDisplay: React.CSSProperties = {
    background: '#0A0A0A', borderRadius: '0.375rem', padding: '0.75rem',
    fontFamily: "'JetBrains Mono', monospace", fontSize: '0.85rem', wordBreak: 'break-all',
    border: '1px solid #1A1A1A', color: '#00FF85',
};
const label: React.CSSProperties = {
    display: 'block', fontSize: '0.875rem', fontWeight: 500,
    color: '#888888', marginBottom: '0.25rem',
};
const input: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem',
    border: '1px solid #333', fontSize: '0.875rem', boxSizing: 'border-box',
    background: '#0A0A0A', color: '#FFFFFF',
};
const errorBox: React.CSSProperties = {
    background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171',
    borderRadius: '0.375rem', padding: '0.5rem 0.75rem', fontSize: '0.875rem',
    marginBottom: '1rem',
};
const setupBanner: React.CSSProperties = {
    background: '#fefce8', border: '1px solid #fde68a', color: '#92400e',
    borderRadius: '0.375rem', padding: '0.75rem 1rem', fontSize: '0.875rem',
    marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
};
const signOutBtn: React.CSSProperties = {
    padding: '0.25rem 0.75rem', borderRadius: '0.375rem', background: '#fef3c7',
    color: '#92400e', border: '1px solid #fcd34d', cursor: 'pointer',
    fontSize: '0.8rem', fontWeight: 600, marginLeft: 'auto',
};
const table: React.CSSProperties = {
    width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem',
};
const th: React.CSSProperties = {
    textAlign: 'left', padding: '0.5rem 0.75rem', borderBottom: '2px solid #1A1A1A',
    color: '#888888', fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase',
};
const td: React.CSSProperties = {
    padding: '0.5rem 0.75rem', borderBottom: '1px solid #111111', color: '#CCCCCC',
};
