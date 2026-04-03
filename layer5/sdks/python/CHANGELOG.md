# Changelog — Layerinfinite Python SDK

All notable changes to the Python SDK are documented here.

## [0.3.2] — 2026-04-03

### Fixed
- `_log_outcome()` posts `response_ms` (backend-compatible alias) to `/v1/log-outcome`, avoiding 5xx retries caused by legacy `latency_ms` payloads

### Changed
- SDK package/version metadata bumped to `0.3.2`

## [0.3.1] — 2026-04-02

### Fixed
- score callback in @li.action() now correctly skips async functions (inspect.iscoroutine guard) instead of passing a coroutine object to the score function
- li.run() now reads entry.score_fn from ActionEntry and calls it after successful execution, so outcome_score is sent in auto mode (previously omitted)
- ActionEntry dataclass now stores score_fn: Callable | None

### No breaking changes. Fully backward compatible.

## [0.3.0] — 2026-03-31

### Breaking Changes
- `LayerinfiniteClient` is now an alias for `Layerinfinite` (new primary class)
- `LayerinfiniteClient()` now requires `agent_id` parameter
- `get_recommendations(task)` replaced by `recommend(task)` -> returns `Recommendation` dataclass (not dict)
- Removed: `instrument.py`, `pipeline/`, `tracing/` modules

### Added
- `Layerinfinite` class with three modes: `recommend`, `assist`, `auto`
- `@li.action(task)` decorator — auto-logs every outcome, zero boilerplate
- `li.run(task, **kwargs)` — autonomous action execution (auto mode)
- `li.suggest(task)` -> `Suggestion` — best action without executing (assist mode)
- `li.recommend(task)` -> `Recommendation` — plain-English insights (all modes)
- `li.scores(task)` -> `GetScoresResponse` — raw scores (all modes)
- `li.observe(task)` -> `ObservationSummary` — outcome stats (all modes)
- `li.register_action(task, name, fn)` — manual registration
- `li.list_actions(task=None)` — registry introspection
- `LowConfidenceError` exception with `suggestion`, `confidence`, `threshold`
- `auto_fallback` — automatic next-action fallback in auto mode
- `log_async` — non-blocking outcome logging via daemon threads
- `auto_register` — automatic action registration in dashboard
- Thread-safe action registry
- Context manager support (`with Layerinfinite(...) as li:`)
- `py.typed` marker for PEP 561 compliance

### Fixed
- `context_id` in `LogOutcomeRequest` is now optional (default: "")

## CI/CD Setup
Add these secrets to GitHub → Settings → Secrets → Actions:
- PYPI_API_TOKEN — from pypi.org → Account → API tokens
- NPM_TOKEN      — from npmjs.com → Access Tokens (Automation)
- SMOKE_TEST_API_KEY — a real layerinfinite_ API key from 
  https://outcome-green.vercel.app/settings/api-keys

Without SMOKE_TEST_API_KEY, smoke tests are skipped (not failed).

## [0.2.1] — 2026-03-29
### Fixed
- Published `get_recommendations(task)` method that was present in source but missing from PyPI release 0.2.0
- Added Python 3.13 and 3.14 classifier support

---

## [0.2.0] - 2026-03-25
### Added
- instrument(client) — one-line setup, patches httpx + requests
- TracedResponse — auto-captures outcomes with signal_confidence scoring
- tracing/ — causal_graph, execution_context, interceptor, traced_response
- pipeline/ — outcome_pipeline with background daemon thread
### Changed
- log_outcome() now fires automatically inside TracedResponse.__aexit__()
  (manual usage still fully supported — no breaking changes)
- User-Agent updated to layerinfinite-python-sdk/0.2.0
### Migration
No breaking changes. All v0.1.x code works without modification.

---

## [0.1.6] - 2026-03-17

### Fixed
- **Bug 1**: Corrected default `base_url` from placeholder `https://your-app.railway.app` to the real production endpoint `https://outcome-production.up.railway.app`
- **Bug 2**: Fixed `health()` endpoint path from `/v1/health` to `/health` (no `/v1` prefix — matches actual API routing)
- **Bug 4**: Added API key format validation in `__init__`: keys must start with `layerinfinite_`; raises `ValueError` with a link to the dashboard on invalid format
- **Bug 5**: Pinned `httpx>=0.27.0,<0.28.0` in both runtime and dev dependencies to fix `pytest-httpx>=0.30` version conflict

### Changed
- Updated `User-Agent` header from `layerinfinite-python-sdk/0.1.0` to `layerinfinite-python-sdk/0.1.6`

---

## [0.1.5] - 2026-03-10

### Added
- Initial public release
- `LayerinfiniteClient` with `get_scores()`, `log_outcome()`, and `health()` methods
- Exponential backoff retry logic with 429 + 5xx handling
- Typed exceptions: `LayerinfiniteAuthError`, `LayerinfiniteRateLimitError`, `LayerinfiniteServerError`, `LayerinfiniteNotFoundError`
- Pydantic v2 response models
- Python 3.9–3.12 support
