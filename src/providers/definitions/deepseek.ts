import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const deepseekDefinition = defineProvider({
  provider: 'deepseek',
  models: [
    { key: 'quick', position: 1 },
    { key: 'expert', position: 2 },
    { key: 'vision', position: 3 },
  ],
  capabilities: [
    {
      key: 'thinking',
      description: 'Deep thinking mode.',
      kind: 'toggle',
      target: { kind: 'adapter_capability', value: 'thinking' },
    },
    {
      key: 'search',
      description: 'Smart search mode.',
      kind: 'toggle',
      target: { kind: 'adapter_capability', value: 'search' },
    },
  ],
  locators: {
    modelItem: ['div.b0db7355 div[role="radio"][data-model-type]'],
    capabilityToggle: ['div.f79352dc'],
  },
} satisfies ProviderDefinitionInput<'deepseek'>)
