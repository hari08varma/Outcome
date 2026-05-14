/**
 * LayerInfinite MCP Server — tools/li-toggle-action.ts
 * ══════════════════════════════════════════════════════════════
 * RUNTIME CIRCUIT BREAKER — Always registered, all modes.
 *
 * When an agent detects an action is consistently failing (e.g.,
 * a provider API is down), it can disable that action immediately.
 * Disabled actions are excluded from all LI recommendations and
 * resource injections. The action is NOT deleted — all historical
 * data is preserved. The developer can re-enable it from the
 * dashboard once the underlying issue is fixed.
 *
 * Maps to PUT /v1/admin/:action_id on the LI REST API.
 *
 * REST API contract (from admin/actions.ts toggleActionHandler):
 *   PUT /v1/admin/:id with body { is_active: boolean }
 *   Requires action_id (UUID).
 *
 * Auth: X-API-Key + adminAuthMiddleware (customer_admin role)
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_TOGGLE_ACTION_NAME = 'li_toggle_action';

export const LI_TOGGLE_ACTION_DESCRIPTION =
  'Circuit breaker: temporarily disable a failing action or re-enable a fixed one. ' +
  'Disabled actions are immediately excluded from all LI recommendations and ' +
  'resource injections. The action and its historical data are preserved — ' +
  'the developer can re-enable it from the dashboard after fixing the issue.';

export const liToggleActionSchema = {
  action_id: z.string().uuid().describe('UUID of the action to toggle (find via li_observe or dashboard)'),
  enabled: z.boolean().describe('false to circuit-break a failing action, true to re-enable'),
  reason: z.string().max(500).optional().describe('Why you are toggling this action, e.g. "3x GATEWAY_TIMEOUT in 60s"'),
};

export function createLiToggleActionHandler(client: RestClient) {
  return async (input: z.infer<z.ZodObject<typeof liToggleActionSchema>>) => {
    // REST API: PUT /v1/admin/:id with body { is_active: boolean }
    const result = await client.put<unknown>(
      `/v1/admin/${input.action_id}`,
      { is_active: input.enabled },
    );

    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            toggled: false,
            error: result.error.message ?? result.error.error,
          }),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          toggled: true,
          action_id: input.action_id,
          is_active: input.enabled,
          circuit_breaker: !input.enabled ? 'OPEN — action disabled' : 'CLOSED — action re-enabled',
          ...(input.reason ? { reason: input.reason } : {}),
          ...(result.data as object),
        }),
      }],
    };
  };
}
