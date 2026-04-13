/**
 * Layerinfinite — lib/schema-inferrer.ts
 * ══════════════════════════════════════════════════════════════
 * LLM-Powered Auto-Mapping for unknown agent trace formats.
 *
 * When a user uploads data that is NOT LangChain/LangGraph and NOT
 * already in Layerinfinite's standard schema, this module:
 *
 *   1. Samples the first 5 records from the uploaded data.
 *   2. Sends ONLY the structure (5 sample rows) to a fast LLM.
 *   3. Receives a deterministic mapping: { "action_name": "payload.step.command", ... }
 *   4. Applies that mapping to ALL rows using lodash-style deep-get.
 *
 * SAFETY RULES:
 *   - The LLM NEVER sees all the data — only 5 samples.
 *   - The LLM output is validated against a strict JSON schema.
 *   - If the LLM returns garbage, we reject immediately (fail-closed).
 *   - The mapping is applied deterministically — no LLM in the hot path.
 *   - Every inferred mapping is logged for audit.
 * ══════════════════════════════════════════════════════════════
 */

// ── Types ─────────────────────────────────────────────────────

/** The field mapping contract the LLM must produce. */
export interface SchemaMapping {
    /** JSON path to the action/tool/function name */
    action_name: string;
    /** JSON path to the issue type / task category / intent */
    issue_type: string | null;
    /** JSON path to the success/failure indicator */
    success: string;
    /** JSON path to the error message, if any */
    error_message: string | null;
    /** JSON path to the error code, if any */
    error_code: string | null;
    /** JSON path to the response time / latency in ms */
    response_time_ms: string | null;
    /** JSON path to the session / trace / request identifier */
    session_id: string | null;
    /** JSON path to the episode / thread / conversation ID */
    episode_id: string | null;
    /** JSON path to the environment (prod/staging/dev) */
    environment: string | null;
    /** JSON path to the outcome score (0-1 or 0-100) */
    outcome_score: string | null;
    /** JSON path to the business outcome / resolution status */
    business_outcome: string | null;
    /** JSON path to the timestamp of the event */
    timestamp: string | null;
    /** JSON path to the token count or resource cost */
    resource_cost_units: string | null;
    /** JSON path to the retry attempt number */
    retry_attempt: string | null;
    /** JSON path to any task name / workflow name */
    task_name: string | null;
    /** The identified data source / framework (e.g. "crewai", "autogpt", "custom") */
    detected_framework: string;
    /** Confidence that the mapping is correct (0.0-1.0) */
    confidence: number;
}

export interface InferResult {
    mapping: SchemaMapping;
    mappedRecords: Record<string, unknown>[];
    sampleCount: number;
    llmModel: string;
}

// ── Configuration ─────────────────────────────────────────────

const SAMPLE_SIZE = 5;
const MAX_SAMPLE_JSON_LENGTH = 8000; // chars per sample batch (avoid token bloat)
const LLM_TIMEOUT_MS = 10_000; // 10 second timeout on LLM calls

// ── Schema Fingerprint Cache ──────────────────────────────────
// Caches mappings by schema fingerprint so the same data shape
// doesn't trigger redundant LLM calls across multiple uploads.
//
// Implemented as a true LRU: Map insertion order is preserved, and
// every cache hit moves the entry to the tail so least-recently-used
// entries are always at the head.
const mappingCache = new Map<string, SchemaMapping>();
const MAX_CACHE_SIZE = 100;

// ── In-flight deduplication ───────────────────────────────────
// When N concurrent uploads share the same schema fingerprint and
// the mapping isn't cached yet, all N requests coalesce onto a
// single in-flight LLM promise instead of firing N separate calls.
// The promise is removed from the map the moment it settles (success
// or failure), so the next request after that goes through the
// normal LRU cache path.
const inflightCalls = new Map<
    string,
    Promise<{ result: InferResult | null; error: string | null }>
>();

