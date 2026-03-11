'use strict';

module.exports = {
  key: 'get_scores',
  noun: 'Scores',
  display: {
    label: 'Get Action Scores',
    description:
      'Ask Layer5 which action your AI agent should take next. ' +
      'Returns a ranked list of actions with confidence scores.',
    important: true,
  },
  operation: {
    inputFields: [
      {
        key: 'agent_id',
        label: 'Agent Name',
        type: 'string',
        required: true,
        helpText:
          'A consistent name for your AI agent. ' +
          'Use the same name every time. ' +
          'Example: customer-support-bot',
      },
      {
        key: 'issue_type',
        label: 'Issue Type',
        type: 'string',
        required: true,
        helpText:
          'What kind of situation is this? ' +
          'Layer5 uses this to find the best actions for this problem type. ' +
          'Example: payment_failed',
      },
      {
        key: 'top_n',
        label: 'Max Results (Optional)',
        type: 'integer',
        required: false,
        default: '10',
        helpText:
          'How many action recommendations to return. ' +
          'Default is 10, maximum is 50.',
      },
    ],
    perform: async (z, bundle) => {
      const params = {
        issue_type: bundle.inputData.issue_type,
      };
      if (bundle.inputData.top_n) {
        params.top_n = String(bundle.inputData.top_n);
      }

      const response = await z.request({
        url: 'https://api.layer5.dev/v1/get-scores',
        method: 'GET',
        params,
        headers: {
          Authorization: `Bearer ${bundle.authData.apiKey}`,
          'X-Agent-Id': bundle.inputData.agent_id,
        },
      });

      handleErrors(z, response);

      const data = response.json;

      // Zapier works best with an ID field. Use top_action or generate one.
      return {
        id: data.context_id || Date.now(),
        ...data,
      };
    },
    sample: {
      id: 'ctx_001',
      ranked_actions: [
        {
          action_name: 'send_refund',
          score: 0.92,
          confidence: 0.87,
          trend: 'improving',
          rank: 1,
          recommendation: 'use',
        },
        {
          action_name: 'restart_service',
          score: 0.65,
          confidence: 0.72,
          trend: 'stable',
          rank: 2,
          recommendation: 'consider',
        },
      ],
      top_action: 'send_refund',
      should_escalate: false,
      cold_start: false,
      context_id: 'ctx_001',
      issue_type: 'payment_failed',
      policy: { decision: 'exploit', reason: 'High confidence' },
    },
    outputFields: [
      { key: 'top_action', label: 'Recommended Action', type: 'string' },
      { key: 'should_escalate', label: 'Should Escalate?', type: 'boolean' },
      { key: 'cold_start', label: 'Cold Start?', type: 'boolean' },
      { key: 'context_id', label: 'Context ID', type: 'string' },
      { key: 'issue_type', label: 'Issue Type', type: 'string' },
      { key: 'ranked_actions[]action_name', label: 'Action Name', type: 'string' },
      { key: 'ranked_actions[]score', label: 'Score', type: 'number' },
      { key: 'ranked_actions[]confidence', label: 'Confidence', type: 'number' },
      { key: 'ranked_actions[]recommendation', label: 'Recommendation', type: 'string' },
    ],
  },
};

/**
 * Translate Layer5 error codes into friendly Zapier error messages.
 */
function handleErrors(z, response) {
  if (response.status === 401) {
    throw new z.errors.Error(
      'Your Layer5 API key is invalid. ' +
        'Check it in your Zapier connection settings. ' +
        'Keys start with "layer5_". ' +
        'Find yours at app.layer5.dev/settings/api-keys',
      'INVALID_API_KEY',
      401
    );
  }

  if (response.status === 429) {
    throw new z.errors.Error(
      'You\'ve hit the Layer5 rate limit. ' +
        'Zapier will automatically retry in a moment.',
      'RATE_LIMITED',
      429
    );
  }

  if (response.status >= 400) {
    const data = response.json;
    const code = (data && data.code) || 'UNKNOWN';
    const msg = (data && data.error) || response.content;

    const friendlyMessages = {
      MISSING_PARAM:
        'Issue Type is required. ' +
        'Fill in what kind of problem this is (e.g., "payment_failed").',
      AGENT_SUSPENDED:
        'This agent has been suspended due to too many failures. ' +
        'Check agent status at app.layer5.dev/agents',
    };

    const friendly = friendlyMessages[code] || `Layer5 error: ${msg} (code: ${code})`;
    throw new z.errors.Error(friendly, code, response.status);
  }
}
