import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useToastContext } from '../../../components/Toast';
import { useActionsSettings } from '../../../hooks/useActionsSettings';

function isValidActionName(value: string): boolean {
  return /^[a-z0-9_]+$/.test(value);
}

export default function ActionsSettings(): React.ReactElement {
  const { showToast } = useToastContext();
  const { actions, loading, error, refetch, registerAction, toggleAction } = useActionsSettings();

  const [showForm, setShowForm] = useState(false);
  const [actionName, setActionName] = useState('');
  const [paramInput, setParamInput] = useState('');
  const [requiredParams, setRequiredParams] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const actionNameError = actionName.length > 0 && !isValidActionName(actionName)
    ? 'Only lowercase letters, numbers, and underscores are allowed.'
    : null;

  const hasActions = useMemo(() => actions.length > 0, [actions.length]);

  const addParam = (rawValue: string): void => {
    const value = rawValue.trim();
    if (!value) {
      return;
    }
    if (requiredParams.includes(value)) {
      return;
    }
    setRequiredParams((prev) => [...prev, value]);
  };

  const handleParamKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addParam(paramInput.replace(',', ''));
      setParamInput('');
    }
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!actionName || actionNameError) {
      return;
    }

    setSaving(true);
    try {
      await registerAction(actionName, requiredParams);
      showToast('Action registered. Your agent can now log outcomes for this action.', 'success', 4500);
      setActionName('');
      setParamInput('');
      setRequiredParams([]);
      setShowForm(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to register action', 'critical', 5000);
    } finally {
      setSaving(false);
    }
  };

  const onToggleAction = async (id: string, isActive: boolean): Promise<void> => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }

    try {
      await toggleAction(id, isActive);
      showToast(`Action ${isActive ? 'disabled' : 'enabled'} successfully.`, 'success', 3000);
      setConfirmingId(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update action', 'critical', 5000);
    }
  };

  return (
    <div className="text-white">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-bold">Actions Registry</h2>
          <p className="text-sm text-[#a1a1aa] mt-1">Actions discovered from real outcomes across your agents.</p>
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
          Actions are <strong className="text-white">auto-discovered</strong> when your agent logs outcomes.
          You can disable specific actions here.
        </p>
      </div>

      <section className={`bg-[#111118] border border-[#1a1a24] rounded-xl p-5 mb-6 transition-all duration-300 ${showForm ? 'block' : 'hidden'}`}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Action Name</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="e.g. clear_cache"
              value={actionName}
              onChange={(event) => setActionName(event.target.value)}
              required
            />
            {actionNameError && <p className="text-xs text-[#ff8a8a] mt-1">{actionNameError}</p>}
          </div>

          <div>
            <label className="text-xs text-[#a1a1aa] block mb-1">Required Parameters</label>
            <input
              className="w-full bg-[#0a0a0f] border border-[#1a1a24] rounded-lg px-3 py-2 text-sm"
              placeholder="e.g. service_id (press Enter to add)"
              value={paramInput}
              onChange={(event) => setParamInput(event.target.value)}
              onKeyDown={handleParamKeyDown}
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {requiredParams.map((param) => (
                <span key={param} className="bg-[#1a1a24] px-2 py-1 rounded text-xs text-[#a1a1aa] flex items-center gap-2">
                  {param}
                  <button
                    type="button"
                    className="text-[#52525b] hover:text-white"
                    onClick={() => setRequiredParams((prev) => prev.filter((item) => item !== param))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving || Boolean(actionNameError)}
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
          <button className="text-xs text-white border border-[#1a1a24] rounded-lg px-3 py-1.5" onClick={refetch}>Retry</button>
        </div>
      )}

      <section className="bg-[#111118] border border-[#1a1a24] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-3">
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
            <div className="h-10 rounded-lg bg-[#0a0a0f] border border-[#1a1a24] animate-pulse" />
          </div>
        ) : !hasActions ? (
          <div className="p-10 text-center">
            <Zap size={48} className="mx-auto text-[#52525b]" />
            <p className="text-white text-lg font-medium mt-4">No actions registered yet</p>
            <p className="text-[#a1a1aa] text-sm mt-1">Actions are auto-registered when your agent first uses them. Connect your agent to get started.</p>
            <Link
              className="inline-block mt-5 bg-[#b8ff00] hover:bg-[#a5e800] text-black font-semibold px-4 py-2 rounded-lg"
              to="/dashboard/settings/api-keys"
            >
              Create API Key
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1a1a24] text-[#a1a1aa]">
                  <th className="text-left px-4 py-3 font-medium">ACTION NAME</th>
                  <th className="text-left px-4 py-3 font-medium">REQUIRED PARAMS</th>
                  <th className="text-left px-4 py-3 font-medium">STATUS</th>
                  <th className="text-left px-4 py-3 font-medium">REGISTERED</th>
                  <th className="text-left px-4 py-3 font-medium">ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((action) => (
                  <tr key={action.actionId} className="border-b border-[#1a1a24]/70">
                    <td className="px-4 py-3 text-white font-mono text-sm">{action.actionName}</td>
                    <td className="px-4 py-3">
                      {action.requiredParams.length === 0 ? (
                        <span className="text-[#52525b]">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {action.requiredParams.map((param) => (
                            <span key={`${action.actionId}-${param}`} className="bg-[#1a1a24] px-1.5 py-0.5 rounded text-[#a1a1aa] text-xs">
                              {param}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={action.isActive
                        ? 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#00cc66]/10 text-[#00cc66] border border-[#00cc66]/30'
                        : 'text-[10px] font-bold px-2 py-1 rounded-full bg-[#52525b]/20 text-[#a1a1aa] border border-[#52525b]/30'}
                      >
                        {action.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#a1a1aa]">{format(new Date(action.createdAt), 'MMM dd, yyyy')}</td>
                    <td className="px-4 py-3">
                      {confirmingId !== action.actionId ? (
                        <button
                          className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${action.isActive ? 'bg-[#00cc66]' : 'bg-[#1a1a24]'}`}
                          onClick={() => setConfirmingId(action.actionId)}
                        >
                          <span className={`inline-block h-5 w-5 rounded-full bg-white mt-0.5 transition-transform ${action.isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button className="text-xs text-[#52525b]" onClick={() => setConfirmingId(null)}>Cancel</button>
                          <button
                            className="text-xs border border-[#ffaa00] text-[#ffaa00] rounded-lg px-3 py-1.5"
                            onClick={() => void onToggleAction(action.actionId, action.isActive)}
                          >
                            Confirm?
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
    </div>
  );
}
