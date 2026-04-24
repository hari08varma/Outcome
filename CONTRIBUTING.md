# Contributing to LayerInfinite

Thank you for your interest in contributing to LayerInfinite! We welcome pull requests, bug reports, and feature requests for the open-source SDKs.

## What's Open Source

The LayerInfinite SDKs are fully open source under the MIT license:
- **Python SDK** — [`layerinfinite-sdk` on PyPI](https://pypi.org/project/layerinfinite-sdk/)
- **TypeScript SDK** — [`layerinfinite-sdk` on npm](https://www.npmjs.com/package/layerinfinite-sdk)

The hosted platform (API, database, dashboard) is a managed service at [layerinfinite.app](https://layerinfinite.app).

## SDK Development Setup

### Python SDK
```bash
cd sdks/python
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -e .[dev]
pytest
```

### TypeScript SDK
```bash
cd sdks/typescript
npm install
npm test
```

## Submitting a Pull Request

1. **Fork the repository** and create your branch from `main`.
2. **Write tests** for any new functionality.
3. **Ensure tests pass** locally before submitting.
4. **Update documentation** if you are changing SDK signatures or public API surface.

## Reporting Issues

- **Bug reports**: Open a GitHub Issue with reproduction steps, SDK version, and Python/Node version.
- **Feature requests**: Open a GitHub Issue describing the use case and proposed API.
- **Security vulnerabilities**: Do **not** open a public issue. Email `team@layerinfinite.app` directly.

## Code of Conduct

Please ensure your interactions in the issue tracker and PRs are professional and respectful.
