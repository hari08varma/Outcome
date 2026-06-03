/**
 * LayerInfinite MCP Gateway — resources/dashboard.ts
 * ══════════════════════════════════════════════════════════════
 * Static MCP resource: layerinfinite://dashboard
 *
 * Returns the LayerInfinite dashboard URL so agents can
 * reference or present it to users.
 * ══════════════════════════════════════════════════════════════
 */

import type { Resource } from '../types.js';

const DASHBOARD_URL = process.env.LAYERINFINITE_DASHBOARD_URL ?? 'https://layerinfinite.me/dashboard';

export const dashboardResource: Resource = {
  uri: 'layerinfinite://dashboard',
  name: 'LayerInfinite Dashboard',
  description:
    'The LayerInfinite dashboard provides real-time outcome analytics, ' +
    'trust scores, action performance metrics, model version history, ' +
    'and shadow mode comparison data.',
  mimeType: 'text/plain',
  handler: async () => ({
    contents: [
      {
        uri: 'layerinfinite://dashboard',
        mimeType: 'text/plain',
        text: DASHBOARD_URL,
      },
    ],
  }),
};
