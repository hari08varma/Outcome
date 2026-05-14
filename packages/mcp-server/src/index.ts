/**
 * LayerInfinite MCP Server — index.ts
 * ══════════════════════════════════════════════════════════════
 * Main server entry point. Creates the McpServer instance and
 * conditionally registers tools based on the configured mode.
 *
 * Tool Registration Matrix:
 * ┌─────────────────────┬───────────┬───────────┬────────┬──────┐
 * │ Tool                │ Bootstrap │ Recommend │ Assist │ Auto │
 * ├─────────────────────┼───────────┼───────────┼────────┼──────┤
 * │ li_log              │     ✅    │     ✅    │   ✅   │  ✅  │
 * │ li_observe          │     ✅    │     ✅    │   ✅   │  ✅  │
 * │ li_audit            │     ✅    │     ✅    │   ✅   │  ✅  │
 * │ li_health           │     ✅    │     ✅    │   ✅   │  ✅  │
 * │ li_toggle_action    │     ✅    │     ✅    │   ✅   │  ✅  │
 * │ li_simulate         │           │     ✅    │   ✅   │  ✅  │
 * │ li_patterns         │           │     ✅    │   ✅   │  ✅  │
 * │ li_action           │           │           │   ✅   │  ✅  │
 * │ li_fallback         │           │           │   ✅   │  ✅  │
 * │ li_register_action  │ admin key │ admin key │admin   │admin │
 * └─────────────────────┴───────────┴───────────┴────────┴──────┘
 *
 * Resource (always): layerinfinite://tasks/{task_name}
 * Prompt  (always):  layerinfinite-setup
 * ══════════════════════════════════════════════════════════════
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { RestClient } from './rest-client.js';
import { EpisodeTracker } from './episode-tracker.js';
import { logger } from './logger.js';

// ── Tool imports ────────────────────────────────────────────
import { LI_LOG_NAME, LI_LOG_DESCRIPTION, liLogSchema, createLiLogHandler } from './tools/li-log.js';
import { LI_OBSERVE_NAME, LI_OBSERVE_DESCRIPTION, liObserveSchema, createLiObserveHandler } from './tools/li-observe.js';
import { LI_AUDIT_NAME, LI_AUDIT_DESCRIPTION, liAuditSchema, createLiAuditHandler } from './tools/li-audit.js';
import { LI_HEALTH_NAME, LI_HEALTH_DESCRIPTION, liHealthSchema, createLiHealthHandler } from './tools/li-health.js';
import { LI_TOGGLE_ACTION_NAME, LI_TOGGLE_ACTION_DESCRIPTION, liToggleActionSchema, createLiToggleActionHandler } from './tools/li-toggle-action.js';
import { LI_ACTION_NAME, getLiActionDescription, liActionSchema, createLiActionHandler } from './tools/li-action.js';
import { LI_FALLBACK_NAME, LI_FALLBACK_DESCRIPTION, liFallbackSchema, createLiFallbackHandler } from './tools/li-fallback.js';
import { LI_SIMULATE_NAME, LI_SIMULATE_DESCRIPTION, liSimulateSchema, createLiSimulateHandler } from './tools/li-simulate.js';
import { LI_PATTERNS_NAME, LI_PATTERNS_DESCRIPTION, liPatternsSchema, createLiPatternsHandler } from './tools/li-patterns.js';
import { LI_REGISTER_ACTION_NAME, LI_REGISTER_ACTION_DESCRIPTION, liRegisterActionSchema, createLiRegisterActionHandler } from './tools/li-register-action.js';

// ── Resource + prompt imports ───────────────────────────────
import { createTaskIntelligenceReader } from './resources/task-intelligence.js';
import { AGENT_SETUP_PROMPT_NAME, AGENT_SETUP_PROMPT_DESCRIPTION, getAgentSetupPrompt } from './prompts/agent-setup.js';

/**
 * Creates and configures the McpServer with all tools, resources, and prompts.
 */
