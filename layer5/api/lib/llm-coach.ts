/**
 * LayerInfinite API — llm-coach.ts
 * ══════════════════════════════════════════════════════════════
 * LLM-based coaching that fires on failed actions.
 *
 * Model: gpt-4o-mini (~$0.15/1M input tokens)
 * Cap:    3 coaching injections per agent session
 * Retire: when task_type has ≥ 50 historical outcomes
 * Timeout: 3s — on timeout, agent proceeds without coaching
 *
 * Integration point: called from the MCP gateway's enrichment
 * engine when an agent reports a failure. The coaching message
 * is injected into the next tools/list enrichment as a
 * "LI Note:" prefix.
 * ══════════════════════════════════════════════════════════════
 */

import { coachTracker } from './coach-session-tracker.js';
import type { ActionScore } from './supabase.js';

// ── Types ──────────────────────────────────────────────────────

export interface CoachingInput {
  agentId: string;
  customerId: string;
  /** The task the agent was attempting (e.g. "build_failed"). */
  taskType: string;
  /** The action that just failed. */
  failedActionName: string;
  /** Error details if available. */
  errorMessage?: string;
  /** All tools the agent can see (names + descriptions). */
  availableTools: Array<{ name: string; description: string }>;
  /** Historical scores for this task_type. */
  historicalScores: Pick<
    ActionScore,
    'action_name' | 'raw_success_rate' | 'total_attempts' | 'trend_delta'
  >[];
  /** Number of recorded outcomes for this task_type. */
  taskOutcomeCount: number;
}

// ── Constants ──────────────────────────────────────────────────

const COACH_TIMEOUT_MS = 3_000;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

// ── Public API ─────────────────────────────────────────────────

/**
 * Generate a coaching message for a failed action.
 * Returns null if coaching is disabled, capped, retired, or errors.
 */
export async function generateCoachingMessage(
  input: CoachingInput,
): Promise<string | null> {
  // ── 1. Pre-flight checks ──────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  if (!(await coachTracker.canCoach(input.agentId, input.taskType, input.taskOutcomeCount))) {
    return null;
  }

  // ── 2. Build scoring summary ───────────────────────────────
  const relevantScores = input.historicalScores
    .filter((s) => s.action_name !== input.failedActionName)
    .sort((a, b) => (b.raw_success_rate ?? 0) - (a.raw_success_rate ?? 0))
    .slice(0, 5);

  if (relevantScores.length === 0) return null; // No alternatives to suggest

  const scoreLines = relevantScores.map((s) => {
    const pct = Math.round((s.raw_success_rate ?? 0) * 100);
    const attempts = s.total_attempts ?? 0;
    const trend = s.trend_delta != null
      ? s.trend_delta > 0 ? 'improving' : s.trend_delta < 0 ? 'declining' : 'stable'
      : null;
    let line = `- ${s.action_name}: ${pct}% success (${attempts} outcomes)`;
    if (trend) line += `, trend: ${trend}`;
    return line;
  }).join('\n');

  // ── 3. Build prompt ────────────────────────────────────────
  const systemPrompt =
    'You are a concise engineering coach. ' +
    'Given a failed action and historical performance data, suggest an alternative ' +
    'in exactly 1-2 sentences. Be specific — name the tool and its success rate. ' +
    'Do not apologize, explain your reasoning, or use filler words. ' +
    'Start directly with the coaching note.';

  const userPrompt =
    `The agent just failed executing "${input.failedActionName}" for task "${input.taskType}".` +
    (input.errorMessage ? ` Error: ${input.errorMessage}.` : '') +
    `\n\nHistorical performance for "${input.taskType}":\n${scoreLines}` +
    `\n\nAvailable tools: ${input.availableTools.map((t) => t.name).join(', ')}` +
    `\n\nProvide a 1-2 sentence coaching note suggesting the best alternative. ` +
    `Format: "LI Note: [your coaching]". Include the recommended tool's name and success rate.`;

  // ── 4. Call gpt-4o-mini with timeout ───────────────────────
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COACH_TIMEOUT_MS);

    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 120,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        '[llm-coach] OpenAI API error:',
        response.status,
        response.statusText,
      );
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // ── 5. Record + return ──────────────────────────────────
    coachTracker.recordCoaching(input.agentId, input.taskType);

    // Ensure "LI Note:" prefix is present
    if (!content.startsWith('LI Note:')) {
      return `LI Note: ${content}`;
    }
    return content;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[llm-coach] OpenAI call timed out after 3s — skipping coaching');
    } else {
      console.warn('[llm-coach] OpenAI call failed:', err.message);
    }
    return null;
  }
}
