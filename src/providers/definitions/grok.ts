import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const grokDefinition = defineProvider({
  provider: 'grok',
  models: [
    { key: 'fast', position: 1 },
    { key: 'auto', position: 2 },
    { key: 'expert', position: 3 },
    { key: 'heavy', position: 4 },
  ],
  capabilities: [],
  locators: {
    modelTrigger: ['#model-select-trigger'],
    modelMenu: [
      '[data-radix-popper-content-wrapper] [role="menu"][data-state="open"]',
    ],
  },
} satisfies ProviderDefinitionInput<'grok'>)
