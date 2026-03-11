/**
 * Vercel AI SDK integration for Layer5.
 * Uses the stable Vercel AI SDK tool wrapping API.
 * Does NOT use experimental_telemetry.
 *
 * Works with: ai >= 3.0.0 (@vercel/ai or 'ai' package)
 *
 * @example
 * ```ts
 * import { openai } from '@ai-sdk/openai';
 * import { generateText, tool } from 'ai';
 * import { wrapTools } from '@layer5/sdk/integrations/vercel-ai';
 * import { Layer5 } from '@layer5/sdk';
 * import { z } from 'zod';
 *
 * const l5 = new Layer5({ apiKey: 'layer5_...', agentId: 'vercel-agent' });
 *
 * const myTools = {
 *   restart_service: tool({
 *     description: 'Restart a service',
 *     parameters: z.object({ service: z.string() }),
 *     execute: async ({ service }) => ({ status: 'ok' }),
 *   }),
 * };
 *
 * const trackedTools = wrapTools({ tools: myTools, client: l5, agentId: 'vercel-agent' });
 *
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: trackedTools,
 *   prompt: 'Fix the payment service',
 * });
 * ```
 */

import type { Layer5 } from '../client.js';

type VercelTool = {
  description?: string;
  parameters: unknown;
  execute?: (...args: unknown[]) => Promise<unknown>;
};

type ToolSet = Record<string, VercelTool>;

export function wrapTools<T extends ToolSet>(options: {
  tools: T;
  client: Layer5;
  agentId?: string;
  contextExtractor?: (
    toolName: string,
    params: Record<string, unknown>
  ) => Record<string, unknown>;
  silentErrors?: boolean;
}): T {
  const {
    tools,
    client,
    agentId,
    contextExtractor,
    silentErrors = true,
  } = options;

  const wrapped: ToolSet = {};

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (!toolDef.execute) {
      wrapped[toolName] = toolDef;
      continue;
    }

    const originalExecute = toolDef.execute;

    wrapped[toolName] = {
      ...toolDef,
      execute: async (...args: unknown[]) => {
        const params = (
          args[0] && typeof args[0] === 'object'
            ? args[0]
            : {}
        ) as Record<string, unknown>;

        const context = contextExtractor
          ? contextExtractor(toolName, params)
          : { tool: toolName, ...params };

        const start = Date.now();

        // Get scores before execution (non-blocking on error)
        let decisionId: string | null | undefined;
        try {
          const scores = await client.getScores({
            agentId: agentId ?? client.agentId,
            context,
          });
          decisionId = scores?.decisionId;
        } catch (e) {
          handleSilentError(
            e as Error,
            'getScores',
            toolName,
            silentErrors
          );
        }

        // Execute the original tool
        let success = true;
        try {
          const result = await originalExecute(...args);
          return result;
        } catch (e) {
          success = false;
          throw e;
        } finally {
          const responseMs = Date.now() - start;

          client.logOutcome({
            agentId: agentId ?? client.agentId ?? '',
            actionName: toolName,
            success,
            context,
            responseMs,
            feedbackSignal: 'immediate',
            decisionId: decisionId ?? undefined,
          }).catch(err =>
            handleSilentError(
              err as Error, 'logOutcome', toolName, silentErrors
            )
          );
        }
      },
    };
  }

  return wrapped as T;
}

export function wrapTool<T extends VercelTool>(options: {
  toolName: string;
  tool: T;
  client: Layer5;
  agentId?: string;
  silentErrors?: boolean;
}): T {
  return wrapTools({
    tools: { [options.toolName]: options.tool },
    client: options.client,
    agentId: options.agentId,
    silentErrors: options.silentErrors,
  })[options.toolName] as T;
}

function handleSilentError(
  error: Error,
  operation: string,
  toolName: string,
  silentErrors: boolean
): void {
  if (!silentErrors) throw error;
  console.warn(
    `[Layer5] ${operation} failed for tool '${toolName}': ` +
    `${error.message}. Tool continues normally.`
  );
}
