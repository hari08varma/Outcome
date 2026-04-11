import { supabase } from './supabase.js';
import { writeCounterfactuals } from './ips-engine.js';
import { upsertSequence, closeSequence } from './sequence-tracker.js';
import { backpropagateReward } from './reward-backprop.js';
import { invalidateCache } from './scoring.js';
import { predictDrift } from './predictive-drift.js';
import type { SupabaseClient } from '@supabase/supabase-js';

type TrustLifecycleStatus = 'trusted' | 'probation' | 'sandbox' | 'suspended' | 'new';
const PROTECTED_TRUST_STATUSES: readonly TrustLifecycleStatus[] = ['sandbox', 'suspended'];

function isProtectedTrustStatus(status: string | null | undefined): status is TrustLifecycleStatus {
    return typeof status === 'string' && PROTECTED_TRUST_STATUSES.includes(status as TrustLifecycleStatus);
}

function shouldPreserveProtectedStatus(
    currentStatus: string | null | undefined,
    nextStatus: string,
): boolean {
    // Suspended is sticky until explicit manual reinstatement.
    if (currentStatus === 'suspended') {
        return nextStatus !== 'suspended';
    }

    // Sandbox can escalate to suspended automatically, but cannot auto-upgrade
    // back into probation/trusted without an explicit operator action.
    if (currentStatus === 'sandbox') {
        return nextStatus === 'probation' || nextStatus === 'trusted' || nextStatus === 'new';
    }

    return false;
}

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
    errorCode?: string | null;
    decisionId?: string;
    decisionRecord?: any;
    signalConfidence?: number | null;
    /**
     * When true, the trust-update task is skipped entirely.
     * Set by the import route — imported historical rows must never
     * affect agent trust scores (trust only reflects live SDK signal).
     */
    skipTrust?: boolean;
}

