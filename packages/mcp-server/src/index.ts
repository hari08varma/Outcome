/**
 * LayerInfinite MCP Server — index.ts
 * ══════════════════════════════════════════════════════════════
 * V2 Gateway Proxy entry point. Uses low-level Server (ADR-001)
 * for raw JSON-RPC interception of tools/list and tools/call.
 *
 * Registers handlers:
 *   tools/list   — enriched upstream tools + virtual li_recommend
 *   tools/call   — proxy to upstream, auto-mode rerouting
 *   resources/*  — gateway status + config (admin-gated)
 *   prompts/*    — setup instructions
 * ══════════════════════════════════════════════════════════════
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import type { GatewayConfig } from './config.js';
import { LiApiClient, UpstreamMCPClient } from './rest-client.js';
import { UpstreamRegistry } from './upstream-registry.js';
import { GatewayProxy } from './gateway-proxy.js';
import { OutcomeClassifier } from './outcome-classifier.js';
import { DecisionTracker } from './decision-tracker.js';
import { startQueueProcessor } from './fail-open.js';
import type { QueueSender } from './fail-open.js';
import type { OutcomePayload } from './types.js';
import { logger } from './logger.js';
import { dashboardResource } from './resources/dashboard.js';
import { docsResource } from './resources/docs.js';
import { onboardingPrompt } from './prompts/onboarding.js';

const SERVER_NAME = 'layerinfinite-gateway';
const SERVER_VERSION = '2.0.0';

const log = logger.forTool('index');

// ── Task context extraction ─────────────────────────────────

interface TaskContext {
  taskType: string;
  customerId: string;
  agentId: string;
}

function extractTaskContext(params: Record<string, unknown> | undefined): TaskContext {
  const args = (params?.['arguments'] as Record<string, unknown>) ?? {};
  const meta = (params?.['_meta'] as Record<string, unknown>) ?? {};

  const taskType = String(
    args['task_type'] ?? args['taskType'] ?? params?.['task_type'] ?? meta['taskType'] ?? 'unknown',
  );

  const customerId = String(
    args['customer_id'] ??
      args['customerId'] ??
      params?.['customer_id'] ??
      process.env.LAYERINFINITE_DEFAULT_CUSTOMER ??
      'default',
  );

  const agentId = String(
    meta['agentId'] ??
      args['agent_id'] ??
      args['agentId'] ??
      params?.['agent_id'] ??
      process.env.LAYERINFINITE_DEFAULT_AGENT ??
      'unknown',
  );

  return { taskType, customerId, agentId };
}

// ══════════════════════════════════════════════════════════════
// createGatewayServer
// ══════════════════════════════════════════════════════════════

export interface GatewayServer {
  server: Server;
  proxy: GatewayProxy;
  config: GatewayConfig;
  upstreamClient: UpstreamMCPClient;
  registry: UpstreamRegistry;
  tracker: DecisionTracker;
  queueProcessor: { stop: () => void };
}

export function createGatewayServer(): GatewayServer {
  const config = loadConfig();
  const registry = new UpstreamRegistry(config);
  const liApi = new LiApiClient(config);
  const upstreamClient = new UpstreamMCPClient(registry);

  const classifier = config.classifier ? new OutcomeClassifier(config.classifier) : null;
  const tracker = new DecisionTracker(liApi, config.environment);
  const proxy = new GatewayProxy(liApi, upstreamClient, registry, config, classifier, tracker);

  // Start periodic queue processor for retrying failed outcome logs
  const queueSender: QueueSender = (payload: OutcomePayload) => liApi.logOutcome(payload);
  const queueProcessor = startQueueProcessor(queueSender, 30_000);

  // Start periodic flush of tracker buffer (secondary durability)
  tracker.startFlushTimer();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const startedAt = Date.now();

  // ── tools/list ──────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      const taskCtx = extractTaskContext(request.params as Record<string, unknown> | undefined);
      const enriched = await proxy.handleListTools(taskCtx);

      // Strip internal fields (upstreamName, annotations) per MCP spec
      const tools = enriched.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      return { tools };
    } catch (err) {
      log.error('tools/list handler failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { tools: [] };
    }
  });

  // ── tools/call ──────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params?.name ?? '';
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
    const taskCtx = extractTaskContext(request.params as Record<string, unknown> | undefined);

    try {
      const result = await proxy.handleCallTool(toolName, args, taskCtx);
      return result as unknown as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tools/call handler failed', { tool: toolName, error: message });
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  });

  // ── resources/list ──────────────────────────────────────

  server.setRequestHandler(
    { method: 'resources/list' } as never,
    async () => {
      try {
        const entries = registry.getAllUpstreams();
        const healthyCount = entries.filter((e) => registry.isHealthy(e.server.name)).length;

        const resources = [
          {
            uri: 'li://gateway/status',
            name: 'Gateway Status',
            description: 'LayerInfinite Gateway Proxy runtime status',
            mimeType: 'text/plain',
          },
        ];

        if (config.adminKey) {
          resources.push({
            uri: 'li://gateway/config',
            name: 'Gateway Configuration',
            description: 'Gateway config summary (requires admin key to read)',
            mimeType: 'application/json',
          });
        }

          resources.push({ uri: dashboardResource.uri, name: dashboardResource.name, description: dashboardResource.description, mimeType: dashboardResource.mimeType });
          resources.push({ uri: docsResource.uri, name: docsResource.name, description: docsResource.description, mimeType: docsResource.mimeType });

        return { resources };
      } catch (err) {
        log.error('resources/list failed', { error: err instanceof Error ? err.message : String(err) });
        return { resources: [] };
      }
    },
  );

  // ── resources/read ──────────────────────────────────────

  server.setRequestHandler(
    { method: 'resources/read' } as never,
    async (request: { params?: { uri?: string } }) => {
      const uri = request.params?.uri ?? '';

      try {
        if (uri === 'li://gateway/status') {
          const entries = registry.getAllUpstreams();
          const healthy = entries.filter((e) => registry.isHealthy(e.server.name));
          const uptimeMs = Date.now() - startedAt;

          const status = {
            mode: config.mode ?? 'bootstrap',
            environment: config.environment,
            shadowMode: config.shadowMode,
            upstreams: {
              total: entries.length,
              healthy: healthy.length,
              names: entries.map((e) => e.server.name),
              healthyNames: healthy.map((e) => e.server.name),
            },
            uptime_seconds: Math.floor(uptimeMs / 1000),
            version: SERVER_VERSION,
          };

          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        }

        if (uri === 'li://gateway/config') {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(
                  {
                    mode: config.mode ?? 'bootstrap',
                    environment: config.environment,
                    shadowMode: config.shadowMode,
                    upstreamCount: config.upstreamServers.length,
                    modeOverrides: Object.fromEntries(config.modeOverrides),
                    apiKey: '[REDACTED]',
                    baseUrl: config.baseUrl,
                    adminEnabled: config.adminKey !== null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

          if (uri === dashboardResource.uri) {
            const result = await dashboardResource.handler();
            return { contents: result.contents };
          }

          if (uri === docsResource.uri) {
            const result = await docsResource.handler();
            return { contents: result.contents };
          }

        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `Unknown resource: ${uri}`,
            },
          ],
        };
      } catch (err) {
        log.error('resources/read failed', { uri, error: err instanceof Error ? err.message : String(err) });
        return {
          contents: [{ uri, mimeType: 'text/plain', text: 'Error reading resource' }],
        };
      }
    },
  );

  // ── prompts/list ────────────────────────────────────────

  server.setRequestHandler(
    { method: 'prompts/list' } as never,
    async () => {
      return {
        prompts: [
          {
            name: 'layerinfinite-gateway-setup',
            description: 'LayerInfinite Gateway Proxy setup instructions',
            arguments: [],
          },
          {
            name: onboardingPrompt.name,
            description: onboardingPrompt.description,
            arguments: onboardingPrompt.arguments,
          },
        ],
      };
    },
  );

  // ── prompts/get ─────────────────────────────────────────

  server.setRequestHandler(
    { method: 'prompts/get' } as never,
    async (request: { params?: { name?: string; arguments?: Record<string, unknown> } }) => {
      const name = request.params?.name ?? '';

      if (name === onboardingPrompt.name) {
          const result = await onboardingPrompt.handler();
          return { messages: result.messages };
        }

        if (name !== 'layerinfinite-gateway-setup') {
        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: `Unknown prompt: ${name}` },
            },
          ],
        };
      }

      const text = [
        '# LayerInfinite Gateway Proxy Setup',
        '',
        'The LayerInfinite MCP Gateway Proxy transparently enriches your existing MCP tools with historical outcome intelligence.',
        '',
        '## Configuration',
        '',
        'Set these environment variables before starting:',
        '',
        '| Variable | Required | Description |',
        '|----------|----------|-------------|',
        '| `LAYERINFINITE_API_KEY` | Yes | Your LayerInfinite API key |',
        '| `LAYERINFINITE_UPSTREAM_TOOLS` | Yes | JSON array of upstream MCP servers (name, url, optional apiKey) |',
        '| `LAYERINFINITE_MODE` | No | Operating mode: `recommend`, `assist`, `auto` (omit for bootstrap) |',
        '| `LAYERINFINITE_MODE_OVERRIDES` | No | Per-task-type mode overrides as JSON object |',
        '| `LAYERINFINITE_SHADOW_MODE` | No | Set to `true` to observe without intervening |',
        '| `LAYERINFINITE_ENVIRONMENT` | No | `staging` or `production` (default: production) |',
        '| `LAYERINFINITE_BASE_URL` | No | API base URL (default: https://layerinfinite.me) |',
        '',
        '## Modes',
        '',
        '- **Bootstrap** (no mode set): Observe only — no enrichment or intervention',
        '- **Recommend**: Tool descriptions enriched with historical success rates',
        '- **Assist**: Recommendations + directional warnings based on history',
        '- **Auto**: Silent rerouting to the best tool based on outcome data',
        '',
        '## Upstream Format',
        '',
        '```json',
        '[',
        '  { "name": "github", "url": "https://github-mcp.example.com", "apiKey": "sk-..." },',
        '  { "name": "filesystem", "url": "http://localhost:8080" }',
        ']',
        '```',
        '',
        '## Starting the Gateway',
        '',
        '```bash',
        'npx @layerinfinite/mcp-server',
        '# or directly:',
        'node dist/bin/cli.js',
        '```',
        '',
        'The gateway connects via stdio — configure your MCP client to spawn this process.',
      ].join('\n');

      return {
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text },
          },
        ],
      };
    },
  );

  log.info('Gateway server created', {
    mode: config.mode ?? 'bootstrap',
    upstreams: config.upstreamServers.length,
    environment: config.environment,
    shadowMode: config.shadowMode,
    classifier: config.classifier ? `${config.classifier.model} (enabled)` : 'disabled',
  });

  return { server, proxy, config, upstreamClient, registry, tracker, queueProcessor };
}

