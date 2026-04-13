/**
 * Layerinfinite — lib/context-embed.ts
 * ══════════════════════════════════════════════════════════════
 * Context embedding: generate vectors + cosine similarity.
 *
 * Provider switching via EMBEDDING_PROVIDER env var:
 *   'supabase' (default) → Supabase AI gte-small
 *   'openai'             → text-embedding-3-small
 *
 * FALLBACK RULE: If embedding generation fails for ANY reason,
 * return null — scoring treats null context_match as 1.0
 * (exact match assumed). Never throw, never 500.
 * ══════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? 'supabase';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const EXPECTED_CONTEXT_VECTOR_DIMENSION = Number(
    process.env.CONTEXT_VECTOR_DIMENSION ?? '384',
);
// SIMILARITY_THRESHOLD: cosine similarity floor for context matching.
// Below this value, findClosestContext returns null ->
// scoring treats as exact match (1.0 penalty applied).
//
// Calibration (gte-small model, 384-dim):
//   > 0.85 -> near-identical phrasing
//   0.70-0.85 -> strongly related contexts
//   0.60-0.70 -> moderately related (current threshold - permissive)
//   < 0.60 -> loosely related or unrelated
//
// At 0.6, false positives (wrong context matched) are more likely than
// at 0.75. Increase to 0.75 if context mismatches appear in scoring logs.
const SIMILARITY_THRESHOLD = 0.6;

// Versioning: stamp every stored vector with its origin model + version
const CURRENT_EMBEDDING_MODEL = EMBEDDING_PROVIDER === 'openai'
    ? 'text-embedding-3-small'
    : 'gte-small';
const CURRENT_EMBEDDING_VERSION = process.env.EMBEDDING_VERSION ?? '2024-01-01';
const CURRENT_EMBEDDING_SCHEMA_VERSION = 2;
const CONTEXT_EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RAW_CONTEXT_EMBED_FIELDS = 20;
const MAX_RAW_CONTEXT_EMBED_CHARS = 512;

const contextEmbeddingReadyUntil = new Map<string, number>();
const contextEmbeddingInFlight = new Map<string, Promise<boolean>>();

// ── Generate embedding ───────────────────────────────────────
/**
 * Generates a provider vector from context text.
 * contextText = "payment_failed enterprise production"
 * Returns null on failure (never throws).
 */
export async function generateEmbedding(contextText: string): Promise<number[] | null> {
    try {
        const embedding = EMBEDDING_PROVIDER === 'openai'
            ? await generateOpenAIEmbedding(contextText)
            : await generateSupabaseEmbedding(contextText);

        if (!embedding) return null;

        if (embedding.length !== EXPECTED_CONTEXT_VECTOR_DIMENSION) {
            console.warn(
                `[context-embed] Embedding dimension mismatch: got=${embedding.length}, ` +
                `expected=${EXPECTED_CONTEXT_VECTOR_DIMENSION}. Dropping vector.`
            );
            return null;
        }

        return embedding;
    } catch (err: any) {
        console.warn(`[context-embed] Embedding unavailable — using exact match fallback. Error: ${err.message}`);
        return null;
    }
}

async function generateSupabaseEmbedding(text: string): Promise<number[] | null> {
    try {
        // Use Supabase AI inference endpoint (gte-small model, free, no API key needed)
        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !serviceKey) {
            console.warn('[context-embed] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
            return null;
        }

        // 5s timeout: Supabase AI endpoint cold-starts can hang for 30s+.
        // On abort, falls through to embed_text SQL RPC fallback below.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        let response: Response;
        try {
            response = await fetch(`${supabaseUrl}/functions/v1/embedding`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${serviceKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ input: text, model: 'gte-small' }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            // Fallback: try Supabase's built-in SQL embedding via pg function
            const { data, error } = await supabase.rpc('embed_text', { input_text: text });
            if (error || !data) {
                console.warn('[context-embed] Supabase embedding fallback failed:', error?.message ?? 'no data');
                return null;
            }
            return data as number[];
        }

        const json = await response.json() as any;
        if (json?.embedding) return json.embedding as number[];
        if (json?.data?.[0]?.embedding) return json.data[0].embedding as number[];

        console.warn('[context-embed] Supabase embedding: unexpected response format');
        return null;
    } catch (err: any) {
        console.warn('[context-embed] Supabase embedding error:', err.message);
        return null;
    }
}

async function generateOpenAIEmbedding(text: string): Promise<number[] | null> {
    if (!OPENAI_API_KEY) {
        console.warn('[context-embed] OPENAI_API_KEY not set — using exact match fallback');
        return null;
    }

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                input: text,
                model: 'text-embedding-3-small',
            }),
        });

        if (!response.ok) {
            console.warn(`[context-embed] OpenAI API error: ${response.status}`);
            return null;
        }

        const json = await response.json() as any;
        return json?.data?.[0]?.embedding ?? null;
    } catch (err: any) {
        console.warn('[context-embed] OpenAI embedding error:', err.message);
        return null;
    }
}

