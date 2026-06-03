/**
 * LayerInfinite MCP Server — mode-manager.ts
 * ══════════════════════════════════════════════════════════════
 * Per-task-type mode resolution with caching. Checks overrides
 * first, falls back to global mode, caches result for 5 minutes.
 * ══════════════════════════════════════════════════════════════
 */

import type { GatewayConfig, LIMode } from './config.js';
import type { GatewayMode } from './types.js';

const MODE_CACHE_TTL_MS = 5 * 60 * 1000;

interface ModeCacheEntry {
  mode: GatewayMode;
  resolvedAt: number;
}

export class ModeManager {
  private readonly cache = new Map<string, ModeCacheEntry>();

  constructor(private readonly config: GatewayConfig) {}

  /**
   * Resolve the effective mode for a task type.
   * Overrides (per-task-type) take precedence over global mode.
   * Cached for 5 min per task type.
   */
  resolveMode(taskType: string): GatewayMode {
    const cached = this.cache.get(taskType);
    if (cached && Date.now() - cached.resolvedAt < MODE_CACHE_TTL_MS) {
      return cached.mode;
    }

    // If global mode is null (bootstrap), everything is bootstrap
    if (this.config.mode === null) {
      return this.cacheAndReturn(taskType, 'bootstrap');
    }

    // Check per-task-type override
    const override = this.config.modeOverrides.get(taskType);
    const mode = override ?? this.config.mode;

    return this.cacheAndReturn(taskType, mode);
  }

  /** Get the global mode (without per-task overrides). */
  getGlobalMode(): GatewayMode {
    return this.config.mode ?? 'bootstrap';
  }

  /** Clear mode resolution cache. */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheAndReturn(taskType: string, mode: GatewayMode): GatewayMode {
    this.cache.set(taskType, { mode, resolvedAt: Date.now() });
    return mode;
  }
}
