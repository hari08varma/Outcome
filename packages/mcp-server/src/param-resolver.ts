/**
 * LayerInfinite MCP Server — param-resolver.ts
 * ══════════════════════════════════════════════════════════════
 * Three-Layer Parameter Resolution for auto mode redirects.
 *
 * When auto mode redirects from action A → action B, parameters
 * must be adapted because different actions may require different params.
 *
 * Layer 1: Shared params carry over (matching field names)
 * Layer 2: Action defaults fill gaps (from dim_actions.required_params)
 * Layer 3: Missing params returned to agent to fill from its context
 * ══════════════════════════════════════════════════════════════
 */

/** Schema for a single parameter in an action's param definition. */
export interface ParamDef {
  type: string;
  description?: string;
  default?: unknown;
  required?: boolean;
}

/** The param schema stored in dim_actions.required_params. */
export type ActionParamSchema = Record<string, ParamDef>;

export interface ResolvedParams {
  /** Fully resolved params ready for execution. */
  resolved: Record<string, unknown>;
  /** Params that could not be resolved — agent must fill these. */
  needed: Record<string, ParamDef>;
  /** Whether all required params are resolved. */
  fullyResolved: boolean;
}

/**
 * Resolves parameters for a redirected action using the three-layer strategy.
 *
 * @param originalParams - The params the agent sent for the original action
 * @param targetSchema   - The param schema of the target (redirected) action
 */
export function resolveParams(
  originalParams: Record<string, unknown>,
  targetSchema: ActionParamSchema | null,
): ResolvedParams {
  // If target action has no defined schema, pass through original params
  if (!targetSchema || Object.keys(targetSchema).length === 0) {
    return { resolved: { ...originalParams }, needed: {}, fullyResolved: true };
  }

  const resolved: Record<string, unknown> = {};
  const needed: Record<string, ParamDef> = {};

  for (const [paramName, paramDef] of Object.entries(targetSchema)) {
    // Layer 1: Shared params — carry over from original if name matches
    if (paramName in originalParams) {
      resolved[paramName] = originalParams[paramName];
      continue;
    }

    // Layer 2: Action defaults — use default from schema
    if (paramDef.default !== undefined) {
      resolved[paramName] = paramDef.default;
      continue;
    }

    // Layer 3: Cannot resolve — agent must fill
    if (paramDef.required !== false) {
      needed[paramName] = paramDef;
    }
  }

  return {
    resolved,
    needed,
    fullyResolved: Object.keys(needed).length === 0,
  };
}
