import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const chatgptDefinition = defineProvider({
  provider: 'chatgpt',
  models: [{ key: 'chatgpt', position: 1 }],
  capabilities: [
    {
      key: 'image_create',
      description: 'Create an image.',
      kind: 'action',
      target: { kind: 'menu_position', position: 1 },
    },
    {
      key: 'web_search',
      description: 'Search the web.',
      kind: 'action',
      target: { kind: 'menu_position', position: 2 },
    },
    {
      key: 'deep_research',
      description: 'Run deep research.',
      kind: 'action',
      target: { kind: 'menu_position', position: 3 },
    },
    {
      key: 'openai_platform',
      description: 'Use OpenAI platform resources.',
      kind: 'action',
      target: { kind: 'menu_position', position: 4 },
    },
  ],
  locators: {
    modelTrigger: [
      'button[data-testid="model-switcher-dropdown-button"]',
      'button.__composer-pill',
    ],
    modelDirectMenu: ['[role="menu"]'],
    modelPicker: ['div[data-testid="composer-intelligence-picker-content"]'],
    modelDirectItem: ['[role="menuitemradio"]'],
    modelModeItem: ['div[role="group"] div[role="menuitemradio"]'],
    modelMenuItem: ['div[role="menuitem"]'],
    modelItem: ['div[role="menuitemradio"]'],
    capabilityTrigger: ['[data-testid="composer-plus-btn"]'],
    capabilityGroup: ['div[role="group"][class*="empty:hidden"]'],
  },
} satisfies ProviderDefinitionInput<'chatgpt'>)
