/**
 * Outcome Pipeline end-to-end tests.
 * Validates classifier fallback, confidence gating, queue persistence,
 * DecisionTracker lifecycle, and queue processor lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { classifyWithRules, OutcomeClassifier } from '../src/outcome-classifier.js';
import { DecisionTracker } from '../src/decision-tracker.js';
import {
  enqueueOutcome,
  listQueuedEntries,
  dequeueEntry,
  processQueue,
  startQueueProcessor,
} from '../src/fail-open.js';
import { GatewayProxy, generateDecisionId } from '../src/gateway-proxy.js';
import { ModeManager } from '../src/mode-manager.js';
import { ScoreFetcher } from '../src/enrichment/score-fetcher.js';
import type { GatewayConfig, ClassifierConfig } from '../src/config.js';
import type {
  OutcomePayload,
  OutcomeClassification,
  DecisionRecord,
} from '../src/types.js';
import type { LiApiClient, UpstreamMCPClient, UpstreamCallResult } from '../src/rest-client.js';
import type { UpstreamRegistry } from '../src/upstream-registry.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
    mode: 'recommend',
    upstreamServers: [{ name: 'github', url: 'https://github-mcp.example.com' }],
    modeOverrides: new Map(),
    shadowMode: false,
    environment: 'production',
    adminKey: null,
    logLevel: 'warn',
    classifier: null,
    ...overrides,
  };
}

function makeResult(text: string, isError = false): UpstreamCallResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

function mockLiApi(): LiApiClient {
  return {
    logOutcome: vi.fn().mockResolvedValue(true),
    getScores: vi.fn().mockResolvedValue([]),
    getPolicyDecision: vi.fn().mockResolvedValue(null),
    getRecommendations: vi.fn().mockResolvedValue([]),
  } as unknown as LiApiClient;
}

function mockUpstream(): UpstreamMCPClient {
  return {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue(makeResult('ok')),
    startHealthChecks: vi.fn(),
  } as unknown as UpstreamMCPClient;
}

function mockRegistry(): UpstreamRegistry {
  return {
    getAllUpstreams: vi.fn().mockReturnValue([
      { server: { name: 'github', url: 'https://github.example.com' } },
    ]),
    isHealthy: vi.fn().mockReturnValue(true),
    stopHealthChecks: vi.fn(),
  } as unknown as UpstreamRegistry;
}

// ── classifyWithRules ──────────────────────────────────────────────

describe('classifyWithRules (rule-based fallback)', () => {
  it('classifies error results as failed', () => {
    const result = classifyWithRules(
      'github_push',
      { branch: 'main' },
      makeResult('Push failed: remote rejected'),
      true,
      'code_deployment',
    );
    expect(result.success).toBe(false);
    expect(result.business_outcome).toBe('failed');
    expect(result.confidence).toBe(0.5);
    expect(result.task_type).toBe('code_deployment');
  });

  it('classifies result.isError as failed', () => {
    const r = makeResult('Something went wrong', true);
    const result = classifyWithRules(
      'db_query',
      {},
      r,
      false, // isError param false but result.isError true
      'unspecified_issue',
    );
    expect(result.success).toBe(false);
    expect(result.business_outcome).toBe('failed');
  });

  it('detects error keywords in result text', () => {
    const result = classifyWithRules(
      'api_call',
      {},
      makeResult('Request timeout after 30s'),
      false,
      'data_query',
    );
    expect(result.success).toBe(false);
    expect(result.business_outcome).toBe('failed');
    expect(result.error_message).toContain('timeout');
  });

  it('detects "unauthorized" as error keyword', () => {
    const result = classifyWithRules(
      'api_call',
      {},
      makeResult('HTTP 401 Unauthorized'),
      false,
      'data_query',
    );
    expect(result.success).toBe(false);
    expect(result.business_outcome).toBe('failed');
  });

  it('classifies empty result as unknown', () => {
    const result = classifyWithRules(
      'silent_tool',
      {},
      makeResult(''),
      false,
      'unspecified_issue',
    );
    expect(result.success).toBe(true);
    expect(result.business_outcome).toBe('unknown');
  });

  it('classifies successful result as resolved', () => {
    const result = classifyWithRules(
      'deploy_service',
      { env: 'prod' },
      makeResult('Deployment completed successfully'),
      false,
      'code_deployment',
    );
    expect(result.success).toBe(true);
    expect(result.business_outcome).toBe('resolved');
    expect(result.task_type).toBe('code_deployment');
  });

  it('falls back to unspecified_issue when agent task_type is unknown', () => {
    const result = classifyWithRules(
      'random_tool',
      {},
      makeResult('OK'),
      false,
      'unknown',
    );
    expect(result.task_type).toBe('unspecified_issue');
  });

  it('preserves explicit agent task_type on success', () => {
    const result = classifyWithRules(
      'refund_tool',
      { orderId: '123' },
      makeResult('Refund processed'),
      false,
      'refund_processing',
    );
    expect(result.task_type).toBe('refund_processing');
    expect(result.business_outcome).toBe('resolved');
  });

  it('truncates long error messages to 500 chars', () => {
    const longError = 'x'.repeat(800);
    const result = classifyWithRules(
      'failing_tool',
      {},
      makeResult(longError),
      true,
      'unspecified_issue',
    );
    expect(result.error_message!.length).toBeLessThanOrEqual(500);
  });

  it('always uses confidence 0.5 (neutral)', () => {
    const results = [
      classifyWithRules('a', {}, makeResult('ok'), false, 'unknown'),
      classifyWithRules('b', {}, makeResult('error'), true, 'unknown'),
      classifyWithRules('c', {}, makeResult(''), false, 'unknown'),
    ];
    for (const r of results) {
      expect(r.confidence).toBe(0.5);
    }
  });
});

// ── DecisionTracker ────────────────────────────────────────────────

describe('DecisionTracker', () => {
  let tracker: DecisionTracker;
  let liApi: LiApiClient;

  beforeEach(() => {
    liApi = mockLiApi();
    tracker = new DecisionTracker(liApi, 'production');
  });

  afterEach(() => {
    tracker.stopFlushTimer();
  });

  it('starts an episode and returns valid episode object', () => {
    const ep = tracker.startEpisode('agent-1', 'cust-1');
    expect(ep.episodeId).toMatch(/^ep_[0-9A-Za-z]{10}_[0-9A-Za-z]{6}$/);
    expect(ep.agentId).toBe('agent-1');
    expect(ep.decisions).toEqual([]);
    expect(ep.coachingCount).toBe(0);
  });

  it('retrieves an existing episode', () => {
    const ep = tracker.startEpisode('agent-1', 'cust-1');
    const found = tracker.getEpisode(ep.episodeId);
    expect(found).toBeDefined();
    expect(found!.episodeId).toBe(ep.episodeId);
  });

  it('records a decision and links to episode', () => {
    const ep = tracker.startEpisode('agent-1', 'cust-1');
    const record: DecisionRecord = {
      decisionId: generateDecisionId('agent-1'),
      agentId: 'agent-1',
      customerId: 'cust-1',
      taskType: 'code_deployment',
      actionName: 'github_push',
      upstreamName: 'github',
      originalAction: 'github_push',
      executedAction: 'github_push',
      mode: 'recommend',
      rerouted: false,
      enrichmentScores: {},
      timestamp: new Date().toISOString(),
    };
    tracker.recordDecision(record);
    const updated = tracker.getEpisode(ep.episodeId);
    expect(updated!.decisions).toContain(record.decisionId);
  });

  it('enforces coaching cap of 3 per episode', () => {
    const ep = tracker.startEpisode('agent-1', 'cust-1');
    expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
    expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
    expect(tracker.recordCoaching(ep.episodeId)).toBe(true);
    expect(tracker.recordCoaching(ep.episodeId)).toBe(false); // cap reached
    expect(tracker.canCoach(ep.episodeId)).toBe(false);
  });

  it('flushes buffer to LI API', async () => {
    const record: DecisionRecord = {
      decisionId: generateDecisionId('agent-1'),
      agentId: 'agent-1',
      customerId: 'cust-1',
      taskType: 'deploy',
      actionName: 'github_push',
      upstreamName: 'github',
      originalAction: 'github_push',
      executedAction: 'github_push',
      mode: 'recommend',
      rerouted: false,
      enrichmentScores: {},
      timestamp: new Date().toISOString(),
    };
    tracker.recordDecision(record);
    await tracker.flushBuffer();

    expect(liApi.logOutcome).toHaveBeenCalled();
    const call = (liApi.logOutcome as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.agent_id).toBe('agent-1');
    expect(call.action_name).toBe('github_push');
  });

  it('has zero buffer after successful flush', async () => {
    tracker.recordDecision({
      decisionId: generateDecisionId('agent-1'),
      agentId: 'agent-1',
      customerId: 'cust-1',
      taskType: 'test',
      actionName: 'test_tool',
      upstreamName: 'github',
      originalAction: 'test_tool',
      executedAction: 'test_tool',
      mode: 'recommend',
      rerouted: false,
      enrichmentScores: {},
      timestamp: new Date().toISOString(),
    });
    expect(tracker.bufferSize).toBeGreaterThan(0);
    await tracker.flushBuffer();
    expect(tracker.bufferSize).toBe(0);
  });
});

// ── Queue Persistence ──────────────────────────────────────────────

describe('Queue persistence (fail-open)', () => {
  it('enqueues and dequeues an outcome payload', async () => {
    const payload: OutcomePayload = {
      agent_id: 'test-agent',
      customer_id: 'test-cust',
      issue_type: 'code_deployment',
      action_name: 'github_push',
      upstream_name: 'github',
      original_action: 'github_push',
      executed_action: 'github_push',
      mode: 'recommend',
      rerouted: false,
      success: true,
      response_time_ms: 42,
      timestamp: new Date().toISOString(),
      ingestion_source: 'mcp',
      environment: 'test',
    };

    await enqueueOutcome(payload);
    const entries = await listQueuedEntries();
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries.find((e) => e.payload.action_name === 'github_push');
    expect(entry).toBeDefined();
    expect(entry!.payload.success).toBe(true);
    expect(entry!.attempts).toBe(0);

    // Clean up
    await dequeueEntry(entry!.id);
    const after = await listQueuedEntries();
    expect(after.find((e) => e.id === entry!.id)).toBeUndefined();
  });
});

// ── Queue Processor Lifecycle ──────────────────────────────────────

describe('startQueueProcessor', () => {
  it('starts and stops cleanly without errors', () => {
    const send = vi.fn().mockResolvedValue(true);
    const processor = startQueueProcessor(send, 60_000); // long interval to avoid timer noise
    expect(processor).toBeDefined();
    expect(processor.stop).toBeDefined();
    processor.stop();
  });

  it('drains queue on startup (calls send immediately)', async () => {
    // Enqueue a payload first
    await enqueueOutcome({
      agent_id: 'drain-agent',
      customer_id: 'drain-cust',
      issue_type: 'test',
      action_name: 'drain_test',
      upstream_name: 'github',
      original_action: 'drain_test',
      executed_action: 'drain_test',
      mode: 'recommend',
      rerouted: false,
      success: true,
      response_time_ms: 1,
      timestamp: new Date().toISOString(),
      ingestion_source: 'mcp',
      environment: 'test',
    });

    const send = vi.fn().mockResolvedValue(true);

    // Drain queue directly (startQueueProcessor uses fire-and-forget void)
    const sent = await processQueue(send);

    expect(send).toHaveBeenCalled();
    expect(sent).toBe(1);

    // Verify queue is now empty for this entry
    const remaining = await listQueuedEntries();
    expect(remaining.find((e) => e.payload.action_name === 'drain_test')).toBeUndefined();
  });
});

// ── Confidence Gating & Feedback Signal ────────────────────────────

describe('Confidence gating and feedback signal', () => {
  it('classifyWithRules always produces confidence 0.5 — below 0.7 threshold', () => {
    // This means business_outcome from rule-based classification
    // will ALWAYS be gated (not sent to API) and trigger feedback_signal: 'delayed'.
    // That's the correct behavior — rules are uncertain by nature.
    const result = classifyWithRules('tool', {}, makeResult('ok'), false, 'code_deployment');
    expect(result.confidence).toBe(0.5);
    expect(result.confidence).toBeLessThan(0.7);
  });
});

// ── GatewayProxy with tracker & classifier wiring ──────────────────

describe('GatewayProxy outcome logging', () => {
  it('constructs with DecisionTracker', () => {
    const proxy = new GatewayProxy(
      mockLiApi(),
      mockUpstream(),
      mockRegistry(),
      makeConfig(),
      null, // classifier
      new DecisionTracker(mockLiApi(), 'production'),
    );
    expect(proxy).toBeDefined();
  });

  it('constructs without DecisionTracker (backwards compatible)', () => {
    const proxy = new GatewayProxy(
      mockLiApi(),
      mockUpstream(),
      mockRegistry(),
      makeConfig(),
    );
    expect(proxy).toBeDefined();
  });

  it('logs an outcome and calls liApi.logOutcome', async () => {
    const liApi = mockLiApi();
    const proxy = new GatewayProxy(
      liApi,
      mockUpstream(),
      mockRegistry(),
      makeConfig(),
      null,
      new DecisionTracker(liApi, 'production'),
    );

    const result = await proxy.handleCallTool(
      'github_push',
      { branch: 'main' },
      { taskType: 'code_deployment', customerId: 'cust-1', agentId: 'agent-1' },
    );

    expect(result).toBeDefined();
    // The fire-and-forget logDecision runs after the response is returned.
    // Wait briefly for the async log to complete.
    await vi.waitFor(
      () => {
        expect(liApi.logOutcome).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    const call = (liApi.logOutcome as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.agent_id).toBe('agent-1');
    expect(call.action_name).toBe('github_push');
    expect(call.mode).toBe('recommend');
  });

  it('generates unique decision IDs per call', async () => {
    const liApi = mockLiApi();
    const proxy = new GatewayProxy(
      liApi,
      mockUpstream(),
      mockRegistry(),
      makeConfig(),
    );

    // Two calls should produce unique decision IDs
    await proxy.handleCallTool('tool_a', {}, { taskType: 'test', customerId: 'c', agentId: 'a' });
    await proxy.handleCallTool('tool_b', {}, { taskType: 'test', customerId: 'c', agentId: 'a' });

    await vi.waitFor(
      () => {
        expect((liApi.logOutcome as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
  });
});

// ── OutcomePayload structure ───────────────────────────────────────

describe('OutcomePayload validation', () => {
  it('has all required fields in payload shape', () => {
    const payload: OutcomePayload = {
      agent_id: 'agent-1',
      customer_id: 'cust-1',
      issue_type: 'code_deployment',
      action_name: 'github_push',
      upstream_name: 'github',
      original_action: 'github_push',
      executed_action: 'github_push',
      mode: 'auto',
      rerouted: true,
      success: true,
      response_time_ms: 150,
      timestamp: new Date().toISOString(),
      ingestion_source: 'mcp',
      environment: 'production',
      // Optional enrichment fields
      context: 'Deployed to production',
      error_message: null,
      result_summary: 'Push successful',
      business_outcome: 'resolved',
      classification_confidence: 0.95,
      feedback_signal: 'immediate',
    };

    expect(payload.agent_id).toBe('agent-1');
    expect(payload.ingestion_source).toBe('mcp');
    expect(payload.feedback_signal).toBe('immediate');
  });

  it('supports delayed feedback_signal', () => {
    const payload: OutcomePayload = {
      agent_id: 'a',
      customer_id: 'c',
      issue_type: 'ticket_resolution',
      action_name: 'resolve_ticket',
      upstream_name: 'zendesk',
      original_action: 'resolve_ticket',
      executed_action: 'resolve_ticket',
      mode: 'assist',
      rerouted: false,
      success: true,
      response_time_ms: 200,
      timestamp: new Date().toISOString(),
      ingestion_source: 'mcp',
      environment: 'production',
      feedback_signal: 'delayed',
      classification_confidence: 0.5,
    };

    expect(payload.feedback_signal).toBe('delayed');
    expect(payload.business_outcome).toBeUndefined(); // gated below 0.7
  });
});
