/**
 * LayerInfinite API — lib/shadow-mode.ts
 * ══════════════════════════════════════════════════════════════
 * Shadow mode: observe + compare agent tool choices against LI
 * enrichment recommendations without injecting enrichment into
 * the live tool list. Records divergence for offline analysis.
 *
 * Gating: enabled per-agent via dim_agents.config.shadow_mode
 *   { enabled: true, sample_rate: 0.1 }
 *
 * Records to shadow_observations table:
 *   - What LI would have recommended (top N actions)
 *   - What the agent actually chose
 *   - Whether the agent followed the recommendation
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

// ── Types ──────────────────────────────────────────────────────

export interface ShadowObservation {
  agent_id: string;
  customer_id: string;
  context_id: string;
  task_type: string;
  /** Top-ranked actions LI would have recommended. */
  recommended_actions: Array<{
    action_name: string;
    composite_score: number;
    rank: number;
  }>;
  /** The action the agent actually chose. */
  chosen_action: string;
  /** Whether the agent picked the top recommendation. */
  followed_recommendation: boolean;
  /** Rank of the chosen action in recommendations (-1 if not in list). */
  chosen_rank: number;
  /** Score delta: top_recommended_score - chosen_score (positive = agent picked worse). */
  score_delta: number;
  environment: string;
  timestamp: string;
}

export interface ShadowConfig {
  enabled: boolean;
  /** Fraction of requests to shadow (0.0–1.0). */
  sample_rate: number;
}

interface ShadowCacheEntry {
  config: ShadowConfig;
  expiresAt: number;
}

// ── Cache ──────────────────────────────────────────────────────

const configCache = new Map<string, ShadowCacheEntry>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

// ── Public API ─────────────────────────────────────────────────

/**
 * Check if shadow mode is enabled for a given agent.
 * Returns the shadow config (including sample_rate) or null.
 */
export async function getShadowConfig(
  agentId: string,
  customerId: string,
): Promise<ShadowConfig | null> {
  const cacheKey = `${customerId}:${agentId}`;
  const cached = configCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  try {
    const { data, error } = await supabase
      .from('dim_agents')
      .select('config')
      .eq('agent_id', agentId)
      .eq('customer_id', customerId)
      .maybeSingle();

    if (error || !data?.config) {
      configCache.set(cacheKey, {
        config: { enabled: false, sample_rate: 0 },
        expiresAt: Date.now() + CONFIG_TTL_MS,
      });
      return null;
    }

    const config = data.config as Record<string, unknown>;
    const shadow = config.shadow_mode as ShadowConfig | undefined;

    if (!shadow?.enabled) {
      configCache.set(cacheKey, {
        config: { enabled: false, sample_rate: 0 },
        expiresAt: Date.now() + CONFIG_TTL_MS,
      });
      return null;
    }

    const resolved: ShadowConfig = {
      enabled: true,
      sample_rate: typeof shadow.sample_rate === 'number' ? shadow.sample_rate : 0.1,
    };

    configCache.set(cacheKey, {
      config: resolved,
      expiresAt: Date.now() + CONFIG_TTL_MS,
    });

    return resolved;
  } catch {
    return null;
  }
}

/**
 * Decide whether to shadow this specific request.
 * Returns true at `sample_rate` frequency, respecting per-agent config.
 */
export function shouldShadow(config: ShadowConfig): boolean {
  if (!config.enabled || config.sample_rate <= 0) return false;
  if (config.sample_rate >= 1) return true;
  return Math.random() < config.sample_rate;
}

/**
 * Record a shadow observation — what LI recommended vs. what the agent chose.
 * Fire-and-forget: failures are logged but never thrown to the caller.
 */
export async function recordShadowObservation(
  observation: Omit<ShadowObservation, 'followed_recommendation' | 'chosen_rank' | 'score_delta'> & {
    followed_recommendation?: boolean;
    chosen_rank?: number;
    score_delta?: number;
  },
): Promise<void> {
  const topScore = observation.recommended_actions[0]?.composite_score ?? 0;
  const chosenEntry = observation.recommended_actions.find(
    (a) => a.action_name === observation.chosen_action,
  );
  const chosenRank = chosenEntry ? chosenEntry.rank : -1;
  const chosenScore = chosenEntry?.composite_score ?? 0;
  const followed = chosenRank === 1;

  const record: ShadowObservation = {
    ...observation,
    followed_recommendation: observation.followed_recommendation ?? followed,
    chosen_rank: observation.chosen_rank ?? chosenRank,
    score_delta: observation.score_delta ?? (topScore - chosenScore),
  };

  try {
    const { error } = await supabase
      .from('shadow_observations')
      .insert({
        agent_id: record.agent_id,
        customer_id: record.customer_id,
        context_id: record.context_id,
        task_type: record.task_type,
        recommended_actions: record.recommended_actions,
        chosen_action: record.chosen_action,
        followed_recommendation: record.followed_recommendation,
        chosen_rank: record.chosen_rank,
        score_delta: record.score_delta,
        environment: record.environment,
        timestamp: record.timestamp,
      });

    if (error) {
      console.warn('[shadow-mode] Failed to record observation:', error.message);
    }
  } catch (err: any) {
    console.warn('[shadow-mode] Record failed:', err.message);
  }
}

/**
 * Compute shadow stats for a time window.
 * Returns follow rate and average score delta.
 */
export async function getShadowStats(
  customerId: string,
  agentId: string,
  sinceHours = 24,
): Promise<{
  total_observations: number;
  follow_rate: number;
  avg_score_delta: number;
  avg_chosen_rank: number;
}> {
  const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();

  try {
    const { data, error } = await supabase
      .from('shadow_observations')
      .select('followed_recommendation, score_delta, chosen_rank')
      .eq('customer_id', customerId)
      .eq('agent_id', agentId)
      .gte('timestamp', since);

    if (error || !data || data.length === 0) {
      return { total_observations: 0, follow_rate: 0, avg_score_delta: 0, avg_chosen_rank: 0 };
    }

    const rows = data as Array<{
      followed_recommendation: boolean;
      score_delta: number;
      chosen_rank: number;
    }>;

    const total = rows.length;
    const follows = rows.filter((r) => r.followed_recommendation).length;
    const avgDelta = rows.reduce((s, r) => s + (r.score_delta ?? 0), 0) / total;
    const avgRank = rows.reduce((s, r) => s + (r.chosen_rank ?? 0), 0) / total;

    return {
      total_observations: total,
      follow_rate: Math.round((follows / total) * 10000) / 10000,
      avg_score_delta: Math.round(avgDelta * 10000) / 10000,
      avg_chosen_rank: Math.round(avgRank * 100) / 100,
    };
  } catch {
    return { total_observations: 0, follow_rate: 0, avg_score_delta: 0, avg_chosen_rank: 0 };
  }
}

/** Invalidate cached shadow config for an agent. */
export function invalidateShadowConfig(agentId: string, customerId: string): void {
  configCache.delete(`${customerId}:${agentId}`);
}