// ── Embedding metadata helpers ───────────────────────────────
/**
 * Returns metadata fields to stamp alongside a stored vector.
 * Call at write time whenever inserting/upserting a context_vector.
 */
export function embeddingVersionMeta(vector: number[], sourceText: string) {
    return {
        source_text: sourceText,
        source_text_hash: createHash('sha256').update(sourceText).digest('hex'),
        embedding_model: CURRENT_EMBEDDING_MODEL,
        embedding_version: CURRENT_EMBEDDING_VERSION,
        embedding_dimension: vector.length,
        embedding_schema_version: CURRENT_EMBEDDING_SCHEMA_VERSION,
    };
}

// ── Cosine similarity ────────────────────────────────────────
/**
 * Standard cosine similarity: dot(a,b) / (|a| × |b|)
 * Returns 0.0 to 1.0. Pure function — no async, no DB.
 * Throws explicitly on dimension mismatch (not a silent wrong answer).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(
            `[context-embed] Dimension mismatch in cosineSimilarity: a.length=${a.length}, b.length=${b.length}. ` +
            'Vectors from different embedding models cannot be compared.'
        );
    }
    if (a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return Math.max(0, Math.min(1, dotProduct / magnitude));
}

// ── Find closest context ─────────────────────────────────────
/**
 * Finds the context with the highest cosine similarity to the
 * given embedding. Returns { context_id, similarity } if above
 * threshold (0.6), else null.
 */
export async function findClosestContext(
    embedding: number[],
    customerId: string,
    options: { environment?: string | null } = {}
): Promise<{ context_id: string; similarity: number } | null> {
    if (embedding.length !== EXPECTED_CONTEXT_VECTOR_DIMENSION && process.env.NODE_ENV !== 'test') {
        console.warn(
            `[context-embed] findClosestContext skipped due to dimension mismatch: ` +
            `query=${embedding.length}, expected=${EXPECTED_CONTEXT_VECTOR_DIMENSION}`
        );
        return null;
    }

    const environmentFilter = typeof options.environment === 'string'
        ? options.environment.trim().toLowerCase()
        : '';

    try {
        const { data, error } = await supabase.rpc('match_context_vector', {
            query_vector: embedding,
            p_customer_id: customerId,
            p_model: CURRENT_EMBEDDING_MODEL,
            p_threshold: SIMILARITY_THRESHOLD,
            p_limit: 1,
            p_schema_version: CURRENT_EMBEDDING_SCHEMA_VERSION,
        });

        if (error) {
            // RPC not available — fall back to TypeScript scan scoped to customer
            console.warn(
                '[context-embed] match_context_vector RPC unavailable, ' +
                'falling back to in-memory scan:',
                error.message
            );
            return await findClosestContextFallback(
                embedding,
                customerId,
                environmentFilter || undefined
            );
        }

        if (!data || data.length === 0) return null;

        const best = data[0] as { context_id: string; similarity: number };

        if (environmentFilter) {
            const { data: matchedContext, error: contextError } = await supabase
                .from('dim_contexts')
                .select('environment')
                .eq('customer_id', customerId)
                .eq('context_id', best.context_id)
                .maybeSingle();

            if (contextError || !matchedContext) {
                return await findClosestContextFallback(embedding, customerId, environmentFilter);
            }

            const matchedEnvironment = String((matchedContext as any).environment ?? '').trim().toLowerCase();
            if (matchedEnvironment !== environmentFilter) {
                return await findClosestContextFallback(embedding, customerId, environmentFilter);
            }
        }

        return best.similarity >= SIMILARITY_THRESHOLD ? best : null;
    } catch (err: any) {
        console.warn('[context-embed] findClosestContext error:', err.message);
        return null;
    }
}

// FALLBACK: used when match_context_vector RPC is unavailable.
// Customer-scoped but O(n/customers) — acceptable for dev/small datasets.
// In production with pgvector RPC deployed, this path should not be hit.
async function findClosestContextFallback(
    embedding: number[],
    customerId: string,
    environment?: string
): Promise<{ context_id: string; similarity: number } | null> {
    let query = supabase
        .from('dim_contexts')
        .select('context_id, context_vector, embedding_model, source_text, embedding_schema_version')
        .eq('customer_id', customerId)
        .eq('embedding_schema_version', CURRENT_EMBEDDING_SCHEMA_VERSION)
        .not('context_vector', 'is', null);

    if (environment) {
        query = query.eq('environment', environment);
    }

    const { data, error } = await query;

    if (error || !data || data.length === 0) {
        return null;
    }

    let bestMatch: { context_id: string; similarity: number } | null = null;

    for (const row of data) {
        if (row.context_vector === null || row.context_vector === undefined) continue;

        // Skip vectors from incompatible embedding models to avoid meaningless scores.
        // Null embedding_model means legacy row (pre-migration 056) — allow through conservatively.
        if (row.embedding_model && row.embedding_model !== CURRENT_EMBEDDING_MODEL) {
            console.warn(
                `[context-embed] Skipping context ${row.context_id}: model mismatch ` +
                `(stored=${row.embedding_model}, current=${CURRENT_EMBEDDING_MODEL}). ` +
                'Run batch re-embedding to migrate.'
            );
            continue;
        }

        const storedVec = typeof row.context_vector === 'string'
            ? parseVector(row.context_vector)
            : (row.context_vector as number[]);

        if (!storedVec) {
            console.warn(`[context-embed] Skipping context ${row.context_id}: failed to parse stored vector string.`);
            continue;
        }
        if (storedVec.length === 0) continue;

        // Dimension safety check before computing similarity
        if (storedVec.length !== embedding.length) {
            console.warn(
                `[context-embed] Skipping context ${row.context_id}: dimension mismatch ` +
                `(stored=${storedVec.length}, query=${embedding.length})`
            );
            continue;
        }

        const sim = cosineSimilarity(embedding, storedVec);

        if (sim > SIMILARITY_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
            bestMatch = { context_id: row.context_id, similarity: sim };
        }
    }

    return bestMatch;
}