/** Clears the schema mapping cache and any in-flight calls. Exported for testing. */
export function clearMappingCache(): void {
    mappingCache.clear();
    inflightCalls.clear();
}

/**
 * Builds a key-shape string for one record, recursing up to `maxDepth`
 * levels so that schemas differing only in nested field names produce
 * distinct fingerprints.
 */
function recordKeyShape(obj: Record<string, unknown>, depth: number): string {
    const keys = Object.keys(obj).sort();
    return keys.map((k) => {
        const v = obj[k];
        if (depth > 0 && typeof v === 'object' && v !== null && !Array.isArray(v)) {
            return `${k}:{${recordKeyShape(v as Record<string, unknown>, depth - 1)}}`;
        }
        return k;
    }).join('|');
}

function computeSchemaFingerprint(records: Record<string, unknown>[]): string {
    // Use the key structure (3 levels deep) of the first 3 records.
    // Values don't matter — only the shape does.
    return records.slice(0, 3).map((r) => recordKeyShape(r, 2)).join('\n');
}

// ── LLM Prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a schema mapping expert for AI agent observability data.
Your job is to analyze sample records from an AI agent's logs and figure out which JSON paths
map to the Layerinfinite Outcome Intelligence schema.

RULES:
1. Return ONLY a valid JSON object. No markdown, no explanation, no backticks.
2. Each value must be a dot-separated JSON path string (e.g. "payload.step.command") or null if
   the field cannot be determined from the samples.
3. "action_name" and "success" are REQUIRED — you MUST find a mapping for them.
   For "action_name": look for tool names, function names, command names, step names, handler names.
   For "success": look for boolean results, status codes, error presence, outcome indicators.
   If there is a status field, map "true"/"completed"/"ok"/"resolved" → true, rest → false.
4. If a value is nested (e.g. result.output.status), use the full dot path.
5. If the same field can serve two purposes, prioritize: action_name > task_name.
6. For "issue_type": look for category, intent, task_type, topic, domain — anything that
   classifies WHAT KIND of issue/request/problem this action is addressing.
   If not found, set to null (the system will infer it from action_name).
7. For "confidence": rate 0.0-1.0 how confident you are that your mapping is correct overall.
   0.9+ = very clear field names matching standard schemas
   0.7-0.9 = reasonable mapping with some ambiguity
   0.5-0.7 = best guess, field names are non-standard
   <0.5 = very uncertain, recommend manual review
8. For "detected_framework": identify the source framework if possible.
   Known frameworks: "crewai", "autogpt", "autogen", "semantic_kernel", "openai_assistants",
   "swarm", "phidata", "superagi", "babyagi", "camel", "metagpt", "custom".
   If unsure, use "custom".

REQUIRED OUTPUT SCHEMA:
{
  "action_name": "string (REQUIRED, dot-path)",
  "issue_type": "string|null",
  "success": "string (REQUIRED, dot-path)",
  "error_message": "string|null",
  "error_code": "string|null",
  "response_time_ms": "string|null",
  "session_id": "string|null",
  "episode_id": "string|null",
  "environment": "string|null",
  "outcome_score": "string|null",
  "business_outcome": "string|null",
  "timestamp": "string|null",
  "resource_cost_units": "string|null",
  "retry_attempt": "string|null",
  "task_name": "string|null",
  "detected_framework": "string",
  "confidence": number
}`;

function buildUserPrompt(samples: unknown[]): string {
    return `Here are ${samples.length} sample records from an AI agent's logs.
Analyze the structure and return the JSON path mapping.

