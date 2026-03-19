import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../lib/config';
import { supabase } from '../supabaseClient';

export interface ActionSettingsItem {
  actionId: string;
  actionName: string;
  requiredParams: string[];
  isActive: boolean;
  createdAt: string;
}

interface ActionsApiRow {
  action_id: string;
  action_name: string;
  required_params: Record<string, unknown> | null;
  is_active: boolean;
  created_at: string;
}

interface ActionsApiResponse {
  actions?: ActionsApiRow[];
  error?: string;
  details?: string;
}

interface UseActionsSettingsResult {
  actions: ActionSettingsItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  registerAction: (name: string, requiredParams: string[]) => Promise<void>;
  toggleAction: (actionId: string, isActive: boolean) => Promise<void>;
}

function extractParams(value: Record<string, unknown> | null): string[] {
  if (!value) {
    return [];
  }
  return Object.keys(value);
}

async function getSessionToken(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }

  return session.access_token;
}

function buildAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function useActionsSettings(): UseActionsSettingsResult {
  const [actions, setActions] = useState<ActionSettingsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const fetchActions = useCallback(async () => {
    if (!API_BASE) {
      setError('API endpoint is not configured. Set VITE_LAYERINFINITE_API_URL and redeploy.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await getSessionToken();
      const response = await fetch(`${API_BASE}/v1/admin/actions?include_inactive=true`, {
        method: 'GET',
        headers: buildAuthHeaders(token),
      });

      const payload = (await response.json()) as ActionsApiResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? payload.details ?? 'Failed to fetch actions');
      }

      const mapped = (payload.actions ?? []).map((row) => ({
        actionId: row.action_id,
        actionName: row.action_name,
        requiredParams: extractParams(row.required_params),
        isActive: row.is_active,
        createdAt: row.created_at,
      }));

      setActions(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch actions');
      setActions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchActions();
  }, [fetchActions, tick]);

  const registerAction = useCallback(async (name: string, requiredParams: string[]) => {
    if (!API_BASE) {
      throw new Error('API endpoint is not configured.');
    }
    const token = await getSessionToken();

    const requiredParamsObject = requiredParams.reduce<Record<string, string>>((acc, item) => {
      acc[item] = 'required';
      return acc;
    }, {});

    const response = await fetch(`${API_BASE}/v1/admin/register-action`, {
      method: 'POST',
      headers: buildAuthHeaders(token),
      body: JSON.stringify({
        action_name: name,
        required_params: requiredParamsObject,
      }),
    });

    const payload = (await response.json()) as ActionsApiResponse;
    if (!response.ok) {
      throw new Error(payload.error ?? payload.details ?? 'Failed to register action');
    }

    setTick((value) => value + 1);
  }, []);

  const toggleAction = useCallback(async (actionId: string, isActive: boolean) => {
    if (!API_BASE) {
      throw new Error('API endpoint is not configured.');
    }
    const token = await getSessionToken();

    const response = await fetch(`${API_BASE}/v1/admin/actions/${actionId}`, {
      method: 'PUT',
      headers: buildAuthHeaders(token),
      body: JSON.stringify({ is_active: !isActive }),
    });

    const payload = (await response.json()) as ActionsApiResponse;
    if (!response.ok) {
      throw new Error(payload.error ?? payload.details ?? 'Failed to update action');
    }

    setTick((value) => value + 1);
  }, []);

  const refetch = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return useMemo(() => ({
    actions,
    loading,
    error,
    refetch,
    registerAction,
    toggleAction,
  }), [actions, loading, error, refetch, registerAction, toggleAction]);
}
