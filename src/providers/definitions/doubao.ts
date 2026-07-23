import {
  defineProvider,
  type ProviderDefinitionInput,
} from './provider-definition.ts'

export const doubaoDefinition = defineProvider({
  provider: 'doubao',
  models: [
    { key: 'quick', position: 1 },
    { key: 'expert', position: 2 },
    { key: 'office-turbo', position: 3 },
    { key: 'office-pro', position: 4 },
  ],
  capabilities: [],
  locators: {
    modelTrigger: [
      'button[data-dbx-name="button"]:has(img[src*="mode_"])',
      'button[data-dbx-name="button"][aria-haspopup="menu"]',
    ],
    modelMenu: ['div[data-slot="dropdown-menu-content"]', '[role="menu"]'],
    capabilityToolbar: [
      '[style*="--chat-input-tool-button-overflow-list-gap"]',
    ],
    selectedCapability: ['[class*="text-g-exit-skill-btn-text"][data-value]'],
    capabilityOverflowPopover: [
      '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"]',
    ],
  },
} satisfies ProviderDefinitionInput<'doubao'>)
