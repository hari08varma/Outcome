/**
 * LayerInfinite MCP Gateway — prompts/onboarding.ts
 * ══════════════════════════════════════════════════════════════
 * Static MCP prompt: layerinfinite-onboarding
 *
 * Quick-start guide presented to new users when they first
 * connect to the LayerInfinite MCP gateway.
 * ══════════════════════════════════════════════════════════════
 */

import type { Prompt } from '../types.js';

export const onboardingPrompt: Prompt = {
  name: 'layerinfinite-onboarding',
  description:
    'Quick-start guide for LayerInfinite — learn how the MCP gateway enriches your tools with historical outcome data.',
  arguments: [],
  handler: async () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            '# Welcome to LayerInfinite',
            '',
            'LayerInfinite is an MCP gateway proxy that enriches your tool descriptions',
            'with historical outcome data — so you can make better tool choices using',
            'real performance data, without changing any of your existing code.',
            '',
            '## How It Works',
            '',
            '1. **You request tools** → LayerInfinite intercepts `tools/list`',
            '2. **Enrichment happens** → Historical success rates are woven into tool descriptions',
            '3. **You choose tools** → Descriptions now include data like "84% success on build_failed"',
            '4. **Outcomes are logged** → Every tool call feeds back into the model',
            '',
            '## Gateway Modes',
            '',
            '- **Recommend**: Descriptions include informational historical context',
            '- **Assist**: Directional guidance + warnings for low-performing tools',
            '- **Auto**: Silent rerouting to the best tool (you never notice)',
            '',
            '## Key Tools',
            '',
            '- `li_recommend` — Ask LayerInfinite directly for ranked tool recommendations',
            '- Your existing tools — All your usual tools, now enriched with outcome data',
            '',
            '## Resources',
            '',
            '- `layerinfinite://dashboard` — Real-time analytics dashboard',
            '- `layerinfinite://docs` — Full documentation and integration guides',
            '',
            '## Getting Started',
            '',
            'Just continue using your tools as normal. LayerInfinite works invisibly.',
            'If you want explicit recommendations, call `li_recommend` with your task type.',
          ].join('\n'),
        },
      },
    ],
  }),
};