SAMPLES:
${JSON.stringify(samples, null, 2)}`;
}

// ── Deep-Get Utility ──────────────────────────────────────────

/**
 * Safely retrieves a value from a nested object using a dot-path.
 * E.g. deepGet({ a: { b: { c: 42 } } }, "a.b.c") => 42
 *
 * Also handles array index notation: "steps.0.name"
 */
export function deepGet(obj: unknown, path: string): unknown {
    if (!path || obj === null || obj === undefined) return undefined;

    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
        if (current === null || current === undefined) return undefined;

        if (typeof current === 'object') {
            // Handle array index
            const asIndex = Number(part);
            if (Array.isArray(current) && Number.isFinite(asIndex)) {
                current = current[asIndex];
            } else {
                current = (current as Record<string, unknown>)[part];
            }
        } else {
            return undefined;
        }
    }

    return current;
}

// ── Mapping Validation ────────────────────────────────────────

const REQUIRED_MAPPING_FIELDS: (keyof SchemaMapping)[] = ['action_name', 'success'];
const ALL_MAPPING_FIELDS: (keyof SchemaMapping)[] = [
    'action_name', 'issue_type', 'success', 'error_message', 'error_code',
    'response_time_ms', 'session_id', 'episode_id', 'environment',
    'outcome_score', 'business_outcome', 'timestamp', 'resource_cost_units',
    'retry_attempt', 'task_name', 'detected_framework', 'confidence',
];

/**
 * Validates the raw LLM output is a valid SchemaMapping.
 * Returns normalized mapping or null with error reason.
 */
export function validateMapping(raw: unknown): { mapping: SchemaMapping | null; error: string | null } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { mapping: null, error: 'LLM returned non-object' };
    }

    const obj = raw as Record<string, unknown>;

    // Check required fields are strings
    for (const field of REQUIRED_MAPPING_FIELDS) {
        if (typeof obj[field] !== 'string' || obj[field] === '') {
            return { mapping: null, error: `Required field "${field}" missing or empty in LLM mapping` };
        }
    }

    // Build normalized mapping
    const mapping: SchemaMapping = {
        action_name: obj.action_name as string,
        issue_type: typeof obj.issue_type === 'string' ? obj.issue_type : null,
        success: obj.success as string,
        error_message: typeof obj.error_message === 'string' ? obj.error_message : null,
        error_code: typeof obj.error_code === 'string' ? obj.error_code : null,
        response_time_ms: typeof obj.response_time_ms === 'string' ? obj.response_time_ms : null,
        session_id: typeof obj.session_id === 'string' ? obj.session_id : null,
        episode_id: typeof obj.episode_id === 'string' ? obj.episode_id : null,
        environment: typeof obj.environment === 'string' ? obj.environment : null,
        outcome_score: typeof obj.outcome_score === 'string' ? obj.outcome_score : null,
        business_outcome: typeof obj.business_outcome === 'string' ? obj.business_outcome : null,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        resource_cost_units: typeof obj.resource_cost_units === 'string' ? obj.resource_cost_units : null,
        retry_attempt: typeof obj.retry_attempt === 'string' ? obj.retry_attempt : null,
        task_name: typeof obj.task_name === 'string' ? obj.task_name : null,
        detected_framework: typeof obj.detected_framework === 'string' ? obj.detected_framework : 'custom',
        confidence: typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
            ? obj.confidence
            : 0.5,
    };

    return { mapping, error: null };
}

// ── Spot-Check: Validate the mapping against sample data ──────

/**
 * After the LLM returns a mapping, we verify it actually extracts
 * valid data from the samples. If action_name or success can't be
 * resolved from the first 3 samples, we reject the mapping.
 *
 * This is the critical safety gate — the LLM can hallucinate paths
 * that don't exist. This function catches that.
 */
export function spotCheckMapping(
    mapping: SchemaMapping,
    samples: Record<string, unknown>[],
): { valid: boolean; error: string | null; extractionRate: number } {
    const checkSamples = samples.slice(0, Math.min(3, samples.length));
    let actionHits = 0;
    let successHits = 0;

    for (const sample of checkSamples) {
        const actionVal = deepGet(sample, mapping.action_name);
        if (actionVal !== undefined && actionVal !== null && String(actionVal).trim().length > 0) {
            actionHits++;
        }

        const successVal = deepGet(sample, mapping.success);
        if (successVal !== undefined && successVal !== null) {
            successHits++;
        }
    }

    const actionRate = actionHits / checkSamples.length;
    const successRate = successHits / checkSamples.length;

    if (actionRate < 0.67) {
        return {
            valid: false,
            error: `Mapping for "action_name" (path: "${mapping.action_name}") did not resolve in ${checkSamples.length - actionHits}/${checkSamples.length} samples.`,
            extractionRate: actionRate,
        };
    }

    if (successRate < 0.67) {
        return {
            valid: false,
            error: `Mapping for "success" (path: "${mapping.success}") did not resolve in ${checkSamples.length - successHits}/${checkSamples.length} samples.`,
            extractionRate: successRate,
        };
    }

    // Count how many optional fields resolved
    let optionalHits = 0;
    let optionalTotal = 0;
    const optionalPaths = [
        mapping.issue_type, mapping.error_message, mapping.response_time_ms,
        mapping.session_id, mapping.episode_id, mapping.timestamp,
    ].filter(Boolean) as string[];

    for (const path of optionalPaths) {
        optionalTotal++;
        for (const sample of checkSamples) {
            const val = deepGet(sample, path);
            if (val !== undefined && val !== null) {
                optionalHits++;
                break; // found at least one hit for this path
            }
        }
    }

    const overallRate = optionalTotal > 0
        ? (actionRate + successRate + (optionalHits / optionalTotal)) / 3
        : (actionRate + successRate) / 2;

    return { valid: true, error: null, extractionRate: overallRate };
}

// ── Apply Mapping to Records ──────────────────────────────────

/**
 * Takes the LLM-inferred mapping and re-keys ALL records into
 * Layerinfinite's standard schema. This is the deterministic
 * hot-path — no LLM involved.
 */
export function applyMapping(
    records: Record<string, unknown>[],
    mapping: SchemaMapping,
): Record<string, unknown>[] {
    return records.map((record) => {
        const mapped: Record<string, unknown> = {};

        // Required fields
        mapped.action_name = deepGet(record, mapping.action_name);
        mapped.success = deepGet(record, mapping.success);

        // Optional fields — only set if path exists in mapping AND the value is
        // present in this record. Skipping undefined prevents downstream code
        // from seeing a key with an undefined value (e.g. 'session_id' in record
        // returning true with value undefined).
        const optionals: [string, string | null][] = [
            ['issue_type', mapping.issue_type],
            ['error_message', mapping.error_message],
            ['error_code', mapping.error_code],
            ['response_time_ms', mapping.response_time_ms],
            ['session_id', mapping.session_id],
            ['episode_id', mapping.episode_id],
            ['environment', mapping.environment],
            ['outcome_score', mapping.outcome_score],
            ['business_outcome', mapping.business_outcome],
            ['timestamp', mapping.timestamp],
            ['resource_cost_units', mapping.resource_cost_units],
            ['retry_attempt', mapping.retry_attempt],
            ['task_name', mapping.task_name],
        ];
        for (const [field, path] of optionals) {
            if (!path) continue;
            const val = deepGet(record, path);
            if (val !== undefined) mapped[field] = val;
        }

        // Preserve the original record as raw_context for auditability
        mapped._original = record;
        mapped._inferred_by = 'schema-inferrer';
        mapped._detected_framework = mapping.detected_framework;

        return mapped;
    });
}

// ── LLM Call (Pluggable backend) ──────────────────────────────

export interface LLMProvider {
    /** Send a prompt to the LLM and get a text response */
    complete(systemPrompt: string, userPrompt: string): Promise<string>;
    /** Model identifier for audit logs */
    modelId: string;
}

/**
 * Default LLM provider using OpenAI-compatible API.
 * Expects SCHEMA_INFERRER_API_KEY and SCHEMA_INFERRER_API_URL env vars.
 * Falls back to Gemini Flash if not set.
 */
export function createDefaultLLMProvider(): LLMProvider | null {
    const apiKey = process.env.SCHEMA_INFERRER_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.GOOGLE_API_KEY;
    const apiUrl = process.env.SCHEMA_INFERRER_API_URL
        || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

    if (!apiKey) return null;

    const isGemini = apiUrl.includes('generativelanguage.googleapis.com');

    return {
        modelId: isGemini ? 'gemini-2.0-flash' : 'openai-compatible',
        async complete(systemPrompt: string, userPrompt: string): Promise<string> {
            if (isGemini) {
                const controller1 = new AbortController();
                const timeout1 = setTimeout(() => controller1.abort(), LLM_TIMEOUT_MS);
                const res = await fetch(`${apiUrl}?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller1.signal,
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemPrompt }] },
                        contents: [{ parts: [{ text: userPrompt }] }],
                        generationConfig: {
                            temperature: 0,
                            responseMimeType: 'application/json',
                            maxOutputTokens: 1024,
                        },
                    }),
                });
                clearTimeout(timeout1);
                if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);
                const json = await res.json() as any;
                return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            }

            // OpenAI-compatible fallback
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), LLM_TIMEOUT_MS);
            const res = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                signal: controller2.signal,
                body: JSON.stringify({
                    model: process.env.SCHEMA_INFERRER_MODEL || 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0,
                    max_tokens: 1024,
                    response_format: { type: 'json_object' },
                }),
            });
            clearTimeout(timeout2);
            if (!res.ok) throw new Error(`LLM API error: ${res.status} ${await res.text()}`);
            const json = await res.json() as any;
            return json.choices?.[0]?.message?.content ?? '';
        },
    };
}

