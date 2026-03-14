# Layer5 TypeScript SDK (`@layer5/sdk`)

Layer5 is a decision intelligence middleware for AI agents — it records action outcomes, computes composite trust scores, and recommends the highest-performing next action so your agents learn from every decision. Drop it into any TypeScript or JavaScript project with zero runtime dependencies.

## Installation

```bash
npm install @layer5/sdk
# or
yarn add @layer5/sdk
# or
pnpm add @layer5/sdk
```

## Quick Start

```typescript
import { Layer5Client } from '@layer5/sdk';

const client = new Layer5Client({ apiKey: 'layer5_your_key' });

// Ask Layer5 which action to take
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
import { Layer5Client } from '@layer5/sdk';
import { tool } from '@langchain/core/tools';

const l5 = new Layer5Client({ apiKey: process.env.LAYER5_API_KEY! });

const resolveTicket = tool(
  async ({ agentId, issueType }: { agentId: string; issueType: string }) => {
    const scores = await l5.getScores({ agentId, issueType });
    const action = scores.top_action!;
    // ... run the action ...
    await l5.logOutcome({
      agent_id: agentId, action_id: action.action_id,
      context_id: scores.context_id, issue_type: issueType,
      success: true, outcome_score: 0.85, business_outcome: 'resolved',
    });
    return action.action_name;
  },
  { name: 'resolve_ticket', description: 'Resolve a support ticket guided by Layer5' }
);
```

## CrewAI-style Integration

```typescript
import { Layer5Client } from '@layer5/sdk';

const l5 = new Layer5Client({ apiKey: process.env.LAYER5_API_KEY! });

export async function agentDecide(agentId: string, issue: string) {
  const { top_action, context_id, policy } = await l5.getScores({
    agentId, issueType: issue,
  });
  console.log(`[Layer5] Policy: ${policy}, Action: ${top_action?.action_name}`);
  return { action: top_action, contextId: context_id };
}
```

## Error Handling

```typescript
import {
  Layer5Client,
  Layer5AuthError,
  Layer5RateLimitError,
  Layer5ServerError,
} from '@layer5/sdk';

const client = new Layer5Client({ apiKey: 'layer5_key' });

try {
  const scores = await client.getScores({ agentId: 'agent-1', issueType: 'billing' });
} catch (err) {
  if (err instanceof Layer5AuthError) {
    console.error('Invalid API key');
  } else if (err instanceof Layer5RateLimitError) {
    console.error(`Rate limited — retry after ${err.retryAfter}s`);
    await new Promise(r => setTimeout(r, err.retryAfter * 1000));
  } else if (err instanceof Layer5ServerError) {
    console.error(`Server error: ${err.statusCode}`);
  }
}
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | required | Your Layer5 API key |
| `baseUrl` | `https://your-app.railway.app` | API base URL |
| `timeout` | `10000` | Request timeout in ms |
| `maxRetries` | `3` | Max retries on 429/5xx |

## Links

- **npm**: [@layer5/sdk](https://www.npmjs.com/package/@layer5/sdk)
- **Docs**: [docs.layer5.ai](https://docs.layer5.ai)
- **GitHub**: [github.com/hari08varma/Outcome](https://github.com/hari08varma/Outcome)
