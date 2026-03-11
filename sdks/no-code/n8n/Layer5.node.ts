import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionType,
  NodeApiError,
  NodeOperationError,
} from 'n8n-workflow';

export class Layer5 implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Layer5',
    name: 'layer5',
    icon: 'file:layer5.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description:
      'Learn from every AI agent action. ' +
      'Get action scores, log outcomes, and submit feedback.',
    defaults: {
      name: 'Layer5',
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],
    credentials: [
      {
        name: 'layer5Api',
        required: true,
      },
    ],
    properties: [
      // ── Operation selector ──────────────────────────────────
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Get Scores',
            value: 'getScores',
            action: 'Get action scores for a situation',
            description:
              'Ask Layer5 which action your agent should take next. ' +
              'Returns a ranked list of actions with confidence scores.',
          },
          {
            name: 'Log Outcome',
            value: 'logOutcome',
            action: 'Log what happened after an action',
            description:
              'Tell Layer5 whether an action succeeded or failed. ' +
              'Layer5 learns from every outcome to give better recommendations.',
          },
          {
            name: 'Log Feedback',
            value: 'logFeedback',
            action: 'Submit delayed feedback on an outcome',
            description:
              'Update a previous outcome with a final score. ' +
              'Use this when you learn later how well an action really worked.',
          },
          {
            name: 'Get Patterns',
            value: 'getPatterns',
            action: 'Get successful action sequences',
            description:
              'See which sequences of actions have worked best. ' +
              'Returns playbooks — ordered steps that resolved similar issues.',
          },
          {
            name: 'Simulate Sequence',
            value: 'simulateSequence',
            action: 'Predict the outcome of a proposed action sequence',
            description:
              'Predict the outcome of a proposed action sequence ' +
              'before your agent runs it.',
          },
        ],
        default: 'getScores',
      },

      // ════════════════════════════════════════════════════════
      // GET SCORES fields
      // ════════════════════════════════════════════════════════
      {
        displayName: 'Agent Name',
        name: 'agent_id',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'customer-support-bot',
        description:
          'A unique name for your AI agent. ' +
          'Use the same name every time so Layer5 can learn from this agent\'s history. ' +
          'Example: "customer-support-bot"',
        displayOptions: {
          show: {
            operation: ['getScores', 'logOutcome', 'getPatterns'],
          },
        },
      },
      {
        displayName: 'Issue Type',
        name: 'issue_type',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'payment_failed',
        description:
          'What kind of situation is this? ' +
          'Layer5 uses this to find the best actions for this type of problem. ' +
          'Example: "payment_failed" or "account_locked"',
        displayOptions: {
          show: {
            operation: ['getScores', 'getPatterns'],
          },
        },
      },
      {
        displayName: 'Context (JSON)',
        name: 'context',
        type: 'json',
        required: false,
        default: '',
        placeholder: '{"issue_type": "payment_failed", "customer_tier": "enterprise"}',
        description:
          'Optional: Information about the current situation. ' +
          'Paste as JSON. Layer5 uses this to give better recommendations for different situations. ' +
          'Example: {"issue_type": "payment_failed", "customer_tier": "enterprise"}',
        displayOptions: {
          show: {
            operation: ['getScores', 'logOutcome'],
          },
        },
      },
      {
        displayName: 'Max Results',
        name: 'top_n',
        type: 'number',
        required: false,
        default: 10,
        placeholder: '10',
        description:
          'How many action recommendations to return. ' +
          'Default is 10, maximum is 50.',
        typeOptions: {
          minValue: 1,
          maxValue: 50,
        },
        displayOptions: {
          show: {
            operation: ['getScores', 'getPatterns'],
          },
        },
      },

      // ════════════════════════════════════════════════════════
      // LOG OUTCOME fields
      // ════════════════════════════════════════════════════════
      {
        displayName: 'Action Name',
        name: 'action_name',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'send_refund',
        description:
          'The name of the action your agent just took. ' +
          'This must be registered in your Layer5 dashboard. ' +
          'Example: "send_refund" or "restart_service"',
        displayOptions: {
          show: {
            operation: ['logOutcome'],
          },
        },
      },
      {
        displayName: 'Did It Work?',
        name: 'success',
        type: 'boolean',
        required: true,
        default: true,
        description:
          'Did the action work as expected? ' +
          'Toggle on for success, off for failure.',
        displayOptions: {
          show: {
            operation: ['logOutcome'],
          },
        },
      },
      {
        displayName: 'Outcome Score (Optional)',
        name: 'outcome_score',
        type: 'number',
        required: false,
        default: undefined,
        placeholder: '0.85',
        description:
          'Optional: How well did the action actually work? ' +
          '0.0 = completely failed, 0.5 = partially worked, 1.0 = worked perfectly. ' +
          'Leave empty to use the success toggle only.',
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberPrecision: 2,
        },
        displayOptions: {
          show: {
            operation: ['logOutcome'],
          },
        },
      },
      {
        displayName: 'Response Time (ms, Optional)',
        name: 'response_ms',
        type: 'number',
        required: false,
        default: undefined,
        placeholder: '1200',
        description:
          'Optional: How long did the action take in milliseconds? ' +
          'Layer5 uses this to detect when actions are getting slower. ' +
          'Example: 1200',
        displayOptions: {
          show: {
            operation: ['logOutcome'],
          },
        },
      },
      {
        displayName: 'Session ID (Optional)',
        name: 'session_id',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'sess_abc123',
        description:
          'Optional: A unique ID for this conversation or workflow run. ' +
          'Groups related actions together so Layer5 can learn from sequences.',
        displayOptions: {
          show: {
            operation: ['logOutcome'],
          },
        },
      },

      // ════════════════════════════════════════════════════════
      // LOG FEEDBACK fields
      // ════════════════════════════════════════════════════════
      {
        displayName: 'Outcome ID',
        name: 'outcome_id',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'abc-123-def-456',
        description:
          'The outcome ID returned when you logged the original action. ' +
          'You get this from the "Log Outcome" step.',
        displayOptions: {
          show: {
            operation: ['logFeedback'],
          },
        },
      },
      {
        displayName: 'Final Score',
        name: 'final_score',
        type: 'number',
        required: true,
        default: 0.5,
        placeholder: '0.85',
        description:
          'How well did the action really work in the end? ' +
          '0.0 = completely failed, 1.0 = worked perfectly. ' +
          'Use this when the real result becomes clear later.',
        typeOptions: {
          minValue: 0,
          maxValue: 1,
          numberPrecision: 2,
        },
        displayOptions: {
          show: {
            operation: ['logFeedback'],
          },
        },
      },
      {
        displayName: 'Business Outcome',
        name: 'business_outcome',
        type: 'options',
        required: true,
        default: 'resolved',
        options: [
          {
            name: 'Resolved',
            value: 'resolved',
            description: 'The issue was fully resolved',
          },
          {
            name: 'Partial',
            value: 'partial',
            description: 'The issue was partially resolved',
          },
          {
            name: 'Failed',
            value: 'failed',
            description: 'The action did not help',
          },
          {
            name: 'Unknown',
            value: 'unknown',
            description: 'Not sure yet what the outcome was',
          },
        ],
        description:
          'What was the final business result? ' +
          'Choose the option that best describes what happened.',
        displayOptions: {
          show: {
            operation: ['logFeedback'],
          },
        },
      },
      {
        displayName: 'Notes (Optional)',
        name: 'feedback_notes',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'Customer confirmed issue is resolved',
        description:
          'Optional: Any extra notes about the outcome. ' +
          'These are stored for your team\'s reference.',
        displayOptions: {
          show: {
            operation: ['logFeedback'],
          },
        },
      },

      // ════════════════════════════════════════════════════════
      // SIMULATE SEQUENCE fields
      // ════════════════════════════════════════════════════════════
      {
        displayName: 'Agent ID',
        name: 'simulate_agent_id',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'my-payment-agent',
        description:
          'The unique identifier of your Layer5 agent. ' +
          'Find this in your dashboard under Agents.',
        displayOptions: {
          show: {
            operation: ['simulateSequence'],
          },
        },
      },
      {
        displayName: 'Context (JSON)',
        name: 'simulate_context',
        type: 'json',
        required: true,
        default: '',
        placeholder: '{"issue_type": "payment_failed", "tier": "enterprise"}',
        description:
          'Describe the situation your agent is facing. ' +
          'Use the same context format you use when calling Get Scores. ' +
          'Example: {"issue_type": "payment_failed"}',
        displayOptions: {
          show: {
            operation: ['simulateSequence'],
          },
        },
      },
      {
        displayName: 'Proposed Action Sequence',
        name: 'proposed_sequence',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'clear_cache,restart_service',
        description:
          'The actions your agent plans to take, in order, separated by commas. ' +
          'Maximum 5 actions. ' +
          'Example: clear_cache,restart_service,update_app',
        displayOptions: {
          show: {
            operation: ['simulateSequence'],
          },
        },
      },
      {
        displayName: 'Already Tried (Optional)',
        name: 'episode_history',
        type: 'string',
        required: false,
        default: '',
        placeholder: 'update_app',
        description:
          '(Optional) Actions your agent has already tried in this session, ' +
          'separated by commas. Layer5 will factor these in and ' +
          'deprioritize them in the prediction.',
        displayOptions: {
          show: {
            operation: ['simulateSequence'],
          },
        },
      },
      {
        displayName: 'Number of Alternatives',
        name: 'simulate_alternatives',
        type: 'options',
        required: false,
        default: '2',
        options: [
          { name: '0', value: '0' },
          { name: '1', value: '1' },
          { name: '2', value: '2' },
          { name: '3', value: '3' },
        ],
        description:
          'How many alternative action sequences to suggest. ' +
          'Set to 0 to only predict your proposed sequence.',
        displayOptions: {
          show: {
            operation: ['simulateSequence'],
          },
        },
      },

      // ════════════════════════════════════════════════════════
      // GET PATTERNS extra fields
      // ════════════════════════════════════════════════════════
      {
        displayName: 'Minimum Samples',
        name: 'min_samples',
        type: 'number',
        required: false,
        default: 2,
        placeholder: '2',
        description:
          'Only show patterns that have been seen at least this many times. ' +
          'Higher numbers mean more reliable patterns but fewer results.',
        typeOptions: {
          minValue: 1,
        },
        displayOptions: {
          show: {
            operation: ['getPatterns'],
          },
        },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials('layer5Api');

    const baseUrl = (credentials.baseUrl as string) || 'https://api.layer5.dev';
    const operation = this.getNodeParameter('operation', 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        if (operation === 'getScores') {
          const result = await this.executeGetScores(i, baseUrl);
          returnData.push({ json: result });
        } else if (operation === 'logOutcome') {
          const result = await this.executeLogOutcome(i, baseUrl);
          returnData.push({ json: result });
        } else if (operation === 'logFeedback') {
          const result = await this.executeLogFeedback(i, baseUrl);
          returnData.push({ json: result });
        } else if (operation === 'getPatterns') {
          const result = await this.executeGetPatterns(i, baseUrl);
          returnData.push({ json: result });
        } else if (operation === 'simulateSequence') {
          const result = await this.executeSimulateSequence(i, baseUrl);
          returnData.push({ json: result });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw error;
      }
    }

    return [returnData];
  }

  private async executeGetScores(
    this: IExecuteFunctions,
    itemIndex: number,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.getNodeParameter('agent_id', itemIndex) as string;
    const issueType = this.getNodeParameter('issue_type', itemIndex, '') as string;
    const contextRaw = this.getNodeParameter('context', itemIndex, '') as string;
    const topN = this.getNodeParameter('top_n', itemIndex, 10) as number;

    const params = new URLSearchParams();
    if (issueType) params.set('issue_type', issueType);
    if (topN) params.set('top_n', String(topN));

    // If context is provided as JSON, extract issue_type from it
    if (contextRaw) {
      try {
        const ctx = JSON.parse(contextRaw);
        if (ctx.issue_type && !issueType) {
          params.set('issue_type', ctx.issue_type);
        }
      } catch {
        // Not valid JSON — ignore
      }
    }

    const qs = params.toString();
    const url = `${baseUrl}/v1/get-scores${qs ? '?' + qs : ''}`;

    const response = await this.helpers.httpRequestWithAuthentication.call(
      this,
      'layer5Api',
      {
        method: 'GET',
        url,
        headers: {
          'X-Agent-Id': agentId,
        },
        json: true,
      },
    );

    return handleApiResponse(response, this, itemIndex);
  }

  private async executeLogOutcome(
    this: IExecuteFunctions,
    itemIndex: number,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.getNodeParameter('agent_id', itemIndex) as string;
    const actionName = this.getNodeParameter('action_name', itemIndex) as string;
    const success = this.getNodeParameter('success', itemIndex) as boolean;
    const outcomeScore = this.getNodeParameter('outcome_score', itemIndex, undefined) as
      | number
      | undefined;
    const responseMs = this.getNodeParameter('response_ms', itemIndex, undefined) as
      | number
      | undefined;
    const sessionId = this.getNodeParameter('session_id', itemIndex, '') as string;
    const contextRaw = this.getNodeParameter('context', itemIndex, '') as string;

    const body: Record<string, unknown> = {
      action_name: actionName,
      success,
    };

    if (outcomeScore !== undefined && outcomeScore !== null) {
      body.outcome_score = outcomeScore;
    }
    if (responseMs !== undefined && responseMs !== null) {
      body.response_ms = responseMs;
    }
    if (sessionId) {
      body.session_id = sessionId;
    }
    if (contextRaw) {
      try {
        body.context = JSON.parse(contextRaw);
      } catch {
        body.context = contextRaw;
      }
    }

    const response = await this.helpers.httpRequestWithAuthentication.call(
      this,
      'layer5Api',
      {
        method: 'POST',
        url: `${baseUrl}/v1/log-outcome`,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Id': agentId,
        },
        body,
        json: true,
      },
    );

    return handleApiResponse(response, this, itemIndex);
  }

  private async executeLogFeedback(
    this: IExecuteFunctions,
    itemIndex: number,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const outcomeId = this.getNodeParameter('outcome_id', itemIndex) as string;
    const finalScore = this.getNodeParameter('final_score', itemIndex) as number;
    const businessOutcome = this.getNodeParameter('business_outcome', itemIndex) as string;
    const feedbackNotes = this.getNodeParameter('feedback_notes', itemIndex, '') as string;

    const body: Record<string, unknown> = {
      outcome_id: outcomeId,
      final_score: finalScore,
      business_outcome: businessOutcome,
    };

    if (feedbackNotes) {
      body.feedback_notes = feedbackNotes;
    }

    const response = await this.helpers.httpRequestWithAuthentication.call(
      this,
      'layer5Api',
      {
        method: 'POST',
        url: `${baseUrl}/v1/outcome-feedback`,
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        json: true,
      },
    );

    return handleApiResponse(response, this, itemIndex);
  }

  private async executeGetPatterns(
    this: IExecuteFunctions,
    itemIndex: number,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.getNodeParameter('agent_id', itemIndex) as string;
    const issueType = this.getNodeParameter('issue_type', itemIndex, '') as string;
    const topN = this.getNodeParameter('top_n', itemIndex, 5) as number;
    const minSamples = this.getNodeParameter('min_samples', itemIndex, 2) as number;

    const params = new URLSearchParams();
    if (issueType) params.set('issue_type', issueType);
    if (topN) params.set('top_n', String(topN));
    if (minSamples) params.set('min_samples', String(minSamples));

    const qs = params.toString();
    const url = `${baseUrl}/v1/get-patterns${qs ? '?' + qs : ''}`;

    const response = await this.helpers.httpRequestWithAuthentication.call(
      this,
      'layer5Api',
      {
        method: 'GET',
        url,
        headers: {
          'X-Agent-Id': agentId,
        },
        json: true,
      },
    );

    return handleApiResponse(response, this, itemIndex);
  }

  private async executeSimulateSequence(
    this: IExecuteFunctions,
    itemIndex: number,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.getNodeParameter('simulate_agent_id', itemIndex) as string;
    const contextRaw = this.getNodeParameter('simulate_context', itemIndex) as string;
    const sequenceRaw = this.getNodeParameter('proposed_sequence', itemIndex) as string;
    const episodeRaw = this.getNodeParameter('episode_history', itemIndex, '') as string;
    const alternativesStr = this.getNodeParameter('simulate_alternatives', itemIndex, '2') as string;

    // Parse context JSON
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(contextRaw);
    } catch {
      throw new NodeOperationError(
        this.getNode(),
        'Context must be valid JSON. Example: {"issue_type": "payment_failed"}',
        { itemIndex },
      );
    }

    // Parse proposed_sequence
    const proposedSequence = sequenceRaw.split(',').map((s) => s.trim());
    if (proposedSequence.some((a) => a === '')) {
      throw new NodeOperationError(
        this.getNode(),
        'Proposed sequence contains an empty action. Check for trailing commas.',
        { itemIndex },
      );
    }
    if (proposedSequence.length > 5) {
      throw new NodeOperationError(
        this.getNode(),
        `Proposed sequence is limited to 5 actions. You provided ${proposedSequence.length}. Remove ${proposedSequence.length - 5} action(s).`,
        { itemIndex },
      );
    }

    // Parse episode_history
    const episodeHistory = episodeRaw
      ? episodeRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const body: Record<string, unknown> = {
      agent_id: agentId,
      context,
      proposed_sequence: proposedSequence,
      simulate_alternatives: parseInt(alternativesStr, 10),
    };
    if (episodeHistory.length > 0) {
      body.episode_history = episodeHistory;
    }

    const response = await this.helpers.httpRequestWithAuthentication.call(
      this,
      'layer5Api',
      {
        method: 'POST',
        url: `${baseUrl}/v1/simulate`,
        headers: {
          'Content-Type': 'application/json',
        },
        body,
        json: true,
      },
    );

    const res = handleApiResponse(response, this, itemIndex);

    // Map response to flat output fields
    const primary = res.primary as Record<string, unknown> | undefined;
    const alternatives = res.alternatives as Array<Record<string, unknown>> | undefined;

    return {
      predicted_outcome: primary?.predicted_outcome ?? null,
      confidence: primary?.confidence ?? null,
      confidence_low: primary?.outcome_interval_low ?? null,
      confidence_high: primary?.outcome_interval_high ?? null,
      predicted_resolution: primary?.predicted_resolution ?? null,
      predicted_steps: primary?.predicted_steps ?? null,
      actions: Array.isArray(primary?.actions)
        ? (primary!.actions as string[]).join(', ')
        : '',
      simulation_tier: res.simulation_tier ?? null,
      tier_explanation: res.tier_explanation ?? '',
      simulation_warning: res.simulation_warning ?? '',
      episode_count: res.episode_count ?? null,
      alternatives: JSON.stringify(alternatives ?? []),
      best_alternative_outcome:
        alternatives && alternatives.length > 0
          ? alternatives[0]?.predicted_outcome ?? null
          : null,
      best_alternative_actions:
        alternatives && alternatives.length > 0 && Array.isArray(alternatives[0]?.actions)
          ? (alternatives[0]!.actions as string[]).join(', ')
          : '',
    };
  }
}

