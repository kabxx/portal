import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const glmDefinition = defineProvider({
  provider: 'glm',
  models: [
    { key: 'glm-5.2' },
    { key: 'glm-5.1' },
    { key: 'glm-5-turbo' },
    { key: 'glm-5v-turbo' },
    { key: 'glm-4.7' },
  ],
  capabilities: [
    {
      key: 'thinking',
      description: 'Deep thinking mode.',
      kind: 'toggle',
    },
    {
      key: 'search',
      description: 'Smart search mode.',
      kind: 'toggle',
    },
    {
      key: 'advanced_search',
      description: 'Multi-round advanced search mode.',
      kind: 'toggle',
    },
  ],
} satisfies ProviderDefinitionInput<'glm'>)
