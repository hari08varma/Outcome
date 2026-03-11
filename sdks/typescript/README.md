# @layer5/sdk

> Outcome-ranked decision intelligence SDK for TypeScript/JavaScript.
> Zero dependencies. Works in Node.js 18+, Deno, Bun, Cloudflare Workers, and browsers.

## Installation

```bash
npm install @layer5/sdk
```

## Quick Start

```ts
import { Layer5 } from '@layer5/sdk';

const l5 = new Layer5({ apiKey: 'layer5_...' });

// Get ranked actions BEFORE your agent acts
const scores = await l5.getScores({
  agentId: 'my-agent',
  context: { issue_type: 'payment_failed' },
});

const bestAction = scores.ranked_actions[0].action_name;

// Log what happened AFTER your agent acts
await l5.logOutcome({
  agentId: 'my-agent',
  actionName: bestAction,
  sessionId: 'sess-123',
  issueType: 'payment_failed',
  success: true,
  responseTimeMs: 241,
});
```

## Configuration

```ts
const l5 = new Layer5({
  apiKey: 'layer5_...', // or set LAYER5_API_KEY env var
  baseUrl: 'https://api.layer5.dev', // or LAYER5_BASE_URL
  timeout: 10000, // ms
  maxRetries: 3,
  agentId: 'default-agent', // default for all requests
});
```

## API Methods

### `getScores(options)`

Get ranked actions before your agent acts.

```ts
const result = await l5.getScores({
  agentId: 'my-agent', // optional if set on client
  context: { issue_type: 'billing_dispute' },
  topN: 5,
  refresh: false,
});

console.log(result.ranked_actions);
// [{ action_name: 'offer_refund', score: 0.92, ... }]
```

### `logOutcome(options)`

Log what happened after your agent took an action.

```ts
await l5.logOutcome({
  agentId: 'my-agent',
  actionName: 'offer_refund',
  sessionId: 'sess-abc',
  issueType: 'billing_dispute',
  success: true,
  responseTimeMs: 150,
  outcomeScore: 0.95,
  businessOutcome: 'resolved',
  feedbackSignal: 'immediate',
});
```

### `logOutcomeFeedback(options)`

Submit delayed feedback for a previously logged outcome.

```ts
await l5.logOutcomeFeedback({
  outcomeId: 'out-123',
  finalScore: 0.1,
  businessOutcome: 'failed',
  feedbackNotes: 'Customer called back — refund never processed',
});
```

## Integrations

### LangChain.js

```ts
import { Layer5LangChainHandler } from '@layer5/sdk/integrations/langchain';

const handler = new Layer5LangChainHandler({
  apiKey: 'layer5_...',
  agentId: 'my-langchain-agent',
});

// Use with any LangChain agent/tool
const agent = createAgent({ callbacks: [handler] });
```

### Vercel AI SDK

```ts
import { Layer5 } from '@layer5/sdk';
import { layer5WrapTools } from '@layer5/sdk/integrations/vercel-ai';

const l5 = new Layer5({ apiKey: 'layer5_...', agentId: 'vercel-bot' });

const result = await generateText({
  model: openai('gpt-4o'),
  tools: layer5WrapTools(l5, myTools),
});
```

### OpenAI Function Calling

```ts
import { Layer5 } from '@layer5/sdk';
import { layer5Wrap, layer5WrapAll } from '@layer5/sdk/integrations/openai';

const l5 = new Layer5({ apiKey: 'layer5_...', agentId: 'my-agent' });

// Wrap a single function
const trackedSearch = layer5Wrap(l5, 'search_kb', searchKnowledgeBase);

// Or wrap all handlers at once
const tracked = layer5WrapAll(l5, {
  search_kb: searchKnowledgeBase,
  escalate: escalateToHuman,
});
```

## Error Handling

All errors extend `Layer5Error` with actionable messages:

```ts
import {
  Layer5Error,
  Layer5AuthError,
  Layer5RateLimitError,
  Layer5ValidationError,
  Layer5NetworkError,
  Layer5TimeoutError,
  Layer5ServerError,
  Layer5UnknownActionError,
  Layer5AgentSuspendedError,
} from '@layer5/sdk';

try {
  await l5.getScores({ ... });
} catch (error) {
  if (error instanceof Layer5RateLimitError) {
    console.log(`Retry after ${error.retryAfter} seconds`);
  } else if (error instanceof Layer5AuthError) {
    console.log('Check your API key');
  }
}
```

## Environment Support

| Runtime | Version | Notes |
|---------|---------|-------|
| Node.js | 18+ | Native fetch |
| Deno | 1.0+ | Native fetch |
| Bun | 1.0+ | Native fetch |
| Cloudflare Workers | — | Native fetch |
| Browsers | Modern | Native fetch |

## License

MIT
