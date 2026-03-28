import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { API_BASE } from '../../../lib/config';
import { useToastContext } from '../../../components/Toast';
import { supabase } from '../../../supabaseClient';
import { AGENT_API_KEY_STORAGE_KEY } from '../../../hooks/useAgentApiKey';

interface ApiKeyItem {
  key_id: string;
  name: string;
  prefix: string | null;
  is_active: boolean;
  created_at: string;
}

interface KeysApiResponse {
  keys?: ApiKeyItem[];
  api_key?: string;
  key_id?: string;
  agent_id?: string;
  agent_name?: string;
  created_at?: string;
  warning?: string;
  name?: string;
  error?: string;
  details?: string;
}

function getStoredApiKey(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return localStorage.getItem(AGENT_API_KEY_STORAGE_KEY);
}

function saveApiKey(value: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(AGENT_API_KEY_STORAGE_KEY, value);
}

async function getFallbackJwt(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function requestApiKeys(path: string, init: RequestInit): Promise<Response> {
  // /v1/auth/* routes ONLY accept Supabase JWT — never send agent key here
  const jwt = await getFallbackJwt();
  if (!jwt) {
    throw new Error('Session expired — please sign in again.');
  }

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
  });
}

export default function ApiKeysSettings(): React.ReactElement {
  const { showToast } = useToastContext();
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealedWarning, setRevealedWarning] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const createInFlightRef = useRef(false);

  // Auto-zero the revealed key after 30 seconds to limit DevTools exposure (SETTINGS-2)
  useEffect(() => {
    if (!revealedKey) return;
    const timer = window.setTimeout(() => {
      setRevealedKey(null);
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [revealedKey]);

  const hasAnyKeys = useMemo(() => keys.length > 0, [keys.length]);

  const handleStaleKey = useCallback(() => {
    showToast('Your stored API key was deactivated. Please create a new one.', 'warning', 6000);
  }, [showToast]);

  const fetchKeys = useCallback(async () => {
    if (!API_BASE) {
      setError('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL and redeploy.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await requestApiKeys('/v1/auth/api-keys', { method: 'GET' });

      const payload = (await response.json()) as KeysApiResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? 'Failed to fetch API keys');
      }

      setKeys(payload.keys ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch API keys');
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [handleStaleKey]);

  useEffect(() => {
    void fetchKeys();
  }, [fetchKeys, tick]);

  const createKey = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (creating || createInFlightRef.current) {
      return;
    }

    if (!newKeyName.trim()) {
      return;
    }

    if (!API_BASE) {
      setError('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL and redeploy.');
      return;
    }

    createInFlightRef.current = true;
    setCreating(true);
    setError(null);

    try {
      const response = await requestApiKeys('/v1/auth/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim() }),
      });

      const payload = (await response.json()) as KeysApiResponse;
      if (!response.ok) {
        setError(payload.error ?? payload.details ?? 'Failed to create API key');
        return;
      }

      const fullKey = payload.api_key ?? '';
      if (!fullKey) {
        console.error('[api-keys] Key created but api_key missing in response');
        showToast('Key created but could not be displayed. Check your keys list.', 'warning', 6000);
        await fetchKeys();
        return;
      }

      setRevealedKey(fullKey);
      setRevealedWarning(payload.warning ?? null);
      setCopiedKey(false);
      showToast('API key generated. Copy it now - it cannot be shown again.', 'success', 6000);
      setShowCreateForm(false);
      void fetchKeys();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create API key';
      const lowered = message.toLowerCase();
      if (lowered.includes('fetch') || lowered.includes('network') || lowered.includes('timeout')) {
        setError('Network error - your key may have been created. Refresh to check.');
        void fetchKeys();
      } else {
        setError(message);
      }
    } finally {
      setCreating(false);
      createInFlightRef.current = false;
    }
  };

  const copyGeneratedKey = async (): Promise<void> => {
    if (!revealedKey) {
      return;
    }

    await navigator.clipboard.writeText(revealedKey);
    try {
      saveApiKey(revealedKey);
      // Notify same-window listeners (storage event only fires cross-tab by default)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: AGENT_API_KEY_STORAGE_KEY,
          newValue: revealedKey,
          storageArea: window.localStorage,
        })
      );
    } catch {
      // Private browsing — silently skip
    }
    setCopiedKey(true);
    showToast('API key copied and saved. Recommendations page is now active.', 'success', 3000);
  };

  const closeCreateFlow = (): void => {
    setRevealedKey(null);
    setRevealedWarning(null);
    setCopiedKey(false);
    setShowCreateForm(false);
    setNewKeyName('');
    void fetchKeys();
  };

  const copyPrefixToClipboard = async (prefix: string | null, name: string): Promise<void> => {
    if (!prefix) {
      showToast('No prefix available for this key.', 'warning', 3000);
      return;
    }

    const cleanPrefix = prefix.replace(/\.+$/, '');
    await navigator.clipboard.writeText(cleanPrefix);
    showToast(`Copied prefix for "${name}".`, 'info', 2500);
  };

  const deactivateKey = async (keyId: string): Promise<void> => {
    if (!API_BASE) {
      setError('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL and redeploy.');
      return;
    }

    setDeletingId(keyId);
    setError(null);

    try {
      const response = await requestApiKeys(`/v1/auth/api-keys/${keyId}`, {
        method: 'DELETE',
      });

      const payload = (await response.json()) as KeysApiResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? 'Failed to deactivate API key');
      }

      showToast('API key deactivated.', 'warning', 3500);
      setConfirmingId(null);
      setTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deactivate API key');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="text-white">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-bold">API Keys</h2>
          <p className="text-sm text-[#a1a1aa] mt-1">Create and manage Layerinfinite API keys for your agents.</p>
        </div>
        <button
          onClick={() => setShowCreateForm((value) => !value)}
          className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
        >
          Create New Key
        </button>
      </div>

      {!getStoredApiKey() && (
        <div className="mb-4 bg-[#ffaa00]/10 border border-[#ffaa00]/30 text-[#ffaa00] rounded-xl px-4 py-3 text-sm">
          No API key found - create one below. Other settings pages that call the API require a saved key.
        </div>
      )}

      {error && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            className="border border-[#1a1a24] rounded-lg px-3 py-1.5 text-xs text-white"
            onClick={() => setTick((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}

      <section className="bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6 overflow-hidden">
        <div className={`transition-all duration-300 ${showCreateForm ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0 pointer-events-none'}`}>
          <form className="space-y-4" onSubmit={createKey}>
            <div>
              <label className="text-xs tracking-wide text-[#a1a1aa] block mb-1">Key Name</label>
              <input
                className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm text-white"
                placeholder="e.g. production-agent"
                required
                value={newKeyName}
                onChange={(event) => setNewKeyName(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="bg-[#00cc66] hover:bg-[#00b55a] text-black font-semibold px-4 py-2 rounded-lg disabled:opacity-60"
              >
                {creating ? 'Generating...' : 'Generate Key'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateForm(false);
                  setRevealedKey(null);
                  setRevealedWarning(null);
                  setCopiedKey(false);
                }}
                className="border border-[#1a1a24] rounded-lg px-4 py-2 text-[#a1a1aa] hover:text-white"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
          </div>
        ) : !hasAnyKeys ? (
          <div className="p-8 text-center">
            <p className="text-white text-lg font-medium">No API keys yet</p>
            <p className="text-[#a1a1aa] text-sm mt-1">Create a key to authenticate API requests from your agents.</p>
            <button
              onClick={() => setShowCreateForm(true)}
              className="mt-4 bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
            >
              Create First API Key
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1a24] text-[#a1a1aa]">
                  <th className="text-left px-4 py-3 font-medium">NAME</th>
                  <th className="text-left px-4 py-3 font-medium">PREFIX</th>
                  <th className="text-left px-4 py-3 font-medium">STATUS</th>
                  <th className="text-left px-4 py-3 font-medium">CREATED</th>
                  <th className="text-left px-4 py-3 font-medium">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((keyItem) => (
                  <tr key={keyItem.key_id} className="border-b border-[#1a1a24]/70">
                    <td className="px-4 py-3 text-white font-medium">{keyItem.name}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[#a1a1aa]">{keyItem.prefix ?? '-'}</span>
                        <button
                          onClick={() => void copyPrefixToClipboard(keyItem.prefix, keyItem.name)}
                          className="text-xs text-[#b8ff00] hover:underline"
                        >
                          Copy Prefix
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={keyItem.is_active
                        ? 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30'
                        : 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'}
                      >
                        {keyItem.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#a1a1aa]">{format(new Date(keyItem.created_at), 'MMM dd, yyyy')}</td>
                    <td className="px-4 py-3">
                      {!keyItem.is_active ? (
                        <span className="text-xs text-[#52525b]">No actions</span>
                      ) : confirmingId !== keyItem.key_id ? (
                        <button
                          onClick={() => setConfirmingId(keyItem.key_id)}
                          className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white rounded-lg px-3 py-1.5 text-xs"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setConfirmingId(null)}
                            className="text-xs text-[#52525b]"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => void deactivateKey(keyItem.key_id)}
                            disabled={deletingId === keyItem.key_id}
                            className="border border-[#ffaa00] text-[#ffaa00] rounded-lg px-3 py-1.5 text-xs min-w-[90px]"
                          >
                            {deletingId === keyItem.key_id ? '...' : 'Confirm?'}
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
      </section>

      {!getStoredApiKey() && hasAnyKeys && (
        <div className="mt-4 text-xs text-[#a1a1aa]">
          Need API access for admin endpoints? Store a key using the create flow above.
          {' '}
          <Link className="text-[#b8ff00] hover:underline" to="/dashboard/settings/api-keys">API Keys</Link>
        </div>
      )}

      {revealedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4">
          <div className="w-full max-w-xl rounded-2xl border border-[#1a1a24] bg-[#111118] p-6 shadow-2xl">
            <h3 className="text-xl font-bold text-white">API Key Created — Save It Now</h3>
            <p className="mt-3 text-sm text-[#ffaa00]">This key will never be shown again. Copy it now before closing.</p>
            {revealedWarning && <p className="mt-1 text-xs text-[#a1a1aa]">{revealedWarning}</p>}
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-[#1a1a24] bg-[#0a0a0f] p-2">
              <input
                className="flex-1 bg-transparent px-2 py-1 font-mono text-xs text-[#f4f4f5] outline-none"
                value={revealedKey}
                readOnly
              />
              <button
                onClick={copyGeneratedKey}
                className="rounded-lg bg-[#b8ff00] px-3 py-1.5 text-sm font-semibold text-black hover:bg-[#a5e800]"
              >
                {copiedKey ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => {
                if (revealedKey) {
                  try {
                    saveApiKey(revealedKey);
                    // Notify same-window listeners
                    window.dispatchEvent(
                      new StorageEvent('storage', {
                        key: AGENT_API_KEY_STORAGE_KEY,
                        newValue: revealedKey,
                        storageArea: window.localStorage,
                      })
                    );
                  } catch {
                    // Private browsing — silently skip
                  }
                }
                closeCreateFlow();
              }}
              className="mt-5 w-full rounded-lg border border-[#1a1a24] bg-[#00cc66] px-4 py-2 text-sm font-semibold text-black hover:bg-[#00b55a]"
            >
              I've copied my key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
