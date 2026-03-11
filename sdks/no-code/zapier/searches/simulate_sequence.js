'use strict';

module.exports = {
  key: 'simulate_sequence',
  noun: 'Simulation',
  display: {
    label: 'Simulate Action Sequence',
    description:
      'Predict the outcome of a proposed action sequence ' +
      'before your agent runs it in the real world.',
    important: true,
  },
  operation: {
    inputFields: [
      {
        key: 'agent_id',
        label: 'Agent ID',
        type: 'string',
        required: true,
        helpText:
          'Your Layer5 agent identifier. ' +
          'Found in your Layer5 dashboard.',
      },
      {
        key: 'context',
        label: 'Context (JSON)',
        type: 'text',
        required: true,
        helpText:
          'The situation your agent is facing, as JSON. ' +
          'Example: {"issue_type":"payment_failed"}',
      },
      {
        key: 'proposed_sequence',
        label: 'Proposed Actions (comma-separated)',
        type: 'string',
        required: true,
        helpText:
          'The actions your agent plans to take, in order. ' +
          'Example: clear_cache,restart_service. ' +
          'Maximum 5 actions.',
      },
      {
        key: 'episode_history',
        label: 'Already Tried (Optional)',
        type: 'string',
        required: false,
        helpText:
          'Actions already attempted this session, comma-separated. ' +
          'Layer5 will deprioritize these.',
      },
      {
        key: 'simulate_alternatives',
        label: 'Number of Alternatives (Optional)',
        type: 'integer',
        required: false,
        helpText:
          'How many alternative sequences to suggest. ' +
          '0\u20133. Default: 2.',
      },
    ],
    perform: async (z, bundle) => {
      // Parse context JSON
      let context;
      try {
        context = JSON.parse(bundle.inputData.context);
      } catch (e) {
        throw new z.errors.Error(
          'The Context field must be valid JSON. ' +
            'Example: {"issue_type": "payment_failed"}',
          'INVALID_JSON',
          400
        );
      }

      // Parse proposed_sequence
      const proposedSequence = bundle.inputData.proposed_sequence
        .split(',')
        .map((s) => s.trim());

      if (proposedSequence.some((a) => a === '')) {
        throw new z.errors.Error(
          'Proposed sequence contains an empty action. ' +
            'Check for trailing commas.',
          'INVALID_SEQUENCE',
          400
        );
      }
      if (proposedSequence.length > 5) {
        throw new z.errors.Error(
          `Proposed sequence is limited to 5 actions. ` +
            `You provided ${proposedSequence.length}. ` +
            `Remove ${proposedSequence.length - 5} action(s).`,
          'INVALID_SEQUENCE',
          400
        );
      }

      // Parse episode_history
      const episodeHistory = bundle.inputData.episode_history
        ? bundle.inputData.episode_history
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

      const body = {
        agent_id: bundle.inputData.agent_id,
        context,
        proposed_sequence: proposedSequence,
      };
      if (episodeHistory.length > 0) {
        body.episode_history = episodeHistory;
      }
      if (bundle.inputData.simulate_alternatives != null) {
        body.simulate_alternatives = parseInt(
          bundle.inputData.simulate_alternatives,
          10
        );
      }

      const response = await z.request({
        url: 'https://api.layer5.dev/v1/simulate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bundle.authData.apiKey}`,
        },
        body,
      });

      handleErrors(z, response);

      const data = response.json;
      const primary = data.primary || {};
      const alternatives = data.alternatives || [];

      return {
        id: (primary.actions || []).join('\u2192'),
        predicted_outcome: primary.predicted_outcome,
        confidence: primary.confidence,
        confidence_low: primary.outcome_interval_low,
        confidence_high: primary.outcome_interval_high,
        predicted_resolution: primary.predicted_resolution,
        predicted_steps: primary.predicted_steps,
        actions: (primary.actions || []).join(', '),
        simulation_tier: data.simulation_tier,
        tier_explanation: data.tier_explanation,
        data_source: data.data_source,
        episode_count: data.episode_count,
        simulation_warning: data.simulation_warning || '',
        has_alternatives: alternatives.length > 0,
        best_alternative_actions:
          alternatives.length > 0 && alternatives[0].actions
            ? alternatives[0].actions.join(', ')
            : '',
        best_alternative_outcome:
          alternatives.length > 0
            ? alternatives[0].predicted_outcome
            : null,
        better_alternative_exists: alternatives.some(
          (a) => a.better_than_proposed
        ),
      };
    },
    sample: {
      id: 'clear_cache\u2192restart_service',
      predicted_outcome: 0.83,
      confidence: 0.78,
      confidence_low: 0.65,
      confidence_high: 0.94,
      predicted_resolution: 0.88,
      predicted_steps: 2,
      actions: 'clear_cache, restart_service',
      simulation_tier: 1,
      tier_explanation: 'Based on 47 historical records matching this context.',
      data_source: 'historical',
      episode_count: 47,
      simulation_warning: '',
      has_alternatives: true,
      best_alternative_actions: 'restart_service, clear_cache',
      best_alternative_outcome: 0.91,
      better_alternative_exists: true,
    },
    outputFields: [
      { key: 'predicted_outcome', label: 'Predicted Outcome (0\u20131)', type: 'number' },
      { key: 'confidence', label: 'Confidence (0\u20131)', type: 'number' },
      { key: 'confidence_low', label: 'Confidence Low', type: 'number' },
      { key: 'confidence_high', label: 'Confidence High', type: 'number' },
      { key: 'predicted_resolution', label: 'Predicted Resolution', type: 'number' },
      { key: 'predicted_steps', label: 'Predicted Steps', type: 'integer' },
      { key: 'actions', label: 'Actions', type: 'string' },
      { key: 'simulation_tier', label: 'Simulation Tier', type: 'integer' },
      { key: 'tier_explanation', label: 'Tier Explanation', type: 'string' },
      { key: 'data_source', label: 'Data Source', type: 'string' },
      { key: 'episode_count', label: 'Episode Count', type: 'integer' },
      { key: 'simulation_warning', label: 'Simulation Warning', type: 'string' },
      { key: 'has_alternatives', label: 'Has Alternatives?', type: 'boolean' },
      { key: 'best_alternative_actions', label: 'Best Alternative Actions', type: 'string' },
      { key: 'best_alternative_outcome', label: 'Best Alternative Outcome', type: 'number' },
      { key: 'better_alternative_exists', label: 'Better Alternative Exists?', type: 'boolean' },
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

  if (response.status === 404) {
    throw new z.errors.Error(
      'Agent not found. Check your Agent ID in the Layer5 dashboard.',
      'UNKNOWN_AGENT',
      404
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
      VALIDATION_ERROR:
        'Invalid simulation request: ' + (msg || 'check your fields.'),
      AGENT_NOT_FOUND:
        'Agent not found. Check your Agent ID in the Layer5 dashboard.',
      AGENT_SUSPENDED:
        'This agent has been suspended due to too many failures. ' +
        'Check agent status at app.layer5.dev/agents',
    };

    const friendly = friendlyMessages[code] || `Layer5 error: ${msg} (code: ${code})`;
    throw new z.errors.Error(friendly, code, response.status);
  }
}
