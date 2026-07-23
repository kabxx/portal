import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const kimiDefinition = defineProvider({
  provider: 'kimi',
  models: [
    { key: 'k2.6', position: 1 },
    { key: 'k3', position: 2 },
    { key: 'k3-cluster', position: 3 },
  ],
  capabilities: [
    {
      key: 'search',
      description: 'Web search mode.',
      kind: 'toggle',
      target: { kind: 'adapter_capability', value: 'search' },
    },
  ],
  locators: {
    modelTrigger: ['.chat-editor .current-model'],
    modelMenu: ['.models-popover'],
    modelItem: ['.models-popover .model-item'],
    capabilityTrigger: ['.chat-editor .toolkit-trigger-btn'],
    capabilityPopover: ['.toolkit-popover'],
    searchItem: ['.toolkit-item:has(svg[name="InternetOn"])'],
    searchPopover: ['.connect-popover'],
    searchOption: ['.connect-item'],
    selectedOptionIcon: ['svg[name="Check"]'],
  },
} satisfies ProviderDefinitionInput<'kimi'>)
