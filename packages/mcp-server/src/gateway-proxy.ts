/**
 * LayerInfinite MCP Server — gateway-proxy.ts
 * ══════════════════════════════════════════════════════════════
 * Core V2 Gateway Proxy. Intercepts tools/list (pre-reasoning
 * enrichment) and tools/call (proxy to upstream + auto-mode
 * rerouting). Natural language enrichment per mode — never
 * bracketed metadata.
 *
 * Phase 2 refactor: delegates enrichment to tool-enrichment.ts,
 * mode resolution to mode-manager.ts, score fetching to
 * score-fetcher.ts, and li_recommend to li-recommend-tool.ts.
 * ══════════════════════════════════════════════════════════════
 */

import type { GatewayConfig } from './config.js';
import type {
  EnrichedTool,
  EnrichmentContext,
  OutcomePayload,
  GatewayMode,
} from './types.js';
import type { LiApiClient, UpstreamMCPClient, UpstreamCallResult } from './rest-client.js';
import type { UpstreamRegistry } from './upstream-registry.js';
import { enqueueOutcome } from './fail-open.js';
import { enrichToolList } from './tool-enrichment.js';
import { ModeManager } from './mode-manager.js';
import { ScoreFetcher } from './enrichment/score-fetcher.js';
import { createLiRecommendTool, handleLiRecommend } from './li-recommend-tool.js';
import { generateDecisionId } from './decision-tracker.js';
import { DecisionTracker } from './decision-tracker.js';
export { generateDecisionId };
import { OutcomeClassifier, classifyWithRules } from './outcome-classifier.js';
import type { OutcomeClassification } from './types.js';
import { logger } from './logger.js';

const log = logger.forTool('gateway-proxy');

// ── Auto-mode reroute threshold ─────────────────────────────

const REROUTE_CONFIDENCE_THRESHOLD = 0.3;

// ── Merge helper for agent-explicit > LLM-inferred > defaults ──

function resolveMergeField(
  agentValue: string,
  llmValue: string | null,
  opts?: { exclude?: Set<string> },
): string | null {
  const exclude = opts?.exclude;
  if (agentValue && !exclude?.has(agentValue)) return agentValue;
  if (llmValue && !exclude?.has(llmValue)) return llmValue;
  return null;
}

// ══════════════════════════════════════════════════════════════
// GatewayProxy
// ══════════════════════════════════════════════════════════════

export class GatewayProxy {
  private readonly modeManager: ModeManager;
  private readonly scoreFetcher: ScoreFetcher;

  constructor(
    private readonly liApi: LiApiClient,
    private readonly upstreamClient: UpstreamMCPClient,
    private readonly registry: UpstreamRegistry,
    private readonly config: GatewayConfig,
    private readonly classifier: OutcomeClassifier | null = null,
    private readonly tracker: DecisionTracker | null = null,
  ) {
    this.modeManager = new ModeManager(config);
    this.scoreFetcher = new ScoreFetcher(liApi);
  }

  // ── tools/list handler ───────────────────────────────────

