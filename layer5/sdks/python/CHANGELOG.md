# Changelog — Layerinfinite Python SDK

All notable changes to the Python SDK are documented here.

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
