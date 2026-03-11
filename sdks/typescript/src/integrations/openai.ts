/**
 * OpenAI TypeScript SDK integration.
 * Covers: chat completions with tool calls,
 *         Assistants API function calls.
 *
 * Works with: openai >= 4.0.0
 *
 * @example
 * ```ts
 * import OpenAI from 'openai';
 * import { Layer5 } from '@layer5/sdk';
 * import { trackToolCalls } from '@layer5/sdk/integrations/openai';
 *
 * const openai = new OpenAI();
 * const l5     = new Layer5({ apiKey: 'layer5_...' });
 *
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4o',
 *   messages,
 *   tools,
 * });
 *
 * const toolCalls = response.choices[0].message.tool_calls ?? [];
 * const results = await Promise.all(
 *   toolCalls.map(async (tc) => {
 *     const start = Date.now();
 *     try {
 *       await executeToolCall(tc);
 *       return { success: true, responseMs: Date.now() - start };
 *     } catch {
 *       return { success: false, responseMs: Date.now() - start };
 *     }
 *   })
 * );
 *
 * await trackToolCalls({ client: l5, agentId: 'openai-agent', toolCalls, results });
 * ```
 */

import type { Layer5 } from '../client.js';

interface ToolCallResult {
  success: boolean;
  responseMs?: number;
  outcomeScore?: number;
  businessOutcome?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export async function trackToolCalls(options: {
  client: Layer5;
  agentId: string;
  toolCalls: OpenAIToolCall[];
  results: ToolCallResult[];
  silentErrors?: boolean;
  /** Optional decision IDs — one per tool call. */
  decisionIds?: Array<string | null | undefined>;
}): Promise<void> {
  const {
    client,
    agentId,
    toolCalls,
    results,
    silentErrors = true,
    decisionIds,
  } = options;

  if (toolCalls.length !== results.length) {
    throw new Error(
      `trackToolCalls: toolCalls length (${toolCalls.length}) ` +
      `must match results length (${results.length}). ` +
      `Provide one result object per tool call.`
    );
  }

  await Promise.allSettled(
    toolCalls.map(async (tc, i) => {
      const result = results[i]!;
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // ignore parse errors
      }

      try {
        await client.logOutcome({
          agentId,
          actionName: tc.function.name,
          success: result.success,
          context: { tool: tc.function.name, ...args },
          responseMs: result.responseMs,
          outcomeScore: result.outcomeScore,
          businessOutcome: result.businessOutcome as 'resolved' | 'partial' | 'failed' | 'unknown' | undefined,
          decisionId: decisionIds?.[i] ?? undefined,
        });
      } catch (e) {
        if (!silentErrors) throw e;
        console.warn(
          `[Layer5] logOutcome failed for ` +
          `'${tc.function.name}': ${(e as Error).message}`
        );
      }
    })
  );
}

export function withLayer5<T extends {
  chat: {
    completions: {
      create: (...args: unknown[]) => Promise<unknown>
    }
  }
}>(
  openaiClient: T,
  layer5Client: Layer5,
  options: {
    agentId: string;
    toolExecutor?: (
      toolCall: OpenAIToolCall
    ) => Promise<ToolCallResult>;
    silentErrors?: boolean;
  }
): T {
  const { agentId, toolExecutor, silentErrors = true } = options;

  return new Proxy(openaiClient, {
    get(target, prop) {
      if (prop !== 'chat') return (target as Record<string | symbol, unknown>)[prop];

      return new Proxy(target.chat, {
        get(chatTarget, chatProp) {
          if (chatProp !== 'completions')
            return (chatTarget as Record<string | symbol, unknown>)[chatProp];

          return new Proxy(chatTarget.completions, {
            get(compTarget, compProp) {
              if (compProp !== 'create')
                return (compTarget as Record<string | symbol, unknown>)[compProp];

              return async (...args: unknown[]) => {
                const response = await (
                  compTarget.create as (...a: unknown[]) => Promise<unknown>
                )(...args);

                const message =
                  (response as {
                    choices: Array<{
                      message: {
                        tool_calls?: OpenAIToolCall[]
                      }
                    }>
                  }).choices[0]?.message;

                if (
                  toolExecutor &&
                  message?.tool_calls?.length
                ) {
                  const results = await Promise.all(
                    message.tool_calls.map(tc =>
                      toolExecutor(tc).catch(() => ({
                        success: false,
                        responseMs: 0,
                      }))
                    )
                  );

                  try {
                    await trackToolCalls({
                      client: layer5Client,
                      agentId,
                      toolCalls: message.tool_calls,
                      results,
                      silentErrors,
                    });
                  } catch (e) {
                    if (!silentErrors) throw e;
                    console.warn(
                      `[Layer5] trackToolCalls failed: ${(e as Error).message}`
                    );
                  }
                }

                return response;
              };
            },
          });
        },
      });
    },
  }) as T;
}

export type { OpenAIToolCall, ToolCallResult };
