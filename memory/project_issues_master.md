---
name: project-issues-master
description: "Complete inventory of all issues found across the LayerInfinite codebase during full exploration (5 agents, 200+ files). Grouped by severity."
metadata: 
  node_type: memory
  type: project
  originSessionId: bad08b6b-9006-4a4b-acea-88f62b909625
---

# LayerInfinite — Master Issue Inventory

Compiled from 5-agent exhaustive codebase exploration (2026-05-20). Excludes SDKs (replaced by MCP server). Excludes missing .md files, no-code connectors, and benchmarks (deemed unimportant).

## CRITICAL (Security)

1. **Webhook auth bypass** — `webhook.ts` generic shared-secret path is optional; webhooks can be called unauthenticated.
   - **Why:** No enforcement that a verifier must be configured before accepting webhook payloads.
   - **How to apply:** Add mandatory auth check before any webhook processing.

2. **RLS `USING (TRUE)` on 3 dim tables** — `dim_contexts`, `dim_actions`, `dim_institutional_knowledge` in migration 006 have no row-level security.
   - **Why:** Any authenticated client can read all rows across tenants.
   - **How to apply:** Replace `USING (TRUE)` with proper `customer_id` scoping.

3. **`.env.local` committed with live secrets** — Contains Supabase anon key and Vercel OIDC JWT in plaintext.
   - **Why:** Secrets in git history are permanently exposed.
   - **How to apply:** Rotate all exposed keys immediately; add `.env.local` to `.gitignore`; use `git-filter-repo` to scrub history.

4. **Hardcoded credentials in source** — `layer5/e2e-verify.js` has hardcoded API key + customer UUID.
   - **Why:** Credentials in source leak via git, CI logs, editor screenshots.
   - **How to apply:** Move to environment variables; rotate the exposed key.

## HIGH

5. **verifier.ts downstream_webhook is silent no-op** — The webhook verifier source type is accepted but never actually calls any webhook.
   - **Why:** Outcomes relying on webhook verification get `verified_success=true` without actual verification.
   - **How to apply:** Either implement the webhook call or remove the source type to prevent false assurance.

6. **Rate limit fail-open on DB errors** — `rate-limit.ts` returns 200 when the DB is unreachable.
   - **Why:** A DB outage removes all rate limiting — attackers can flood the API.
   - **How to apply:** Fail closed (429 or 503) when the rate-limit RPC is unavailable.

7. **Pruning scheduler broken** — Cannot UPDATE `fact_outcomes` directly; the pruning mechanism is non-functional.
   - **Why:** Old outcome data accumulates indefinitely with no cleanup path.
   - **How to apply:** Fix the pruning RPC or implement a proper archival strategy.

8. **dim_actions global uniqueness constraint** — Action names must be globally unique rather than scoped per customer.
   - **Why:** Two customers cannot use the same action name; causes ingestion failures.
   - **How to apply:** Change uniqueness constraint to `(customer_id, action_name)`.

9. **CI doesn't run training or MCP tests** — `ci.yml` only runs API tests; training pipeline and MCP server tests are skipped.
   - **Why:** Broken ML or MCP changes silently merge.
   - **How to apply:** Add `layer5/training/tests/` and `packages/mcp-server/__tests__/` to CI matrix.

10. **Training pipeline lacks customer_id scoping** — `train_world_model.py` sequences fetch doesn't filter by customer.
    - **Why:** One customer's data can leak into another customer's trained model.
    - **How to apply:** Add `customer_id` filter to all training data queries.

11. **Pruning RPC `get_undelivered_alerts()` may not exist** — Referenced but never created in any migration.
    - **Why:** Notification dispatcher edge function will fail at runtime.
    - **How to apply:** Create the RPC or verify it exists under a different name.

## MEDIUM

12. **li-log idempotency broken** — `li-log.ts` generates a random UUID per call instead of deterministic idempotency key.
    - **Why:** Duplicate log calls create duplicate outcomes; no deduplication possible.
    - **How to apply:** Derive idempotency key from (agent_id, task_id, action_name, timestamp).

