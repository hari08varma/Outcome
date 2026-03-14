// @ts-nocheck — Deno runtime (not Node.js)
// ==============================================================
// LAYER5 — Edge Function: cold-start-bootstrap
// ==============================================================
// Triggered when a new agent is registered.
//
// 4-Stage Cold Start Protocol:
//   Stage 1: Inject synthetic priors from dim_institutional_knowledge
//   Stage 2: Cap confidence multiplier at 0.3 (handled by policy-engine)
//   Stage 3: Return all available actions (force exploration, handled by policy-engine)
//   Stage 4: Cross-agent transfer — if same-type agent exists with 10+ outcomes,
//            pull their patterns as priors for the new agent
//
// Synthetic priors have is_synthetic = TRUE.
// The mv_action_scores view filters WHERE is_synthetic = FALSE,
// so priors NEVER inflate real scores.
//
// Invocation:
//   POST /functions/v1/cold-start-bootstrap
//   Body: { "agent_id": "<uuid>", "customer_id": "<uuid>" }
//
// Deploy: supabase functions deploy cold-start-bootstrap
// ==============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LAYER5_INTERNAL_SECRET = Deno.env.get('LAYER5_INTERNAL_SECRET');

// How many synthetic priors to inject per action-context pair
const SYNTHETIC_PRIOR_COUNT = 5;

// Minimum outcomes required for cross-agent transfer donor
const MIN_DONOR_OUTCOMES = 10;

interface TransferEvent {
    source: 'cross_agent' | 'institutional_knowledge';
    donor_agent_id: string | null;
    priors_inserted: number;
    context_types: string[];
}

