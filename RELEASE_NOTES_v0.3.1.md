## What's fixed

### Python SDK (`layerinfinite-sdk==0.3.1`)
- **`run()` now sends `outcome_score`** — actions registered with `score=` and executed via `li.run()` in `auto` mode now correctly compute and send `outcome_score`. Previously always omitted.
- **Async function guard** — `@li.action(score=...)` on an `async def` no longer silently passes a coroutine object to the score function. Score is skipped with a `logger.debug` warning. Full async support planned for v0.4.0.
- **`ActionEntry` stores `score_fn`** — internal registry now carries the score callback so `run()` can access it.

### TypeScript SDK (`@layerinfinite/sdk@0.3.1`)
- **`ActionOptions<TReturn>` type** — exported from index. Pass `{ score: (result) => number }` as last arg to `li.action()`.
- **4-arg overload** — `li.action(task, name, fn, options?)` and `li.action(task, fn, options?)` both supported.
- **`outcome_score` in payload** — only sent when callback returns a finite number in `[0.0, 1.0]`. Never sent as null.

> No breaking changes. Drop-in upgrade from 0.3.0.

## Install

```bash
pip install layerinfinite-sdk==0.3.1
npm install @layerinfinite/sdk@0.3.1
```

## Verified
- ✅ Python: 7 tests passed
- ✅ TypeScript: 5 tests passed
- ✅ PyPI publish: success
- ✅ npm publish: success
- ✅ Fresh install smoke tests: OK