export function createServer() {
  const config = loadConfig();
  const client = new RestClient(config);
  const episodeTracker = new EpisodeTracker();
  const mode = config.mode;

  const server = new McpServer({
    name: 'layerinfinite',
    version: '1.0.0',
  });

  // ════════════════════════════════════════════════════════════
  // ALWAYS REGISTERED — Foundation tools (bootstrap + all modes)
  // ════════════════════════════════════════════════════════════

  server.tool(
    LI_LOG_NAME,
    LI_LOG_DESCRIPTION,
    liLogSchema,
    createLiLogHandler(client),
  );

  server.tool(
    LI_OBSERVE_NAME,
    LI_OBSERVE_DESCRIPTION,
    liObserveSchema,
    createLiObserveHandler(client),
  );

  server.tool(
    LI_AUDIT_NAME,
    LI_AUDIT_DESCRIPTION,
    liAuditSchema,
    createLiAuditHandler(client),
  );

  server.tool(
    LI_HEALTH_NAME,
    LI_HEALTH_DESCRIPTION,
    liHealthSchema,
    createLiHealthHandler(client, config),
  );

  // ════════════════════════════════════════════════════════════
  // CIRCUIT BREAKER — Runtime action disable/enable (all modes)
  // ════════════════════════════════════════════════════════════

  server.tool(
    LI_TOGGLE_ACTION_NAME,
    LI_TOGGLE_ACTION_DESCRIPTION,
    liToggleActionSchema,
    createLiToggleActionHandler(client),
  );

  // ════════════════════════════════════════════════════════════
  // MODE-GATED — Intelligence tools (recommend + assist + auto)
  // ════════════════════════════════════════════════════════════

  if (mode) {
    server.tool(
      LI_SIMULATE_NAME,
      LI_SIMULATE_DESCRIPTION,
      liSimulateSchema,
      createLiSimulateHandler(client),
    );

    server.tool(
      LI_PATTERNS_NAME,
      LI_PATTERNS_DESCRIPTION,
      liPatternsSchema,
      createLiPatternsHandler(client),
    );
  }

  // ════════════════════════════════════════════════════════════
  // DECISION LAYER — Gateway + Fallback (assist + auto only)
  // ════════════════════════════════════════════════════════════

  if (mode === 'assist' || mode === 'auto') {
    server.tool(
      LI_ACTION_NAME,
      getLiActionDescription(mode),
      liActionSchema,
      createLiActionHandler(client, config, episodeTracker),
    );

    server.tool(
      LI_FALLBACK_NAME,
      LI_FALLBACK_DESCRIPTION,
      liFallbackSchema,
      createLiFallbackHandler(client, episodeTracker),
    );
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN — Gated by LAYERINFINITE_ADMIN_KEY
  // ════════════════════════════════════════════════════════════

  if (config.adminKey) {
    server.tool(
      LI_REGISTER_ACTION_NAME,
      LI_REGISTER_ACTION_DESCRIPTION,
      liRegisterActionSchema,
      createLiRegisterActionHandler(client, config.adminKey),
    );
  }

  // ════════════════════════════════════════════════════════════
  // RESOURCE — Decision intelligence (always active)
  // ════════════════════════════════════════════════════════════

  const taskReader = createTaskIntelligenceReader(client, config);

  server.resource(
    'task-intelligence',
    new ResourceTemplate('layerinfinite://tasks/{task_name}', {
      list: undefined,
    }),
    taskReader,
  );

  // ════════════════════════════════════════════════════════════
  // PROMPT — Mode-aware agent configuration (always active)
  // ════════════════════════════════════════════════════════════

  server.prompt(
    AGENT_SETUP_PROMPT_NAME,
    AGENT_SETUP_PROMPT_DESCRIPTION,
    () => getAgentSetupPrompt(config),
  );

  // ── Startup log ───────────────────────────────────────────
  const toolCount = 5 // foundation (4) + circuit breaker (1)
    + (mode ? 2 : 0) // intelligence
    + (mode === 'assist' || mode === 'auto' ? 2 : 0) // decision layer
    + (config.adminKey ? 1 : 0); // admin

  logger.info('Server configured', {
    mode: mode ?? 'bootstrap',
    tools: toolCount,
    admin: config.adminKey ? 'enabled' : 'disabled',
    api: config.baseUrl,
  });

  return server;
}
