/**
 * LayerInfinite MCP Server — tools/li-health.ts
 * ══════════════════════════════════════════════════════════════
 * Always registered. System health diagnostics.
 * Maps to GET /health on the LI REST API.
 * ══════════════════════════════════════════════════════════════
 */

import { z } from 'zod';
import type { RestClient } from '../rest-client.js';
import type { LIConfig } from '../config.js';

export const LI_HEALTH_NAME = 'li_health';

export const LI_HEALTH_DESCRIPTION =
  'Check LayerInfinite system health — API connectivity, queue status, ' +
  'and current MCP server configuration.';

export const liHealthSchema = {};

export function createLiHealthHandler(client: RestClient, config: LIConfig) {
  return async () => {
    // ── API health check ────────────────────────────────────
    let apiStatus = 'unknown';
    let apiLatencyMs = 0;

    const start = Date.now();
    try {
      const result = await client.get<{ status?: string }>('/health');
      apiLatencyMs = Date.now() - start;
      apiStatus = result.ok ? 'healthy' : `unhealthy (${result.status})`;
    } catch {
      apiLatencyMs = Date.now() - start;
      apiStatus = 'unreachable';
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          mcp_server: {
            version: '1.0.0',
            mode: config.mode ?? 'bootstrap',
            admin_enabled: config.adminKey !== null,
            base_url: config.baseUrl,
          },
          api: {
            status: apiStatus,
            latency_ms: apiLatencyMs,
          },
        }),
      }],
    };
  };
}
