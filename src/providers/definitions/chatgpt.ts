import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const chatgptDefinition = defineProvider({
  provider: 'chatgpt',
  models: [{ key: 'chatgpt' }],
  capabilities: [
    {
      key: 'image_create',
      description: 'Create an image.',
      kind: 'action',
    },
    {
      key: 'web_search',
      description: 'Search the web.',
      kind: 'action',
    },
    {
      key: 'deep_research',
      description: 'Run deep research.',
      kind: 'action',
    },
    {
      key: 'openai_platform',
      description: 'Use OpenAI platform resources.',
      kind: 'action',
    },
  ],
} satisfies ProviderDefinitionInput<'chatgpt'>)
