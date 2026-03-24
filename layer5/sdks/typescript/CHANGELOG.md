# Changelog — Layerinfinite TypeScript SDK

All notable changes to the TypeScript SDK are documented here.

## CI/CD Setup
Add these secrets to GitHub → Settings → Secrets → Actions:
- PYPI_API_TOKEN — from pypi.org → Account → API tokens
- NPM_TOKEN      — from npmjs.com → Access Tokens (Automation)
- SMOKE_TEST_API_KEY — a real layerinfinite_ API key from 
  https://outcome-green.vercel.app/settings/api-keys

Without SMOKE_TEST_API_KEY, smoke tests are skipped (not failed).

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
