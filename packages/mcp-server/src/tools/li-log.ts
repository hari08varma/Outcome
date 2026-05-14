/**
 * LayerInfinite MCP Server — tools/li-log.ts
 * ══════════════════════════════════════════════════════════════
 * FOUNDATION TOOL — Always registered, works from Day 0.
 *
 * Logs the outcome of an action the agent just performed.
 * Maps to POST /v1/log-outcome on the LI REST API.
 *
 * decision_id is ALWAYS optional:
 *   - Bootstrap (no mode): agent just logs, no prior li_action call
 *   - Recommend: optional linkage if agent read the resource
 *   - Assist/Auto: set by li_action gateway, passed through here
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { RestClient } from '../rest-client.js';

export const LI_LOG_NAME = 'li_log';

export const LI_LOG_DESCRIPTION =
  'Log the outcome of an action you just performed. Call this EVERY TIME you ' +
  'complete a task action, regardless of mode. This is how LayerInfinite learns ' +
  'which actions work best for each task.';

export const liLogSchema = {
  task: z.string().min(1).describe('Task name, e.g. "payment_failed", "refund_request"'),
  action_taken: z.string().min(1).describe('The action that was executed'),
  success: z.boolean().describe('Whether the action succeeded'),
  error_code: z.string().optional().describe('Error code if the action failed'),
  error_message: z.string().max(500).optional().describe('Brief error description'),
  outcome_score: z.number().min(0).max(1).optional().describe('Granular outcome score 0.0-1.0'),
  business_outcome: z.enum(['resolved', 'partial', 'failed', 'unknown']).optional().describe('Business-level result'),
  response_time_ms: z.number().int().min(0).optional().describe('How long the action took in ms'),
  decision_id: z.string().uuid().optional().describe('From li_action if called prior — links outcome to decision'),
  episode_id: z.string().uuid().optional().describe('Groups related actions in a multi-step sequence'),
  redirected_from: z.string().optional().describe('Original action name if auto-redirected by li_action'),
};

export type LiLogInput = z.infer<z.ZodObject<typeof liLogSchema>>;

/** Response shape from POST /v1/log-outcome. */
interface LogOutcomeResponse {
  outcome_id?: string;
  status?: string;
  data_quality_score?: number;
  [key: string]: unknown;
}

/** Response shape from GET /v1/observe (used to get task stats). */
interface ObserveResponse {
  total_runs?: number;
  [key: string]: unknown;
}

export function createLiLogHandler(client: RestClient) {
  return async (input: LiLogInput) => {
    // ── Build the log-outcome payload ───────────────────────
    const payload: Record<string, unknown> = {
      action_name: input.action_taken,
      issue_type: input.task,
      success: input.success,
      session_id: randomUUID(),
      idempotency_key: randomUUID(),
      ingestion_source: 'mcp',
    };

    // Optional fields — only set if provided
    if (input.error_code) payload.error_code = input.error_code;
    if (input.error_message) payload.error_message = input.error_message;
    if (input.outcome_score !== undefined) payload.outcome_score = input.outcome_score;
    if (input.business_outcome) payload.business_outcome = input.business_outcome;
    if (input.response_time_ms !== undefined) payload.response_time_ms = input.response_time_ms;
    if (input.decision_id) payload.decision_id = input.decision_id;
    if (input.episode_id) payload.episode_id = input.episode_id;

    // Redirect audit trail (Gap Fix #3)
    if (input.redirected_from) {
      payload.metadata = { redirected_from: input.redirected_from };
    }

    // ── POST /v1/log-outcome ────────────────────────────────
    const result = await client.post<LogOutcomeResponse>('/v1/log-outcome', payload);

    if (!result.ok) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            logged: false,
            error: result.error.message ?? result.error.error,
            code: result.error.code,
          }),
        }],
        isError: true,
      };
    }

    // ── Fetch task stats for progress feedback ──────────────
    // Non-critical: if this fails, we still return success
    let outcomesForTask = 0;
    let recommendationsAvailable = false;
    const STABLE_THRESHOLD = 50;

    try {
      const statsResult = await client.get<ObserveResponse>('/v1/observe', {
        task: input.task,
      });
      if (statsResult.ok && statsResult.data.total_runs !== undefined) {
        outcomesForTask = statsResult.data.total_runs;
        recommendationsAvailable = outcomesForTask >= STABLE_THRESHOLD;
      }
    } catch {
      // Stats fetch is best-effort — don't fail the log
    }

    const outcomesNeeded = Math.max(0, STABLE_THRESHOLD - outcomesForTask);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          logged: true,
          outcome_id: result.data.outcome_id ?? null,
          data_quality_score: result.data.data_quality_score ?? null,
          outcomes_for_task: outcomesForTask,
          recommendations_available: recommendationsAvailable,
          outcomes_needed: outcomesNeeded,
          ...(input.redirected_from ? { redirected_from: input.redirected_from } : {}),
        }),
      }],
    };
  };
}