// ── Orchestrator Main Entrypoint ──
export async function orchestrateOutcome(params: OrchestratorParams): Promise<void> {

    async function taskTrustUpdate() {
        // IMPORT GUARD: imported historical rows must never update agent trust.
        // Trust reflects live SDK signal only. skipTrust is set by the import route.
        if (params.skipTrust === true) return;
        await updateAgentTrust(params.agentId, params.customerId, params.finalSuccess,
            params.actionName, params.signalConfidence ?? null);
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
            business_outcome: params.businessOutcome ?? null,
            error_code: params.errorCode ?? null,
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
                customerId: params.customerId,
                contextHash: params.decisionRecord?.context_hash ?? `${params.contextId}:${params.issueType}`,
                actionName: params.actionName,
                responseMs: params.responseMs ?? undefined,
            });

            if (params.businessOutcome === 'resolved' || params.businessOutcome === 'failed') {
                const finalScore = params.finalOutcomeScore ?? (params.finalSuccess ? 1.0 : 0.0);
                await closeSequence({
                    episodeId: params.episodeId,
                    agentId: params.agentId,
                    customerId: params.customerId,
                    finalOutcome: finalScore,
                });

                await backpropagateReward({
                    episode_id: params.episodeId,
                    customer_id: params.customerId,
                    final_outcome: finalScore,
                    gamma: 0.85,
                });
            }
        }
    }

    async function taskLatencySpike(): Promise<void> {
        const { data: recentOutcomes } = await supabase
            .from('fact_outcomes')
            .select('response_time_ms')
            .eq('agent_id', params.agentId)
            .eq('action_id', params.actionId)
            .order('timestamp', { ascending: false })
            .limit(20);

        if (!recentOutcomes || recentOutcomes.length < 5) return;

        const current = recentOutcomes[0].response_time_ms;
        if (!current || current <= 0) return;

        const baselineValues = recentOutcomes
            .slice(1, 16)
            .map((r) => r.response_time_ms)
            .filter((v): v is number => typeof v === 'number' && v > 0)
            .sort((a, b) => a - b);

        if (baselineValues.length < 3) return;

        const mid = Math.floor(baselineValues.length / 2);
        const median = baselineValues[mid]!;

        // 3× multiplier + 1000ms absolute floor prevents false positives
        // (e.g. an action that normally takes 50ms spiking to 200ms is not worth alerting on)
        if (current <= median * 3 || current <= 1000) return;

        // Deduplicate: skip if a latency_spike alert already exists for
        // this (customer_id, action_id) in the last hour
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: existing } = await supabase
            .from('degradation_alert_events')
            .select('id')
            .eq('customer_id', params.customerId)
            .eq('action_id', params.actionId)
            .eq('alert_type', 'latency_spike')
            .gte('created_at', oneHourAgo)
            .limit(1);

        if (existing && existing.length > 0) return;

        await supabase.from('degradation_alert_events').insert({
            customer_id: params.customerId,
            agent_id: params.agentId,
            action_id: params.actionId,
            alert_type: 'latency_spike',
            severity: 'warning',
            message:
                `Latency spike detected on action "${params.actionName}". ` +
                `Current response time: ${current}ms vs median baseline: ${median}ms ` +
                `(${(current / median).toFixed(1)}× normal).`,
        });
    }

    async function taskCacheInvalidation() {
        // Invalidate only this customer/context score cache entry so the next
        // getScores() call reads fresh data instead of serving a stale 5-min TTL entry.
        invalidateCache(params.customerId, params.contextId);
    }

    async function taskPredictiveDrift(): Promise<void> {
        // Predictive drift only runs for live SDK outcomes, not imports.
        if (params.skipTrust === true) return;
        await predictDrift(
            params.actionId,
            params.customerId,
            params.agentId,
            params.actionName,
        );
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
        taskLatencySpike(),
        taskCacheInvalidation(),
        taskPredictiveDrift(),
    ]);

    const taskNames = [
        'trust-update',
        'context-drift',
        'silent-failure',
        'counterfactuals',
        'sequence',
        'latency-spike',
        'cache-invalidation',
        'predictive-drift',
    ];

    const criticalTaskFailures: string[] = [];

    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            const taskName = taskNames[index];
            const errorMessage = (result.reason as Error)?.message ?? String(result.reason);

            console.error(`[orchestrator:${taskName}] failed`, {
                error: errorMessage,
                outcomeId: params.outcomeId,
                agentId: params.agentId,
            });

            if (taskName === 'trust-update' || taskName === 'counterfactuals') {
                criticalTaskFailures.push(
                    `${taskName} failed for outcome_id=${params.outcomeId} agent_id=${params.agentId}: ${errorMessage}`
                );
            }
        }
    });

    if (criticalTaskFailures.length > 0) {
        void Promise.resolve(supabase.from('degradation_alert_events').insert({
            customer_id: params.customerId,
            agent_id: params.agentId,
            alert_type: 'orchestrator_failure',
            severity: 'critical',
            message: criticalTaskFailures.join(' | '),
        })).catch(() => { });
    }

    // Non-blocking: refresh trust cache row for dashboard reads.
    // Trust score/status authority is updateAgentTrust() via update_trust_and_audit RPC.
    // IMPORT GUARD: skip for imported rows — trust reflects SDK signal only.
    if (params.skipTrust !== true) {
        refreshLiveTrustCache(params.agentId).catch((err) =>
            console.warn('[orchestrator] refreshLiveTrustCache failed:', (err as Error).message)
        );
    }
}

