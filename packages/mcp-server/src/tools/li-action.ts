/**
 * LayerInfinite MCP Server — tools/li-action.ts
 * ══════════════════════════════════════════════════════════════
 * THE DECISION LAYER GATEWAY — registered in assist + auto modes.
 *
 * All action execution routes through this tool. It provides:
 *   - Assist mode: Intercepts and warns if a better action exists
 *   - Auto mode: Redirects to the proven best action (Path B)
 *
 * Implements all 6 gap fixes:
 *   #1 Context loss: accepts agent context field
 *   #2 Redirect loops: uses EpisodeTracker
 *   #3 Audit trail: returns redirected_from for li_log
 *   #4 Per-task downgrade: auto falls back to assist/recommend
 *   #5 Error handling: fallback chain on redirect
 *   #6 Unknown action: pass-through for low-data actions
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';
import type { LIConfig, LIMode } from '../config.js';
import type { EpisodeTracker } from '../episode-tracker.js';
import { resolveParams, type ActionParamSchema } from '../param-resolver.js';

export const LI_ACTION_NAME = 'li_action';

export function getLiActionDescription(mode: LIMode): string {
  if (mode === 'auto') {
    return (
      'Execute an action through LayerInfinite\'s decision layer. In auto mode, ' +
      'LI may redirect to a statistically proven better action based on real ' +
      'production outcomes. Execute the action returned in the response. ' +
      'Always call li_log afterward with the decision_id and action from the response.'
    );
  }
  return (
    'Execute an action through LayerInfinite\'s decision layer. LI will check if ' +
    'a better-performing action exists and warn you with evidence. You can proceed ' +
    'with your choice or switch. Always call li_log afterward.'
  );
}

export const liActionSchema = {
  action_name: z.string().min(1).describe('The action you intend to execute'),
  task: z.string().min(1).describe('Current task context, e.g. "payment_failed"'),
  params: z.record(z.unknown()).optional().describe('Parameters for the action'),
  context: z.string().max(500).optional().describe('Your reasoning for choosing this action — helps LI make better redirect decisions'),
  episode_id: z.string().uuid().optional().describe('Groups related actions in a multi-step sequence'),
};

/** Score response from GET /v1/get-scores. */
interface ScoresResponse {
  ranked_actions: Array<{
    action_name: string;
    composite_score: number;
    confidence: number;
    trend_delta?: number;
    is_cold_start?: boolean;
    [key: string]: unknown;
  }>;
  decision_id: string;
  cold_start: boolean;
  outcomes_needed: number;
  [key: string]: unknown;
}

/** Recommendation response from GET /v1/recommendations. */
interface RecommendationResponse {
  state: 'no_data' | 'early_signal' | 'stable';
  best_action?: string;
  confidence?: number;
  [key: string]: unknown;
}

// ── Confidence thresholds ──────────────────────────────────────
const ASSIST_CONFIDENCE_FLOOR = 0.70;
const ASSIST_SCORE_GAP = 0.15;
const AUTO_CONFIDENCE_FLOOR = 0.90;

