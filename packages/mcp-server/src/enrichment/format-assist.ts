/**
 * LayerInfinite MCP Server — enrichment/format-assist.ts
 * ══════════════════════════════════════════════════════════════
 * Assist-mode description formatting. Provides directional
 * guidance: recommends the best tool, warns on low performers,
 * handles tie-breaking when scores are close.
 * ══════════════════════════════════════════════════════════════
 */

import type { ScoredAction } from '../types.js';

const CLOSE_RACE_GAP = 0.05; // 5 percentage points in 0-1 scale

export interface AssistFormatContext {
  toolName: string;
  taskType: string;
  description: string;
  score: ScoredAction | null;
  rank: number | null;
  totalTools: number;
  bestScore: ScoredAction | null;
}

/**
 * Format a tool description for Assist mode.
 * Includes ranking, comparisons, and warnings for low performers.
 */
export function formatAssistEnrichment(ctx: AssistFormatContext): string {
  const { description, toolName, taskType, score, rank, totalTools, bestScore } = ctx;
  const base = description;

  // No historical data at all
  if (!score || score.sampleSize < 1) {
    return `${base}\n\nNo historical data available for this tool on "${taskType}" tasks. Consider testing it in a low-risk context first.`;
  }

  const lines = [base, '', formatHistoricalContext(toolName, taskType, score)];

  // Add ranking guidance
  if (rank && score.sampleSize >= 3) {
    lines.push(formatRankingGuidance(rank, totalTools, score, bestScore));
  }

  // Add warning for low performers
  lines.push(formatWarning(score, totalTools));

  return lines.filter(Boolean).join('\n');
}

function formatHistoricalContext(
  toolName: string,
  taskType: string,
  score: ScoredAction,
): string {
  const { successRate, sampleSize, trendLabel } = score;

  if (sampleSize < 3) {
    return `Historically for "${taskType}" tasks, ${toolName} has been used ${sampleSize} time${sampleSize === 1 ? '' : 's'} (insufficient data for reliability).`;
  }

  const pct = Math.round(successRate * 100);
  const trendText = trendLabel ? ` ${formatTrendInline(trendLabel)}` : '';
  return `Historically for "${taskType}" tasks, ${toolName} has a ${pct}% success rate across ${sampleSize} executions.${trendText}`;
}

function formatRankingGuidance(
  rank: number,
  total: number,
  score: ScoredAction,
  bestScore: ScoredAction | null,
): string {
  if (rank === 1) {
    // Is this best by a clear margin?
    if (bestScore && bestScore.actionName !== score.actionName) {
      // Actually find the gap — bestScore is the overall best, but this tool IS rank 1
      // Check if there's a close second
      return '★ This is the recommended tool for this task.';
    }
    return '★ This is the recommended tool for this task.';
  }

  if (bestScore && bestScore.actionName !== score.actionName) {
    const gap = Math.round((bestScore.successRate - score.successRate) * 100);
    if ((bestScore.successRate - score.successRate) <= CLOSE_RACE_GAP) {
      return `Tied for best option — within ${gap}% of the top-ranked tool (${bestScore.actionName} at ${Math.round(bestScore.successRate * 100)}%).`;
    }
  }

  return `Ranked #${rank} of ${total}. ⚠ Consider the success history when choosing tools.`;
}

function formatWarning(score: ScoredAction, total: number): string {
  const { successRate, sampleSize } = score;

  // Only warn when we have enough data
  if (sampleSize < 5) return '';

  if (successRate < 0.30) {
    return `⚠ WARNING: This tool has a critically low success rate (${Math.round(successRate * 100)}%). Strongly consider alternatives.`;
  }

  if (successRate < 0.50) {
    const altCount = total > 1 ? ` ${total - 1} alternative${total > 2 ? 's' : ''} available` : '';
    return `⚠ CAUTION: This tool fails more than half the time (${Math.round(successRate * 100)}% success).${altCount ? `Consider using one of the${altCount}.` : ''}`;
  }

  return '';
}

function formatTrendInline(trendLabel: string): string {
  switch (trendLabel) {
    case 'strongly_improving': return 'and has been improving significantly';
    case 'improving': return 'and has been improving';
    case 'slightly_improving': return 'with a slight positive trend';
    case 'stable': return ''; // no trend text for stable
    case 'slightly_declining': return 'with a slight negative trend';
    case 'declining': return 'but has been declining';
    case 'sharply_declining': return 'but has been declining significantly';
    default: return '';
  }
}
