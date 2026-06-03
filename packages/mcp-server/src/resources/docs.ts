/**
 * LayerInfinite MCP Gateway — resources/docs.ts
 * ══════════════════════════════════════════════════════════════
 * Static MCP resource: layerinfinite://docs
 *
 * Returns the LayerInfinite documentation URL so agents can
 * reference integration guides and API documentation.
 * ══════════════════════════════════════════════════════════════
 */

import type { Resource } from '../types.js';

const DOCS_URL = process.env.LAYERINFINITE_DOCS_URL ?? 'https://layerinfinite.me/docs';

export const docsResource: Resource = {
  uri: 'layerinfinite://docs',
  name: 'LayerInfinite Documentation',
  description:
    'LayerInfinite integration guides, MCP gateway configuration, ' +
    'API reference, and troubleshooting documentation.',
  mimeType: 'text/plain',
  handler: async () => ({
    contents: [
      {
        uri: 'layerinfinite://docs',
        mimeType: 'text/plain',
        text: DOCS_URL,
      },
    ],
  }),
};
