/**
 * LayerInfinite API — lib/confidence-thresholds.ts
 * ══════════════════════════════════════════════════════════════
 * Per-agent per-task confidence thresholds loaded from
 * dim_agents.config JSONB.
 *
 * Each agent's config may specify thresholds per task_type:
 *   {
 *     "confidence_thresholds": {
 *       "build_failed": {
 *         "minimum_success_rate": 0.6,
 *         "minimum_sample_size": 10,
 *         "fallback_behavior": "warn"
 *       }
 *     }
 *   }
 *
 * If no per-task threshold exists, the agent-level default applies.
 * If no agent-level default exists, the global defaults apply.
 *
 * Fallback behaviors:
 *   - "omit":    Exclude actions below threshold from enrichment
 *   - "warn":    Include but annotate with a warning
 *   - "allow":   Include without restriction (bypass thresholds)
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

// ── Types ──────────────────────────────────────────────────────

export type FallbackBehavior = 'omit' | 'warn' | 'allow';

export interface TaskConfidenceThreshold {
  minimum_success_rate: number;
  minimum_sample_size: number;
  fallback_behavior: FallbackBehavior;
}

export interface AgentConfidenceConfig {
  /** Per-task-type overrides. */
  thresholds: Map<string, TaskConfidenceThreshold>;
  /** Agent-level defaults. */
  defaults: TaskConfidenceThreshold;
}

// ── Global defaults ────────────────────────────────────────────

const GLOBAL_DEFAULTS: TaskConfidenceThreshold = {
  minimum_success_rate: 0.0,
  minimum_sample_size: 1,
  fallback_behavior: 'allow',
};

// ── Cache ──────────────────────────────────────────────────────

interface CacheEntry {
  config: AgentConfidenceConfig;
  expiresAt: number;
}

const configCache = new Map<string, CacheEntry>();
const CONFIG_TTL_MS = 5 * 60 * 1000;

function cacheKey(customerId: string, agentId: string): string {
  return `${customerId}:${agentId}`;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Load confidence thresholds for an agent.
 * Returns a merged config: per-task overrides + agent defaults + global defaults.
 */
export async function getConfidenceConfig(
  customerId: string,
  agentId: string,
): Promise<AgentConfidenceConfig> {
  const key = cacheKey(customerId, agentId);
  const cached = configCache.get(key);
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

    const rawConfig = (data?.config as Record<string, unknown>) ?? {};
    const ctConfig = rawConfig.confidence_thresholds as Record<string, Record<string, unknown>> | undefined;

    // Parse agent-level defaults
    const agentDefaults = ctConfig?.['*'] as Record<string, unknown> | undefined;
    const defaults: TaskConfidenceThreshold = {
      minimum_success_rate: (agentDefaults?.minimum_success_rate as number)
        ?? GLOBAL_DEFAULTS.minimum_success_rate,
      minimum_sample_size: (agentDefaults?.minimum_sample_size as number)
        ?? GLOBAL_DEFAULTS.minimum_sample_size,
      fallback_behavior: normalizeFallback(agentDefaults?.fallback_behavior)
        ?? GLOBAL_DEFAULTS.fallback_behavior,
    };

    // Parse per-task overrides
    const thresholds = new Map<string, TaskConfidenceThreshold>();
    if (ctConfig) {
      for (const [taskType, raw] of Object.entries(ctConfig)) {
        if (taskType === '*') continue;
        thresholds.set(taskType, {
          minimum_success_rate: (raw.minimum_success_rate as number) ?? defaults.minimum_success_rate,
          minimum_sample_size: (raw.minimum_sample_size as number) ?? defaults.minimum_sample_size,
          fallback_behavior: normalizeFallback(raw.fallback_behavior) ?? defaults.fallback_behavior,
        });
      }
    }

    const config: AgentConfidenceConfig = { thresholds, defaults };

    configCache.set(key, { config, expiresAt: Date.now() + CONFIG_TTL_MS });
    return config;
  } catch {
    return { thresholds: new Map(), defaults: { ...GLOBAL_DEFAULTS } };
  }
}

/**
 * Get the effective threshold for a specific task_type.
 * Merges: per-task override > agent default > global default.
 */
export async function getEffectiveThreshold(
  customerId: string,
  agentId: string,
  taskType: string,
): Promise<TaskConfidenceThreshold> {
  const config = await getConfidenceConfig(customerId, agentId);
  return config.thresholds.get(taskType) ?? config.defaults;
}

/**
 * Check if an action passes confidence thresholds.
 * Returns { passed, behavior, reason? }.
 */
export function checkThreshold(
  threshold: TaskConfidenceThreshold,
  successRate: number,
  sampleSize: number,
): { passed: boolean; behavior: FallbackBehavior; reason?: string } {
  if (sampleSize < threshold.minimum_sample_size) {
    return {
      passed: false,
      behavior: threshold.fallback_behavior,
      reason: `Sample size ${sampleSize} < minimum ${threshold.minimum_sample_size}`,
    };
  }

  if (successRate < threshold.minimum_success_rate) {
    return {
      passed: false,
      behavior: threshold.fallback_behavior,
      reason: `Success rate ${(successRate * 100).toFixed(0)}% < minimum ${(threshold.minimum_success_rate * 100).toFixed(0)}%`,
    };
  }

  return { passed: true, behavior: 'allow' };
}

/**
 * Apply thresholds to a list of scored actions.
 *
 * Returns the filtered/enriched list based on fallback behaviors:
 *   - "allow": no filtering
 *   - "warn": actions below threshold get a warning annotation
 *   - "omit": actions below threshold are removed
 */
export function applyThresholds(
  actions: Array<{
    action_id: string;
    action_name: string;
    composite_score: number;
    total_attempts: number;
    [key: string]: unknown;
  }>,
  threshold: TaskConfidenceThreshold,
): Array<{
  action_id: string;
  action_name: string;
  composite_score: number;
  total_attempts: number;
  threshold_warning?: string;
  [key: string]: unknown;
}> {
  if (threshold.fallback_behavior === 'allow') {
    return actions;
  }

  return actions
    .map((action) => {
      const result = checkThreshold(
        threshold,
        action.composite_score,
        action.total_attempts,
      );

      if (result.passed) return action;

      if (threshold.fallback_behavior === 'omit') {
        return null; // filtered out below
      }

      if (threshold.fallback_behavior === 'warn') {
        return {
          ...action,
          composite_score: Math.round(action.composite_score * 10000) / 10000,
          threshold_warning: result.reason,
        };
      }

      return action;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
}

/** Invalidate cached config for an agent. */
export function invalidateThresholdConfig(customerId: string, agentId: string): void {
  configCache.delete(cacheKey(customerId, agentId));
}

// ── Helpers ────────────────────────────────────────────────────

function normalizeFallback(v: unknown): FallbackBehavior | null {
  if (typeof v !== 'string') return null;
  const lower = v.toLowerCase();
  if (lower === 'omit' || lower === 'warn' || lower === 'allow') {
    return lower;
  }
  return null;
}
