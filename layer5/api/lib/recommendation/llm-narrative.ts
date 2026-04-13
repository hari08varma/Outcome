/**
 * LLM Narrative Generator for Recommendations
 *
 * Replaces the static template strings in reason.ts with LLM-generated
 * context-aware explanations. Uses OpenAI gpt-4o-mini (cheap, fast).
 *
 * Graceful degradation: if the LLM call fails or the env flag is off,
 * the static template text is returned unchanged.
 *
 * Env vars:
 *   ENABLE_RECOMMENDATION_NARRATIVE=true   — gates the whole feature
 *   OPENAI_API_KEY                         — required when feature is on
 *   RECOMMENDATION_NARRATIVE_MODEL         — defaults to gpt-4o-mini
 */

import type { ActionableOutput } from './reason.js';

const ENABLED = process.env.ENABLE_RECOMMENDATION_NARRATIVE === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.RECOMMENDATION_NARRATIVE_MODEL ?? 'gpt-4o-mini';

export interface NarrativeContext {
    // Core recommendation fields
    task: string;
    state: string;
    confidence_pct: number;
    confidence_label: string;
    best_action: string | null;
    best_rate_pct: string | null;
    worst_action: string | null;
    worst_rate_pct: string | null;
    delta_pct: string | null;
    sample_size_best: number | null;
    sample_size_worst: number | null;
    min_sample_count: number;
    decision_type: 'collect_more_data' | 'monitor' | 'replace';

    // Signal quality
    reliability_band: 'stable' | 'watch' | 'anomalous' | null;
    reliability_reasons: string[];
    silent_failure_warning: boolean;
    data_freshness_stale: boolean;
    data_freshness_age_hours: number | null;
    scope: 'agent_scoped' | 'customer_blended';
    scope_fallback_applied: boolean;
    confidence_source: string;
    confidence_source_reason: string;

    // What the static templates already generated
    static_summary: string;
    static_evidence: string;
    static_confidence_note: string;
    static_message: string;
}

export interface NarrativeOutput {
    summary: string;
    evidence: string;
    confidence_note: string;
    message: string;
    /** One-line plain-English headline for the card header */
    headline: string;
}

function buildPrompt(ctx: NarrativeContext): string {
    const lines: string[] = [
        `You are the AI engine for Layerinfinite, a decision-intelligence platform that helps developers know which action their AI agent should take for a given task.`,
        ``,
        `Generate a short, clear, developer-friendly recommendation narrative. Be direct. No marketing language. No fluff. Use concrete numbers from the data.`,
        ``,
        `## Recommendation context`,
        `Task name: ${ctx.task}`,
        `State: ${ctx.state}`,
        `Decision: ${decision_type_label(ctx.decision_type)}`,
        `Best action: ${ctx.best_action ?? 'none yet'}`,
        `Best success rate: ${ctx.best_rate_pct ?? 'unknown'}`,
        `Worst action: ${ctx.worst_action ?? 'none yet'}`,
        `Worst success rate: ${ctx.worst_rate_pct ?? 'unknown'}`,
        `Performance gap: ${ctx.delta_pct ?? 'unknown'}`,
        `Samples (best/worst): ${ctx.sample_size_best ?? '?'} / ${ctx.sample_size_worst ?? '?'}`,
        `Minimum sample count: ${ctx.min_sample_count}`,
        `Confidence: ${ctx.confidence_pct}% (${ctx.confidence_label})`,
        `Signal reliability band: ${ctx.reliability_band ?? 'unknown'}`,
        ctx.reliability_reasons.length > 0
            ? `Reliability signals: ${ctx.reliability_reasons.join('; ')}`
            : '',
        `Silent failure warning: ${ctx.silent_failure_warning ? 'YES — some outcomes marked success=true had low outcome scores' : 'no'}`,
        `Data freshness: ${ctx.data_freshness_stale ? `STALE (${ctx.data_freshness_age_hours?.toFixed(1) ?? '?'}h old)` : 'fresh'}`,
        `Data scope: ${ctx.scope === 'agent_scoped' ? 'this agent only' : ctx.scope_fallback_applied ? 'blended (agent scope not yet mature)' : 'blended across all agents'}`,
        `Confidence source: ${ctx.confidence_source} — ${ctx.confidence_source_reason}`,
        ``,
        `## What to generate`,
        `Return a JSON object with exactly these keys:`,
        `- "headline": 10-15 words max. The single most important thing a developer should know right now. No hedging.`,
        `- "summary": 1-2 sentences. Why is one action better, or why can't we say yet? Be specific.`,
        `- "evidence": 1 sentence. Cite the numbers: rates, sample counts, gap size.`,
        `- "confidence_note": 1 sentence. Explain what drives the confidence level and what would change it.`,
        `- "message": 1 sentence imperative. Tell the developer exactly what to do next.`,
        ``,
        `Rules:`,
        `- Use the actual action names (e.g. "${ctx.best_action ?? 'action_name'}")`,
        `- Use percentages (e.g. "73.2%") not decimals`,
        `- If state is no_data or collect_more_data: focus on what to log, not performance`,
        `- If silent_failure_warning: mention that success signals may be unreliable`,
        `- If reliability is anomalous or watch: note the uncertainty`,
        `- If data is stale: mention that evidence is old`,
        `- If scope fallback is active: note recommendations come from the broader agent pool`,
        `- Do NOT say "Layerinfinite recommends" — write as the system speaking directly`,
        `- Do NOT use em-dashes`,
        `- Return ONLY the JSON object, no markdown fences`,
    ].filter((l) => l !== undefined);

    return lines.join('\n');
}

