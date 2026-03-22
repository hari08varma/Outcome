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
        await updateAgentTrust(params.agentId, params.customerId, params.finalSuccess, params.actionName);
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

    // Trust atomicity is guaranteed by the update_trust_and_audit() RPC (migration 062),
    // which writes both the trust score UPDATE and audit INSERT in one DB transaction.
    // Surfacing trust failures as HTTP 500 to agents is counterproductive — a trust DB
    // issue should not block outcome logging entirely. Run all tasks via allSettled.
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
    upsertLiveTrustScore(params.agentId).catch((err) =>
        console.warn('[orchestrator] upsertLiveTrustScore failed:', (err as Error).message)
    );
}

// ── Live Trust Score Upsert (fire-and-forget, creates row for new agents) ──
async function upsertLiveTrustScore(
    agentId: string,
): Promise<void> {
    const { data: outcomes, error } = await supabase
        .from('fact_outcomes')
        .select('success')
        .eq('agent_id', agentId)
        .eq('is_synthetic', false)
        .eq('is_deleted', false)
        .order('timestamp', { ascending: false })
        .limit(100);

    if (error) {
        console.warn('[trust] upsertLiveTrustScore: failed to fetch outcomes:', error.message);
    }

    if (error || !outcomes || outcomes.length === 0) {
        // Ensure zero-outcome agents stay in 'new' state with no score.
        // Guards against any race condition or manual call writing a stale score.
        await supabase
            .from('agent_trust_scores')
            .update({ trust_status: 'new', trust_score: null })
            .eq('agent_id', agentId)
            .eq('total_decisions', 0);
        return;
    }

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

    // NOTE: No audit INSERT here. The update_trust_and_audit() RPC (called by
    // updateAgentTrust() for each outcome) already writes the canonical audit row.
    // Adding a second insert here would produce duplicate Trust History entries.
}

// ── Trust Snapshot (fire-and-forget) ──────────────────────────
async function snapshotTrust(
    agentId: string,
    trust: { trust_score: number; trust_status: string; consecutive_failures: number },
    reason: 'pre_failure' | 'pre_incident' | 'manual',
    incidentId?: string,
): Promise<void> {
    await supabase.from('agent_trust_snapshots').insert({
        agent_id: agentId,
        trust_score: trust.trust_score,
        trust_status: trust.trust_status,
        consecutive_failures: trust.consecutive_failures,
        snapshot_reason: reason,
        incident_id: incidentId ?? null,
    });
}

