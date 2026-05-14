/**
 * LayerInfinite MCP Server — tools/li-observe.ts
 * ══════════════════════════════════════════════════════════════
 * Always registered. Returns per-task outcome statistics.
 * Maps to GET /v1/observe?task={task} on the LI REST API.
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';

export const LI_OBSERVE_NAME = 'li_observe';

export const LI_OBSERVE_DESCRIPTION =
  'Get outcome statistics for a task — total runs, success rate, best/worst ' +
  'performing actions, and when the last outcome was logged.';

export const liObserveSchema = {
  task: z.string().min(1).describe('Task name to get statistics for'),
};

interface ObserveResponse {
  task: string;
  total_runs: number;
  success_rate: number;
  actions_seen: string[];
  best_performing: string | null;
  worst_performing: string | null;
  last_run: string | null;
}

export function createLiObserveHandler(client: RestClient) {
  return async (input: { task: string }) => {
    const result = await client.get<ObserveResponse>('/v1/observe', {
      task: input.task,
    });

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