/**
 * Parse pgvector string format "[0.1,0.2,0.3]" → number[]
 */
function parseVector(v: string): number[] | null {
    try {
        const clean = v.replace(/[\[\]]/g, '').trim();
        if (!clean) return null;
        const parsed = clean.split(',').map(Number);
        if (parsed.some(isNaN)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function flattenRawContextForEmbedding(rawContext?: Record<string, unknown>): string {
    if (!rawContext || typeof rawContext !== 'object') return '';

    const parts: string[] = [];
    const entries = Object.entries(rawContext)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, MAX_RAW_CONTEXT_EMBED_FIELDS);

    for (const [key, value] of entries) {
        if (value === null || value === undefined) continue;

        let normalized = '';
        if (typeof value === 'string') {
            normalized = value.trim();
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            normalized = String(value);
        } else {
            try {
                normalized = JSON.stringify(value);
            } catch {
                normalized = '';
            }
        }

        if (!normalized) continue;
        parts.push(`${key}:${normalized}`);
    }

    return parts.join(' ').slice(0, MAX_RAW_CONTEXT_EMBED_CHARS);
}

/**
 * Build context text from components for embedding.
 */
export function buildContextText(
    issueType: string,
    customerTier?: string,
    environment?: string,
    rawContext?: Record<string, unknown>
): string {
    const rawContextText = flattenRawContextForEmbedding(rawContext);
    return [issueType, customerTier, environment, rawContextText]
        .filter(Boolean)
        .join(' ')
        .trim();
}

/**
 * Ensures a context row has a vector + embedding metadata.
 * Safe to call on every ingestion path; fast-path exits when vector already exists.
 */
export async function ensureContextEmbedding(params: {
    contextId: string;
    customerId: string;
    issueType: string;
    customerTier?: string | null;
    environment?: string | null;
    rawContext?: Record<string, unknown> | null;
}): Promise<boolean> {
    const readyUntil = contextEmbeddingReadyUntil.get(params.contextId);
    if (readyUntil && readyUntil > Date.now()) {
        return true;
    }

    const existingInFlight = contextEmbeddingInFlight.get(params.contextId);
    if (existingInFlight) {
        return existingInFlight;
    }

    const task = (async () => {
        const { data: existing, error: existingError } = await supabase
            .from('dim_contexts')
            .select('context_vector, issue_type, customer_tier, environment')
            .eq('context_id', params.contextId)
            .eq('customer_id', params.customerId)
            .maybeSingle();

        if (existingError || !existing) {
            if (existingError) {
                console.warn('[context-embed] ensureContextEmbedding lookup failed:', existingError.message);
            }
            return false;
        }

        if ((existing as any).context_vector) {
            contextEmbeddingReadyUntil.set(
                params.contextId,
                Date.now() + CONTEXT_EMBEDDING_CACHE_TTL_MS,
            );
            return true;
        }

        const sourceText = buildContextText(
            params.issueType || String((existing as any).issue_type ?? ''),
            params.customerTier ?? String((existing as any).customer_tier ?? ''),
            params.environment ?? String((existing as any).environment ?? ''),
            params.rawContext ?? undefined,
        );

        if (!sourceText) {
            return false;
        }

        const embedding = await generateEmbedding(sourceText);
        if (!embedding) {
            return false;
        }

        const metadata = embeddingVersionMeta(embedding, sourceText);
        const { error: updateError } = await supabase
            .from('dim_contexts')
            .update({
                context_vector: embedding,
                ...metadata,
            })
            .eq('context_id', params.contextId)
            .eq('customer_id', params.customerId)
            .is('context_vector', null);

        if (updateError) {
            console.warn('[context-embed] ensureContextEmbedding update failed:', updateError.message);
            return false;
        }

        contextEmbeddingReadyUntil.set(
            params.contextId,
            Date.now() + CONTEXT_EMBEDDING_CACHE_TTL_MS,
        );
        return true;
    })();

    contextEmbeddingInFlight.set(params.contextId, task);

    try {
        return await task;
    } finally {
        contextEmbeddingInFlight.delete(params.contextId);
    }
}
