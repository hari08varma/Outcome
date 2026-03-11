/**
 * LangChain.js integration for Layer5.
 *
 * LangChain.js uses handleToolStart / handleToolEnd / handleToolError
 * (not on_tool_start like Python).
 *
 * @example
 * ```ts
 * import { Layer5Callback } from '@layer5/sdk/integrations/langchain';
 * import { AgentExecutor } from 'langchain/agents';
 *
 * const callback = new Layer5Callback({
 *   apiKey:  'layer5_...',
 *   agentId: 'my-agent'
 * });
 *
 * const result = await executor.invoke(
 *   { input: 'fix the payment error' },
 *   { callbacks: [callback] }
 * );
 * ```
 */

import { Layer5 } from '../client.js';

interface ActiveCall {
  toolName: string;
  start: Date;
  context: Record<string, unknown>;
  decisionId?: string | null;
}

export class Layer5Callback {
  readonly name = 'Layer5Callback';

  private client: Layer5;
  private agentId: string;
  private silentErrors: boolean;
  private contextExtractor?: (
    toolName: string,
    toolInput: Record<string, unknown>
  ) => Record<string, unknown>;
  private activeCalls = new Map<string, ActiveCall>();

  constructor(options: {
    apiKey: string;
    agentId: string;
    baseUrl?: string;
    contextExtractor?: (
      toolName: string,
      toolInput: Record<string, unknown>
    ) => Record<string, unknown>;
    silentErrors?: boolean;
    timeout?: number;
    maxRetries?: number;
  }) {
    this.client = new Layer5({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      agentId: options.agentId,
      timeout: options.timeout,
      maxRetries: options.maxRetries,
    });
    this.agentId = options.agentId;
    this.silentErrors = options.silentErrors ?? true;
    this.contextExtractor = options.contextExtractor;
  }

  async handleToolStart(
    tool: { name?: string; [key: string]: unknown },
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _name?: string,
  ): Promise<void> {
    const toolName = (tool.name ?? _name ?? 'unknown_tool') as string;

    let toolInput: Record<string, unknown> = {};
    try {
      toolInput = typeof input === 'string'
        ? JSON.parse(input)
        : (input as unknown as Record<string, unknown>);
    } catch {
      toolInput = { raw_input: String(input).slice(0, 500) };
    }

    const context = this.contextExtractor
      ? this.contextExtractor(toolName, toolInput)
      : { tool: toolName, ...toolInput };

    let decisionId: string | null | undefined;
    try {
      const scores = await this.client.getScores({
        agentId: this.agentId,
        context,
      });
      decisionId = scores?.decisionId;
    } catch (e) {
      this.handleError(e as Error, 'getScores failed');
    }

    this.activeCalls.set(runId, {
      toolName,
      start: new Date(),
      context,
      decisionId,
    });
  }

  async handleToolEnd(
    _output: string,
    runId: string,
  ): Promise<void> {
    const call = this.activeCalls.get(runId);
    this.activeCalls.delete(runId);
    if (!call) return;

    const responseMs = Date.now() - call.start.getTime();

    try {
      await this.client.logOutcome({
        agentId: this.agentId,
        actionName: call.toolName,
        success: true,
        context: call.context,
        responseMs,
        feedbackSignal: 'immediate',
        decisionId: call.decisionId ?? undefined,
      });
    } catch (e) {
      this.handleError(e as Error, 'logOutcome failed');
    }
  }

  async handleToolError(
    _error: Error,
    runId: string,
  ): Promise<void> {
    const call = this.activeCalls.get(runId);
    this.activeCalls.delete(runId);
    if (!call) return;

    const responseMs = Date.now() - call.start.getTime();

    try {
      await this.client.logOutcome({
        agentId: this.agentId,
        actionName: call.toolName,
        success: false,
        context: call.context,
        responseMs,
        feedbackSignal: 'immediate',
        decisionId: call.decisionId ?? undefined,
      });
    } catch (e) {
      this.handleError(e as Error, 'logOutcome(error) failed');
    }
  }

  private handleError(error: Error, context: string): void {
    if (!this.silentErrors) throw error;
    console.warn(
      `[Layer5] ${context}: ${error.message}. ` +
      `Agent continues normally.`
    );
  }
}
