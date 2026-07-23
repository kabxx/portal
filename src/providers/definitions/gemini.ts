import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

const extendedOption = {
  key: 'extended',
  target: { kind: 'suffix', value: 'extended' },
} as const

export const geminiDefinition = defineProvider({
  provider: 'gemini',
  models: [
    { key: '3.5-flash-lite', position: 1, options: [extendedOption] },
    { key: '3.6-flash', position: 2, options: [extendedOption] },
    { key: '3.1-pro', position: 3, options: [extendedOption] },
  ],
  capabilities: [],
  locators: {
    modelTrigger: ['[data-test-id="bard-mode-menu-button"]'],
    modelMenu: ['gem-menu[data-test-id="gem-mode-menu"]'],
    modelItem: ['gem-menu-item'],
    toolsMenuTrigger: ['div.has-model-picker button'],
    capabilityItem: ['button[role="menuitemcheckbox"]'],
    capabilityIcon: ['[data-mat-icon-name]'],
    moreToolsTrigger: ['button[data-test-id="more-tools-button"]'],
    selectedCapability: [
      'gem-button[data-test-id="deselect-drawer-item-gem-button"] > button',
    ],
  },
} satisfies ProviderDefinitionInput<'gemini'>)
