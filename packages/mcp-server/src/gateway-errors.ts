/**
 * LayerInfinite MCP Server — gateway-errors.ts
 * ══════════════════════════════════════════════════════════════
 * Standardized MCP error format (ADR-003). All gateway errors
 * use MCP's native `{ content, isError: true }` format — never
 * thrown exceptions.
 * ══════════════════════════════════════════════════════════════
 */

export interface GatewayError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

export const Errors = {
  upstreamUnreachable: (name: string): GatewayError => ({
    content: [
      {
        type: 'text',
        text: `Upstream MCP server "${name}" is unreachable. The agent can retry or proceed with other tools.`,
      },
    ],
    isError: true,
  }),

  noRecommendations: (task: string): GatewayError => ({
    content: [
      {
        type: 'text',
        text: `No historical data available for task "${task}". Continue collecting outcomes to enable recommendations.`,
      },
    ],
    isError: true,
  }),

  webhookInvalidSignature: (): GatewayError => ({
    content: [
      {
        type: 'text',
        text: 'Webhook signature verification failed.',
      },
    ],
    isError: true,
  }),

  webhookDecisionNotFound: (id: string): GatewayError => ({
    content: [
      {
        type: 'text',
        text: `Decision ID "${id}" not found. Ensure the decision was logged before sending a callback.`,
      },
    ],
    isError: true,
  }),
};
