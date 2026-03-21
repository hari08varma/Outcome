import { supabase } from './supabase.js';
import { writeCounterfactuals } from './ips-engine.js';
import { upsertSequence, closeSequence } from './sequence-tracker.js';
import { backpropagateReward } from './reward-backprop.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Shared Types ──
export interface OrchestratorParams {
    agentId: string;
    customerId: string;
    outcomeId: string;
    actionId: string;
    actionName: string;
    contextId: string;
    issueType: string;
    finalSuccess: boolean;
    finalOutcomeScore: number | null;
    responseMs?: number | null;
    episodeId?: string;
    businessOutcome?: string;
    decisionId?: string;
    decisionRecord?: any;
}

// ── Orchestrator Main Entrypoint ──
export async function orchestrateOutcome(params: OrchestratorParams): Promise<void> {

    async function taskTrustUpdate() {
        await updateAgentTrust(params.agentId, params.customerId, params.finalSuccess);
    }

    async function taskContextDrift() {
        await detectContextDrift(supabase, params.customerId, params.issueType, params.agentId);
    }

    async function taskSilentFailure() {
        await detectSilentFailure(supabase, {
            outcome_id: params.outcomeId,
            customer_id: params.customerId,
            agent_id: params.agentId,
            action_id: params.actionId,
            action_name: params.actionName,
            success: params.finalSuccess,
            outcome_score: params.finalOutcomeScore,
        });
    }

    async function taskCounterfactuals() {
        if (params.decisionRecord?.ranked_actions) {
            const outcomeScore = params.finalOutcomeScore ?? (params.finalSuccess ? 1.0 : 0.0);
            await writeCounterfactuals({
                decisionId: params.decisionId!,
                realOutcomeId: params.outcomeId,
                realOutcomeScore: outcomeScore,
                chosenActionName: params.actionName,
                rankedActions: params.decisionRecord.ranked_actions,
                contextHash: params.decisionRecord.context_hash ?? '',
                episodePosition: params.decisionRecord.episode_position ?? 0,
            });
        }
    }

    async function taskSequence() {
        if (params.episodeId) {
            await upsertSequence({
                episodeId: params.episodeId,
                agentId: params.agentId,
                contextHash: params.decisionRecord?.context_hash ?? `${params.contextId}:${params.issueType}`,
                actionName: params.actionName,
                responseMs: params.responseMs ?? undefined,
            });

            if (params.businessOutcome === 'resolved' || params.businessOutcome === 'failed') {
                const finalScore = params.finalOutcomeScore ?? (params.finalSuccess ? 1.0 : 0.0);
                await closeSequence({
                    episodeId: params.episodeId,
                    finalOutcome: finalScore,
                });
                
                await backpropagateReward({
                    episode_id: params.episodeId,
                    final_outcome: finalScore,
                    gamma: 0.85,
                });
            }
        }
    }

    const results = await Promise.allSettled([
        taskTrustUpdate(),
        taskContextDrift(),
        taskSilentFailure(),
        taskCounterfactuals(),
        taskSequence(),
    ]);

    const taskNames = [
        'trust-update',
        'context-drift',
        'silent-failure',
        'counterfactuals',
        'sequence',
    ];

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            const taskName = taskNames[index];
            console.error(`[orchestrator:${taskName}] failed`, {
                error: (result.reason as Error)?.message,
                outcomeId: params.outcomeId,
                agentId: params.agentId,
            });
        }
    });

    // Non-blocking: upsert live trust score so dashboard health card
    // shows real data immediately (not 0 while waiting for backprop engine)
    upsertLiveTrustScore(params.agentId, params.customerId).catch((err) =>
        console.warn('[orchestrator] upsertLiveTrustScore failed:', (err as Error).message)
    );
}

