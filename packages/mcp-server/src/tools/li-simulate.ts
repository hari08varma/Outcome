/**
 * LayerInfinite MCP Server — tools/li-simulate.ts
 * ══════════════════════════════════════════════════════════════
 * Mode-gated. Sequence prediction via the 3-tier simulation engine.
 * Maps to POST /v1/simulate on the LI REST API.
 *
 * The simulate endpoint requires agent_id in the body. Since the
 * MCP server authenticates via X-API-Key (which resolves to an agent),
 * we pass a placeholder and let the auth middleware resolve it.
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_SIMULATE_NAME = 'li_simulate';

export const LI_SIMULATE_DESCRIPTION =
  'Simulate a proposed action sequence and predict its outcome. Returns ' +
  'success probability, confidence intervals, and alternative sequences.';

export const liSimulateSchema = {
  task: z.string().min(1).describe('Task context for the simulation'),
  proposed_sequence: z.array(z.string().min(1)).min(1).max(5).describe('Ordered list of actions to simulate'),
  episode_history: z.array(z.string()).optional().describe('Actions already taken in this episode'),
};

export function createLiSimulateHandler(client: RestClient) {
  return async (input: z.infer<z.ZodObject<typeof liSimulateSchema>>) => {
    // The simulate endpoint requires agent_id in the POST body.
    // The X-API-Key auth middleware on the REST API sets agent_id in the
    // request context. We send 'mcp' as a marker; the auth middleware
    // overrides this with the real agent_id from the API key lookup.
    const result = await client.post<unknown>('/v1/simulate', {
      agent_id: 'mcp',
      context: { issue_type: input.task },
      proposed_sequence: input.proposed_sequence,
      episode_history: input.episode_history ?? [],
    });

    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error.message ?? result.error.error }) }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(result.data) }] };
  };
}
