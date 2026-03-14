/**
 * Layerinfinite — lib/sequence-tracker.ts
 * ══════════════════════════════════════════════════════════════
 * Manages action_sequences records.
 * Called from log-outcome.ts to maintain sequence state.
 *
 * Three operations:
 *   1. upsertSequence  — create or append to a sequence
 *   2. closeSequence   — mark sequence as done when episode ends
 *   3. getSequenceForEpisode — retrieve current sequence
 * ══════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';

const RESOLUTION_THRESHOLD = 0.7;  // outcome >= this = resolved

/**
 * Create a new sequence record or append to existing one
 * for this episode.
 *
 * Called every time log-outcome is called with an episode_id.
 */
export async function upsertSequence(params: {
    episodeId:    string;
    agentId:      string;
    contextHash:  string;
    actionName:   string;
    responseMs?:  number;
}): Promise<{ sequenceId: string; isNew: boolean }> {
    // Check if sequence exists for this episode
    const { data: existing } = await supabase
        .from('action_sequences')
        .select('id, action_sequence, total_response_ms')
        .eq('episode_id', params.episodeId)
        .single();

    if (!existing) {
        // Create new sequence
        const { data, error } = await supabase
            .from('action_sequences')
            .insert({
                episode_id:        params.episodeId,
                agent_id:          params.agentId,
                context_hash:      params.contextHash,
                action_sequence:   [params.actionName],
                total_response_ms: params.responseMs ?? null,
            })
            .select('id')
            .single();

        if (error) throw new Error(
            `Failed to create action sequence: ${error.message}`
        );

        return { sequenceId: data.id, isNew: true };
    }

    // Append action to existing sequence
    const { error } = await supabase
        .from('action_sequences')
        .update({
            action_sequence:   [...existing.action_sequence, params.actionName],
            total_response_ms: (existing.total_response_ms ?? 0) +
                               (params.responseMs ?? 0),
        })
        .eq('id', existing.id);

    if (error) throw new Error(
        `Failed to update action sequence: ${error.message}`
    );

    return { sequenceId: existing.id, isNew: false };
}

/**
 * Close a sequence when an episode ends.
 * Sets final_outcome, resolved, and closed_at.
 *
 * Called when:
 *   - business_outcome is "resolved" or "failed"
 *   - outcome_score indicates definitive completion
 *   - feedback_signal is "immediate" with clear outcome
 */
export async function closeSequence(params: {
    episodeId:    string;
    finalOutcome: number;  // 0.0–1.0
}): Promise<void> {
    const { error } = await supabase
        .from('action_sequences')
        .update({
            final_outcome: params.finalOutcome,
            resolved:      params.finalOutcome >= RESOLUTION_THRESHOLD,
            closed_at:     new Date().toISOString(),
        })
        .eq('episode_id', params.episodeId)
        .is('closed_at', null);  // only close if not already closed

    if (error) {
        console.error(
            '[SequenceTracker] Failed to close sequence:',
            error.message,
            `episode_id=${params.episodeId}`
        );
        // Do not throw — sequence closure failure must not
        // affect the log-outcome response
    }
}

/**
 * Get the current action sequence for an episode.
 * Returns null if no sequence exists.
 */
export async function getSequenceForEpisode(
    episodeId: string
): Promise<string[] | null> {
    const { data } = await supabase
        .from('action_sequences')
        .select('action_sequence')
        .eq('episode_id', episodeId)
        .single();

    return data?.action_sequence ?? null;
}
