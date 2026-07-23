import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const grokDefinition = defineProvider({
  provider: 'grok',
  models: [
    { key: 'fast' },
    { key: 'auto' },
    { key: 'expert' },
    { key: 'heavy' },
  ],
  capabilities: [],
} satisfies ProviderDefinitionInput<'grok'>)
