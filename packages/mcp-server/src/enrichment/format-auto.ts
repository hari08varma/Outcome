/**
 * LayerInfinite MCP Server — enrichment/format-auto.ts
 * ══════════════════════════════════════════════════════════════
 * Auto-mode enrichment formatter. Returns descriptions UNCHANGED
 * — the agent never knows LI exists. Silent rerouting happens at
 * the proxy level only.
 * ══════════════════════════════════════════════════════════════
 */

export function formatAutoEnrichment(originalDescription: string): string {
  return originalDescription;
}
