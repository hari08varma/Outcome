'use strict';

module.exports = {
  key: 'log_outcome',
  noun: 'Outcome',
  display: {
    label: 'Log Action Outcome',
    description:
      'Tell Layer5 what happened after your AI agent ' +
      'took an action. Layer5 learns from every outcome ' +
      'to give better recommendations next time.',
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
        key: 'action_name',
        label: 'Action Name',
        type: 'string',
        required: true,
        helpText:
          'The name of the action your agent took. ' +
          'Must be registered at app.layer5.dev/actions. ' +
          'Example: send_refund',
      },
      {
        key: 'success',
        label: 'Did It Work?',
        type: 'boolean',
        required: true,
        helpText: 'True if the action succeeded, False if it failed.',
      },
      {
        key: 'outcome_score',
        label: 'Outcome Score (Optional)',
        type: 'number',
        required: false,
        helpText:
          'How well did it actually work? ' +
          '0.0 = completely failed, 1.0 = perfect. ' +
          'Use this when success is not black-and-white. ' +
          'Example: 0.7 if it mostly worked.',
      },
      {
        key: 'response_ms',
        label: 'Response Time (ms, Optional)',
        type: 'integer',
        required: false,
        helpText:
          'How long the action took in milliseconds. ' +
          'Layer5 uses this to detect slowdowns.',
      },
      {
        key: 'session_id',
        label: 'Session ID (Optional)',
        type: 'string',
        required: false,
        helpText:
          'A unique ID for this conversation or workflow run. ' +
          'Groups related actions together. ' +
          'Example: sess_abc123',
      },
      {
        key: 'context',
        label: 'Context (JSON, Optional)',
        type: 'text',
        required: false,
        helpText:
          'Extra information about the situation, as JSON. ' +
          'Example: {"issue_type": "payment_failed", "customer_tier": "enterprise"} ' +
          'Layer5 uses this to give better recommendations.',
      },
    ],
    perform: async (z, bundle) => {
      const body = {
        action_name: bundle.inputData.action_name,
        success: bundle.inputData.success,
      };

      if (bundle.inputData.outcome_score) {
        body.outcome_score = parseFloat(bundle.inputData.outcome_score);
      }
      if (bundle.inputData.response_ms) {
        body.response_ms = parseInt(bundle.inputData.response_ms, 10);
      }
      if (bundle.inputData.session_id) {
        body.session_id = bundle.inputData.session_id;
      }
      if (bundle.inputData.context) {
        try {
          body.context = JSON.parse(bundle.inputData.context);
        } catch (e) {
          throw new z.errors.Error(
            'The Context field must be valid JSON. ' +
              'Example: {"issue_type": "payment_failed"}',
            'INVALID_JSON',
            400
          );
        }
      }

      const response = await z.request({
        url: 'https://api.layer5.dev/v1/log-outcome',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bundle.authData.apiKey}`,
          'X-Agent-Id': bundle.inputData.agent_id,
        },
        body,
      });

      handleErrors(z, response);
      return response.json;
    },
    sample: {
      success: true,
      outcome_id: 'abc-123-def-456',
      action_id: 'act_001',
      context_id: 'ctx_001',
      timestamp: '2026-01-15T10:30:00Z',
      message: 'Outcome recorded',
      recommendation: {
        policy: 'exploit',
        reason: 'High confidence in current best action',
        selected_action: 'send_refund',
      },
    },
    outputFields: [
      { key: 'success', label: 'Success', type: 'boolean' },
      { key: 'outcome_id', label: 'Outcome ID', type: 'string' },
      { key: 'action_id', label: 'Action ID', type: 'string' },
      { key: 'context_id', label: 'Context ID', type: 'string' },
      { key: 'timestamp', label: 'Recorded At', type: 'string' },
      { key: 'message', label: 'Message', type: 'string' },
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
      UNKNOWN_ACTION:
        'This action is not registered in Layer5. ' +
        'Add it at app.layer5.dev/actions before using it in Zapier.',
      ACTION_DISABLED:
        'This action has been disabled in Layer5. ' +
        'Re-enable it at app.layer5.dev/actions or use a different action.',
      AGENT_SUSPENDED:
        'This agent has been suspended due to too many failures. ' +
        'Check agent status at app.layer5.dev/agents',
      MISSING_FIELD:
        'A required field is missing. ' +
        'Make sure Agent Name and Action Name are filled in.',
    };

    const friendly = friendlyMessages[code] || `Layer5 error: ${msg} (code: ${code})`;
    throw new z.errors.Error(friendly, code, response.status);
  }
}
