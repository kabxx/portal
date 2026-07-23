import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const qwenDefinition = defineProvider({
  provider: 'qwen',
  models: [
    { key: 'qwen3.7-plus' },
    { key: 'qwen3.8-max-preview' },
    { key: 'qwen3.7-max' },
  ],
  capabilities: [
    {
      key: 'deep_research',
      description: 'Run deep research.',
      kind: 'action',
    },
    {
      key: 'image_generation',
      description: 'Generate images.',
      kind: 'action',
    },
    {
      key: 'video_generation',
      description: 'Generate videos.',
      kind: 'action',
    },
    {
      key: 'web_dev',
      description: 'Build web experiences.',
      kind: 'action',
    },
    {
      key: 'slides',
      description: 'Create slides.',
      kind: 'action',
    },
    {
      key: 'search',
      description: 'Search the web.',
      kind: 'action',
    },
    {
      key: 'artifacts',
      description: 'Create artifacts.',
      kind: 'action',
    },
    {
      key: 'learn',
      description: 'Use learning mode.',
      kind: 'action',
    },
    {
      key: 'travel',
      description: 'Plan travel.',
      kind: 'action',
    },
  ],
} satisfies ProviderDefinitionInput<'qwen'>)
