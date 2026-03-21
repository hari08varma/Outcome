/**
 * Layerinfinite — lib/api.ts
 * ══════════════════════════════════════════════════════════════
 * Shared fetch utility for agent API routes (/v1/*).
 *
 * API CALL RULE: All calls to /v1/* MUST use the agent API key from localStorage.
 * NEVER use supabase.auth.getSession() token for agent routes.
 * Use the createAgentFetch() helper below which enforces this and handles 401 globally.
 *
 * Usage:
 *   const agentFetch = createAgentFetch(apiKey, handleAuthFailure);
 *   const res = await agentFetch(`${API_BASE}/v1/me`);
 * ══════════════════════════════════════════════════════════════
 */

/**
 * Creates a fetch wrapper that:
 * 1. Always attaches the agent API key as X-API-Key header
 * 2. On 401 or 403: calls onAuthFailure() (which should clear the key + redirect)
 *
 * @param apiKey - The layerinfinite_XXXX key from localStorage
 * @param onAuthFailure - Callback to invoke on auth failure (typically handleAuthFailure from useAgentApiKey)
 */
export function createAgentFetch(
  apiKey: string,
  onAuthFailure: () => void
): (url: string, options?: RequestInit) => Promise<Response> {
  return async (url: string, options: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        'X-API-Key': apiKey,
      },
    });

    if (res.status === 401 || res.status === 403) {
      onAuthFailure();
    }

    return res;
  };
}