// ── Main Entry Point ──────────────────────────────────────────

/**
 * Attempts to infer the schema mapping for unknown agent trace data.
 *
 * @param records - Raw parsed records (from parseFileContent)
 * @param provider - LLM provider (pass null to use default)
 * @returns InferResult with mapped records, or null if inference failed/unavailable
 */
export async function inferSchemaAndMap(
    records: Record<string, unknown>[],
    provider?: LLMProvider | null,
): Promise<{ result: InferResult | null; error: string | null }> {
    const llm = provider ?? createDefaultLLMProvider();
    if (!llm) {
        return { result: null, error: 'No LLM API key configured for schema inference (set SCHEMA_INFERRER_API_KEY)' };
    }

    if (records.length === 0) {
        return { result: null, error: 'No records to infer' };
    }

    // 0. Check cache first — avoid redundant LLM calls for same schema shape.
    //    On hit, re-insert to move the entry to the tail (true LRU behaviour).
    const fingerprint = computeSchemaFingerprint(records);
    const cachedMapping = mappingCache.get(fingerprint);
    if (cachedMapping) {
        // Re-insert promotes entry to tail so it won't be the next eviction victim.
        mappingCache.delete(fingerprint);
        mappingCache.set(fingerprint, cachedMapping);
        const mappedRecords = applyMapping(records, cachedMapping);
        return {
            result: {
                mapping: cachedMapping,
                mappedRecords,
                sampleCount: 0,
                llmModel: 'cache',
            },
            error: null,
        };
    }

    // 1–6: Coalesce concurrent requests for the same fingerprint onto a
    //      single LLM call. If another request is already in-flight for
    //      this fingerprint, wait on its promise — zero extra API calls.
    const existing = inflightCalls.get(fingerprint);
    if (existing) {
        // Re-apply the mapping to THIS request's records once the
        // shared call resolves (the in-flight result carries the mapping,
        // not the caller's specific rows).
        const shared = await existing;
        if (shared.result) {
            return {
                result: {
                    mapping: shared.result.mapping,
                    mappedRecords: applyMapping(records, shared.result.mapping),
                    sampleCount: 0,
                    llmModel: 'inflight-dedup',
                },
                error: null,
            };
        }
        return shared; // propagate the error from the original call
    }

    const inferencePromise = (async () => {
        // 1. Sample records (limit JSON size to avoid token bloat)
        const sampleCount = Math.min(SAMPLE_SIZE, records.length);
        let samples = records.slice(0, sampleCount);

        // Truncate if samples are too large
        let samplesJson = JSON.stringify(samples, null, 2);
        if (samplesJson.length > MAX_SAMPLE_JSON_LENGTH) {
            samples = records.slice(0, 3);
            samplesJson = JSON.stringify(samples, null, 2);
            if (samplesJson.length > MAX_SAMPLE_JSON_LENGTH) {
                samples = samples.map((r) => {
                    const truncated: Record<string, unknown> = {};
                    let charCount = 0;
                    for (const [k, v] of Object.entries(r)) {
                        const valStr = JSON.stringify(v);
                        charCount += k.length + valStr.length;
                        if (charCount > 1500) break;
                        truncated[k] = v;
                    }
                    return truncated;
                });
            }
        }

        // 2. Call LLM
        const userPrompt = buildUserPrompt(samples);
        let llmResponse: string;
        try {
            llmResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);
        } catch (err) {
            return { result: null, error: `LLM call failed: ${(err as Error).message}` };
        }

        // 3. Parse LLM response
        let parsedResponse: unknown;
        try {
            const cleaned = llmResponse
                .replace(/^```(?:json)?\s*/i, '')
                .replace(/\s*```\s*$/i, '')
                .trim();
            parsedResponse = JSON.parse(cleaned);
        } catch {
            return { result: null, error: `LLM returned invalid JSON: ${llmResponse.slice(0, 200)}` };
        }

        // 4. Validate mapping structure
        const { mapping, error: validationError } = validateMapping(parsedResponse);
        if (!mapping) {
            return { result: null, error: `Invalid mapping: ${validationError}` };
        }

        // 5. Spot-check against real data
        const spotCheck = spotCheckMapping(mapping, records.slice(0, sampleCount));
        if (!spotCheck.valid) {
            return { result: null, error: `Mapping spot-check failed: ${spotCheck.error}` };
        }

        // 6. Populate LRU cache for future requests.
        if (mappingCache.size >= MAX_CACHE_SIZE) {
            const lruKey = mappingCache.keys().next().value;
            if (lruKey) mappingCache.delete(lruKey);
        }
        mappingCache.set(fingerprint, mapping);

        // 7. Apply mapping to THIS request's records (deterministic, no LLM)
        const mappedRecords = applyMapping(records, mapping);
        return {
            result: { mapping, mappedRecords, sampleCount, llmModel: llm.modelId },
            error: null,
        };
    })().finally(() => {
        // Remove from in-flight map once settled so the next cold-start
        // goes through the LRU cache path (not another in-flight wait).
        inflightCalls.delete(fingerprint);
    });

    inflightCalls.set(fingerprint, inferencePromise);
    return inferencePromise;
}

// ── Quick Check: Does standard parsing already work? ──────────

/**
 * Checks if standard field extraction already works on the records.
 * If action_name and success can be found without LLM help, returns true.
 * Used to short-circuit the LLM call when it's not needed.
 */
export function standardFieldsPresent(records: Record<string, unknown>[]): boolean {
    const ACTION_FIELDS = ['action_name', 'action', 'action_taken', 'handler', 'function_name'];
    const SUCCESS_FIELDS = ['success', 'result', 'outcome', 'status', 'passed', 'succeeded'];

    const testRecords = records.slice(0, 3);
    let actionHits = 0;
    let successHits = 0;

    for (const rec of testRecords) {
        for (const field of ACTION_FIELDS) {
            const val = rec[field] ?? rec[field.toUpperCase()] ?? rec[field.toLowerCase()];
            if (val !== undefined && val !== null && String(val).trim().length > 0) {
                actionHits++;
                break;
            }
        }
        for (const field of SUCCESS_FIELDS) {
            const val = rec[field] ?? rec[field.toUpperCase()] ?? rec[field.toLowerCase()];
            if (val !== undefined && val !== null) {
                successHits++;
                break;
            }
        }
    }

    return actionHits >= 2 && successHits >= 2;
}
