/**
 * Layer5 — routes/simulate.ts
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
import { supabase } from '../lib/supabase.js';
import { runSimulation } from '../lib/simulation/tier-selector.js';

export const simulateRouter = new Hono();

// ── Request validation schema ─────────────────────────────────
const SimulateBody = z.object({
  agent_id: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  proposed_sequence: z.array(z.string().min(1)).min(1).max(5),
  episode_history: z.array(z.string()).optional().default([]),
  simulate_alternatives: z.number().int().min(0).max(3).optional().default(2),
  max_sequence_depth: z.number().int().min(1).max(5).optional().default(5),
});

/**
 * Resolve agent_id: look up the agent UUID in dim_agents.
 * Accepts either a UUID or an agent_name.
 * Returns the UUID or null if not found.
 */
async function resolveAgentId(agentId: string): Promise<string | null> {
  // Try as-is first (most likely a UUID from auth middleware)
  const { data: byId } = await supabase
    .from('dim_agents')
    .select('agent_id')
    .eq('agent_id', agentId)
    .maybeSingle();

  if (byId) return byId.agent_id;

  // Try as agent_name
  const { data: byName } = await supabase
    .from('dim_agents')
    .select('agent_id')
    .eq('agent_name', agentId)
    .maybeSingle();

  return byName?.agent_id ?? null;
}

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
      },
      400,
    );
  }

  const {
    agent_id,
    context,
    proposed_sequence,
    episode_history,
    simulate_alternatives,
    max_sequence_depth,
  } = body;

  // Resolve agent UUID
  const resolvedAgentId = await resolveAgentId(agent_id);
  if (!resolvedAgentId) {
    return c.json({ error: 'Unknown agent', code: 'AGENT_NOT_FOUND' }, 404);
  }

  // Compute context hash
  const contextHash = computeContextHash(context);

  // Run simulation
  const result = await runSimulation({
    agentId: resolvedAgentId,
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
