import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const geminiDefinition = defineProvider({
  provider: 'gemini',
  models: [
    { key: '3.5-flash-lite', options: [{ key: 'extended' }] },
    { key: '3.6-flash', options: [{ key: 'extended' }] },
    { key: '3.1-pro', options: [{ key: 'extended' }] },
  ],
  capabilities: [],
} satisfies ProviderDefinitionInput<'gemini'>)