Deno.serve(async (req: Request): Promise<Response> => {
    const startTime = Date.now();

    // ── Auth check ─────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!LAYER5_INTERNAL_SECRET || authHeader !== `Bearer ${LAYER5_INTERNAL_SECRET}`) {
        return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // ── Parse request body ─────────────────────────────────────
    let body: { agent_id: string; customer_id: string };
    try {
        body = await req.json();
        if (!body.agent_id || !body.customer_id) {
            throw new Error('Missing agent_id or customer_id');
        }
    } catch (err) {
        return new Response(
            JSON.stringify({ error: 'Invalid request body', details: String(err) }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });

    const { agent_id: agentId, customer_id: customerId } = body;

    // ── Fetch the new agent's metadata ─────────────────────────
    const { data: agent, error: agentErr } = await supabase
        .from('dim_agents')
        .select('agent_type, customer_id')
        .eq('agent_id', agentId)
        .single();

    if (agentErr || !agent) {
        return new Response(
            JSON.stringify({ error: 'Agent not found', details: agentErr?.message }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const agentType = agent.agent_type;
    const transferEvents: TransferEvent[] = [];
    let totalPriorsInserted = 0;

    // ── Stage 4: Cross-agent transfer ──────────────────────────
    // Find same-type agents from the same customer with enough history
    const { data: donorAgents } = await supabase
        .from('dim_agents')
        .select('agent_id')
        .eq('agent_type', agentType)
        .eq('customer_id', customerId)
        .neq('agent_id', agentId)  // exclude the new agent itself
        .eq('is_active', true);

    let crossAgentTransferred = false;

    if (donorAgents && donorAgents.length > 0) {
        for (const donor of donorAgents) {
            // Check if this donor has enough real outcomes
            const { count } = await supabase
                .from('fact_outcomes')
                .select('outcome_id', { count: 'exact', head: true })
                .eq('agent_id', donor.agent_id)
                .eq('is_synthetic', false);

            if (count !== null && count >= MIN_DONOR_OUTCOMES) {
                // Found a valid donor — pull their outcome patterns
                // Get distinct context_ids the donor has operated in
                const { data: donorContexts } = await supabase
                    .from('fact_outcomes')
                    .select('context_id')
                    .eq('agent_id', donor.agent_id)
                    .eq('is_synthetic', false);

                const contextIdSet = new Set<string>();
                for (const r of (donorContexts ?? [])) {
                    contextIdSet.add(String((r as any).context_id));
                }
                const uniqueContextIds = Array.from(contextIdSet);

                // For each context, look up institutional knowledge patterns
                const contextTypes: string[] = [];
                for (const ctxId of uniqueContextIds) {
                    // Resolve context_id → issue_type
                    const { data: ctx } = await supabase
                        .from('dim_contexts')
                        .select('issue_type')
                        .eq('context_id', ctxId)
                        .single();

                    if (!ctx) continue;
                    contextTypes.push(ctx.issue_type);

                    // Pull institutional knowledge for this context type
                    const { data: patterns } = await supabase
                        .from('dim_institutional_knowledge')
                        .select('action_id, avg_success_rate, sample_count')
                        .eq('context_type', ctx.issue_type);

                    if (!patterns || patterns.length === 0) continue;

                    // Insert synthetic priors for the new agent
                    for (const pattern of patterns) {
                        const syntheticRows = generateSyntheticPriors(
                            agentId,
                            pattern.action_id,
                            ctxId,
                            customerId,
                            pattern.avg_success_rate,
                            SYNTHETIC_PRIOR_COUNT
                        );

                        const { error: insertErr } = await supabase
                            .from('fact_outcomes')
                            .insert(syntheticRows);

                        if (!insertErr) {
                            totalPriorsInserted += syntheticRows.length;
                        } else {
                            console.error(`[cold-start] Insert failed for action ${pattern.action_id}:`, insertErr.message);
                        }
                    }
                }

                transferEvents.push({
                    source: 'cross_agent',
                    donor_agent_id: donor.agent_id,
                    priors_inserted: totalPriorsInserted,
                    context_types: contextTypes,
                });

                crossAgentTransferred = true;
                break;  // Use the first valid donor
            }
        }
    }

    // ── Stage 1: Institutional knowledge fallback ──────────────
    // If no cross-agent transfer was possible, use global averages
    if (!crossAgentTransferred) {
        // Get the customer's industry for better matching
        const { data: customer } = await supabase
            .from('dim_customers')
            .select('industry')
            .eq('customer_id', customerId)
            .single();

        const industry = customer?.industry ?? null;

        // Fetch all institutional knowledge (filtered by industry if available)
        let knowledgeQuery = supabase
            .from('dim_institutional_knowledge')
            .select('action_id, context_type, avg_success_rate, sample_count');

        if (industry) {
            knowledgeQuery = knowledgeQuery.eq('industry', industry);
        }

        const { data: knowledge } = await knowledgeQuery;

        if (knowledge && knowledge.length > 0) {
            // Group by context_type and resolve to context_ids
            const contextTypeMap = new Map<string, string>();

            for (const k of knowledge) {
                if (!contextTypeMap.has(k.context_type)) {
                    // Try to find existing context
                    const { data: ctx } = await supabase
                        .from('dim_contexts')
                        .select('context_id')
                        .eq('issue_type', k.context_type)
                        .limit(1)
                        .maybeSingle();

                    if (ctx) {
                        contextTypeMap.set(k.context_type, ctx.context_id);
                    }
                }
            }

            const contextTypes: string[] = [];
            for (const k of knowledge) {
                const contextId = contextTypeMap.get(k.context_type);
                if (!contextId) continue;

                contextTypes.push(k.context_type);

                const syntheticRows = generateSyntheticPriors(
                    agentId,
                    k.action_id,
                    contextId,
                    customerId,
                    k.avg_success_rate,
                    SYNTHETIC_PRIOR_COUNT
                );

                const { error: insertErr } = await supabase
                    .from('fact_outcomes')
                    .insert(syntheticRows);

                if (!insertErr) {
                    totalPriorsInserted += syntheticRows.length;
                } else {
                    console.error(`[cold-start] Global insert failed for action ${k.action_id}:`, insertErr.message);
                }
            }

            transferEvents.push({
                source: 'institutional_knowledge',
                donor_agent_id: null,
                priors_inserted: totalPriorsInserted,
                context_types: [...new Set(contextTypes)],
            });
        }
    }

    // ── Log transfer event to trust audit ──────────────────────
    if (totalPriorsInserted > 0) {
        await supabase.from('agent_trust_audit').insert({
            agent_id: agentId,
            customer_id: customerId,
            event_type: 'created',
            old_score: null,
            new_score: 0.7,
            old_status: null,
            new_status: 'trusted',
            performed_by: 'cold-start-bootstrap',
            reason: `Cold start: inserted ${totalPriorsInserted} synthetic priors via ${crossAgentTransferred ? 'cross-agent transfer' : 'institutional knowledge'
                }`,
        });
    }

    // ── Response ────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const response = {
        completed: true,
        agent_id: agentId,
        agent_type: agentType,
        duration_ms: totalDuration,
        total_priors_inserted: totalPriorsInserted,
        transfer_events: transferEvents,
        strategy: crossAgentTransferred ? 'cross_agent_transfer' : 'institutional_knowledge_fallback',
        timestamp: new Date().toISOString(),
    };

    console.log('[cold-start-bootstrap] Result:', JSON.stringify(response));

    return new Response(
        JSON.stringify(response),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }
    );
});

// ── Helper: generate synthetic prior outcome rows ──────────────
// Creates N fake outcome rows based on the avg_success_rate.
// All rows have is_synthetic = TRUE and a deterministic session_id.
function generateSyntheticPriors(
    agentId: string,
    actionId: string,
    contextId: string,
    customerId: string,
    avgSuccessRate: number,
    count: number
): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    const syntheticSessionId = crypto.randomUUID();

    for (let i = 0; i < count; i++) {
        // Deterministic success based on avg rate:
        // First floor(rate * count) rows succeed, rest fail
        const success = i < Math.round(avgSuccessRate * count);

        rows.push({
            agent_id: agentId,
            action_id: actionId,
            context_id: contextId,
            customer_id: customerId,
            session_id: syntheticSessionId,
            success,
            is_synthetic: true,
            is_deleted: false,
            salience_score: 0.0,  // zero salience → won't survive pruning
            raw_context: { source: 'cold-start-bootstrap', prior_rate: avgSuccessRate },
        });
    }

    return rows;
}