export function createLiActionHandler(
  client: RestClient,
  config: LIConfig,
  episodeTracker: EpisodeTracker,
) {
  const mode = config.mode as 'assist' | 'auto';

  return async (input: z.infer<z.ZodObject<typeof liActionSchema>>) => {
    const { action_name, task, params, context, episode_id } = input;
    const episodeId = episode_id ?? `ephemeral-${Date.now()}`;

    // Mark this action as tried (Gap Fix #2)
    episodeTracker.markTried(episodeId, action_name);

    // ── Fetch scores + recommendations in parallel ──────────
    const [scoresResult, recsResult] = await Promise.all([
      client.get<ScoresResponse>('/v1/get-scores', { issue_type: task }),
      client.get<RecommendationResponse>('/v1/recommendations', { task }),
    ]);

    // If scores API fails, pass through without interception
    if (!scoresResult.ok) {
      return passThrough(action_name, params, null, 'Scores API unavailable — proceeding without interception');
    }

    const scores = scoresResult.data;
    const recs = recsResult.ok ? recsResult.data : null;
    const decisionId = scores.decision_id;
    const ranked = scores.ranked_actions ?? [];

    // ── Gap Fix #6: Unknown action pass-through ─────────────
    // If the agent's chosen action has insufficient data, let it through.
    // outcomes_needed > 0 means the task hasn't reached the stable threshold yet.
    const chosenAction = ranked.find(a => a.action_name === action_name);
    const hasEnoughData = scores.outcomes_needed === 0;

    if (!chosenAction || scores.cold_start || !hasEnoughData) {
      return passThrough(action_name, params, decisionId, 'Insufficient data for interception — proceeding with your action');
    }

    // ── Find the best alternative ───────────────────────────
    const bestAction = ranked.find(a =>
      a.action_name !== action_name &&
      !episodeTracker.hasTried(episodeId, a.action_name) // Gap Fix #2: skip tried actions
    );

    // No better alternative found
    if (!bestAction) {
      return passThrough(action_name, params, decisionId, 'No better alternative — proceeding with your action');
    }

    const recState = recs?.state ?? 'no_data';
    const recConfidence = recs?.confidence ?? 0;
    const chosenScore = chosenAction.composite_score;
    const bestScore = bestAction.composite_score;
    const scoreGap = bestScore - chosenScore;

    // Agent's choice is already the best or close enough
    if (scoreGap <= 0) {
      return passThrough(action_name, params, decisionId, 'Your action is the top-ranked choice');
    }

    // ── Gap Fix #4: Per-task auto-downgrade ─────────────────
    // Auto mode requires stable + high confidence. Otherwise downgrade.
    let effectiveMode = mode;
    if (mode === 'auto') {
      if (recState !== 'stable' || recConfidence < AUTO_CONFIDENCE_FLOOR) {
        // Not enough confidence for auto redirect — downgrade
        if (recState === 'no_data') {
          // No recommendation data at all — can't even assist
          return passThrough(action_name, params, decisionId,
            'Auto mode downgraded to pass-through: no recommendation data for this task');
        }
        // early_signal or stable-but-low-confidence — downgrade to assist
        effectiveMode = 'assist';
      }
    }

    // ── Assist mode: warn and let agent decide ──────────────
    if (effectiveMode === 'assist') {
      if (scoreGap < ASSIST_SCORE_GAP || recConfidence < ASSIST_CONFIDENCE_FLOOR) {
        return passThrough(action_name, params, decisionId, 'Score gap or confidence too low to recommend a switch');
      }

      const trendWarning = chosenAction.trend_delta !== undefined && chosenAction.trend_delta < -0.05
        ? ` ⚠️ ${action_name} is degrading (trend: ${chosenAction.trend_delta.toFixed(3)})`
        : '';

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            approved: false,
            warning: `${action_name} scores ${chosenScore.toFixed(2)} while ${bestAction.action_name} scores ${bestScore.toFixed(2)} across real production outcomes.${trendWarning} Consider switching.`,
            your_action: { name: action_name, score: chosenScore },
            suggested_action: { name: bestAction.action_name, score: bestScore },
            decision_id: decisionId,
            confirm_or_switch: true,
            mode: 'assist',
          }),
        }],
      };
    }

    // ── Auto mode: redirect to best action (Path B) ─────────
    // At this point: mode=auto, state=stable, confidence≥0.90, gap>0

    // Resolve parameters for the target action (Three-Layer Resolution)
    const targetParamSchema = await fetchActionParamSchema(client, bestAction.action_name);
    const paramResolution = resolveParams(params ?? {}, targetParamSchema);

    // Mark the redirect target as tried (Gap Fix #2)
    episodeTracker.markTried(episodeId, bestAction.action_name);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          action: bestAction.action_name,
          params: paramResolution.resolved,
          ...(paramResolution.fullyResolved ? {} : { params_needed: paramResolution.needed }),
          decision_id: decisionId,
          redirected_from: action_name,
          redirect_reason: `${bestAction.action_name} scores ${bestScore.toFixed(2)} (stable, ${(recConfidence * 100).toFixed(0)}% confidence) vs ${action_name} at ${chosenScore.toFixed(2)}`,
          mode: 'auto',
          episode_id: episodeId,
        }),
      }],
    };
  };
}

// ── Helper: pass through without interception ───────────────
function passThrough(
  actionName: string,
  params: Record<string, unknown> | undefined,
  decisionId: string | null,
  reason: string,
) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        action: actionName,
        params: params ?? {},
        decision_id: decisionId,
        approved: true,
        reason,
      }),
    }],
  };
}

// ── Helper: fetch action param schema from admin API ────────
// GET /v1/admin returns { actions: [...] } with all registered actions.
// required_params in the REST API is string[] (param names), not a
// schema with types/defaults. For now, we build a basic schema from it.
async function fetchActionParamSchema(
  client: RestClient,
  actionName: string,
): Promise<ActionParamSchema | null> {
  try {
    const result = await client.get<{ actions?: Array<{ action_name: string; required_params?: string[] }> }>(
      '/v1/admin',
    );
    if (result.ok && result.data.actions) {
      const action = result.data.actions.find(a => a.action_name === actionName);
      if (action?.required_params?.length) {
        // Convert string[] to ActionParamSchema
        const schema: ActionParamSchema = {};
        for (const paramName of action.required_params) {
          schema[paramName] = { type: 'unknown', required: true };
        }
        return schema;
      }
    }
  } catch {
    // Non-critical — use empty schema (all original params carry over)
  }
  return null;
}
