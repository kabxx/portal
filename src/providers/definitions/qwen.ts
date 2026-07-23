import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const qwenDefinition = defineProvider({
  provider: 'qwen',
  models: [
    { key: 'qwen3.7-plus', position: 1 },
    { key: 'qwen3.8-max-preview', position: 2 },
    { key: 'qwen3.7-max', position: 3 },
  ],
  capabilities: [
    {
      key: 'deep_research',
      description: 'Run deep research.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'deep_research', scope: 'root' },
    },
    {
      key: 'image_generation',
      description: 'Generate images.',
      kind: 'action',
      target: { kind: 'menu_id', value: 't2i', scope: 'root' },
    },
    {
      key: 'video_generation',
      description: 'Generate videos.',
      kind: 'action',
      target: { kind: 'menu_id', value: 't2v', scope: 'root' },
    },
    {
      key: 'web_dev',
      description: 'Build web experiences.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'web_dev', scope: 'root' },
    },
    {
      key: 'slides',
      description: 'Create slides.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'slides', scope: 'root' },
    },
    {
      key: 'search',
      description: 'Search the web.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'search', scope: 'nested' },
    },
    {
      key: 'artifacts',
      description: 'Create artifacts.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'artifacts', scope: 'nested' },
    },
    {
      key: 'learn',
      description: 'Use learning mode.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'learn', scope: 'nested' },
    },
    {
      key: 'travel',
      description: 'Plan travel.',
      kind: 'action',
      target: { kind: 'menu_id', value: 'travel', scope: 'nested' },
    },
  ],
  locators: {
    modelTrigger: [
      '#qwen-chat-header-left [role="button"][aria-haspopup="listbox"]',
    ],
    modelListbox: ['[role="listbox"]'],
    modelItem: ['[role="option"]'],
    capabilityTrigger: ['.mode-select-open[role="button"]'],
    capabilityMenu: ['.mode-select-dropdown [role="menu"]'],
    capabilityItem: [':scope > [role="menuitem"][data-menu-id]'],
    capabilitySubmenu: ['[role="menuitem"][aria-haspopup="true"]'],
    selectedCapability: ['.mode-select-current-mode'],
    selectedCapabilityIcon: ['.mode-select-current-mode-icon use'],
    selectedCapabilityClose: ['.mode-select-current-mode-close'],
    capabilityItemIcon: ['.mode-select-dropdown-item-icon use'],
  },
} satisfies ProviderDefinitionInput<'qwen'>)
