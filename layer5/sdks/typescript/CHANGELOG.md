# Changelog — Layerinfinite TypeScript SDK

All notable changes to the TypeScript SDK are documented here.

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
