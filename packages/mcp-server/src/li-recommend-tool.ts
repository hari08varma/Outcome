/**
 * LayerInfinite MCP Server — li-recommend-tool.ts
 * ══════════════════════════════════════════════════════════════
 * Virtual li_recommend tool. Injected into every tools/list
 * response (non-bootstrap modes). When called, returns ranked
 * recommendations from the LI scoring engine.
 * ══════════════════════════════════════════════════════════════
 */

import type { EnrichedTool, ScoredAction } from './types.js';
import type { LiApiClient, UpstreamCallResult } from './rest-client.js';
import { logger } from './logger.js';

const log = logger.forTool('li-recommend-tool');

const RECOMMEND_TOOL_DEF: Omit<EnrichedTool, 'annotations'> = {
  name: 'li_recommend',
  description:
    'Get LayerInfinite recommendations for the best tool to use for this task type based on historical success data across all agents.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task type to get recommendations for (e.g., "build_failed", "ci_timeout", "deploy_error")',
      },
    },
    required: ['task'],
  },
  upstreamName: 'layerinfinite',
};

/** Create the li_recommend enriched tool entry with annotations. */
export function createLiRecommendTool(): EnrichedTool {
  return {
    ...RECOMMEND_TOOL_DEF,
    annotations: { category: 'recommended', ranking: 0 },
  };
}

/** Handle a call to the virtual li_recommend tool. */
export async function handleLiRecommend(
  liApi: LiApiClient,
  taskType: string,
  customerId: string,
  agentId: string,
): Promise<UpstreamCallResult> {
  try {
    const scores = await liApi.getScores(taskType, customerId, agentId);
    const text = formatRecommendations(scores);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    log.warn('li_recommend failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      content: [
        {
          type: 'text',
          text: 'Unable to fetch recommendations right now. Please try again or select a tool manually.',
        },
      ],
      isError: true,
    };
  }
}

function formatRecommendations(scores: ScoredAction[]): string {
  if (scores.length === 0) {
    return 'No recommendations available yet. Execute a few tasks to build up outcome history.';
  }

  const ranked = [...scores]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 5);

  const lines = ['**Top recommended tools:**', ''];

  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i];
    const icon = trendIcon(s.trendLabel);
    const warning = s.successRate < 50 && s.sampleSize >= 5 ? ' ⚠ BELOW THRESHOLD' : '';
    lines.push(
      `${i + 1}. **${s.actionName}** — ${s.successRate}% success (${s.sampleSize} runs)${icon}${warning}`,
    );
  }

  lines.push('');
  lines.push(
    ranked.length > 1
      ? 'Call a tool by name to execute it. LayerInfinite will automatically reroute in Auto mode when a better tool is available.'
      : 'This is the only tool with outcome history for this task type.',
  );

  return lines.join('\n');
}

function trendIcon(trendLabel?: string): string {
  if (!trendLabel) return '';
  switch (trendLabel) {
    case 'strongly_improving':
    case 'improving':
      return ' ↑';
    case 'declining':
    case 'sharply_declining':
      return ' ↓';
    default:
      return '';
  }
}
