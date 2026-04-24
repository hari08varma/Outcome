# Architecture Deep Dive

LayerInfinite is designed from the ground up for **durability**, **compliance**, and **sub-5ms decision latency**. It is fundamentally a deterministic, append-only system built on top of PostgreSQL, designed to sit synchronously in the hot-path of autonomous AI agents.

## Core Philosophy

1. **Deterministic over Probabilistic:** 
   LLMs are fundamentally non-deterministic. LayerInfinite brings determinism back to the execution layer. Actions are ranked by a deterministic mathematical formula (`success_count / total_count * recency_weight`), not by a vector similarity search or an LLM call.
2. **Auto-Instrumentation First:** 
   Developers should not have to write custom tracking telemetry. The SDK uses decorators (`@li.action`) to hook into execution contexts, automatically trapping `return` values and `Exceptions` to log outcomes.
3. **Immutability:** 
   No log is ever deleted or overwritten. All `fact_outcomes` are append-only. This is required for EU AI Act compliance and internal enterprise auditing.

## System Components

### 1. The SDK (Client)
The SDK runs alongside your agent (Python or JS/TS). It acts as an interceptor. 
- When an `@li.action` is invoked, the SDK records the `start_time`.
- When the function exits, the SDK immediately ships a `LogOutcomeRequest` to the backend asynchronously.
- The SDK utilizes **L1 Memory Caching** to ensure that rapid repeated requests for action routing do not hit the network.

### 2. The Ingestion Engine (Hono Edge API)
The ingestion API is designed for immense throughput.
- **Strict Validation:** Uses Zod (TS) to ensure bad data never hits the database.
- **Durable Queue:** High-volume logging requests are pushed to a `dim_pending_signal_registrations` queue, allowing the system to decouple immediate ingestion from heavy analytical inserts.

### 3. The Scoring Engine (Supabase / Postgres)
The heart of LayerInfinite is PostgreSQL.
Instead of querying raw logs on every request, LayerInfinite uses **Materialized Views** and **RPC Functions** to maintain a hot cache of probability scores. 
- `get_recommendations` executes a highly optimized SQL query that filters by `agent_id` and `issue_type`, returning ranked actions in under 5ms.
- Recency weighting ensures that if an API endpoint breaks today, the action's score decays instantly, routing the agent to a fallback action before it causes a major incident.

## Security & Privacy

**LayerInfinite does NOT store PII.**
When the SDK extracts context from a function call to log an outcome, it automatically scrubs parameter names matching common PII patterns (`email`, `password`, `ssn`, `api_key`). String values longer than 64 characters or values that look like bearer tokens are completely dropped.

We store *metadata* about the decision (success boolean, latency, error codes), never the sensitive payload.
