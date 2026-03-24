# Changelog — Layerinfinite Python SDK

All notable changes to the Python SDK are documented here.

## CI/CD Setup
Add these secrets to GitHub → Settings → Secrets → Actions:
- PYPI_API_TOKEN — from pypi.org → Account → API tokens
- NPM_TOKEN      — from npmjs.com → Access Tokens (Automation)
- SMOKE_TEST_API_KEY — a real layerinfinite_ API key from 
  https://outcome-green.vercel.app/settings/api-keys

Without SMOKE_TEST_API_KEY, smoke tests are skipped (not failed).

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
