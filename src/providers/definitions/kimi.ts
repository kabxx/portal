import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const kimiDefinition = defineProvider({
  provider: 'kimi',
  models: [{ key: 'k2.6' }, { key: 'k3' }, { key: 'k3-cluster' }],
  capabilities: [
    {
      key: 'search',
      description: 'Web search mode.',
      kind: 'toggle',
    },
  ],
} satisfies ProviderDefinitionInput<'kimi'>)
