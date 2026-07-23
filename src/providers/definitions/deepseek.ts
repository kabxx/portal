import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const deepseekDefinition = defineProvider({
  provider: 'deepseek',
  models: [{ key: 'quick' }, { key: 'expert' }, { key: 'vision' }],
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
  ],
} satisfies ProviderDefinitionInput<'deepseek'>)
