/**
 * LayerInfinite MCP Server — outcome-classifier.ts
 * ══════════════════════════════════════════════════════════════
 * LLM-based outcome classifier using GPT-4o mini. Classifies raw
 * tool calls into structured OutcomeClassification when the agent
 * does not provide explicit task_type / context / business_outcome.
 *
 * Fail-open: LLM timeout or error → null (caller falls back to
 * existing rule-based defaults). Never blocks the gateway.
 * ══════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import type { ClassifierConfig } from './config.js';
import type { OutcomeClassification } from './types.js';
import type { UpstreamCallResult } from './rest-client.js';
import { logger } from './logger.js';

const log = logger.forTool('outcome-classifier');

const SYSTEM_PROMPT = [
  'You are an outcome classifier. Given a tool call and its result, extract structured fields.',
  'Classify the task_type from this taxonomy: payment_failed, refund_processing, subscription_management, ticket_resolution, auth_recovery, order_recovery, onboarding, code_deployment, data_query, content_generation, web_search, file_operation, system_diagnostic, unspecified_issue.',
  'Determine business_outcome: resolved (success), partial (mixed/partial success), failed (error/unsuccessful), unknown (unclear).',
  'Output ONLY valid JSON matching the schema. No explanation.',
].join(' ');

const TAXONOMY = new Set([
  'payment_failed', 'refund_processing', 'subscription_management',
  'ticket_resolution', 'auth_recovery', 'order_recovery',
  'onboarding', 'code_deployment', 'data_query', 'content_generation',
  'web_search', 'file_operation', 'system_diagnostic', 'unspecified_issue',
]);

const VALID_OUTCOMES = new Set(['resolved', 'partial', 'failed', 'unknown']);

// ── Helpers ────────────────────────────────────────────────────

function truncateResult(result: UpstreamCallResult, maxChars: number): string {
  const texts: string[] = [];
  for (const item of result.content) {
    if (typeof item.text === 'string') texts.push(item.text);
    else if (typeof item.data === 'string') texts.push(item.data);
    else texts.push(JSON.stringify(item));
  }
  let joined = texts.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars) + '…';
  }
  return joined;
}

function makeSignature(toolName: string, args: Record<string, unknown>): string {
  const normalized = JSON.stringify(args, Object.keys(args).sort());
  const hash = createHash('sha256').update(`${toolName}:${normalized}`).digest('hex');
  return hash.slice(0, 16);
}

function isValidClassification(o: unknown): o is OutcomeClassification {
  if (!o || typeof o !== 'object') return false;
  const c = o as Record<string, unknown>;
  return (
    typeof c.task_type === 'string' &&
    TAXONOMY.has(c.task_type) &&
    typeof c.context === 'string' &&
    typeof c.success === 'boolean' &&
    (c.error_message === null || typeof c.error_message === 'string') &&
    typeof c.result_summary === 'string' &&
    typeof c.business_outcome === 'string' &&
    VALID_OUTCOMES.has(c.business_outcome) &&
    typeof c.confidence === 'number' &&
    c.confidence >= 0 &&
    c.confidence <= 1
  );
}

// ── Rule-based fallback classifier ───────────────────────────

const ERROR_KEYWORDS = /\b(?:error|failed|denied|refused|invalid|timeout|unauthorized|forbidden|not.?found|conflict|unavailable|panic|fatal|crash)\b/i;

/**
 * Rule-based classification when the LLM is unreachable.
 * Less accurate but always available — fail-open design.
 * Confidence is always 0.5 (neutral — rules are uncertain by nature).
 */
