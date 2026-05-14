/**
 * LayerInfinite MCP Server — tools/li-audit.ts
 * ══════════════════════════════════════════════════════════════
 * Always registered. Returns paginated audit trail from fact_outcomes.
 * Maps to GET /v1/audit on the LI REST API.
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_AUDIT_NAME = 'li_audit';

export const LI_AUDIT_DESCRIPTION =
  'Get an immutable audit trail of logged outcomes. Filter by action, ' +
  'time range, or success/failure. Returns paginated results.';

export const liAuditSchema = {
  action_name: z.string().optional().describe('Filter by action name'),
  success: z.boolean().optional().describe('Filter by success (true/false)'),
  from: z.string().optional().describe('Start date (ISO 8601)'),
  to: z.string().optional().describe('End date (ISO 8601)'),
  limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results to return'),
};

export function createLiAuditHandler(client: RestClient) {
  return async (input: z.infer<z.ZodObject<typeof liAuditSchema>>) => {
    const params: Record<string, string> = {};
    if (input.action_name) params.action_name = input.action_name;
    if (input.success !== undefined) params.success = String(input.success);
    if (input.from) params.from = input.from;
    if (input.to) params.to = input.to;
    if (input.limit) params.page_size = String(input.limit);

    const result = await client.get<unknown>('/v1/audit', params);

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error.message ?? result.error.error }) }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.data) }],
    };
  };
}
