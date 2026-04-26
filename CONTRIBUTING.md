# Contributing to LayerInfinite

Thank you for contributing. LayerInfinite's open-source SDKs are the interface between the developer community and the platform — quality here matters more than anywhere else.

This document covers everything you need to make a meaningful contribution: environment setup, testing, commit conventions, the PR process, and how releases are cut.

---

## Table of Contents

- [What Is and Is Not Open Source](#what-is-and-is-not-open-source)
- [Repository Layout](#repository-layout)
- [Development Setup](#development-setup)
  - [Python SDK](#python-sdk-setup)
  - [TypeScript SDK](#typescript-sdk-setup)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Commit Conventions](#commit-conventions)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Release Process](#release-process)
- [Reporting Issues](#reporting-issues)
- [Security Vulnerabilities](#security-vulnerabilities)
- [Code of Conduct](#code-of-conduct)

---

## What Is and Is Not Open Source

| Component | Status | Location |
|-----------|--------|----------|
| Python SDK | ✅ Open Source (MIT) | `layer5/sdks/python/` |
| TypeScript SDK | ✅ Open Source (MIT) | `layer5/sdks/typescript/` |
| Hosted API (`layerinfinite.me`) | ❌ Proprietary | Managed service |
| Dashboard (`layerinfinite.app`) | ❌ Proprietary | Managed service |
| Import pipeline | ❌ Proprietary | Managed service |

Pull requests, bug reports, and feature requests for the SDKs are fully welcome. Issues about the hosted platform or Dashboard are best directed to `team@layerinfinite.app`.

---

## Repository Layout

```
layer5/sdks/
├── python/
│   ├── layerinfinite/      # SDK source
│   │   ├── client.py       # Core client, decorators, routing logic
│   │   ├── models.py       # Pydantic request/response models
│   │   └── exceptions.py   # Typed exception hierarchy
│   ├── tests/
│   │   └── test_client.py  # Full test suite (pytest + respx)
│   ├── pyproject.toml
│   └── Makefile
│
└── typescript/
    ├── src/
    │   ├── client.ts        # Core client
    │   ├── types.ts         # TypeScript interfaces
    │   └── index.ts         # Public exports
    ├── tests/               # Vitest test suite
    ├── package.json
    └── tsconfig.json
```

---

## Development Setup

### Python SDK Setup

**Requirements:** Python 3.9+

```bash
# 1. Clone and navigate
git clone https://github.com/harinathpathipaka-commits/Layerinfinite-AI.git
cd Layerinfinite-AI/layer5/sdks/python

# 2. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate        # macOS / Linux
# .venv\Scripts\activate         # Windows (PowerShell)

# 3. Install the SDK in editable mode with all dev dependencies
pip install -e ".[dev]"

# 4. Verify your setup
python -m pytest tests/ -q
```

Your environment is ready when all tests pass with no errors.

**Environment variables for local testing against a real API:**

```bash
export LAYERINFINITE_API_KEY="li_test_..."
export LAYERINFINITE_BASE_URL="https://layerinfinite.me"
```

Without these, the test suite uses mocked HTTP via `respx` and does not require a real API connection.

---

### TypeScript SDK Setup

**Requirements:** Node.js 18+

```bash
# 1. Navigate to the TypeScript SDK
cd layer5/sdks/typescript

# 2. Install dependencies (exact lockfile)
npm ci

# 3. Run the full test suite
npm test

# 4. Type check
npm run typecheck

# 5. Build the distribution
npm run build
```

Your environment is ready when `npm test` and `npm run typecheck` both exit cleanly.

---

## Making Changes

### Branch Naming

Create your branch from `master` using one of these prefixes:

| Prefix | Use for |
|--------|---------|
| `fix/` | Bug fixes |
| `feat/` | New features or methods |
| `docs/` | Documentation-only changes |
| `refactor/` | Internal refactors with no behaviour change |
| `test/` | Adding or improving tests |
| `chore/` | Dependency bumps, CI changes |

**Example:**
```bash
git checkout -b fix/auto-fallback-timeout-handling
```

### What Counts as a Good Change

- **Bug fixes** must include a failing test that reproduces the bug, then passes after the fix.
- **New public methods or parameters** must include tests covering the happy path, the error path, and edge cases.
- **Behaviour changes** must update the relevant section of the SDK's `README.md` located inside the SDK directory.
- **Internal refactors** must not change any public API signatures.

---

## Testing

### Python

```bash
# Run the full suite
python -m pytest tests/ -v

# Run a single test file
python -m pytest tests/test_client.py -v

# Run tests matching a keyword
python -m pytest tests/ -k "test_auto_mode" -v

# Check coverage
python -m pytest tests/ --cov=layerinfinite --cov-report=term-missing
```

The test suite uses `respx` to mock all HTTP calls. No real API key is required.

### TypeScript

```bash
# Run the full suite
npm test

# Run in watch mode during development
npx vitest

# Run with coverage
npx vitest run --coverage
```

---

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must match this format:

```
<type>(<scope>): <short description>

[optional body]
[optional footer]
```

**Types:** `fix`, `feat`, `docs`, `refactor`, `test`, `chore`, `perf`

**Scope** (optional but encouraged): `python-sdk`, `ts-sdk`, `ci`, `docs`

**Examples:**

```
fix(python-sdk): handle ConnectionError during async outcome flush
feat(ts-sdk): add min_observations_per_action support to auto mode
docs: add exploration floor example to README
test(python-sdk): add coverage for LowConfidenceError fallback chain
chore(ci): bump pytest-httpx to 0.31
```

> **Breaking changes** must include `BREAKING CHANGE:` in the commit footer and increment the minor version.

---

## Submitting a Pull Request

1. **Fork** the public repository: `github.com/harinathpathipaka-commits/Layerinfinite-AI`
2. **Create your branch** from `master` following the naming convention above.
3. **Make your changes** with tests.
4. **Verify everything passes locally:**
   ```bash
   # Python
   python -m pytest tests/ -q

   # TypeScript
   npm test && npm run typecheck
   ```
5. **Open the PR** against `master` with:
   - A clear title following the commit convention format
   - A description explaining *what* changed and *why*
   - A reference to any related issue (e.g. `Closes #42`)

### PR Checklist

- [ ] Tests pass locally
- [ ] New behaviour is covered by tests
- [ ] Public API changes are reflected in the SDK's `README.md`
- [ ] No hardcoded API keys, URLs, or credentials
- [ ] Commit messages follow the convention

PRs that fail CI (tests or typecheck) will not be reviewed until they are green.

---

## Release Process

> **Note:** Only maintainers cut releases. This section is for transparency.

Releases are **fully automated via GitHub Actions** and triggered by pushing a semver-matching Git tag. There is no manual build or upload step.

### Python SDK

```bash
# 1. Update version in layer5/sdks/python/pyproject.toml
# 2. Commit the version bump
git commit -m "chore(python-sdk): bump version to X.Y.Z"

# 3. Push the tag — this triggers the publish workflow
git tag sdk-python-vX.Y.Z
git push origin sdk-python-vX.Y.Z
```

The workflow (`publish-python-sdk.yml`) will:
1. Verify the tag version matches `pyproject.toml`
2. Run the full test suite
3. Build the `sdist` and `wheel`
4. Publish to PyPI using the `PYPI_TOKEN` secret
5. Create a GitHub Release

### TypeScript SDK

```bash
# 1. Update version in layer5/sdks/typescript/package.json
# 2. Commit the version bump
git commit -m "chore(ts-sdk): bump version to X.Y.Z"

# 3. Push the tag — this triggers the publish workflow
git tag sdk-ts-vX.Y.Z
git push origin sdk-ts-vX.Y.Z
```

The workflow (`publish-npm-sdk.yml`) will:
1. Verify the tag version matches `package.json`
2. Run the full test suite and typecheck
3. Build the distribution
4. Publish to npm as `@layerinfinite/sdk` using the `NPM_TOKEN` secret
5. Create a GitHub Release

---

## Reporting Issues

| Issue type | Where to report |
|------------|-----------------|
| SDK bug | [GitHub Issues](https://github.com/harinathpathipaka-commits/Layerinfinite-AI/issues) with the `bug` label |
| Feature request | [GitHub Issues](https://github.com/harinathpathipaka-commits/Layerinfinite-AI/issues) with the `enhancement` label |
| Platform / Dashboard issue | Email `team@layerinfinite.app` |
| Documentation gap | [GitHub Issues](https://github.com/harinathpathipaka-commits/Layerinfinite-AI/issues) with the `docs` label |

**For bug reports, include:**
- SDK version (`pip show layerinfinite-sdk` or `npm list @layerinfinite/sdk`)
- Python version or Node.js version
- Minimal reproduction script
- Full error traceback or unexpected output
- Operating system

---

## Security Vulnerabilities

**Do not open a public GitHub Issue for security vulnerabilities.**

Email `team@layerinfinite.app` directly with:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional but appreciated)

We will acknowledge within 48 hours and aim to issue a patch within 7 days depending on severity.

---

## Code of Conduct

LayerInfinite is a professional open-source project. All interactions in issues, PRs, and discussions must be:

- **Respectful** — critique the code, not the person
- **Constructive** — if you identify a problem, propose a solution or ask a clarifying question
- **Inclusive** — welcome contributors of all experience levels

Interactions that are abusive, harassing, or discriminatory will result in removal from the project.

---

<div align="center">
  <p>
    <a href="README.md">← Back to README</a> ·
    <a href="ARCHITECTURE.md">Architecture</a> ·
    <a href="BENCHMARKS.md">Benchmarks</a>
  </p>
</div>
