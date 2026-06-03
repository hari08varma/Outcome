/**
 * LayerInfinite MCP Server — enrichment/format-recommend.ts
 * ══════════════════════════════════════════════════════════════
 * Recommend-mode description formatting. Informational only —
 * provides historical success data with no directional guidance.
 * Appends enrichment as a single concatenated sentence.
 * ══════════════════════════════════════════════════════════════
 */

import type { ScoredAction } from '../types.js';

export function formatRecommendEnrichment(
  description: string,
  toolName: string,
  taskType: string,
  score: ScoredAction | null,
  rank: number | null,
): string {
  if (!score || score.sampleSize < 1) return description;

  const { successRate, sampleSize, trendLabel } = score;
  const pct = Math.round(successRate * 100);

  let enrichment: string;
  if (sampleSize < 3) {
    enrichment = `Insufficient historical data for ${toolName} on ${taskType} (${sampleSize} recorded outcomes).`;
  } else if (sampleSize < 10) {
    enrichment = `Historically, ${toolName} has resolved ${taskType} issues successfully ${pct}% of the time (limited data: ${sampleSize} outcomes).`;
  } else {
    enrichment = `Historically, ${toolName} has resolved ${taskType} issues successfully ${pct}% of the time (${sampleSize} recorded outcomes).`;
  }

  if (trendLabel && sampleSize >= 10) {
    enrichment += ` Success rate is ${formatTrend(trendLabel)}.`;
  }

  return `${description} ${enrichment}`;
}

function formatTrend(trendLabel: string): string {
  switch (trendLabel) {
    case 'strongly_improving': return 'improving significantly';
    case 'improving': return 'improving';
    case 'slightly_improving': return 'showing a slight positive trend';
    case 'stable': return 'stable';
    case 'slightly_declining': return 'showing a slight decline';
    case 'declining': return 'declining';
    case 'sharply_declining': return 'declining significantly';
    default: return '';
  }
}
