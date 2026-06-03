/**
 * LayerInfinite API — lib/environment-isolation.ts
 * ══════════════════════════════════════════════════════════════
 * Environment isolation: ensures staging data never pollutes
 * production probability models or materialized views.
 *
 * Rules:
 *   - Outcomes in staging are tagged environment='staging'
 *   - Materialized views filter WHERE environment = 'production'
 *   - World model training only uses production data
 *   - Staging outcomes can be queried separately for testing
 *
 * Environment detection:
 *   1. Explicit X-LI-Environment header (set by MCP gateway)
 *   2. NODE_ENV fallback
 *   3. Defaults to 'production' when unknown
 * ══════════════════════════════════════════════════════════════
 */

export type Environment = 'production' | 'staging' | 'development';

const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'production',
  'staging',
  'development',
]);

// ── Public API ─────────────────────────────────────────────────

/**
 * Resolve the environment for a request.
 * Precedence: header > NODE_ENV > default('production').
 */
export function resolveEnvironment(headerValue?: string | null): Environment {
  if (headerValue) {
    const normalized = headerValue.toLowerCase().trim();
    if (VALID_ENVIRONMENTS.has(normalized)) {
      return normalized as Environment;
    }
  }

  const nodeEnv = process.env.NODE_ENV?.toLowerCase().trim();
  if (nodeEnv && VALID_ENVIRONMENTS.has(nodeEnv)) {
    return nodeEnv as Environment;
  }

  return 'production';
}

/**
 * Is the given environment a non-production (staging/dev) environment?
 */
export function isNonProduction(env: Environment): boolean {
  return env === 'staging' || env === 'development';
}

/**
 * Is the given environment production?
 */
export function isProduction(env: Environment): boolean {
  return env === 'production';
}

/**
 * Build the environment filter suffix for Supabase queries.
 * In production: `.eq('environment', 'production')` (or no filter for
 * tables that store only production data).
 * In staging: `.eq('environment', 'staging')` for isolation.
 *
 * Returns the filter value to use in `.eq('environment', value)`.
 * Returns null if no filter should be applied (all environments).
 */
export function getEnvironmentFilter(
  env: Environment,
  includeStaging = false,
): string | null {
  if (includeStaging) return null; // no filter — all environments
  return env;
}

/**
 * Tag an outcome row with its environment before writing to DB.
 * Returns the environment tag to set on the outcome record.
 *
 * Callers should set:
 *   environment = tagOutcomeWithEnvironment(env)
 * in their INSERT/UPDATE payloads.
 */
export function tagOutcomeWithEnvironment(env: Environment): string {
  return env;
}

/**
 * Validate that an environment transition is safe.
 *
 * Staging → Production: OK (promotion)
 * Production → Staging: BLOCKED (downgrade)
 * Same → Same: OK (no-op)
 */
export function validateEnvironmentTransition(
  from: Environment,
  to: Environment,
): { allowed: boolean; reason?: string } {
  if (from === to) return { allowed: true };

  if (from === 'staging' && to === 'production') {
    return { allowed: true };
  }

  if (from === 'production' && to === 'staging') {
    return {
      allowed: false,
      reason: 'Cannot downgrade production data to staging',
    };
  }

  if (from === 'development' && (to === 'staging' || to === 'production')) {
    return { allowed: true };
  }

  return { allowed: true };
}

/**
 * Build a Supabase query filter for environment-aware queries.
 *
 * Usage:
 *   const filter = buildEnvQueryFilter(env);
 *   let query = supabase.from('fact_outcomes').select('*');
 *   if (filter) query = query.eq('environment', filter);
 */
export function buildEnvQueryFilter(
  env: Environment,
  options?: { includeAll?: boolean },
): string | null {
  if (options?.includeAll) return null;
  return env;
}
