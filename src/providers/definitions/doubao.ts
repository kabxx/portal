import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const doubaoDefinition = defineProvider({
  provider: 'doubao',
  models: [
    { key: 'quick' },
    { key: 'expert' },
    { key: 'office-turbo' },
    { key: 'office-pro' },
  ],
  capabilities: [],
} satisfies ProviderDefinitionInput<'doubao'>)