// ── Friendly error messages ──────────────────────────────────
function handleApiResponse(
  response: unknown,
  ctx: IExecuteFunctions,
  itemIndex: number,
): Record<string, unknown> {
  const res = response as Record<string, unknown>;

  // n8n's httpRequestWithAuthentication already throws on non-2xx,
  // but we add extra clarity for known Layer5 error codes.
  if (res.error || res.code) {
    const code = (res.code as string) || '';
    const message = (res.error as string) || 'Unknown error';

    const friendlyMessages: Record<string, string> = {
      MISSING_API_KEY:
        'Your Layer5 API key is missing. ' +
        'Open your n8n credentials and add your Layer5 API key.',
      INVALID_API_KEY:
        'Your Layer5 API key is invalid. ' +
        'Check it in n8n credentials. Keys start with "layer5_". ' +
        'Find yours at app.layer5.dev/settings/api-keys',
      RATE_LIMITED:
        'You\'ve hit the Layer5 rate limit. ' +
        'Wait a moment and try again, or reduce how often this workflow runs.',
      UNKNOWN_ACTION:
        'This action is not registered in Layer5. ' +
        'Add it at app.layer5.dev/actions before using it here.',
      ACTION_DISABLED:
        'This action has been disabled in Layer5. ' +
        'Re-enable it at app.layer5.dev/actions or use a different action.',
      AGENT_SUSPENDED:
        'This agent has been suspended by Layer5 due to too many failures. ' +
        'Check the agent\'s status at app.layer5.dev/agents and reinstate it.',
      MISSING_PARAM:
        'A required field is missing. ' +
        'Make sure you filled in all required fields (marked with *).',
      MISSING_FIELD:
        'A required field is missing in the request. ' +
        'Check that action_name and other required fields are filled in.',
      UNKNOWN_AGENT:
        'Agent not found. Check your Agent ID in the Layer5 dashboard.',
      VALIDATION_ERROR:
        'Invalid simulation request. ' +
        'Check that all fields are filled in correctly.',
      AGENT_NOT_FOUND:
        'Agent not found. Check your Agent ID in the Layer5 dashboard.',
    };

    const friendly = friendlyMessages[code] || `Layer5 error: ${message} (code: ${code})`;
    throw new NodeOperationError(ctx.getNode(), friendly, { itemIndex });
  }

  return res;
}
