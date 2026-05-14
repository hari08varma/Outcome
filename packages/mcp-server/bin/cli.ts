#!/usr/bin/env node

/**
 * LayerInfinite MCP Server — bin/cli.ts
 * ══════════════════════════════════════════════════════════════
 * Entry point for stdio transport. This is what Claude Desktop,
 * Cursor, Cline, and other MCP hosts spawn as a child process.
 *
 * Production hardening:
 *   - Graceful shutdown on SIGINT/SIGTERM
 *   - Unhandled rejection safety net
 *
 * Usage:
 *   LAYERINFINITE_API_KEY=xxx npx layerinfinite-mcp
 * ══════════════════════════════════════════════════════════════
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../src/index.js';
import { logger } from '../src/logger.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  // ── Graceful shutdown ─────────────────────────────────────
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('Shutting down', { signal });

    try {
      await server.close();
      logger.info('Server closed cleanly');
    } catch (err) {
      logger.error('Error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Safety net for unhandled rejections — log but don't crash
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  await server.connect(transport);
  logger.info('Connected via stdio transport');
}

main().catch((err) => {
  logger.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
