/**
 * LayerInfinite MCP Server — resources/task-intelligence.ts
 * ══════════════════════════════════════════════════════════════
 * MCP Resource: layerinfinite://tasks/{task_name}
 *
 * THE DECISION LAYER — always active regardless of mode.
 * Injects scored action intelligence into the agent's context
 * BEFORE the agent reasons about which action to take.
 *
 * This is how LI works like a memory layer — the agent reads this
 * resource and reasons WITH the data, not against it.
 * ══════════════════════════════════════════════════════════════
 */

import type { RestClient } from '../rest-client.js';
import type { LIConfig } from '../config.js';

/** Score response from GET /v1/get-scores. */
interface ScoresResponse {
  ranked_actions: Array<{
    action_name: string;
    composite_score: number;
    confidence: number;
    trend_delta?: number;
    is_cold_start?: boolean;
  }>;
  cold_start: boolean;
  outcomes_needed: number;
  decision_id: string;
  [key: string]: unknown;
}

/** Recommendation response from GET /v1/recommendations. */
interface RecommendationResponse {
  state: 'no_data' | 'early_signal' | 'stable';
  best_action?: string;
  confidence?: number;
  improvement?: number;
  [key: string]: unknown;
}

export const TASK_RESOURCE_TEMPLATE = 'layerinfinite://tasks/{task_name}';

/**
 * Creates the resource read handler for layerinfinite://tasks/{task_name}.
 * Returns formatted intelligence data that becomes part of the agent's context.
 */
export function createTaskIntelligenceReader(client: RestClient, config: LIConfig) {
  return async (uri: URL, variables: Record<string, string | string[]>) => {
    const rawTaskName = variables.task_name;
    const taskName = (Array.isArray(rawTaskName) ? rawTaskName[0] : rawTaskName) ?? uri.pathname.split('/').pop() ?? '';

    if (!taskName) {
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify({ error: 'Task name is required' }),
        }],
      };
    }

    // Fetch scores + recommendations in parallel
    const [scoresResult, recsResult] = await Promise.all([
      client.get<ScoresResponse>('/v1/get-scores', { issue_type: taskName }),
      client.get<RecommendationResponse>('/v1/recommendations', { task: taskName }),
    ]);

    if (!scoresResult.ok) {
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify({
            task: taskName,
            status: 'unavailable',
            message: 'Could not fetch intelligence — API may be unreachable',
          }),
        }],
      };
    }

    const scores = scoresResult.data;
    const recs = recsResult.ok ? recsResult.data : null;

    // Format the intelligence data
    const intelligence: Record<string, unknown> = {
      task: taskName,
      cold_start: scores.cold_start,
      outcomes_needed: scores.outcomes_needed,
      decision_id: scores.decision_id,
    };

    if (scores.cold_start || !scores.ranked_actions?.length) {
      intelligence.status = 'no_data';
      intelligence.message = `No outcome data for "${taskName}" yet. Execute actions and log via li_log to begin learning.`;
    } else {
      intelligence.status = recs?.state ?? 'early_signal';
      intelligence.ranked_actions = scores.ranked_actions.map(a => ({
        action: a.action_name,
        score: a.composite_score,
        confidence: a.confidence,
        trend: a.trend_delta ?? 0,
      }));

      if (recs?.best_action) {
        intelligence.recommendation = {
          best_action: recs.best_action,
          confidence: recs.confidence,
          improvement: recs.improvement,
          state: recs.state,
        };
      }

      // Mode-specific guidance
      const mode = config.mode;
      if (mode === 'auto' && recs?.state === 'stable' && (recs?.confidence ?? 0) >= 0.90) {
        intelligence.guidance = `DECISION LAYER: ${recs!.best_action} is the statistically proven best action (${((recs!.confidence ?? 0) * 100).toFixed(0)}% confidence, stable). Route through li_action to execute.`;
      } else if (mode === 'assist') {
        intelligence.guidance = `LI suggests ${recs?.best_action ?? scores.ranked_actions[0]?.action_name}. Route through li_action for interception check.`;
      } else {
        intelligence.guidance = `Data available. ${scores.ranked_actions[0]?.action_name} ranks highest at ${scores.ranked_actions[0]?.composite_score.toFixed(2)}.`;
      }
    }

    return {
      contents: [{
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(intelligence),
      }],
    };
  };
}