13. **rest-client 15s timeout too short for simulation** — MCP server's REST client hardcodes 15s; Tier 3 MCTS can take 8s alone.
    - **Why:** Simulate calls with Tier 3 + network latency can hit the timeout.
    - **How to apply:** Increase to 30s or make configurable per endpoint.

14. **Decision buffer data loss on crash** — `decision-writer.ts` flushes every 5s; unflushed decisions lost on process death.
    - **Why:** Up to 50 buffered decisions can vanish.
    - **How to apply:** Reduce flush interval to 1s or write-through on critical decisions.

15. **Cohort cycling state lost on restart** — Primary store is in-memory Map; SQL RPC is only a fallback.
    - **Why:** All cohort cycle state resets on server restart if RPC isn't deployed.
    - **How to apply:** Make SQL RPC the primary store, in-memory as cache only.

16. **No transaction wrapping across orchestration** — 8 side-effects in `outcome-orchestrator.ts` fire via `Promise.allSettled` independently.
    - **Why:** Partial failure leaves inconsistent state (e.g., trust updated but counterfactuals missing).
    - **How to apply:** Add compensating actions or use a saga pattern for rollback.

17. **Dual auth model confusion** — Dashboard uses Supabase JWT; API uses X-API-Key; no unified session.
    - **Why:** Users need two different auth mechanisms; switching contexts is error-prone.
    - **How to apply:** Document clearly; consider unified token exchange endpoint.

18. **Template-literal Tailwind classes won't resolve** — Dynamic class names like `bg-${color}-500` are not in Tailwind's static analysis.
    - **Why:** Those styles are silently missing in production builds.
    - **How to apply:** Use full class names or add them to Tailwind's `safelist`.

19. **config.toml seed path mismatch** — Points to `./seed.sql` but actual seed is at `./seed/cold_start_priors.sql`.
    - **Why:** Seed data won't load on fresh deployments.
    - **How to apply:** Fix the path in config.toml.

20. **task-intelligence.ts null-safety issue** — MCP server tool can pass null where string expected.
    - **Why:** Runtime TypeError in certain edge cases.
    - **How to apply:** Add null guard before string operations.

21. **Scoring cache lacks in-flight dedup** — `scoring.ts` cache (1000-entry LRU) doesn't deduplicate concurrent requests like other caches do.
    - **Why:** Cache stampede on cold start when many agents request scores simultaneously.
    - **How to apply:** Add in-flight promise map (pattern already exists in `context-embed.ts` and `schema-inferrer.ts`).

22. **layer5/db-update.js hardcoded SQL path** — Points to a fixed file path that may not exist in all environments.
    - **Why:** Deployment in different directory structures fails.
    - **How to apply:** Use path relative to `__dirname` or configurable env var.

## LOW

23. **smoke-test.js incomplete** — Only tests 2 endpoints, no timeout handling.
    - **Why:** Doesn't catch regressions in other 20+ endpoints.
    - **How to apply:** Expand to cover all critical paths; add timeout handling.

24. **Legacy layer4 dashboard components static/hardcoded** — ActionScores, Alerts, Episodes, Overview, TrustDashboard show mock data.
    - **Why:** Confusing to users who land on layer4 pages.
    - **How to apply:** Either wire up to real data or remove/redirect to layer5.

25. **Dashboard styling split** — Mix of inline styles and Tailwind classes across components.
    - **Why:** Inconsistent UX; maintenance burden.
    - **How to apply:** Standardize on Tailwind; remove inline styles.

## DOCUMENTATION DISCREPANCIES

26. **Scoring factors: doc says 5, code has 6** — Doc: W_SUCCESS/W_CONF/W_TREND/W_SALIENCE/W_RECENCY. Code adds W_LATENCY. Recency weight differs (doc 0.10, code 0.05).
27. **Policy branches: doc says 7 or 10, code has 11** — Architecture doc is inconsistent internally and with code.
28. **trust-updater edge function doesn't exist** — Referenced in docs but never created. Trust updating happens inline via RPC in `outcome-orchestrator.ts`.
29. **MIN_CONFIDENCE: doc says 0.30, code has 0.15** — Lowered in commit 5489555 to fix cold-start exit for 2+ outcomes.
30. **IPS_WEIGHT_CAP still 0.3** — Doc mentions this was to be raised but code never changed.