// Hack to make the prompt builder not need a method on context
function decision_type_label(type: NarrativeContext['decision_type']): string {
    if (type === 'replace') return 'Replace worst action with best action';
    if (type === 'monitor') return 'Monitor — do not switch yet';
    return 'Collect more data — no recommendation yet';
}

// In-flight dedup: same context fingerprint → share one LLM promise
const inflightCalls = new Map<string, Promise<NarrativeOutput | null>>();

function contextFingerprint(ctx: NarrativeContext): string {
    return [
        ctx.task,
        ctx.state,
        ctx.confidence_pct,
        ctx.best_action,
        ctx.worst_action,
        ctx.delta_pct,
        ctx.min_sample_count,
        ctx.reliability_band,
        ctx.silent_failure_warning,
        ctx.scope,
        ctx.scope_fallback_applied,
    ].join('|');
}

async function callOpenAI(prompt: string): Promise<NarrativeOutput | null> {
    if (!OPENAI_API_KEY) {
        console.warn('[llm-narrative] OPENAI_API_KEY not set — skipping narrative');
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: 0,
                max_tokens: 400,
                messages: [
                    { role: 'user', content: prompt },
                ],
            }),
        });

        if (!res.ok) {
            console.warn(`[llm-narrative] OpenAI error ${res.status}`);
            return null;
        }

        const json = await res.json() as {
            choices?: Array<{ message?: { content?: string } }>;
        };

        const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
        if (!raw) return null;

        // Strip markdown fences if the model added them anyway
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

        const parsed = JSON.parse(cleaned) as Partial<NarrativeOutput>;

        // Validate all required keys are non-empty strings
        const required: (keyof NarrativeOutput)[] = ['headline', 'summary', 'evidence', 'confidence_note', 'message'];
        for (const key of required) {
            if (typeof parsed[key] !== 'string' || parsed[key]!.trim() === '') {
                console.warn(`[llm-narrative] missing key "${key}" in LLM response`);
                return null;
            }
        }

        return parsed as NarrativeOutput;
    } catch (err: any) {
        if (err?.name !== 'AbortError') {
            console.warn('[llm-narrative] call failed:', err.message);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Generate an LLM narrative for a recommendation.
 *
 * Returns null when:
 * - ENABLE_RECOMMENDATION_NARRATIVE is not 'true'
 * - OPENAI_API_KEY is not set
 * - The LLM call fails or times out
 * - The response cannot be parsed
 *
 * The caller should fall back to static template text in all null cases.
 */
export async function generateNarrative(
    output: ActionableOutput,
    extra: {
        reliability_band: 'stable' | 'watch' | 'anomalous' | null;
        reliability_reasons: string[];
        silent_failure_warning: boolean;
        data_freshness_stale: boolean;
        data_freshness_age_hours: number | null;
        scope: 'agent_scoped' | 'customer_blended';
        scope_fallback_applied: boolean;
        confidence_source: string;
        confidence_source_reason: string;
    },
): Promise<NarrativeOutput | null> {
    if (!ENABLED) return null;

    const ctx: NarrativeContext = {
        task: output.task,
        state: output.state,
        confidence_pct: output.confidence_meta.percent,
        confidence_label: (output.confidence_meta as any).label ?? 'none',
        best_action: output.insight.best_action,
        best_rate_pct: output.insight.best_rate !== null
            ? `${(output.insight.best_rate * 100).toFixed(1)}%`
            : null,
        worst_action: output.insight.worst_action,
        worst_rate_pct: output.insight.worst_rate !== null
            ? `${(output.insight.worst_rate * 100).toFixed(1)}%`
            : null,
        delta_pct: output.insight.delta !== null
            ? `+${(output.insight.delta * 100).toFixed(1)}%`
            : null,
        sample_size_best: output.insight.sample_size?.best ?? null,
        sample_size_worst: output.insight.sample_size?.worst ?? null,
        min_sample_count: output.progress.current_samples,
        decision_type: output.decision.type,

        ...extra,

        // Static fallbacks (so the model can use them as hints)
        static_summary: output.reason.summary,
        static_evidence: output.reason.evidence,
        static_confidence_note: output.reason.confidence_note,
        static_message: output.message,
    };

    const fingerprint = contextFingerprint(ctx);

    const existing = inflightCalls.get(fingerprint);
    if (existing) return existing;

    const prompt = buildPrompt(ctx);

    const promise = callOpenAI(prompt).finally(() => {
        inflightCalls.delete(fingerprint);
    });

    inflightCalls.set(fingerprint, promise);
    return promise;
}
