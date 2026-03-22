/**
 * Layerinfinite — routes/simulate.ts
 * POST /v1/simulate
 * ══════════════════════════════════════════════════════════════
 * Public API for the 3-tier simulation engine.
 * Accepts proposed sequences, returns predictions with
 * confidence intervals and tier metadata.
 *
 * Auth: same API key middleware as other /v1 endpoints.
 * Rate limited by customer tier.
 * ══════════════════════════════════════════════════════════════
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { runSimulation } from '../lib/simulation/tier-selector.js';

export const simulateRouter = new Hono();

// ── Request validation schema ─────────────────────────────────
const SimulateBody = z.object({
  agent_id: z.string().optional(),   // ignored — auth middleware provides it
  context: z.record(z.string(), z.unknown()),
  proposed_sequence: z.array(z.string().min(1)).min(1).max(5),
  episode_history: z.array(z.string()).optional().default([]),
  simulate_alternatives: z.number().int().min(0).max(3).optional().default(2),
  max_sequence_depth: z.number().int().min(1).max(5).optional().default(5),
});

/**
 * Compute a deterministic context hash from a context object.
 * Matches the pattern used in get-scores.ts / log-outcome.ts:
 *   context_hash = `${context_id}:${issue_type}`
 *
 * For simulation we use a simplified stable-sorted JSON hash.
 */
function computeContextHash(context: Record<string, unknown>): string {
  // Use issue_type if present (most common pattern)
  const issueType = context.issue_type ?? context.context_type ?? '';
  const contextId = context.context_id ?? '';
  if (contextId) {
    return `${contextId}:${issueType}`;
  }
  // Fallback: stable JSON key — deterministic across calls
  const keys = Object.keys(context).sort();
  const stable = keys.map((k) => `${k}=${JSON.stringify(context[k])}`).join('|');
  return stable;
}

// ── POST /v1/simulate ─────────────────────────────────────────
simulateRouter.post('/', async (c) => {
  // Parse and validate body
  let body: z.infer<typeof SimulateBody>;
  try {
    const raw = await c.req.json();
    body = SimulateBody.parse(raw);
  } catch (err: any) {
    return c.json(
      {
        error: 'Invalid request body',
        details: err.errors ?? err.message,
        code: 'VALIDATION_ERROR',
        agent_id: '',
      },
      400,
    );
  }

  const {
    context,
    proposed_sequence,
    episode_history,
    simulate_alternatives,
    max_sequence_depth,
  } = body;

  const agentId    = c.get('agent_id')    as string;
  const customerId = c.get('customer_id') as string;

  if (!agentId || !customerId) {
    return c.json({ error: 'Missing agent context', code: 'MISSING_AGENT', agent_id: '' }, 401);
  }

  // Compute context hash
  const contextHash = computeContextHash(context);

  // Run simulation
  const result = await runSimulation({
    customerId: customerId,
    agentId: agentId,
    context,
    contextHash,
    proposedSequence: proposed_sequence,
    episodeHistory: episode_history,
    simulateAlternatives: simulate_alternatives,
    maxSequenceDepth: max_sequence_depth,
  });

  // Map to snake_case response (API convention)
  return c.json({
    primary: {
      actions: result.primary.actions,
      predicted_outcome: result.primary.predictedOutcome,
      outcome_interval_low: result.primary.outcomeIntervalLow,
      outcome_interval_high: result.primary.outcomeIntervalHigh,
      confidence_width: result.primary.confidenceWidth,
      confidence: result.primary.confidence,
      predicted_resolution: result.primary.predictedResolution,
      predicted_steps: result.primary.predictedSteps,
    },
    alternatives: result.alternatives.map((alt) => ({
      actions: alt.actions,
      predicted_outcome: alt.predictedOutcome,
      outcome_interval_low: alt.outcomeIntervalLow,
      outcome_interval_high: alt.outcomeIntervalHigh,
      confidence: alt.confidence,
      better_than_proposed: alt.betterThanProposed,
    })),
    simulation_tier: result.simulationTier,
    tier_explanation: result.tierExplanation,
    data_source: result.dataSource,
    episode_count: result.episodeCount,
    simulation_warning: result.simulationWarning,
  });
});