  async handleListTools(taskContext: {
    taskType: string;
    customerId: string;
    agentId: string;
  }): Promise<EnrichedTool[]> {
    const mode = this.modeManager.resolveMode(taskContext.taskType);

    try {
      const [rawTools, context] = await Promise.all([
        this.upstreamClient.listTools(),
        this.getEnrichmentContext(taskContext.taskType, taskContext.customerId, taskContext.agentId, mode),
      ]);

      const enriched = enrichToolList(rawTools, context);

      // Inject virtual li_recommend tool (only in non-bootstrap modes)
      if (mode !== 'bootstrap') {
        enriched.push(createLiRecommendTool());
      }

      // Sort: ranked first, then alphabetically
      enriched.sort((a, b) => {
        const rankA = a.annotations?.ranking ?? 999;
        const rankB = b.annotations?.ranking ?? 999;
        if (rankA !== rankB) return rankA - rankB;
        return a.name.localeCompare(b.name);
      });

      log.debug('tools/list enriched', {
        count: enriched.length,
        mode,
        taskType: taskContext.taskType,
      });

      return enriched;
    } catch (err) {
      log.error('tools/list failed', { error: err instanceof Error ? err.message : String(err) });
      // Degrade: return raw tools with no enrichment
      try {
        const rawTools = await this.upstreamClient.listTools();
        return rawTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          upstreamName: t.upstreamName,
        }));
      } catch {
        return [];
      }
    }
  }

  // ── tools/call handler ───────────────────────────────────

  async handleCallTool(
    toolName: string,
    args: Record<string, unknown>,
    taskContext: { taskType: string; customerId: string; agentId: string },
  ): Promise<UpstreamCallResult> {
    const decisionId = generateDecisionId(taskContext.agentId);
    const mode = this.modeManager.resolveMode(taskContext.taskType);
    const startMs = Date.now();

    // Handle virtual li_recommend tool (delegated to li-recommend-tool.ts)
    if (toolName === 'li_recommend') {
      return handleLiRecommend(
        this.liApi,
        taskContext.taskType,
        taskContext.customerId,
        taskContext.agentId,
      );
    }

    // Determine which tool to execute (auto-mode may reroute)
    let executedAction = toolName;
    let originalAction = toolName;
    let rerouted = false;
    let enrichmentScores: Record<string, number> = {};

    if (mode === 'auto' && !this.config.shadowMode) {
      try {
        const [scores, policy] = await Promise.all([
          this.scoreFetcher.getScores(taskContext.taskType, taskContext.customerId, taskContext.agentId),
          this.liApi.getPolicyDecision(taskContext.taskType, taskContext.customerId, taskContext.agentId),
        ]);

        for (const s of scores) {
          enrichmentScores[s.actionName] = s.compositeScore;
        }

        if (
          policy &&
          policy.confidence >= REROUTE_CONFIDENCE_THRESHOLD &&
          policy.action !== toolName &&
          this.registry.isHealthy(this.resolveUpstream(policy.action))
        ) {
          originalAction = toolName;
          executedAction = policy.action;
          rerouted = true;
          log.info('Auto-mode reroute', {
            decisionId,
            from: toolName,
            to: policy.action,
            confidence: policy.confidence,
            reason: policy.reason,
          });
        }
      } catch {
        // Degrade — continue with original tool
      }
    }

    // Resolve upstream from tool name
    const upstreamName = this.resolveUpstream(executedAction);

    // Proxy to upstream
    const result = await this.upstreamClient.callTool(upstreamName, executedAction, args);

    // Fire-and-forget outcome logging
    const latencyMs = Date.now() - startMs;
    void this.logDecision({
      decisionId,
      agentId: taskContext.agentId,
      customerId: taskContext.customerId,
      taskType: taskContext.taskType,
      actionName: executedAction,
      upstreamName,
      originalAction,
      executedAction,
      mode,
      rerouted,
      enrichmentScores,
      latencyMs,
      args,
      result,
      isError: result.isError === true,
    });

    return result;
  }

  // ── Shutdown ─────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this.registry.stopHealthChecks();
    log.info('Gateway proxy shut down');
  }

  // ── Private: enrichment context ──────────────────────────

  private async getEnrichmentContext(
    taskType: string,
    customerId: string,
    agentId: string,
    mode: GatewayMode,
  ): Promise<EnrichmentContext> {
    // Bootstrap mode — no enrichment needed
    if (mode === 'bootstrap') {
      return {
        taskType,
        customerId,
        agentId,
        mode,
        scores: [],
        policyDecision: null,
      };
    }

    try {
      const [scores, policyDecision] = await Promise.all([
        this.scoreFetcher.getScores(taskType, customerId, agentId),
        this.liApi.getPolicyDecision(taskType, customerId, agentId),
      ]);

      return { taskType, customerId, agentId, mode, scores, policyDecision };
    } catch (err) {
      log.warn('Enrichment context fetch failed — degrading to bootstrap-like', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        taskType,
        customerId,
        agentId,
        mode,
        scores: [],
        policyDecision: null,
      };
    }
  }

  // ── Private: routing helpers ─────────────────────────────

  private resolveUpstream(toolName: string): string {
    const entries = this.registry.getAllUpstreams();

    // Match tool name to upstream by prefix convention:
    // "github_push_fix" → upstream named "github"
    // "database_query" → upstream named "database"
    const prefix = toolName.split('_')[0];
    if (prefix) {
      const matched = entries.find(
        (e) => e.server.name === prefix && this.registry.isHealthy(e.server.name),
      );
      if (matched) return matched.server.name;
    }

    // Fallback: first healthy upstream
    for (const entry of entries) {
      if (this.registry.isHealthy(entry.server.name)) return entry.server.name;
    }
    return entries[0]?.server.name ?? 'unknown';
  }

  private async logDecision(record: {
    decisionId: string;
    agentId: string;
    customerId: string;
    taskType: string;
    actionName: string;
    upstreamName: string;
    originalAction: string;
    executedAction: string;
    mode: GatewayMode;
    rerouted: boolean;
    enrichmentScores: Record<string, number>;
    latencyMs: number;
    args?: Record<string, unknown>;
    result?: UpstreamCallResult;
    isError?: boolean;
  }): Promise<void> {
    try {
      // ── LLM classification (fire-and-forget, non-blocking) ────
      let classification: OutcomeClassification | null = null;
      if (this.classifier && record.result) {
        try {
          classification = await this.classifier.classify(
            record.actionName,
            record.args ?? {},
            record.result,
            record.isError ?? false,
            record.taskType,
          );
        } catch {
          // LLM failed — continue with defaults
        }
      }

      // ── Rule-based fallback when LLM is unavailable ───────────
      if (!classification && record.result) {
        try {
          classification = classifyWithRules(
            record.actionName,
            record.args ?? {},
            record.result,
            record.isError ?? false,
            record.taskType,
          );
        } catch {
          // Rules failed — continue with defaults
        }
      }

      // ── Merge: agent-explicit > LLM-inferred > defaults ──────
      const mergedTaskType = resolveMergeField(
        record.taskType,
        classification?.task_type ?? null,
        { exclude: new Set(['unknown', '', 'unspecified_issue']) },
      ) ?? 'unspecified_issue';

      const mergedSuccess = record.isError === true ? false : (classification?.success ?? true);

      // Build API-compatible payload. Omit decision_id — the gateway's
      // dec_ format is non-UUID and the API's schema accepts UUID only.
      const payload: OutcomePayload = {
        agent_id: record.agentId,
        customer_id: record.customerId,
        issue_type: mergedTaskType,
        action_name: record.actionName,
        upstream_name: record.upstreamName,
        original_action: record.originalAction,
        executed_action: record.executedAction,
        mode: record.mode,
        rerouted: record.rerouted,
        success: mergedSuccess,
        response_time_ms: record.latencyMs,
        timestamp: new Date().toISOString(),
        ingestion_source: 'mcp',
        environment: this.config.environment,
      };

      // Attach classifier enrichment if available
      if (classification) {
        payload.context = classification.context;
        payload.error_message = classification.error_message;
        payload.result_summary = classification.result_summary;
        payload.classification_confidence = classification.confidence;

        // Confidence gating: only attach business_outcome when confidence >= 0.7.
        // Low-confidence LLM classifications trigger false-positive silent-failure alerts.
        if (classification.confidence >= 0.7) {
          payload.business_outcome = classification.business_outcome;
        }

        // Request delayed signal registration when confidence is low or outcome is ambiguous.
        // This auto-creates a pending_signal row so Layer 2/3 webhooks can resolve it later.
        if (
          classification.confidence < 0.7 ||
          classification.business_outcome === 'partial' ||
          classification.business_outcome === 'unknown'
        ) {
          payload.feedback_signal = 'delayed';
        }
      }

      const sent = await this.liApi.logOutcome(payload);
      if (!sent) {
        await enqueueOutcome(payload);
      }

      // ── Episode tracking (secondary durability) ───────────────
      this.tracker?.recordDecision({
        decisionId: record.decisionId,
        agentId: record.agentId,
        customerId: record.customerId,
        taskType: mergedTaskType,
        actionName: record.actionName,
        upstreamName: record.upstreamName,
        originalAction: record.originalAction,
        executedAction: record.executedAction,
        mode: record.mode,
        rerouted: record.rerouted,
        enrichmentScores: record.enrichmentScores,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Fire-and-forget — silent failure is acceptable
      log.debug('Outcome logging skipped (non-critical)');
    }
  }
}
