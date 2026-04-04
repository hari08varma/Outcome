# Layerinfinite TypeScript SDK (`@layerinfinite/sdk`)

Layerinfinite is a decision intelligence middleware for AI agents — it records action outcomes, computes composite trust scores, and recommends the highest-performing next action so your agents learn from every decision. Drop it into any TypeScript or JavaScript project with zero runtime dependencies.

## Installation

```bash
npm install @layerinfinite/sdk
# or
yarn add @layerinfinite/sdk
# or
pnpm add @layerinfinite/sdk
```

## Quick Start

```typescript
import { LayerinfiniteClient } from '@layerinfinite/sdk';

const client = new LayerinfiniteClient({ apiKey: 'layerinfinite_your_key' });

// Ask Layerinfinite which action to take
const scores = await client.getScores({
  agentId: 'my-agent',
  issueType: 'billing_dispute',
});
console.log(scores.top_action?.action_name);  // e.g. "escalate_to_senior"
console.log(`Policy: ${scores.policy}`);      // exploit | explore | escalate

// Log the outcome after the action runs
await client.logOutcome({
  agent_id: 'my-agent',
  action_id: scores.top_action!.action_id,
  context_id: scores.context_id,
  issue_type: 'billing_dispute',
  success: true,
  outcome_score: 0.9,
  business_outcome: 'resolved',
});
```

## LangChain Integration

```typescript
import { LayerinfiniteClient } from '@layerinfinite/sdk';
import { tool } from '@langchain/core/tools';

const layerinfinite = new LayerinfiniteClient({ apiKey: process.env.LAYERINFINITE_API_KEY! });

const resolveTicket = tool(
  async ({ agentId, issueType }: { agentId: string; issueType: string }) => {
    const scores = await layerinfinite.getScores({ agentId, issueType });
    const action = scores.top_action!;
    // ... run the action ...
    await layerinfinite.logOutcome({
      agent_id: agentId, action_id: action.action_id,
      context_id: scores.context_id, issue_type: issueType,
      success: true, outcome_score: 0.85, business_outcome: 'resolved',
    });
    return action.action_name;
  },
  { name: 'resolve_ticket', description: 'Resolve a support ticket guided by Layerinfinite' }
);
```

## CrewAI-style Integration

```typescript
import { LayerinfiniteClient } from '@layerinfinite/sdk';

const layerinfinite = new LayerinfiniteClient({ apiKey: process.env.LAYERINFINITE_API_KEY! });

export async function agentDecide(agentId: string, issue: string) {
  const { top_action, context_id, policy } = await layerinfinite.getScores({
    agentId, issueType: issue,
  });
  console.log(`[Layerinfinite] Policy: ${policy}, Action: ${top_action?.action_name}`);
  return { action: top_action, contextId: context_id };
}
```

## Error Handling

```typescript
import {
  LayerinfiniteClient,
  LayerinfiniteAuthError,
  LayerinfiniteRateLimitError,
  LayerinfiniteServerError,
} from '@layerinfinite/sdk';

const client = new LayerinfiniteClient({ apiKey: 'layerinfinite_key' });

try {
  const scores = await client.getScores({ agentId: 'agent-1', issueType: 'billing' });
} catch (err) {
  if (err instanceof LayerinfiniteAuthError) {
    console.error('Invalid API key');
  } else if (err instanceof LayerinfiniteRateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfter}s`);
    await new Promise(r => setTimeout(r, err.retryAfter * 1000));
  } else if (err instanceof LayerinfiniteServerError) {
    console.error(`Server error: ${err.statusCode}`);
  }
}
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | required | Your Layerinfinite API key |
| `baseUrl` | `https://api.layerinfinite.app` | Primary API base URL |
| `baseUrls` | `[]` | Optional fallback API URLs used after network/timeout/5xx failures |
| `timeout` | `10000` | Request timeout in ms |
| `maxRetries` | `3` | Max retries on 429/5xx/timeouts/network errors |

You can also provide fallback endpoints with the `LAYERINFINITE_BASE_URLS` environment variable (comma-separated), for example:

`LAYERINFINITE_BASE_URLS="https://api-backup-1.layerinfinite.app,https://api-backup-2.layerinfinite.app"`

## Production Runbook (Railway/Vercel)

Use this endpoint order in production:

1. Primary: stable custom domain (example: `https://api.layerinfinite.app`)
2. Fallback 1: Railway deployment URL
3. Fallback 2: Vercel deployment URL

Recommended client setup:

```typescript
const client = new LayerinfiniteClient({
  apiKey: process.env.LAYERINFINITE_API_KEY!,
  baseUrl: 'https://api.layerinfinite.app',
  baseUrls: [
    'https://layerinfinite-api-production.up.railway.app',
    'https://layerinfinite-api.vercel.app',
  ],
  timeout: 10_000,
  maxRetries: 3,
});
```

Production checklist:

- Keep all endpoints on the same backend version and schema.
- Point all endpoints to the same production database/project.
- Do not use preview URLs as fallbacks.
- Keep `maxRetries` low (2-3) to reduce latency spikes.
- Run a failover drill weekly by temporarily blocking the primary URL and confirming fallback succeeds.

## Links

- **npm**: [@layerinfinite/sdk](https://www.npmjs.com/package/@layerinfinite/sdk)
- **Docs**: [docs.layerinfinite.ai](https://docs.layerinfinite.ai)
- **GitHub**: [github.com/hari08varma/Outcome](https://github.com/hari08varma/Outcome)