// ── Live Trust Score Upsert (fire-and-forget, creates row for new agents) ──
async function upsertLiveTrustScore(
    agentId: string,
    customerId: string,
): Promise<void> {
    const { data: outcomes, error } = await supabase
        .from('fact_outcomes')
        .select('success')
        .eq('agent_id', agentId)
        .eq('is_synthetic', false)
        .eq('is_deleted', false)
        .order('timestamp', { ascending: false })
        .limit(100);

    if (error || !outcomes || outcomes.length === 0) return;

    const total = outcomes.length;
    const successes = outcomes.filter((o) => o.success).length;
    const rawScore = successes / total;

    const recent = outcomes.slice(0, 10);
    const recentSuccesses = recent.filter((o) => o.success).length;
    const recentWeight = recent.length > 0 ? recentSuccesses / recent.length : rawScore;
    const weightedScore = Math.round(((rawScore * 0.6) + (recentWeight * 0.4)) * 10000) / 10000;

    const consecutiveFailures = (() => {
        let count = 0;
        for (const o of outcomes) {
            if (!o.success) count++;
            else break;
        }
        return count;
    })();

    // Check >= 10 before >= 5 so 'suspended' is reachable
    const trustStatus =
        consecutiveFailures >= 10 ? 'suspended' :
        consecutiveFailures >= 5  ? 'degraded'  :
        weightedScore >= 0.7      ? 'trusted'   : 'probation';

    await supabase
        .from('agent_trust_scores')
        .upsert({
            agent_id: agentId,
            trust_score: weightedScore,
            trust_status: trustStatus,
            consecutive_failures: consecutiveFailures,
            total_decisions: total,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent_id' });
}

// ── Imported Helper Implementations ──
async function updateAgentTrust(agentId: string, customerId: string, success: boolean): Promise<void> {
    const { data: trust } = await supabase
        .from('agent_trust_scores')
        .select('trust_id, trust_score, total_decisions, correct_decisions, consecutive_failures, trust_status')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (!trust) return;

    const oldScore = trust.trust_score;
    const oldStatus = trust.trust_status;
    let newScore: number;
    let newFailures: number;
    let newCorrect = trust.correct_decisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        newScore = Math.min(trust.trust_score * 1.03, 1.0);
    } else {
        newFailures = trust.consecutive_failures + 1;
        newScore = trust.trust_score * Math.pow(0.9, newFailures);
    }

    let newStatus: string;
    let newSuspensionReason = null;

    if (newScore < 0.1 || newFailures >= 10) {
        newStatus = 'suspended';
        newSuspensionReason = newScore < 0.1 ? 'trust_score_critically_low' : 'consecutive_failures_exceeded';
    } else if (newScore < 0.3 || newFailures >= 5) {
        newStatus = 'sandbox';
        newSuspensionReason = newFailures >= 5 ? 'consecutive_failures_exceeded' : null;
    } else if (newScore < 0.6) {
        newStatus = 'probation';
    } else {
        newStatus = 'trusted';
    }

    await supabase
        .from('agent_trust_scores')
        .update({
            trust_score: newScore,
            total_decisions: trust.total_decisions + 1,
            correct_decisions: newCorrect,
            consecutive_failures: newFailures,
            trust_status: newStatus,
            suspension_reason: newSuspensionReason,
            updated_at: new Date().toISOString(),
        })
        .eq('agent_id', agentId);

    if (oldStatus !== newStatus) {
        await supabase.from('agent_trust_audit').insert({
            agent_id: agentId,
            customer_id: customerId,
            event_type: newStatus === 'suspended' ? 'suspended' : 'recalibrated',
            old_score: oldScore,
            new_score: newScore,
            old_status: oldStatus,
            new_status: newStatus,
            reason: newStatus === 'suspended' || newStatus === 'sandbox'
                ? `Trust recalibrated: ${oldStatus} → ${newStatus}. Score: ${newScore.toFixed(3)}, Failures: ${newFailures}`
                : `Trust recalibrated: ${oldStatus} → ${newStatus}`,
        });
    }
}

async function detectContextDrift(
    sb: SupabaseClient,
    customerId: string,
    contextType: string,
    agentId: string
): Promise<void> {
    const { data: existingContext } = await sb
        .from('dim_contexts')
        .select('context_id')
        .eq('issue_type', contextType)
        .limit(1)
        .maybeSingle();

    if (existingContext) {
        const { count } = await sb
            .from('fact_outcomes')
            .select('outcome_id', { count: 'exact', head: true })
            .eq('customer_id', customerId)
            .eq('context_id', existingContext.context_id);

        if ((count ?? 0) > 0) return;
    }

    const { data: recentAlert } = await sb
        .from('degradation_alert_events')
        .select('alert_id')
        .eq('customer_id', customerId)
        .eq('alert_type', 'context_drift')
        .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

    if (recentAlert && recentAlert.length > 0) return;

    await sb.from('degradation_alert_events').insert({
        customer_id: customerId,
        alert_type: 'context_drift',
        severity: 'warning',
        message: `New context type "${contextType}" encountered by agent ${agentId}. No prior outcomes for this customer. Cold-start protocol activated.`,
    });
}

async function detectSilentFailure(
    sb: SupabaseClient,
    outcome: {
        outcome_id: string;
        customer_id: string;
        agent_id: string;
        action_id: string;
        action_name: string;
        success: boolean;
        outcome_score: number | null;
    }
): Promise<void> {
    const isSilentFailure =
        outcome.success === true &&
        outcome.outcome_score !== null &&
        outcome.outcome_score < 0.3;

    if (!isSilentFailure) return;

    await sb.from('degradation_alert_events').insert({
        customer_id: outcome.customer_id,
        action_id: outcome.action_id,
        alert_type: 'degradation',
        severity: 'warning',
        current_value: outcome.outcome_score,
        baseline_value: 1.0,
        message: `Silent failure detected on "${outcome.action_name}": success=true but outcome_score=${outcome.outcome_score}. Technical success, business failure. Score will reflect true outcome.`,
    });
}
