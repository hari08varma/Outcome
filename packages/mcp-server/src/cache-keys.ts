/**
 * LayerInfinite MCP Server — cache-keys.ts
 * ══════════════════════════════════════════════════════════════
 * Centralized cache key patterns (ADR-002). All keys are
 * customer_id-namespaced to enforce multi-tenant isolation.
 * ══════════════════════════════════════════════════════════════
 */

const PREFIX = 'li';
const SEP = ':';

export const CacheKeys = {
  /** Scoring data for enrichment (5-min TTL, from scoring.ts LRU). */
  score: (cust: string, task: string) =>
    `${PREFIX}${SEP}score${SEP}${cust}${SEP}${task}`,

  /** Enriched tool descriptions (60s TTL — balances freshness with latency). */
  enrich: (cust: string, task: string, tool: string) =>
    `${PREFIX}${SEP}enrich${SEP}${cust}${SEP}${task}${SEP}${tool}`,

  /** Upstream tool list cache (30s TTL — tools don't change often). */
  upstreamTools: (name: string) =>
    `${PREFIX}${SEP}upstream${SEP}tools${SEP}${name}`,

  /** Mode resolution per task_type (5-min TTL). */
  mode: (cust: string, task: string) =>
    `${PREFIX}${SEP}mode${SEP}${cust}${SEP}${task}`,

  /** Trust score per agent (60s TTL). */
  trust: (cust: string, agent: string) =>
    `${PREFIX}${SEP}trust${SEP}${cust}${SEP}${agent}`,

  /** Episode state (30-min TTL — session duration). */
  episode: (cust: string, agent: string) =>
    `${PREFIX}${SEP}episode${SEP}${cust}${SEP}${agent}`,

  /** Shadow mode comparison data (5-min TTL). */
  shadow: (cust: string, task: string) =>
    `${PREFIX}${SEP}shadow${SEP}${cust}${SEP}${task}`,

  /** Global cold-start priors (24h TTL — rarely changes). */
  globalPriors: (task: string) =>
    `${PREFIX}${SEP}global${SEP}priors${SEP}${task}`,

  /** Rate limit counters (1-min sliding window). */
  rateLimit: (cust: string) =>
    `${PREFIX}${SEP}ratelimit${SEP}${cust}`,
};
