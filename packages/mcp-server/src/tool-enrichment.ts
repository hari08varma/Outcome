/**
 * LayerInfinite MCP Server — tool-enrichment.ts
 * ══════════════════════════════════════════════════════════════
 * Enrichment engine. Orchestrates per-mode description formatting
 * for every tool returned by upstream servers. CRITICAL: inputSchema
 * is NEVER modified — only description is enriched.
 * ══════════════════════════════════════════════════════════════
 */

import type { EnrichedTool, EnrichmentContext, ScoredAction, GatewayMode } from './types.js';
import type { RawUpstreamTool } from './rest-client.js';
import { formatRecommendEnrichment } from './enrichment/format-recommend.js';
import { formatAssistEnrichment } from './enrichment/format-assist.js';
import type { AssistFormatContext } from './enrichment/format-assist.js';
import { formatAutoEnrichment } from './enrichment/format-auto.js';
import { logger } from './logger.js';

const log = logger.forTool('tool-enrichment');

/**
 * Enrich a list of upstream tools with historical outcome data.
 * Adds annotations (ranking, category) for internal use.
 * inputSchema is passed through unmodified.
 */
export function enrichToolList(
  tools: RawUpstreamTool[],
  context: EnrichmentContext,
): EnrichedTool[] {
  const { mode, scores, taskType } = context;

  // Build score lookup
  const scoreMap = new Map<string, ScoredAction>();
  for (const s of scores) {
    scoreMap.set(s.actionName, s);
  }

  // Rank by composite score descending
  const ranked = [...scores].sort((a, b) => b.compositeScore - a.compositeScore);
  const bestScore = ranked[0] ?? null;

  return tools.map((tool) => {
    const score = scoreMap.get(tool.name) ?? null;
    const rank = score
      ? ranked.findIndex((s) => s.actionName === tool.name) + 1
      : null;

    const enrichedDesc =
      mode === 'bootstrap'
        ? tool.description
        : enrichDescription(mode, tool, taskType, score, rank, tools.length, bestScore);

    return {
      name: tool.name,
      description: enrichedDesc,
      inputSchema: tool.inputSchema, // UNMODIFIED — passthrough from upstream
      upstreamName: tool.upstreamName,
      annotations: {
        ranking: rank ?? undefined,
        category: categorize(score),
      },
    };
  });
}

function enrichDescription(
  mode: GatewayMode,
  tool: RawUpstreamTool,
  taskType: string,
  score: ScoredAction | null,
  rank: number | null,
  totalTools: number,
  bestScore: ScoredAction | null,
): string {
  switch (mode) {
    case 'recommend':
      return formatRecommendEnrichment(
        tool.description,
        tool.name,
        taskType,
        score,
        rank,
      );

    case 'assist': {
      const ctx: AssistFormatContext = {
        toolName: tool.name,
        taskType,
        description: tool.description,
        score,
        rank,
        totalTools,
        bestScore,
      };
      return formatAssistEnrichment(ctx);
    }

    case 'auto':
      // Auto mode: descriptions unchanged — agent never knows LI exists.
      // Rerouting happens silently at the proxy level.
      return formatAutoEnrichment(tool.description);

    default:
      return tool.description;
  }
}

function categorize(
  score: ScoredAction | null,
): 'recommended' | 'neutral' | 'warning' | undefined {
  if (!score || score.sampleSize < 3) return undefined;
  if (score.compositeScore >= 0.7) return 'recommended';
  if (score.compositeScore >= 0.4) return 'neutral';
  return 'warning';
}