// ── Live Trust Cache Refresh (fire-and-forget) ──
// Read-only for existing rows: never recomputes trust score/status.
// Bootstrap-only write: inserts a neutral row if the trigger-minted row is missing.
async function refreshLiveTrustCache(
    agentId: string,
): Promise<void> {
    const { data: trustRow, error } = await supabase
        .from('agent_trust_scores')
        .select('agent_id, trust_score, trust_status, total_decisions, consecutive_failures')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (error) {
        console.warn('[trust] refreshLiveTrustCache: failed to read agent_trust_scores:', error.message);
        return;
    }

    if (trustRow) {
        return;
    }

    const { error: bootstrapError } = await supabase
        .from('agent_trust_scores')
        .upsert({
            agent_id: agentId,
            trust_score: null,
            trust_status: 'new',
            consecutive_failures: 0,
            total_decisions: 0,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'agent_id' });

    if (bootstrapError) {
        console.warn(
            '[trust] refreshLiveTrustCache: failed to bootstrap missing trust row:',
            bootstrapError.message,
        );
    }
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

/**
 * Updates agent trust score using exponential smoothing.
 *
 * Formula:
 *   On success: new_score = min(score × 1.03, 1.0)
 *               consecutive_failures reset to 0
 *   On failure: new_score = score × (0.9 ^ consecutive_failures)
 *               consecutive_failures incremented
 *
 * Status thresholds:
 *   score >= 0.6                       → trusted
 *   score 0.3–0.6                      → probation
 *   score 0.1–0.3 OR failures >= 5     → sandbox
 *   score < 0.1  OR failures >= 10     → suspended
 *
 * Cold-start prior: 0.70 (set on first DB insert by account-setup trigger).
 * First real outcome moves score to ~0.721 (success) or ~0.567 (failure).
 *
 * Note: scoring.ts uses a separate Bayesian (Laplace) smoothing formula for
 * composite action scores (computeCompositeScore). These are independent calculations.
 * This function uses exponential smoothing only.
 */
async function updateAgentTrust(
    agentId: string,
    customerId: string,
    success: boolean,
    actionName?: string,
    signalConfidence?: number | null,
): Promise<void> {
    const { data: trust } = await supabase
        .from('agent_trust_scores')
        .select('trust_id, trust_score, total_decisions, correct_decisions, consecutive_failures, trust_status, suspension_reason')
        .eq('agent_id', agentId)
        .maybeSingle();

    if (!trust) {
        // The fn_init_agent_trust() trigger (migration 058) should
        // have created this row. If it's missing, throw so the
        // orchestrator's allSettled logs a [trust-update] error.
        // Do NOT silently return - a missing row is a data integrity issue.
        throw new Error(
            `[trust] No agent_trust_scores row for agent_id=${agentId}. ` +
            `Trigger fn_init_agent_trust may have failed at agent creation.`
        );
    }

    const currentScore = typeof trust.trust_score === 'number' ? trust.trust_score : 0.7;
    const currentTotalDecisions = typeof trust.total_decisions === 'number' ? trust.total_decisions : 0;
    const currentCorrectDecisions = typeof trust.correct_decisions === 'number' ? trust.correct_decisions : 0;
    const currentFailures = typeof trust.consecutive_failures === 'number' ? trust.consecutive_failures : 0;
    const currentStatus = typeof trust.trust_status === 'string' ? trust.trust_status : 'trusted';
    const currentSuspensionReason = typeof trust.suspension_reason === 'string' ? trust.suspension_reason : null;

    // Always capture old values before any mutation.
    // These are written to every audit row so the dashboard can show
    // the score delta for each event in the Trust History timeline.
    const oldScore = currentScore;
    const oldStatus = currentStatus;

    let newScore: number;
    let newFailures: number;
    let newCorrect = currentCorrectDecisions;

    if (success) {
        newFailures = 0;
        newCorrect += 1;
        // ── Phase 1: Signal confidence weighting ──────────────
        // High-confidence signals (e.g. Stripe webhooks, explicit SDK)
        // contribute the full 3% growth. Low-confidence signals (e.g.
        // LLM evaluation at 0.3) contribute proportionally less.
        // When signalConfidence is null/1.0 → 1 + 0.03*1.0 = 1.03 (unchanged).
        const confidence = signalConfidence ?? 1.0;
        newScore = Math.min(currentScore * (1 + 0.03 * confidence), 1.0);
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
            snapshotTrust(agentId, trust, 'pre_incident', `coordinated:${actionName ?? 'unknown'}`).catch(() => { });

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

            await supabase.from('degradation_alert_events').insert({
                customer_id: customerId,
                agent_id: agentId,
                alert_type: 'coordinated_failure',
                severity: 'critical',
                message:
                    `Coordinated infrastructure failure detected on action "${actionName}". ` +
                    `3+ agents failed this action within 5 minutes. ` +
                    `Trust score frozen for affected agents.`,
            });

            console.info('[trust] Failure excluded — coordinated infrastructure event', { agentId, actionName });
            return; // No trust modification
        }

        // Normal agent-attributable failure: snapshot then decay
        snapshotTrust(agentId, trust, 'pre_failure').catch(() => { });
        newFailures = currentFailures + 1;
        newScore = currentScore * Math.pow(0.9, newFailures);
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

    if (shouldPreserveProtectedStatus(currentStatus, newStatus)) {
        console.warn(
            '[trust] updateAgentTrust: preserving protected status to avoid flip-flop',
            { agentId, currentStatus, computedStatus: newStatus }
        );

        newStatus = currentStatus as TrustLifecycleStatus;
        if (newStatus === 'suspended') {
            newSuspensionReason = currentSuspensionReason ?? 'manual_reinstatement_required';
        } else if (newStatus === 'sandbox') {
            newSuspensionReason = currentSuspensionReason;
        }
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

    const action = actionName?.trim() || 'unknown_action';
    const statusChanged = oldStatus !== newStatus;

    const baseReason = success
        ? `Outcome success via SDK: ${action}`
        : `Outcome failure recorded: ${action}`;

    const reason = statusChanged
        ? `${baseReason} | Trust recalibrated: ${oldStatus} → ${newStatus}`
        : baseReason;

    const { error: rpcError } = await supabase.rpc('update_trust_and_audit', {
        p_agent_id: agentId,
        p_customer_id: customerId,
        p_trust_score: newScore,
        p_total_decisions: currentTotalDecisions + 1,
        p_correct_decisions: newCorrect,
        p_consecutive_failures: newFailures,
        p_trust_status: newStatus,
        p_suspension_reason: newSuspensionReason,
        p_updated_at: new Date().toISOString(),
        p_event_type: success ? 'success' : 'failure',
        p_old_score: oldScore,
        p_old_status: oldStatus,
        p_new_status: newStatus,
        p_performed_by: 'outcome-orchestrator',
        p_reason: reason,
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
        // TODO: Add (customer_id, alert_type, context_type) composite unique constraint
        // to degradation_alert_events once a context_type column is added (migration TBD).
        // Until then, message-based ilike dedup is the deduplication mechanism.
        .eq('customer_id', customerId)
        .eq('alert_type', 'context_drift')
        .gte('detected_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .ilike('message', `%"${contextType}"%`)
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
        business_outcome: string | null;
        error_code: string | null;
    }
): Promise<void> {
    const isSilentFailure =
        outcome.success === true && (
            // Explicit score signal: low score despite success flag
            (outcome.outcome_score !== null && outcome.outcome_score < 0.3) ||
            // Implicit signal: business outcome contradicts success flag
            (outcome.business_outcome === 'partial' || outcome.business_outcome === 'failed') ||
            // Implicit signal: error code present despite success=true
            (outcome.error_code != null && outcome.error_code.trim() !== '')
        );

    if (!isSilentFailure) return;

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentAlert } = await sb
        .from('degradation_alert_events')
        .select('alert_id')
        .eq('customer_id', outcome.customer_id)
        .eq('action_id', outcome.action_id)
        .eq('alert_type', 'degradation')
        .gte('detected_at', since24h)
        .limit(1);

    if (recentAlert && recentAlert.length > 0) return;

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