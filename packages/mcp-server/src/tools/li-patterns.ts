/**
 * LayerInfinite MCP Server — tools/li-patterns.ts
 * ══════════════════════════════════════════════════════════════
 * Mode-gated. Returns successful action sequences (playbooks).
 * Maps to GET /v1/get-patterns on the LI REST API.
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_PATTERNS_NAME = 'li_patterns';

export const LI_PATTERNS_DESCRIPTION =
  'Get the most successful action sequences (playbooks) for a task. ' +
  'Shows which multi-step workflows have the highest resolution rates.';

export const liPatternsSchema = {
  task: z.string().min(1).describe('Task to get patterns for'),
  min_samples: z.number().int().min(1).optional().default(2).describe('Minimum sample count per pattern'),
  top_n: z.number().int().min(1).max(10).optional().default(5).describe('Number of top patterns to return'),
};

export function createLiPatternsHandler(client: RestClient) {
  return async (input: z.infer<z.ZodObject<typeof liPatternsSchema>>) => {
    const result = await client.get<unknown>('/v1/get-patterns', {
      issue_type: input.task,
      min_samples: String(input.min_samples),
      top_n: String(input.top_n),
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
