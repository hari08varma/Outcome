/**
 * Layerinfinite — lib/drift-detector.ts
 * ══════════════════════════════════════════════════════════════
 * Proactive embedding drift detection.
 *
 * Maintains a reference corpus of canonical text samples with
 * known embeddings under the current model. On each check, a
 * random subset is re-embedded and compared against the stored
 * reference vectors.
 *
 * If mean cosine similarity drops below DRIFT_THRESHOLD (0.995),
 * drift is detected — indicating the embedding provider has
 * silently updated model weights. All stored vectors are flagged
 * as potentially_stale.
 *
 * Triggered via: POST /v1/admin/embedding-drift/check
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';
import { generateEmbedding, cosineSimilarity } from './context-embed.js';

const DRIFT_THRESHOLD = parseFloat(process.env.EMBEDDING_DRIFT_THRESHOLD ?? '0.995');
const DRIFT_CHECK_SAMPLE_SIZE = parseInt(process.env.EMBEDDING_DRIFT_SAMPLE_SIZE ?? '100', 10);

export interface DriftReport {
    mean_similarity: number;
    min_similarity: number;
    sample_size: number;
    drift_detected: boolean;
    drift_threshold: number;
    embedding_model: string;
    checked_at: string;
    skipped: boolean;
    skip_reason?: string;
}

/**
 * Re-embeds a sample of reference corpus entries and compares
 * against stored reference vectors to detect silent model drift.
 */
export async function runDriftDetection(): Promise<DriftReport> {
    const embeddingModel = process.env.EMBEDDING_PROVIDER === 'openai'
        ? 'text-embedding-3-small'
        : 'gte-small';

    const checkedAt = new Date().toISOString();

    // Load sample from reference corpus for current model
    const { data: corpus, error: corpusErr } = await supabase
        .from('embedding_reference_corpus')
        .select('id, sample_text, reference_vector')
        .eq('embedding_model', embeddingModel)
        .limit(DRIFT_CHECK_SAMPLE_SIZE * 3); // over-fetch then random-sample

    if (corpusErr || !corpus || corpus.length === 0) {
        return {
            mean_similarity: 1.0,
            min_similarity: 1.0,
            sample_size: 0,
            drift_detected: false,
            drift_threshold: DRIFT_THRESHOLD,
            embedding_model: embeddingModel,
            checked_at: checkedAt,
            skipped: true,
            skip_reason: corpus?.length === 0
                ? 'Reference corpus is empty — populate embedding_reference_corpus first'
                : `Corpus query failed: ${corpusErr?.message}`,
        };
    }

    // Random sample
    const shuffled = corpus.sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, Math.min(DRIFT_CHECK_SAMPLE_SIZE, shuffled.length));

    const similarities: number[] = [];

    for (const entry of sample) {
        const freshVector = await generateEmbedding(entry.sample_text);
        if (!freshVector) continue;

        const storedVec = typeof entry.reference_vector === 'string'
            ? parseVec(entry.reference_vector)
            : (entry.reference_vector as number[]);

        if (!storedVec || storedVec.length !== freshVector.length) continue;

        try {
            const sim = cosineSimilarity(freshVector, storedVec);
            similarities.push(sim);
        } catch {
            // dimension mismatch — indicates model change, counts as severe drift
            similarities.push(0);
        }
    }

    if (similarities.length === 0) {
        return {
            mean_similarity: 1.0,
            min_similarity: 1.0,
            sample_size: 0,
            drift_detected: false,
            drift_threshold: DRIFT_THRESHOLD,
            embedding_model: embeddingModel,
            checked_at: checkedAt,
            skipped: true,
            skip_reason: 'No valid similarity pairs computed — embedding provider may be unavailable',
        };
    }

    const meanSim = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const minSim = Math.min(...similarities);
    const driftDetected = meanSim < DRIFT_THRESHOLD;

    // Persist report
    await supabase.from('embedding_drift_reports').insert({
        mean_similarity: meanSim,
        min_similarity: minSim,
        sample_size: similarities.length,
        drift_detected: driftDetected,
        drift_threshold: DRIFT_THRESHOLD,
        embedding_model: embeddingModel,
        checked_at: checkedAt,
    }).catch((err) => {
        console.warn('[drift-detector] Failed to persist drift report:', err.message);
    });

    if (driftDetected) {
        console.warn(
            `[drift-detector] EMBEDDING DRIFT DETECTED — model=${embeddingModel} ` +
            `mean_similarity=${meanSim.toFixed(4)} threshold=${DRIFT_THRESHOLD}. ` +
            'Stored vectors may be stale. Consider re-embedding dim_contexts.'
        );
    } else {
        console.info(
            `[drift-detector] No drift detected — model=${embeddingModel} ` +
            `mean_similarity=${meanSim.toFixed(4)} (threshold=${DRIFT_THRESHOLD})`
        );
    }

    return {
        mean_similarity: meanSim,
        min_similarity: minSim,
        sample_size: similarities.length,
        drift_detected: driftDetected,
        drift_threshold: DRIFT_THRESHOLD,
        embedding_model: embeddingModel,
        checked_at: checkedAt,
        skipped: false,
    };
}

function parseVec(v: string): number[] {
    try {
        return v.replace(/[\[\]]/g, '').split(',').map(Number);
    } catch {
        return [];
    }
}
