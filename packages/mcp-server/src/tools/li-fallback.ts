/**
 * LayerInfinite MCP Server — tools/li-fallback.ts
 * ══════════════════════════════════════════════════════════════
 * Recovery tool — registered in assist + auto modes.
 * When an action fails, get the next-best action excluding
 * already-tried actions (uses EpisodeTracker for loop prevention).
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';
import type { EpisodeTracker } from '../episode-tracker.js';

export const LI_FALLBACK_NAME = 'li_fallback';

export const LI_FALLBACK_DESCRIPTION =
  'Get the next-best action after a failure. Excludes previously tried actions ' +
  'to prevent loops. Always call li_log with the result after executing.';

export const liFallbackSchema = {
  task: z.string().min(1).describe('Same task that failed'),
  failed_action: z.string().min(1).describe('The action that just failed'),
  error_context: z.string().max(500).optional().describe('Why it failed — helps LI exclude similar actions'),
  episode_id: z.string().uuid().optional().describe('Episode ID for tracking tried actions'),
};

interface ScoresResponse {
  ranked_actions: Array<{
    action_name: string;
    composite_score: number;
    confidence: number;
    [key: string]: unknown;
  }>;
  decision_id: string;
  [key: string]: unknown;
}

export function createLiFallbackHandler(client: RestClient, episodeTracker: EpisodeTracker) {
  return async (input: z.infer<z.ZodObject<typeof liFallbackSchema>>) => {
    const { task, failed_action, error_context, episode_id } = input;
    const episodeId = episode_id ?? `ephemeral-${Date.now()}`;

    // Mark the failed action as tried (Gap Fix #2)
    episodeTracker.markTried(episodeId, failed_action);

    // Fetch fresh scores (cache was invalidated by the li_log call)
    const result = await client.get<ScoresResponse>('/v1/get-scores', {
      issue_type: task,
    });

    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            fallback_available: false,
            error: result.error.message ?? result.error.error,
            tried_actions: Array.from(episodeTracker.getTriedActions(episodeId)),
          }),
        }],
        isError: true,
      };
    }

    const triedActions = episodeTracker.getTriedActions(episodeId);
    const ranked = result.data.ranked_actions ?? [];

    // Filter out all tried actions
    const candidates = ranked.filter(a => !triedActions.has(a.action_name));

    if (candidates.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            fallback_available: false,
            reason: 'All available actions have been tried',
            tried_actions: Array.from(triedActions),
            decision_id: result.data.decision_id,
          }),
        }],
      };
    }

    const nextBest = candidates[0];
    episodeTracker.markTried(episodeId, nextBest.action_name);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          fallback_available: true,
          next_action: nextBest.action_name,
          confidence: nextBest.composite_score,
          decision_id: result.data.decision_id,
          episode_id: episodeId,
          tried_actions: Array.from(episodeTracker.getTriedActions(episodeId)),
          ...(error_context ? { previous_error: error_context } : {}),
        }),
      }],
    };
  };
}
