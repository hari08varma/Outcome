#!/usr/bin/env node

/**
 * LayerInfinite MCP Server — bin/cli.ts
 * ══════════════════════════════════════════════════════════════
 * Entry point for stdio transport. This is what Claude Desktop,
 * Cursor, Cline, and other MCP hosts spawn as a child process.
 *
 * Usage:
 *   LAYERINFINITE_API_KEY=xxx npx layerinfinite-mcp
 * ══════════════════════════════════════════════════════════════
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGatewayServer } from '../src/index.js';
import { logger } from '../src/logger.js';

const log = logger.forTool('cli');

let shuttingDown = false;

async function main() {
  log.info('LayerInfinite Gateway starting', { version: '2.0.0' });

  const gateway = createGatewayServer();
  const { server, proxy, upstreamClient, registry, tracker, queueProcessor } = gateway;

  // Start upstream health checks
  upstreamClient.startHealthChecks();

  const transport = new StdioServerTransport();

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });

    try {
      registry.stopHealthChecks();
      queueProcessor.stop();
      tracker.stopFlushTimer();
      await tracker.flushBuffer();
      await proxy.shutdown();
      await server.close();
      log.info('Server closed cleanly');
    } catch (err) {
      log.error('Error during shutdown', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  await server.connect(transport);
  log.info('Gateway connected via stdio', {
    mode: gateway.config.mode ?? 'bootstrap',
    upstreams: gateway.config.upstreamServers.length,
  });
}

main().catch((err) => {
  log.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