async function updateAgentTrust(
    agentId: string,
    customerId: string,
    success: boolean,
    actionName?: string,
): Promise<void> {
    const { data: trust } = await supabase
        .from('agent_trust_scores')
        .select('trust_id, trust_score, total_decisions, correct_decisions, consecutive_failures, trust_status')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (!trust) return;

    const currentScore            = typeof trust.trust_score          === 'number' ? trust.trust_score          : 0.7;
    const currentTotalDecisions   = typeof trust.total_decisions       === 'number' ? trust.total_decisions       : 0;
    const currentCorrectDecisions = typeof trust.correct_decisions     === 'number' ? trust.correct_decisions     : 0;
    const currentFailures         = typeof trust.consecutive_failures  === 'number' ? trust.consecutive_failures  : 0;
    const currentStatus           = typeof trust.trust_status          === 'string'  ? trust.trust_status          : 'trusted';

    // Always capture old values before any mutation.
    // These are written to every audit row so the dashboard can show
    // the score delta for each event in the Trust History timeline.
    const oldScore  = currentScore;
    const oldStatus = currentStatus;

    let newScore: number;
    let newFailures: number;
    let newCorrect = currentCorrectDecisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        newScore = Math.min(currentScore * 1.03, 1.0);
    } else {
        // ── Coordinated Failure Interlock ──────────────────────
        // Check if this failure is infrastructure-attributed before
        // applying decay. detect_coordinated_failures() looks for 3+
        // agents failing the same action within the last 5 minutes.
        let isInfrastructureFailure = false;
        if (actionName) {
            try {
                const { data: coordFailures, error: coordError } = await supabase.rpc('detect_coordinated_failures', {
                    window_minutes: 5,
                    min_agent_count: 3,
                });
                if (coordError) throw new Error(coordError.message);
                if (coordFailures && Array.isArray(coordFailures)) {
                    isInfrastructureFailure = coordFailures.some(
                        (row: { action_name: string }) => row.action_name === actionName
                    );
                }
            } catch (err) {
                // Coordination check failed — proceed with normal decay (fail safe)
                console.warn('[trust] Coordinated failure check failed:', (err as Error).message);
            }
        }

        if (isInfrastructureFailure) {
            snapshotTrust(agentId, trust, 'pre_incident', `coordinated:${actionName ?? 'unknown'}`).catch(() => {});

            const { error: auditError } = await supabase.from('agent_trust_audit').insert({
                agent_id: agentId,
                customer_id: customerId,
                event_type: 'failure_excluded_infrastructure',
                old_score: oldScore,
                new_score: oldScore,        // score unchanged — frozen
                old_status: oldStatus,
                new_status: oldStatus,      // status unchanged — frozen
                reason: `Failure excluded: coordinated infrastructure failure detected on action "${actionName}". Trust score frozen.`,
            });
            if (auditError) {
                throw new Error(`[trust] failed to write audit event: ${auditError.message}`);
            }
            console.info('[trust] Failure excluded — coordinated infrastructure event', { agentId, actionName });
            return; // No trust modification
        }

        // Normal agent-attributable failure: snapshot then decay
        snapshotTrust(agentId, trust, 'pre_failure').catch(() => {});
        newFailures = currentFailures + 1;
        newScore    = currentScore * Math.pow(0.9, newFailures);
    }

    let newStatus: string;
    let newSuspensionReason: string | null = null;

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

    // ── ML-CHECK-2.1-B FIX: atomic trust UPDATE + audit INSERT via RPC ──
    // Previously: two separate supabase calls. If the audit INSERT failed,
    // trust score was already updated with no audit record (INVARIANT 7 violation).
    // Now: both ops execute inside one PL/pgSQL transaction (migration 052).
    // Either both succeed or both are rolled back.
    //
    // Reason format is intentional — agent.tsx parseActionFromReason()
    // relies on exactly these two patterns to extract the action name:
    //   "Outcome success via SDK: {actionName}"
    //   "Outcome failure recorded: {actionName}"
    // Status-change events append a transition note that
    // parseStatusLabel() in agent.tsx picks up separately.

    const action  = actionName?.trim() || 'unknown_action';
    const statusChanged = oldStatus !== newStatus;

    const baseReason = success
        ? `Outcome success via SDK: ${action}`
        : `Outcome failure recorded: ${action}`;

    const reason = statusChanged
        ? `${baseReason} | Trust recalibrated: ${oldStatus} → ${newStatus}`
        : baseReason;

    const { error: rpcError } = await supabase.rpc('update_trust_and_audit', {
        p_agent_id:             agentId,
        p_customer_id:          customerId,
        p_trust_score:          newScore,
        p_total_decisions:      currentTotalDecisions + 1,
        p_correct_decisions:    newCorrect,
        p_consecutive_failures: newFailures,
        p_trust_status:         newStatus,
        p_suspension_reason:    newSuspensionReason,
        p_updated_at:           new Date().toISOString(),
        p_event_type:           success ? 'success' : 'failure',
        p_old_score:            oldScore,
        p_old_status:           oldStatus,
        p_new_status:           newStatus,
        p_performed_by:         'outcome-orchestrator',
        p_reason:               reason,
    });

    if (rpcError) {
        throw new Error(`[trust] atomic trust+audit update failed: ${rpcError.message}`);
    }
}

// ── FIX: detectContextDrift — scope by customer_id ────────────
// BEFORE: context lookup used only issue_type with no customer_id filter.
// This meant Customer A's contexts were matched against Customer B's
// outcomes, causing false "context drift" alerts across customers.
//
// AFTER: every query is scoped by customer_id. Each customer only
// sees their own contexts and their own outcomes.
async function detectContextDrift(
    sb: SupabaseClient,
    customerId: string,
    contextType: string,
    agentId: string,
): Promise<void> {
    const { data: existingContext } = await sb
        .from('dim_contexts')
        .select('context_id')
        .eq('customer_id', customerId)       // FIX: was missing — caused cross-customer matches
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