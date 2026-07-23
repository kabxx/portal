import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const glmDefinition = defineProvider({
  provider: 'glm',
  models: [
    { key: 'glm-5.2', position: 1 },
    { key: 'glm-5.1', position: 2 },
    { key: 'glm-5-turbo', position: 3 },
    { key: 'glm-5v-turbo', position: 4 },
    { key: 'glm-4.7', position: 5 },
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
    {
      key: 'advanced_search',
      description: 'Multi-round advanced search mode.',
      kind: 'toggle',
      target: { kind: 'adapter_capability', value: 'advanced_search' },
    },
  ],
  locators: {
    modelTrigger: ['button[id^="model-selector-"]'],
    modelMenu: ['[data-dropdown-menu-content]'],
    modelItem: ['button[data-value]'],
    advancedSearchSwitch: [
      '[data-tooltip-content] button[role="switch"][data-switch-root]',
    ],
    thinkingToggle: ['button[data-autothink]'],
    searchToggle: ['button[data-active]:has(svg[viewBox^="0 0 15"])'],
  },
} satisfies ProviderDefinitionInput<'glm'>)
