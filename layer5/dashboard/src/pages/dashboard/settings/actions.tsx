import React, { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useToastContext } from '../../../components/Toast';
import { supabase } from '../../../supabaseClient';

interface Action {
  action_id: string;
  action_name: string;
  action_category: string | null;
  action_description: string | null;
  required_params: unknown;
  validation_mode: string | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  customer_id: string | null;
}

export default function ActionsSettings(): React.ReactElement {
  const { showToast } = useToastContext();

  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    action_name: '',
    action_category: 'custom',
    action_description: '',
    validation_mode: 'none',
  });

  useEffect(() => {
    void fetchActions();
  }, []);

  const fetchActions = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('dim_actions')
        .select('*')
        .order('created_at', { ascending: false });
      // RLS automatically scopes to logged-in user's customer_id

      if (queryError) throw queryError;
      setActions(data ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleAction = async (actionId: string, currentState: boolean) => {
    const { error: updateError } = await supabase
      .from('dim_actions')
      .update({
        is_active: !currentState,
        updated_at: new Date().toISOString(),
      })
      .eq('action_id', actionId);

    if (updateError) {
      console.error('Toggle failed:', updateError.message);
      setError(updateError.message);
      return;
    }
    // Optimistic update
    setActions(prev => prev.map(a =>
      a.action_id === actionId
        ? { ...a, is_active: !currentState }
        : a
    ));
  };

  const registerAction = async (payload: {
    action_name: string;
    action_category: string;
    action_description: string;
    validation_mode: string;
  }) => {
    const { error: insertError } = await supabase
      .from('dim_actions')
      .insert({
        ...payload,
        required_params: [],
        is_active: true,
      });

    if (insertError) {
      setError(insertError.message);
      return;
    }
    setShowForm(false);
    await fetchActions();
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();

    if (!formData.action_name.trim()) {
      return;
    }

    setSaving(true);
    try {
      await registerAction(formData);
      showToast('Action registered successfully.', 'success', 3500);
      setFormData({
        action_name: '',
        action_category: 'custom',
        action_description: '',
        validation_mode: 'none',
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to register action', 'critical', 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-white">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-bold">Actions Registry</h2>
          <p className="text-sm text-[#a1a1aa] mt-1">Customer-scoped actions from dim_actions with RLS enforcement.</p>
        </div>
        <button
          className="bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
          onClick={() => setShowForm((value) => !value)}
        >
          Register New Action
        </button>
      </div>

      <div className="bg-[#b8ff00]/5 border border-[#b8ff00]/20 rounded-xl px-5 py-3 mb-6 flex items-center gap-3">
        <span className="text-[#b8ff00]">⚡</span>
        <p className="text-[#a1a1aa] text-sm">
          Actions are{' '}
          <strong className="text-white">auto-discovered</strong>
          {' '}when your agent logs outcomes via the SDK.
          You can also register actions manually or
          disable specific actions here.
        </p>
      </div>

      <section className={`bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6 transition-all duration-300 ${showForm ? 'block' : 'hidden'}`}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Action Name</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="e.g. clear_cache"
              value={formData.action_name}
              onChange={(event) => setFormData(prev => ({ ...prev, action_name: event.target.value }))}
              required
            />
          </div>

          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Category</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              placeholder="custom"
              value={formData.action_category}
              onChange={(event) => setFormData(prev => ({ ...prev, action_category: event.target.value }))}
            />
          </div>

          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Description</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              placeholder="What this action does"
              value={formData.action_description}
              onChange={(event) => setFormData(prev => ({ ...prev, action_description: event.target.value }))}
            />
          </div>

          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Validation Mode</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              placeholder="none"
              value={formData.validation_mode}
              onChange={(event) => setFormData(prev => ({ ...prev, validation_mode: event.target.value }))}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-[#00cc66] hover:bg-[#00b55a] text-black font-semibold px-4 py-2 rounded-lg disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Submit'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="border border-[#1a1a24] text-[#a1a1aa] hover:text-white rounded-lg px-4 py-2"
            >
              Cancel
            </button>
          </div>
        </form>
      </section>

      {error && (
        <div className="mb-4 bg-[#ff4444]/10 border border-[#ff4444]/30 text-[#ff8a8a] rounded-xl px-4 py-3 text-sm flex items-center justify-between">
          <span>{error}</span>
          <button className="text-xs text-white border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={() => void fetchActions()}>Retry</button>
        </div>
      )}

      <section className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
          </div>
        ) : actions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="text-5xl mb-4 opacity-20">⚡</div>
            <h3 className="text-white font-semibold text-lg mb-2">
              No actions yet
            </h3>
            <p className="text-[#52525b] text-sm max-w-sm mb-6">
              Actions are automatically discovered when your agent
              logs outcomes via the SDK. Connect your agent to
              get started, or register an action manually.
            </p>
            <a href="/dashboard/settings/api-keys"
              className="bg-[#b8ff00] text-black font-semibold
                px-5 py-2 rounded-lg text-sm hover:bg-[#a0e600]
                transition-colors">
              Create API Key →
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1a24] text-[#a1a1aa]">
                  <th className="text-left px-4 py-3 font-medium">ACTION NAME</th>
                  <th className="text-left px-4 py-3 font-medium">CATEGORY</th>
                  <th className="text-left px-4 py-3 font-medium">STATUS</th>
                  <th className="text-left px-4 py-3 font-medium">REGISTERED</th>
                  <th className="text-left px-4 py-3 font-medium">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => (
                  <tr key={action.action_id} className="border-b border-[#1a1a24]/70">
                    <td className="px-4 py-3 text-white font-mono text-sm">{action.action_name}</td>
                    <td className="px-4 py-3 text-[#a1a1aa]">{action.action_category ?? 'custom'}</td>
                    <td className="px-4 py-3">
                      <span className={action.is_active
                        ? 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30'
                        : 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'}
                      >
                        {action.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#a1a1aa]">
                      {action.created_at ? format(new Date(action.created_at), 'MMM dd, yyyy') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${action.is_active ? 'bg-[#00cc66]' : 'bg-[#1a1a24]'}`}
                        onClick={() => void toggleAction(action.action_id, action.is_active)}
                      >
                        <span className={`inline-block h-5 w-5 rounded-full bg-white mt-0.5 transition-transform ${action.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
