import {
  IAuthenticateGeneric,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

export class Layer5Api implements ICredentialType {
  name = 'layer5Api';
  displayName = 'Layer5 API';
  documentationUrl = 'https://docs.layer5.dev/api-keys';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      placeholder: 'layer5_abc123...',
      description:
        'Your Layer5 API key. Starts with "layer5_". ' +
        'Find it at app.layer5.dev/settings/api-keys',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.layer5.dev',
      required: false,
      placeholder: 'https://api.layer5.dev',
      description:
        'Only change this if Layer5 support told you to. ' +
        'Most users should leave this as-is.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  };
}
