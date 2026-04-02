# Changelog — Layerinfinite TypeScript SDK

All notable changes to the TypeScript SDK are documented here.

## [0.3.1] — 2026-04-02

### Fixed
- ActionOptions<TReturn> type is exported from index.ts for score callback support
- li.action overloads support both li.action(task, name, fn, options?) and li.action(task, fn, options?)
- outcome_score is included in payload only when score callback returns a valid finite number in [0.0, 1.0]

### No breaking changes. Fully backward compatible.

## CI/CD Setup
Add these secrets to GitHub → Settings → Secrets → Actions:
- PYPI_API_TOKEN — from pypi.org → Account → API tokens
- NPM_TOKEN      — from npmjs.com → Access Tokens (Automation)
- SMOKE_TEST_API_KEY — a real layerinfinite_ API key from 
  https://outcome-green.vercel.app/settings/api-keys

Without SMOKE_TEST_API_KEY, smoke tests are skipped (not failed).

## [0.3.0] — 2026-04-01

### Breaking Changes
- `LayerinfiniteClient` is now an alias for `Layerinfinite` (new primary class)
- Constructor now requires `agentId` parameter
- `getRecommendations(task)` replaced by `recommend(task)` -> returns `Recommendation` (camelCase fields)
- `getScores()` replaced by `scores(task)` - no longer takes `agentId`/`issueType` params
- Removed exports: `instrument`, `InstrumentOptions`, `InstrumentResult`, `CausalGraph`,
  `TracedResponse`, `ContractClient`, all tracing types
- Removed source files: `instrument.ts`, `interceptor.ts`, `pipeline/`, `tracing/`, `contracts/`
- Default base URL changed from `outcome-production.up.railway.app` to `api.layerinfinite.app`

### Added
- `Layerinfinite` class with three modes: `recommend`, `assist`, `auto`
- `li.action(task, fn)` / `li.action(task, name, fn)` - wrapper pattern with auto-logging
- `li.run(task, ...args)` - autonomous execution with ranked fallback (auto mode)
- `li.suggest(task)` -> `Suggestion` - best action without executing (assist mode)
- `li.recommend(task)` -> `Recommendation` - plain-English insights (all modes)
- `li.scores(task)` -> `GetScoresResponse` - raw ranked scores (all modes)
- `li.observe(task)` -> `ObservationSummary` - outcome stats (all modes)
- `li.registerAction(task, name, fn)` - manual registration without wrapping
- `li.listActions(task?)` - registry introspection
- `LowConfidenceError` with `suggestion`, `confidence`, `threshold` fields
- `autoFallback` - automatic next-action fallback in auto mode
- `autoRegister` - automatic action registration in dashboard (no-op, future-ready)
- `confidenceThreshold` constructor option
- `agentId` constructor option
- `mode` constructor option
- Fire-and-forget outcome logging (non-blocking)
- Pretty-print console output for recommend(), suggest(), observe(), run()
- camelCase TypeScript API with snake_case wire protocol (conversion handled internally)

### Deprecated (will be removed in v0.5.0)
- `getScores(params)` -> use `scores(task)` instead
- `getRecommendations(task)` -> use `recommend(task)` instead

### Fixed
- User-Agent header updated to `layerinfinite-ts-sdk/0.3.0`
- `agent_id` no longer sent as query parameter in GET /v1/get-scores

## [0.2.0] - 2026-03-25
### Added
- instrument(client) — one-line setup, patches fetch + db + child process
- TracedResponse — auto-captures outcomes with signal_confidence scoring
- tracing/ — causal-graph, execution-context, traced-primitive, provenance
- pipeline/ — outcome-pipeline, outcome-deriver, pending-signal-writer
- contracts/ — ContractClient for signal contract registration
### Changed
- logOutcome() now fires automatically via OutcomePipeline
  (manual usage still fully supported — no breaking changes)
### Migration
No breaking changes. All v0.1.x code works without modification.

---

## [0.1.6] - 2026-03-17

### Fixed
- **Bug 1**: Corrected `DEFAULT_BASE_URL` from placeholder `https://your-app.railway.app` to the real production endpoint `https://outcome-production.up.railway.app`
- **Bug 2**: Fixed `health()` endpoint path from `/v1/health` to `/health` (no `/v1` prefix — matches actual API routing)
- **Bug 3**: `fetchWithRetry()` now actually calls `isRetryableStatus(response.status)` in the retry condition instead of hardcoding `response.status >= 500`. The parameter is now functional, making retry behaviour configurable per call site
- **Bug 4**: Added API key format validation in `constructor`: keys must start with `layerinfinite_`; throws `LayerinfiniteError` with a link to the dashboard on invalid format

---

## [0.1.5] - 2026-03-10

### Added
- Initial public release
- `LayerinfiniteClient` with `getScores()`, `logOutcome()`, and `health()` methods
- Fetch-based HTTP with timeout + exponential backoff retry
- Typed errors: `LayerinfiniteAuthError`, `LayerinfiniteRateLimitError`, `LayerinfiniteServerError`, `LayerinfiniteNotFoundError`
- Full TypeScript types with `.d.ts` outputs
- CJS + ESM dual build via tsup
- Node 18+ and modern browser support
