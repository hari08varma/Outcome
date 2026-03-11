'use strict';

/**
 * Layer5 Zapier Authentication
 *
 * Uses API key authentication via Bearer token.
 * Tests the key by calling GET /v1/get-scores with a dummy issue_type
 * — a 401 means the key is bad, anything else means it works.
 */
module.exports = {
  type: 'custom',
  test: async (z, bundle) => {
    const response = await z.request({
      url: 'https://api.layer5.dev/v1/get-scores',
      method: 'GET',
      params: { issue_type: '__auth_test__' },
      headers: {
        Authorization: `Bearer ${bundle.authData.apiKey}`,
      },
    });

    // If we get here without a 401, the key is valid.
    // A 400 (missing param) is fine — it proves auth worked.
    return response.json;
  },
  fields: [
    {
      key: 'apiKey',
      label: 'Layer5 API Key',
      type: 'string',
      required: true,
      helpText:
        'Your Layer5 API key. Starts with "layer5_". ' +
        'Find it at [app.layer5.dev/settings/api-keys]' +
        '(https://app.layer5.dev/settings/api-keys)',
    },
  ],
  connectionLabel: 'Layer5 ({{bundle.authData.apiKey}})',
};