export function classifyWithRules(
  toolName: string,
  _args: Record<string, unknown>,
  result: { content: Array<{ type: string; [key: string]: unknown }>; isError?: boolean },
  isError: boolean,
  agentTaskType: string,
): OutcomeClassification {
  const resultText = result.content
    .map((item) => (typeof item.text === 'string' ? item.text : JSON.stringify(item)))
    .join('\n');

  const isExplicitTaskType = agentTaskType !== 'unknown'
    && agentTaskType !== ''
    && agentTaskType !== 'unspecified_issue';

  const task_type = isExplicitTaskType ? agentTaskType : 'unspecified_issue';

  if (isError || result.isError === true) {
    return {
      task_type,
      context: `Tool "${toolName}" returned an error`,
      success: false,
      error_message: resultText.slice(0, 500) || 'Unknown error',
      result_summary: `Call to ${toolName} failed`,
      business_outcome: 'failed',
      confidence: 0.5,
    };
  }

  if (ERROR_KEYWORDS.test(resultText)) {
    return {
      task_type,
      context: `Tool "${toolName}" result contains error indicators`,
      success: false,
      error_message: resultText.slice(0, 500),
      result_summary: `Call to ${toolName} indicates failure`,
      business_outcome: 'failed',
      confidence: 0.5,
    };
  }

  if (!resultText.trim()) {
    return {
      task_type,
      context: `Tool "${toolName}" returned empty result`,
      success: true,
      error_message: null,
      result_summary: `Call to ${toolName} completed with no output`,
      business_outcome: 'unknown',
      confidence: 0.5,
    };
  }

  return {
    task_type,
    context: `Tool "${toolName}" executed successfully`,
    success: true,
    error_message: null,
    result_summary: resultText.slice(0, 500),
    business_outcome: 'resolved',
    confidence: 0.5,
  };
}

// ══════════════════════════════════════════════════════════════
// OutcomeClassifier
// ══════════════════════════════════════════════════════════════

export class OutcomeClassifier {
  private readonly config: ClassifierConfig;
  private readonly cache = new Map<string, { storedAt: number; value: OutcomeClassification }>();
  private readonly inFlight = new Map<string, Promise<OutcomeClassification | null>>();

  constructor(config: ClassifierConfig) {
    this.config = config;
  }

  async classify(
    toolName: string,
    args: Record<string, unknown>,
    result: UpstreamCallResult,
    isError: boolean,
    agentTaskType: string,
  ): Promise<OutcomeClassification | null> {
    // Skip LLM if agent provided a valid explicit task_type
    const isExplicitTaskType = agentTaskType !== 'unknown'
      && agentTaskType !== ''
      && agentTaskType !== 'unspecified_issue';

    if (isExplicitTaskType && !result.isError) {
      return null; // Agent knows best — no LLM needed for healthy calls
    }

    // For error cases, always run classification regardless of agent task_type
    // The LLM can extract error_message and determine business_outcome accurately

    const sig = makeSignature(toolName, args);
    const cacheKey = `${sig}:${isError}`;

    // Check LRU cache
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.storedAt) < this.config.cacheTtlMs) {
      log.debug('Cache hit', { toolName, cacheKey });
      return cached.value;
    }

    // In-flight coalescing
    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) {
      log.debug('In-flight coalesce', { toolName, cacheKey });
      return inFlight;
    }

    const promise = this.callLLM(toolName, args, result, isError, agentTaskType);
    this.inFlight.set(cacheKey, promise);

    try {
      const classification = await promise;
      if (classification) {
        this.cache.set(cacheKey, { storedAt: Date.now(), value: classification });
      }
      return classification;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  private async callLLM(
    toolName: string,
    args: Record<string, unknown>,
    result: UpstreamCallResult,
    isError: boolean,
    agentTaskType: string,
  ): Promise<OutcomeClassification | null> {
    if (!this.config.apiKey) {
      log.warn('Classifier enabled but no API key configured — skipping');
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const userPrompt = JSON.stringify({
        tool_name: toolName,
        arguments: args,
        result: truncateResult(result, 2000),
        is_error: isError || result.isError === true,
        agent_task_type: agentTaskType,
      });

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 1024,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.warn('LLM API error', { status: response.status, text: text.slice(0, 200) });
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) {
        log.warn('LLM returned empty response');
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        log.warn('LLM returned invalid JSON', { raw: rawContent.slice(0, 200) });
        return null;
      }

      if (!isValidClassification(parsed)) {
        log.warn('LLM classification failed validation', { parsed });
        return null;
      }

      log.debug('LLM classified', {
        toolName,
        task_type: parsed.task_type,
        business_outcome: parsed.business_outcome,
        confidence: parsed.confidence,
      });

      return parsed;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        log.warn('LLM classification timed out', { timeoutMs: this.config.timeoutMs });
      } else {
        log.warn('LLM classification error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    } finally {
      clearTimeout(timeout);
      this.pruneCache();
    }
  }

  private pruneCache(): void {
    const cutoff = Date.now() - this.config.cacheTtlMs;
    for (const [key, entry] of this.cache) {
      if (entry.storedAt < cutoff) {
        this.cache.delete(key);
      }
    }
  }
}
