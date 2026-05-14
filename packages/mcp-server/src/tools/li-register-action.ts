/**
 * LayerInfinite MCP Server — tools/li-register-action.ts
 * ══════════════════════════════════════════════════════════════
 * Admin-gated. Pre-registers an action with its parameter schema.
 * Maps to POST /v1/admin/register-action on the LI REST API.
 *
 * REST API contract (from admin/actions.ts RegisterActionBody):
 *   action_name:        string (required, min 1, max 255)
 *   action_category:    string (optional, default 'custom')
 *   action_description: string (optional, max 1000)
 *   required_params:    string[] (optional, default [])
 *   validation_mode:    string (optional, default 'none')
 *
 * Auth: X-API-Key (same key) + adminAuthMiddleware checks
 * dim_customers.config.role === 'customer_admin'
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_REGISTER_ACTION_NAME = 'li_register_action';

export const LI_REGISTER_ACTION_DESCRIPTION =
  'Pre-register an action with its category and required parameter names. ' +
  'Registered actions appear in the admin dashboard and can be toggled on/off.';

export const liRegisterActionSchema = {
  action_name: z.string().min(1).max(255).describe('Action name to register'),
  action_description: z.string().max(1000).optional().describe('Human-readable description'),
  action_category: z.string().max(100).optional().describe('Category, e.g. recovery, escalation, automation'),
  required_params: z.array(z.string()).optional().describe('List of required parameter names'),
};

export function createLiRegisterActionHandler(client: RestClient, _adminKey: string) {
  return async (input: z.infer<z.ZodObject<typeof liRegisterActionSchema>>) => {
    const result = await client.post<unknown>('/v1/admin/register-action', {
      action_name: input.action_name,
      action_description: input.action_description,
      action_category: input.action_category ?? 'custom',
      required_params: input.required_params ?? [],
    });

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error.message ?? result.error.error }) }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ registered: true, ...result.data as object }) }] };
  };
}
